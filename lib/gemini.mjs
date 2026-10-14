// Running Gemini through the official Antigravity CLI (`agy`): one headless
// process per request, signed in with your own Google account. Personal use
// only, as with Claude.
//
// agy is a coding agent rather than a plain model. It has no flags for a system
// prompt or for turning its tools off, and it takes text only. So the caller's
// system prompt goes at the top of the message, images and PDFs are saved into
// the request's own empty folder for Gemini to open, and --sandbox keeps its
// commands and file reads inside that folder; anything else that needs
// permission is denied, since headless mode can't ask.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inSlot, runJsonLines } from "./cli.mjs";
import { AGY_CLI, EFFORT, TIMEOUT_MS } from "./config.mjs";
import { HttpError } from "./http.mjs";

const ROOT = path.join(tmpdir(), "claude-api-gemini");

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" };

// The Gemini models agy offers this account, filled in by checkGeminiLogin().
export const geminiModels = [];

// --- sign-in check -------------------------------------------------------------------

// `agy models` needs a signed-in account, so it doubles as the sign-in check.
// Resolves with { missing: true }, { loggedIn: false }, { loggedIn: true,
// models }, or null when agy can't say.
export function checkGeminiLogin() {
  return new Promise((resolve) => {
    const child = execFile(AGY_CLI, ["models"], { cwd: tmpdir(), timeout: 30000 }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") return resolve({ missing: true });
      if (/sign in/i.test(stdout + stderr)) return resolve({ loggedIn: false });
      if (err) return resolve(null);
      const models = stdout.split("\n").map((line) => line.split("\t")[0].trim()).filter((id) => /^gemini-/.test(id));
      geminiModels.splice(0, Infinity, ...models);
      resolve({ loggedIn: true, models });
    });
    child.stdin?.end(); // agy waits on an open stdin
  });
}

// --- the prompt --------------------------------------------------------------------

// One text message: what the request may and may not do, the caller's system
// prompt, then the conversation, with each attachment named where it was.
function prompt({ system, content, webSearch, files }) {
  const rules = [
    "You are answering as a chat model through an API, not working as a coding agent.",
    webSearch
      ? "You may search the web and read web pages when that helps."
      : "Don't search the web or open URLs; answer from what you know.",
    files.length
      ? `Don't run commands or create or edit files. The files attached below (${files.join(", ")}) are in your current folder; open them with view_file when you need them.`
      : "Don't run commands or read, create or edit files: your current folder is empty.",
  ];
  let i = 0;
  const body = content
    .map((b) => (b.type === "text" ? b.text : `[attached: ${files[i++]}${b.title ? ` (${b.title})` : ""}]`))
    .join("\n");
  return `${rules.join(" ")}\n\n<instructions>\n${system}\n</instructions>\n\n${body}`;
}

// Saves the images and PDFs in `content` into `dir`; returns their file names.
function saveAttachments(content, dir) {
  return content
    .filter((b) => b.type !== "text")
    .map((b, i) => {
      const name = `attachment-${i + 1}.${EXTENSIONS[b.source.media_type]}`;
      writeFileSync(path.join(dir, name), Buffer.from(b.source.data, "base64"));
      return name;
    });
}

// --- running the CLI ---------------------------------------------------------------

function agyArgs({ model, jsonSchema, effort }) {
  const args = [
    "--input-format", "stream-json", // the prompt comes on stdin, so its length isn't limited by argv
    "--output-format", "stream-json",
    "--sandbox", // commands and file reads stay inside the request's folder
    "--disable-slash-commands", // a message starting with "/" is just text
  ];
  // "gemini" alone leaves the choice to agy.
  if (model !== "gemini") args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  args.push("--print="); // last: the prompt is read from stdin
  return args;
}

// Same arguments and result as runClaude. Calls onEvent with Claude-shaped
// events (init with the model, and text deltas) so streaming works unchanged.
export function runGemini({
  system, content, model, jsonSchema = null, signal, onEvent,
  mcpServers = [], maxTurns = null, effort = EFFORT, webSearch = false,
}) {
  if (mcpServers.length) throw new HttpError(400, "mcp_servers isn't supported with Gemini models");
  if (maxTurns != null) throw new HttpError(400, "max_turns isn't supported with Gemini models");

  return inSlot(signal, async () => {
    const dir = path.join(ROOT, randomUUID());
    mkdirSync(dir, { recursive: true });
    try {
      const files = saveAttachments(content, dir);
      const text = prompt({ system, content, webSearch, files });
      let result = null;
      let shownModel = model;
      const { stderr, timedOut } = await runJsonLines(AGY_CLI, agyArgs({ model, jsonSchema, effort }), {
        cwd: dir,
        env: process.env,
        stdin: JSON.stringify({ event: "user", message: { role: "user", content: text } }) + "\n",
        signal,
        onEvent: (event) => {
          if (event.event === "init" && event.init?.model) {
            shownModel = event.init.model;
            onEvent?.({ type: "system", subtype: "init", model: shownModel });
          } else if (event.event === "step_update") {
            const step = event.step_update || {};
            // agy ends each reply with a newline, which the result drops too.
            const delta = step.state === "DONE" ? step.text_delta?.replace(/\n$/, "") : step.text_delta;
            if (step.step_type === "agent_response" && delta) {
              onEvent?.({
                type: "stream_event",
                parent_tool_use_id: null,
                event: { type: "content_block_delta", delta: { type: "text_delta", text: delta } },
              });
            }
          } else if (event.event === "result") {
            result = event.result;
          }
        },
      });
      if (!result) {
        const why = timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s` : stderr || "The agy CLI exited without a result";
        throw new HttpError(timedOut ? 504 : 502, why, "server_error");
      }
      if (result.status !== "SUCCESS") throw geminiError(result.error || stderr);
      if (!result.response?.trim() && result.structured_output === undefined) {
        const denied = (result.denied_actions || []).map((a) => a.display_name || a.action);
        throw new HttpError(
          502,
          denied.length
            ? `Gemini tried to use ${denied.join(", ")}, which isn't allowed here, and stopped without an answer`
            : "Gemini returned an empty reply",
          "server_error",
        );
      }
      if (jsonSchema && result.structured_output === undefined) {
        throw new HttpError(502, "Gemini didn't reply in the requested JSON schema", "server_error");
      }
      return claudeShaped(result, shownModel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// agy's result in the claude CLI's result shape (see cli.mjs).
function claudeShaped(r, model) {
  const u = r.usage || {};
  const cached = u.cache_read_tokens || 0;
  return {
    result: (r.response || "").replace(/\n$/, ""),
    ...(r.structured_output !== undefined ? { structured_output: r.structured_output } : {}),
    usage: {
      input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: u.output_tokens || 0,
    },
    modelUsage: { [model]: {} },
    duration_ms: Math.round((r.duration_seconds || 0) * 1000),
  };
}

function geminiError(message = "Gemini returned an error") {
  if (/sign in|signed out|unauthenticated/i.test(message)) {
    return new HttpError(503, `${message} — run \`agy\` on the host to sign in`, "authentication_error");
  }
  if (/invalid model selection|not recognized as a known model/i.test(message)) {
    return new HttpError(400, message.split("\n")[0], "invalid_request_error");
  }
  if (/disabled in this account|violation of terms/i.test(message)) {
    return new HttpError(403, message, "permission_error");
  }
  if (/quota|rate.?limit|resource.?exhausted|too many requests|limit reached|\b429\b/i.test(message)) {
    return new HttpError(429, message, "rate_limit_error");
  }
  return new HttpError(502, message, "server_error");
}
