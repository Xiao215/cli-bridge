// Running the official `claude` CLI: one headless process per request.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CALLER, ClaudeRun, newToken, takePaused } from "./claude-run.mjs";
import { inSlot, stats } from "./cli.mjs";
import {
  CLAUDE_CLI, DEFAULT_MODEL, EFFORT, EFFORTS, MODEL_ALIASES, MODELS, PAUSE_SECONDS, SELF_URL, THINKING_SUMMARIES, TIMEOUT_MS, TOOLS,
} from "./config.mjs";
import { HttpError } from "./http.mjs";

// Claude runs in an empty folder so it never sees your files; with TOOLS empty
// it can only reply.
const WORKDIR = path.join(tmpdir(), "cli-bridge-workdir");
mkdirSync(WORKDIR, { recursive: true });

// Nothing leaves this machine except the prompt and reply themselves: no usage
// metrics, error reports, feedback surveys or transcript uploads. With
// --no-session-persistence (below) no transcript is written to ~/.claude either.
const CLAUDE_ENV = {
  ...process.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DO_NOT_TRACK: "1",
};
// Claude Code here always uses your claude.ai login. An exported API key would
// switch it to per-token billing, and an exported ANTHROPIC_BASE_URL (handy for
// pointing your SDKs at this service) would make it call itself.
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete CLAUDE_ENV[name];

// --- model and effort ------------------------------------------------------------

// Map whatever model name a client sends onto a Claude model, so clients that
// default to e.g. "gpt-4o" just work. Your MODEL_ALIASES come first, and Gemini
// names ("gemini", "gemini-3.8-flash-high") are kept for the Gemini backend.
export function resolveModel(requested) {
  if (!requested || typeof requested !== "string") return DEFAULT_MODEL;
  const m = requested.toLowerCase();
  if (MODEL_ALIASES.has(m)) return MODEL_ALIASES.get(m);
  if (m.startsWith("claude-")) return requested;
  if (/^gemini(-|$)/.test(m)) return m;
  for (const alias of MODELS) if (m.includes(alias)) return alias;
  if (/mini|nano|small|lite|flash/.test(m)) return "haiku";
  if (/^o\d|large|ultra|-pro\b/.test(m)) return "opus";
  return DEFAULT_MODEL;
}

export function effortOf(value) {
  if (value == null) return EFFORT;
  if (value === "minimal" || value === "none") return "low"; // OpenAI's names
  if (!EFFORTS.includes(value)) throw new HttpError(400, `effort must be one of ${EFFORTS.join(", ")}`);
  return value;
}

// --- tool servers ------------------------------------------------------------------

// Tool servers a caller may attach: MCP over HTTP on this machine only. A URL is
// all that's accepted — never a command to run — so a request can't make this
// service start arbitrary programs.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;
export function toolServers(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 4) throw new HttpError(400, "mcp_servers must be an array of at most 4");
  return list.map((m) => {
    if (!/^[a-z0-9_-]{1,32}$/i.test(m?.name || "")) throw new HttpError(400, "mcp_servers[].name must be 1-32 letters, digits, - or _");
    if (m.name === CALLER) throw new HttpError(400, `mcp_servers[].name "${CALLER}" is reserved for your own tools`);
    if (!LOOPBACK_URL.test(m?.url || "")) throw new HttpError(400, "mcp_servers[].url must be an http:// URL on localhost/127.0.0.1");
    return { name: m.name, url: m.url };
  });
}

export function maxTurnsOf(n) {
  if (n == null) return null;
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 40) throw new HttpError(400, "max_turns must be an integer from 1 to 40");
  return v;
}

// --- plan usage ----------------------------------------------------------------------

function recordPlan(info) {
  const windows = info.unifiedWindows || {};
  stats.plan = {
    status: info.status,
    updated_at: new Date().toISOString(),
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, w]) => [
        name,
        { used_percent: Math.round((w.utilization ?? 0) * 100), resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null },
      ]),
    ),
  };
}

// --- sign-in check -------------------------------------------------------------------

