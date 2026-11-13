#!/usr/bin/env node
// Stand-in for the `claude` CLI so tests run offline and don't use your limits.
// Echoes back what it received; magic words in the prompt trigger failure modes.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "auth") {
  const loggedIn = !process.env.FAKE_CLAUDE_LOGGED_OUT;
  console.log(JSON.stringify(loggedIn ? { loggedIn, authMethod: "claude.ai", email: "me@example.com", subscriptionType: "max" } : { loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const input = JSON.parse(readFileSync(0, "utf8").split("\n")[0]);
const blocks = input.message.content;
const prompt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
const images = blocks.filter((b) => b.type === "image").map((b) => b.source.media_type);
const documents = blocks.filter((b) => b.type === "document").map((b) => b.title ?? b.source.media_type);
const system = readFileSync(opt("--system-prompt-file"), "utf8");
const model = opt("--model");
const schema = opt("--json-schema") && JSON.parse(opt("--json-schema"));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, prompt + "\n");
if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 5000));
const fail = (message) => {
  out({ type: "result", is_error: true, result: message });
  process.exit(1);
};
if (prompt.includes("FAIL_LOGIN")) fail("Not logged in · Please run /login");
if (prompt.includes("FAIL_LIMIT")) fail("You've hit your usage limit · resets 5pm");

const mcpFile = opt("--mcp-config");
const extras = mcpFile
  ? ` mcp=${readFileSync(mcpFile, "utf8")} allowed=${JSON.stringify(opt("--allowedTools"))} turns=${JSON.stringify(opt("--max-turns"))}`
  : "";
const text =
  `echo model=${model} effort=${opt("--effort") ?? ""} tools=${JSON.stringify(opt("--tools"))} images=${JSON.stringify(images)} ` +
  (documents.length ? `documents=${JSON.stringify(documents)} ` : "") +
  `anthropic_env=${JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("ANTHROPIC_")))} ` +
  `thinking_display=${opt("--thinking-display") ?? ""} system=${JSON.stringify(system)} prompt=${JSON.stringify(prompt)}${extras}`;

// With tools offered (a schema with tool_calls), CALL_TOOL makes it call the
// first tool it's allowed to; otherwise it replies in `content`.
let structured;
if (schema?.properties?.tool_calls) {
  const tool = schema.properties.tool_calls.items.anyOf[0].properties.name.const;
  const mustCall = !schema.properties.type.enum.includes("message");
  structured =
    prompt.includes("CALL_TOOL") || mustCall
      ? { type: "tool_calls", content: "Checking.", tool_calls: [{ name: tool, arguments: { city: "Paris" } }] }
      : schema.properties.reply
        ? { type: "message", content: "", reply: { ok: true, tools: opt("--tools") } }
        : { type: "message", content: text };
} else if (schema) {
  structured = { ok: true, schema };
}

// The final reply's content blocks. Like the real CLI, `result` below is only
// the last text block. MULTI_BLOCK: Claude thinks between two text blocks and
// ends with a short note after its answer.
const MULTI = [
  { type: "thinking", thinking: "Weighing the options." },
  { type: "text", text: `Part one. ${text}\n<answer>A</answer>` },
  { type: "thinking", thinking: "Checking once more." },
  { type: "text", text: "Closing note." },
];
const reply = structured ? [] : prompt.includes("MULTI_BLOCK") ? MULTI : [{ type: "thinking", thinking: "hmm" }, { type: "text", text }];
const finalText = reply.filter((b) => b.type === "text").at(-1)?.text;
const assistant = (id, block, parent = null) =>
  out({ type: "assistant", message: { id, model: `claude-${model}-test`, role: "assistant", content: [block] }, parent_tool_use_id: parent });

out({ type: "system", subtype: "init", model: `claude-${model}-test` });
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: 1791078000 } } } });
if (prompt.includes("MULTI_BLOCK")) {
  // An earlier turn that ended in a tool call, and a sub-agent's message: not part of the final reply.
  assistant("msg_early", { type: "text", text: "EARLIER_TURN" });
  assistant("msg_early", { type: "tool_use", id: "toolu_x", name: "Task", input: {} });
  assistant("msg_sub", { type: "text", text: "SUBAGENT" }, "toolu_x");
}
if (args.includes("--include-partial-messages")) {
  // A sub-agent delta that must NOT reach the client.
  out({ type: "stream_event", parent_tool_use_id: "toolu_x", event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT" } } });
  const stream = (event) => out({ type: "stream_event", parent_tool_use_id: null, event });
  reply.forEach((b, index) => {
    stream({ type: "content_block_start", index, content_block: { ...b, [b.type]: "" } });
    for (const piece of b[b.type].match(/.{1,20}/gs)) {
      const delta = b.type === "text" ? { type: "text_delta", text: piece } : { type: "thinking_delta", thinking: piece };
      stream({ type: "content_block_delta", index, delta });
    }
    stream({ type: "content_block_stop", index });
  });
}
for (const b of reply) assistant("msg_final", b);
if (prompt.includes("FAIL_MIDSTREAM")) fail("Claude broke off mid-reply");
out({
  type: "result",
  is_error: false,
  result: structured ? JSON.stringify(structured) : finalText,
  ...(structured ? { structured_output: structured } : {}),
  usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 7 },
  modelUsage: { [`claude-${model}-test`]: {} },
  duration_ms: 1,
});
