// Settings, read once at startup from the environment and from ./.env if there
// is one. Real environment variables win over .env.

try { process.loadEnvFile(); } catch { /* no .env: defaults apply */ }

const env = process.env;

export const PORT = Number(env.PORT || 8787);
export const HOST = env.HOST || "127.0.0.1";
// How the CLI reaches this service (for the MCP server that serves your tools).
const localHost = ["0.0.0.0", "::", "localhost"].includes(HOST) ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
export const SELF_URL = `http://${localHost}:${PORT}`;
export const API_KEY = env.API_KEY || "";
export const CLAUDE_CLI = env.CLAUDE_CLI || "claude";
export const AGY_CLI = env.AGY_CLI || "agy"; // the Antigravity CLI, for gemini-* models
export const DEFAULT_MODEL = env.DEFAULT_MODEL || "sonnet";
export const TOOLS = env.TOOLS || ""; // e.g. "WebSearch,WebFetch"; empty = chat only
export const EFFORT = env.EFFORT || ""; // low | medium | high | xhigh | max; empty = CLI default
// Ask Claude Code for summaries of Claude's thinking, returned as
// reasoning_content (OpenAI format). Set to 0 to leave thinking out.
export const THINKING_SUMMARIES = !/^(0|false|no|off)$/i.test(env.THINKING_SUMMARIES || "");
export const MAX_CONCURRENT =Math.max(1, Number(env.MAX_CONCURRENT || 2));
export const TIMEOUT_MS = Number(env.TIMEOUT_SECONDS || 300) * 1000;
// Your own tools go to Claude as real tools (served by this bridge over MCP).
// Set to 0 to describe them in the system prompt instead, as for Gemini.
export const NATIVE_TOOLS = !/^(0|false|no|off)$/i.test(env.NATIVE_TOOLS || "");
// After Claude calls your tools, its process waits this long for the results.
// A paused process holds memory, so at most MAX_PAUSED wait at once (oldest
// stopped first); late results then start over from the conversation.
export const PAUSE_SECONDS = Number(env.PAUSE_SECONDS || 300);
export const MAX_PAUSED = Math.max(0, Number(env.MAX_PAUSED ?? 4));
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
// Browsers send an Origin header; the apps this serves are servers and scripts,
// which don't. Without this, any web page open in your browser could POST to
// localhost and spend your subscription (a text/plain POST needs no preflight).
export const ALLOWED_ORIGINS = new Set(list(env.ALLOWED_ORIGINS));
// Your own model names, e.g. "gpt-4o-mini=haiku,gpt-4o=sonnet".
export const MODEL_ALIASES = new Map(
  list(env.MODEL_ALIASES).map((pair) => pair.split("=").map((s) => s.trim().toLowerCase())),
);
export const DEFAULT_SYSTEM = "You are a helpful assistant.";
export const MODELS = ["haiku", "sonnet", "opus", "fable"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function list(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}
