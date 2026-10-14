#!/usr/bin/env node
// Stand-in for the Antigravity CLI (`agy`) so tests run offline and don't use
// your limits. Echoes back what it received; magic words in the prompt trigger
// failure modes.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "models") {
  if (process.env.FAKE_AGY_LOGGED_OUT) {
    console.log("Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.");
    process.exit(1);
  }
  console.log("Fetching available models...\ngemini-9-flash-high\tGemini 9 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)");
  process.exit(0);
}
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const input = JSON.parse(readFileSync(0, "utf8").split("\n")[0]);
const prompt = input.message.content;
const model = opt("--model") ?? "gemini-default";
const schema = opt("--json-schema") && JSON.parse(opt("--json-schema"));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const conversation_id = "conv-1";
const usage = { input_tokens: 12, output_tokens: 7, thinking_tokens: 0, cache_read_tokens: 2, total_tokens: 19 };
const result = (fields) => out({ event: "result", result: { conversation_id, num_turns: 1, duration_seconds: 0.5, usage, ...fields } });

if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ args, prompt }) + "\n");
if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 5000));
const fail = (error) => {
  process.stderr.write(`Error: ${error}\n`);
  result({ status: "ERROR", response: "", error });
  process.exit(1);
};
if (prompt.includes("FAIL_LOGIN")) fail("Please sign in to continue. Launch the CLI without arguments to sign in.");
if (prompt.includes("FAIL_QUOTA")) fail("RESOURCE_EXHAUSTED: quota exceeded for this model");
if (model === "gemini-nope") fail(`invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 9 Flash (High)`);

out({ event: "init", conversation_id, init: { model, cwd: process.cwd(), tools: ["run_command", "view_file"], permission_mode: "request-review" } });
out({ event: "step_update", step_update: { conversation_id, step_index: 0, state: "DONE", step_type: "user_input" } });

if (prompt.includes("TRY_COMMAND")) {
  out({ event: "step_update", step_update: { conversation_id, step_index: 1, state: "ERROR", step_type: "tool", tool_name: "run_command" } });
  result({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] });
  process.exit(0);
}

const files = readdirSync(".");
const text =
  `echo model=${model} effort=${opt("--effort") ?? ""} sandbox=${args.includes("--sandbox")} ` +
  `files=${JSON.stringify(files)} prompt=${JSON.stringify(prompt)}`;

// With tools offered (a schema with tool_calls), CALL_TOOL makes it call the
// first tool it's allowed to; otherwise it replies in `content`.
let structured;
if (schema?.properties?.tool_calls) {
  const tool = schema.properties.tool_calls.items.anyOf[0].properties.name.const;
  const mustCall = !schema.properties.type.enum.includes("message");
  structured =
    prompt.includes("CALL_TOOL") || mustCall
      ? { type: "tool_calls", content: "Checking.", tool_calls: [{ name: tool, arguments: { city: "Paris" } }] }
      : { type: "message", content: text };
} else if (schema) {
  structured = { ok: true };
}

const reply = structured ? JSON.stringify(structured) + "\n" : text + "\n";
const pieces = reply.match(/.{1,20}/gs);
pieces.forEach((piece, i) => {
  const last = i === pieces.length - 1;
  out({ event: "step_update", step_update: { conversation_id, step_index: 1, state: last ? "DONE" : "ACTIVE", step_type: "agent_response", text_delta: piece } });
});
if (prompt.includes("FAIL_MIDSTREAM")) process.exit(1);
result({ status: "SUCCESS", response: reply, ...(structured ? { structured_output: structured } : {}) });
