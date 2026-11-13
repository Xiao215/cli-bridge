// One `claude` process, read one request at a time.
//
// Most runs are a single request: the process answers and exits. Two things
// end a request early, while the process is still running:
//   - Claude hits max_tokens. The CLI would carry on by itself (it tells Claude
//     "Output token limit hit. Resume directly" and continues), so the process
//     is stopped there and the reply ends as the API ends it, with "length".
//   - Claude calls the caller's own tools. Those are served to Claude natively,
//     as tools of an MCP server inside this bridge (see handleMcp). The calls go
//     back to the caller and the process is paused: the CLI waits on the tool
//     calls it made. The caller's next request, carrying the results, continues
//     the same process, so Claude sees real tool calls and results throughout.
//     A paused run that isn't continued in time is stopped; the caller's late
//     results then start a new run with the conversation as a transcript.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MAX_PAUSED, PAUSE_SECONDS, TIMEOUT_MS } from "./config.mjs";
import { HttpError } from "./http.mjs";

// The caller's tools are this MCP server's tools, so Claude sees them as
// mcp__caller__<name>; replies carry the caller's own names.
export const CALLER = "caller";
const CALLER_PREFIX = `mcp__${CALLER}__`;

const live = new Map(); // MCP token -> run, from start until exit
const paused = new Map(); // tool_use id -> run waiting for that result

export function newToken() {
  return randomBytes(16).toString("hex");
}

export function pausedCount() {
  return new Set(paused.values()).size;
}

// The paused run waiting for exactly these results, if it was started by the
// same request settings (fingerprint). Any other run holding one of these ids
// is stopped: the caller has moved on from it.
export function takePaused(ids, fingerprint) {
  const runs = new Set(ids.map((id) => paused.get(id)).filter(Boolean));
  const [run] = runs;
  const waiting = run ? run.pendingIds() : [];
  const exact = runs.size === 1 && run.fingerprint === fingerprint && waiting.length === ids.length && ids.every((id) => waiting.includes(id));
  if (exact) return run;
  for (const r of runs) r.stop();
  return null;
}