// Asks the CLI who it's signed in as, so a missing install or login shows up
// at startup instead of as a failed first request. Resolves with
// { missing: true }, `claude auth status` JSON ({ loggedIn, authMethod, ... }),
// or null when the CLI can't say (e.g. an older version).
export function checkLogin() {
  return new Promise((resolve) => {
    execFile(CLAUDE_CLI, ["auth", "status", "--json"], { env: CLAUDE_ENV, timeout: 15000 }, (err, stdout) => {
      if (err?.code === "ENOENT") return resolve({ missing: true });
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// --- running the CLI ---------------------------------------------------------------

// The built-in tools for one request: the configured ones, plus web search
// when the request asks for it.
function builtIns(webSearch) {
  const names = TOOLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (webSearch) names.push("WebSearch", "WebFetch");
  return [...new Set(names)].join(",");
}

function claudeArgs({ model, systemFile, jsonSchema, mcpFile, mcpServers, callerTools, maxTurns, effort, webSearch }) {
  const tools = builtIns(webSearch);
  const args = [
    "-p",
    "--input-format", "stream-json", // lets the prompt carry images
    "--output-format", "stream-json",
    "--verbose", // required by stream-json output
    // Message boundaries and stop reasons (max_tokens, tool_use) only show in
    // the partial-message events, so they're always read.
    "--include-partial-messages",
    "--model", model,
    "--system-prompt-file", systemFile,
    "--tools", tools,
    "--strict-mcp-config", // ignore your MCP servers
    "--setting-sources", "", // ignore your hooks/plugins/settings, for speed and isolation
    "--no-session-persistence",
  ];
  // Headless mode can't ask for permission, so the tools it may use are listed
  // up front: the configured built-ins, plus every tool of each attached server.
  const servers = [...mcpServers.map((m) => m.name), ...(callerTools ? [CALLER] : [])];
  const allowed = [tools, ...servers.map((name) => `mcp__${name}`)].filter(Boolean);
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (mcpFile) args.push("--mcp-config", mcpFile);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (effort) args.push("--effort", effort);
  // Without this the CLI's thinking blocks arrive empty (signature only).
  if (THINKING_SUMMARIES) args.push("--thinking-display", "summarized");
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  return args;
}

// Runs one request. `content` is the user message as Anthropic content blocks
// (text and images). Calls onEvent for each CLI event and resolves with the
// CLI's result shape (see cli.mjs) plus `stop` ("end", "tool_calls" or
// "length") and, when Claude called the caller's tools, `calls`.
//
// `callerTools` are the caller's own tools, served to Claude natively (see
// claude-run.mjs). When the request's last message only carries results for
// calls a paused run is waiting on, that run continues instead of a new one;
// otherwise a new run starts from `content`.
// `maxTokens` caps each reply, as max_tokens does on the API.
export function runClaude({
  system, content, model, jsonSchema = null, signal, onEvent,
  mcpServers = [], maxTurns = null, effort = EFFORT, webSearch = false,
  maxTokens = null, callerTools = [], toolResults = null,
}) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ system, model, jsonSchema, mcpServers, maxTurns, effort, webSearch, maxTokens, callerTools }))
    .digest("hex");
  const events = (event) => {
    if (event.type === "rate_limit_event" && event.rate_limit_info) recordPlan(event.rate_limit_info);
    onEvent?.(event);
  };
  const paused = callerTools.length && toolResults?.length ? takePaused(toolResults.map((r) => r.id), fingerprint) : null;
  if (paused) {
    return inSlot(signal, async () => checked(await paused.resume(toolResults, { signal, onEvent: events }), maxTurns));
  }
  if (callerTools.length && toolResults?.length) {
    console.log("[tools] no paused run waits for these results (expired, stopped or settings changed); starting over from the transcript");
  }

  return inSlot(signal, async () => {
    const id = randomUUID();
    const systemFile = path.join(WORKDIR, `system-${id}.txt`);
    writeFileSync(systemFile, system);
    const token = callerTools.length ? newToken() : null;
    const servers = Object.fromEntries(mcpServers.map((m) => [m.name, { type: "http", url: m.url }]));
    if (token) servers[CALLER] = { type: "http", url: `${SELF_URL}/mcp/${token}` };
    const mcpFile = Object.keys(servers).length ? path.join(WORKDIR, `mcp-${id}.json`) : null;
    if (mcpFile) writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }));
    const env = { ...CLAUDE_ENV };
    // The API's max_tokens: the cap on each reply Claude writes.
    if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    if (token) {
      // Caller tools: never hidden behind tool search, results never cut, and
      // a call may wait as long as the run stays paused.
      env.ENABLE_TOOL_SEARCH = "false";
      env.MAX_MCP_OUTPUT_TOKENS = "1000000";
      env.MCP_TOOL_TIMEOUT = String((PAUSE_SECONDS + 60) * 1000);
    }
    try {
      const run = new ClaudeRun({
        cli: CLAUDE_CLI,
        args: claudeArgs({ model, systemFile, jsonSchema, mcpFile, mcpServers, callerTools: Boolean(token), maxTurns, effort, webSearch }),
        cwd: WORKDIR,
        env,
        stdin: JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
        tools: callerTools,
        token,
        fingerprint,
      });
      return checked(await run.read({ signal, onEvent: events }), maxTurns);
    } finally {
      // The CLI read both at startup, so a paused run doesn't need them.
      rmSync(systemFile, { force: true });
      if (mcpFile) rmSync(mcpFile, { force: true });
    }
  });
}

// The request's result, or the error the CLI ended with.
function checked({ result, timedOut, stderr }, maxTurns) {
  if (!result) {
    const why = timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s` : stderr || "The claude CLI exited without a result";
    throw new HttpError(timedOut ? 504 : 502, why, "server_error");
  }
  if (result.subtype === "error_max_turns") {
    throw new HttpError(422, `Ran out of steps (max_turns ${maxTurns}) before finishing`, "max_turns_exceeded");
  }
  if (result.is_error) throw claudeError(result.result || stderr);
  return result;
}

function claudeError(message = "Claude returned an error") {
  if (/not logged in|\/login|invalid api key|oauth/i.test(message)) {
    return new HttpError(503, `${message} — run \`claude\` then /login on the host`, "authentication_error");
  }
  if (/usage limit|rate.?limit|hit your limit|limit reached|too many requests|overloaded/i.test(message)) {
    return new HttpError(429, message, "rate_limit_error");
  }
  return new HttpError(502, message, "server_error");
}
