// What every backend shares: running one headless CLI process per request, the
// concurrency limit, and the stats. Each backend resolves with a result in the
// `claude` CLI's result shape ({ result, structured_output?, usage, modelUsage,
// duration_ms }), so the API formats read every backend the same way.

import { spawn } from "node:child_process";
import { MAX_CONCURRENT, TIMEOUT_MS } from "./config.mjs";
import { HttpError } from "./http.mjs";

// --- concurrency limit -------------------------------------------------------------

let running = 0;
const waiting = [];
async function acquire() {
  if (running < MAX_CONCURRENT) return void running++;
  await new Promise((resolve) => waiting.push(resolve));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

// --- stats ---------------------------------------------------------------------------

// Since startup, in memory only. `plan` is the latest Claude plan usage the CLI
// reported (fraction of the 5-hour and weekly windows used).
export const stats = { started_at: new Date().toISOString(), requests: 0, errors: 0, tokens: {}, plan: null, last_error: null };

function recordUsage(result) {
  const model = modelOf(result, "unknown");
  const t = (stats.tokens[model] ??= { requests: 0, input_tokens: 0, output_tokens: 0 });
  const u = usageOf(result);
  t.requests++;
  t.input_tokens += u.input;
  t.output_tokens += u.output;
}

export function liveStats() {
  return { running, queued: waiting.length };
}

// --- running a request ---------------------------------------------------------------

// Every request runs through here: counted in /stats, and at most
// MAX_CONCURRENT at once, whichever CLI answers it.
export async function inSlot(signal, run) {
  stats.requests++;
  await acquire();
  try {
    // A client that gave up while queued shouldn't cost anything.
    if (signal?.aborted) throw new HttpError(499, "Client disconnected", "cancelled");
    const result = await run();
    recordUsage(result);
    return result;
  } catch (e) {
    if (e.status !== 499) {
      stats.errors++;
      stats.last_error = { at: new Date().toISOString(), status: e.status, message: e.message };
    }
    throw e;
  } finally {
    release();
  }
}

// Runs a CLI that prints one JSON event per line, calling onEvent for each.
// Resolves with { stderr, timedOut } once it exits. Kills it on timeout or
// when `signal` aborts (then rejects with 499).
export function runJsonLines(cli, args, { cwd, env, stdin, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let forceKill;
    const kill = () => {
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });

    const handle = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      onEvent(event);
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(line);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {}); // the CLI exited early; "close" reports why
    child.on("error", (e) => reject(new HttpError(500, `Could not run "${cli}": ${e.message}`, "server_error")));
    child.on("close", () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", kill);
      if (buffer.trim()) handle(buffer.trim());
      if (signal?.aborted) return reject(new HttpError(499, "Client disconnected", "cancelled"));
      resolve({ stderr: stderr.trim(), timedOut });
    });

    child.stdin.end(stdin);
  });
}

// --- reading the result --------------------------------------------------------------

export function usageOf(result) {
  const u = result.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return { input, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_creation: u.cache_creation_input_tokens || 0 };
}

export function modelOf(result, fallback) {
  return Object.keys(result.modelUsage || {})[0] || fallback;
}

// The structured output when a JSON schema was given, else the reply text.
export function outputOf(result) {
  return result.structured_output !== undefined ? result.structured_output : (result.result ?? "");
}