export class ClaudeRun {
  constructor({ cli, args, cwd, env, stdin, tools = [], token = null, fingerprint = null }) {
    this.tools = tools;
    this.token = token;
    this.fingerprint = fingerprint;
    this.segment = null;
    this.queued = [];
    this.requests = 0;
    this.stderr = "";
    this.exited = false;
    this.calls = []; // the caller-tool calls of the paused message: { id, name, input }
    this.results = new Map(); // tool_use id -> MCP result, once the caller sent it
    this.waiting = new Map(); // tool_use id -> respond(result), MCP calls held open
    this.idle = null;

    this.child = spawn(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    if (token) live.set(token, this);
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.line(line);
      }
    });
    this.child.stderr.on("data", (d) => (this.stderr += d));
    this.child.stdin.on("error", () => {}); // the CLI exited early; "close" reports why
    this.child.on("error", (e) => this.fail(new HttpError(500, `Could not run "${cli}": ${e.message}`, "server_error")));
    this.child.on("close", () => {
      if (buffer.trim()) this.line(buffer.trim());
      this.exited = true;
      this.cleanup();
      this.segment?.closed();
    });
    this.child.stdin.end(stdin);
  }

  // Reads the next request's worth of output. Resolves with { result,
  // timedOut, stderr }: result is in the CLI's result shape plus `stop`
  // ("end", "tool_calls" or "length") and, for tool calls, `calls`; null when
  // the process ended without one.
  read({ signal, onEvent }) {
    if (this.exited) return Promise.resolve({ result: null, timedOut: false, stderr: this.stderr.trim() });
    this.requests++;
    return new Promise((resolve, reject) => {
      const seg = (this.segment = new Segment(this, { onEvent, first: this.requests === 1 }));
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.stop(); }, TIMEOUT_MS);
      const abort = () => this.stop();
      signal?.addEventListener("abort", abort, { once: true });
      seg.done = (out, error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.segment = null;
        if (signal?.aborted) return reject(new HttpError(499, "Client disconnected", "cancelled"));
        if (error) return reject(error);
        resolve({ result: out ?? null, timedOut, stderr: this.stderr.trim() });
      };
      for (const event of this.queued.splice(0)) seg.event(event);
    });
  }

  // Continues a paused run with the caller's tool results, then reads on.
  resume(results, opts) {
    clearTimeout(this.idle);
    for (const id of this.pendingIds()) paused.delete(id);
    const reading = this.read(opts);
    for (const r of results) {
      const result = mcpResult(r);
      this.results.set(r.id, result);
      this.waiting.get(r.id)?.(result);
      this.waiting.delete(r.id);
    }
    return reading;
  }

  pendingIds() {
    return this.calls.map((c) => c.id).filter((id) => !this.results.has(id));
  }

  line(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (this.segment) this.segment.event(event);
    else if (!this.exited) this.queued.push(event);
  }

  pause(calls) {
    this.calls = calls;
    this.results.clear();
    for (const c of calls) paused.set(c.id, this);
    this.idle = setTimeout(() => this.stop(), PAUSE_SECONDS * 1000);
    // Each paused run is a process waiting in memory: keep only the newest few.
    const runs = [...new Set(paused.values())];
    for (const r of runs.slice(0, Math.max(0, runs.length - MAX_PAUSED))) r.stop();
  }

  stop() {
    if (this.exited) return;
    this.cleanup();
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    force.unref();
  }

  fail(error) {
    this.exited = true;
    this.cleanup();
    this.segment?.fail(error);
  }

  cleanup() {
    clearTimeout(this.idle);
    for (const [id, run] of paused) if (run === this) paused.delete(id);
    if (this.token) live.delete(this.token);
    for (const respond of this.waiting.values()) respond({ content: [{ type: "text", text: "The run was stopped." }], isError: true });
    this.waiting.clear();
  }

  // An MCP tools/call from the CLI: answered now if the caller already sent
  // the result, else held open until it does.
  toolCall(params, respond) {
    let id = params?._meta?.["claudecode/toolUseId"];
    if (!id) {
      // Older CLIs don't say which tool_use this is: the first unanswered call
      // with this name and these arguments.
      const args = JSON.stringify(params?.arguments ?? {});
      id = this.calls.find((c) => c.name === params?.name && JSON.stringify(c.input ?? {}) === args && !this.waiting.has(c.id))?.id;
    }
    const result = id && this.results.get(id);
    if (result) return respond(result);
    if (!id) return respond({ content: [{ type: "text", text: `No pending call to ${params?.name}.` }], isError: true });
    this.waiting.set(id, respond);
  }
}

// The output of one request: the top-level messages Claude wrote, and how the
// request ended.
class Segment {
  constructor(run, { onEvent, first }) {
    this.run = run;
    this.onEvent = onEvent;
    this.first = first;
    this.started = Date.now();
    this.messages = new Map(); // message id -> { texts, thinking, tools, stop, usage, model }
    this.current = null;
    this.last = null;
    this.model = null;
    this.finished = false;
  }

  message(id) {
    if (!this.messages.has(id)) this.messages.set(id, { texts: [], thinking: [], tools: [], stop: null, usage: null, model: null });
    return this.messages.get(id);
  }

  event(event) {
    if (this.finished) return;
    this.onEvent?.(event);
    if (event.type === "system" && event.subtype === "init" && event.model) this.model = event.model;
    if (event.parent_tool_use_id) return; // a sub-agent's, not part of the reply
    if (event.type === "assistant") {
      const m = event.message;
      if (!m?.id || m.model === "<synthetic>") return;
      const msg = this.message(m.id);
      msg.model = m.model || msg.model;
      this.last = m.id;
      for (const b of m.content || []) {
        if (b.type === "text" && b.text) msg.texts.push(b.text);
        else if (b.type === "thinking" && b.thinking) msg.thinking.push(b.thinking);
        else if (b.type === "tool_use") msg.tools.push(b);
      }
    } else if (event.type === "stream_event") {
      const ev = event.event || {};
      if (ev.type === "message_start" && ev.message?.id) {
        this.current = ev.message.id;
        this.message(this.current).model = ev.message.model || null;
      } else if (ev.type === "message_delta" && this.current) {
        const msg = this.message(this.current);
        msg.stop = ev.delta?.stop_reason ?? msg.stop;
        if (ev.usage) msg.usage = ev.usage;
      } else if (ev.type === "message_stop" && this.current) {
        const msg = this.message(this.current);
        const calls = msg.tools.filter((t) => t.name?.startsWith(CALLER_PREFIX));
        if (msg.stop === "max_tokens") {
          this.end({ stop: "length", msg });
          this.run.stop();
        } else if (msg.stop === "tool_use" && calls.length) {
          const mine = calls.map((t) => ({ id: t.id, name: t.name.slice(CALLER_PREFIX.length), input: t.input ?? {} }));
          this.end({ stop: "tool_calls", msg, calls: mine });
          this.run.pause(mine);
        }
      }
    } else if (event.type === "result") {
      this.end({ stop: "end", result: event });
    }
  }

  // The request's usage: its own messages' usage, as each API call reports it.
  // A process's final result counts every request it served, so it's used
  // only when this was the first request and no message reported usage.
  usage(result) {
    const sum = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    let seen = false;
    for (const m of this.messages.values()) {
      if (!m.usage) continue;
      seen = true;
      for (const k of Object.keys(sum)) sum[k] += m.usage[k] || 0;
    }
    if (!seen && result?.usage && this.first) return result.usage;
    return sum;
  }

  end({ stop, msg = null, result = null, calls = null }) {
    if (this.finished) return;
    this.finished = true;
    const last = msg ?? this.messages.get(this.last);
    const texts = last?.texts ?? [];
    const thinking = (last?.thinking ?? []).join("\n\n");
    const model = last?.model || this.model;
    const base = result
      ? { ...result }
      : { is_error: false, result: texts.join("\n\n"), modelUsage: model ? { [model]: {} } : {} };
    const out = { ...base, usage: this.usage(result), duration_ms: Date.now() - this.started, stop, reasoning: "" };
    if (calls) out.calls = calls;
    if (stop === "end" && result) {
      if (result.structured_output !== undefined) {
        // The last message is the one that called StructuredOutput: text
        // written in it before the call is part of the reply.
        out.written = texts.join("\n\n");
        out.reasoning = thinking;
      } else if (texts.length && texts.at(-1).trim() === String(result.result ?? "").trim()) {
        // The CLI's `result` is only the last text block; the reply is all of them.
        out.result = texts.join("\n\n");
        out.reasoning = thinking;
      }
    } else {
      out.reasoning = thinking;
    }
    this.done(out);
  }

  closed() {
    if (this.finished) return;
    this.finished = true;
    this.done(null);
  }

  fail(error) {
    if (this.finished) return;
    this.finished = true;
    this.done(null, error);
  }
}

// The caller's result for one tool call, as an MCP tool result.
function mcpResult(r) {
  const content = (r.parts || []).map((p) =>
    p.type === "image" ? { type: "image", data: p.data, mimeType: p.media_type } : { type: "text", text: p.text ?? "" },
  );
  return { content: content.length ? content : [{ type: "text", text: "" }], isError: Boolean(r.is_error) };
}

// --- the MCP endpoint ----------------------------------------------------------------

// POST /mcp/<token>: the MCP server (Streamable HTTP, JSON responses) that
// serves one run's caller tools to its claude process. The token is the
// secret: it's random per run and only that process is told it.
export function handleMcp(req, res, token) {
  const run = live.get(token);
  if (!run) return void res.writeHead(404).end();
  if (req.method === "DELETE") return void res.writeHead(200).end();
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return void res.writeHead(400).end(); }
    if (msg?.id === undefined) return void res.writeHead(202).end(); // a notification
    let answered = false;
    const reply = (result) => {
      if (answered || res.writableEnded) return;
      answered = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cli-bridge", version: "1" } });
      case "tools/list":
        return reply({ tools: run.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
      case "tools/call":
        return run.toolCall(msg.params, reply);
      default:
        return reply({}); // ping, server/discover and the like
    }
  });
}
