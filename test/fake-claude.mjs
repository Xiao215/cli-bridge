#!/usr/bin/env node
// Stand-in for the `claude` CLI so tests run offline and don't use your limits.
// Echoes back what it received; magic words in the prompt trigger failure modes.
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

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
// The bridge's own MCP server for the caller's tools: connect and list them, as the CLI does.
const callerUrl = mcpFile && JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers?.caller?.url;
let rpcId = 0;
const rpc = async (method, params = {}) => {
  const r = await fetch(callerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return (await r.json()).result;
};
let callerTools = null;
if (callerUrl) {
  await rpc("initialize", { protocolVersion: "2025-11-25" });
  await fetch(callerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  callerTools = (await rpc("tools/list")).tools;
}
const extras = mcpFile
  ? ` mcp=${readFileSync(mcpFile, "utf8")} allowed=${JSON.stringify(opt("--allowedTools"))} turns=${JSON.stringify(opt("--max-turns"))}`
  : "";
const text =
  `echo model=${model} effort=${opt("--effort") ?? ""} tools=${JSON.stringify(opt("--tools"))} images=${JSON.stringify(images)} ` +
  (documents.length ? `documents=${JSON.stringify(documents)} ` : "") +
  `anthropic_env=${JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("ANTHROPIC_")))} ` +
  `thinking_display=${opt("--thinking-display") ?? ""} ` +
  (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ? `max_output_tokens=${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS} ` : "") +
  `system=${JSON.stringify(system)} prompt=${JSON.stringify(prompt)}${extras}` +
  (callerTools ? ` native_tools=${JSON.stringify(callerTools)}` : "");

const stream = (event) => out({ type: "stream_event", parent_tool_use_id: null, event });
// One whole message as stream-json prints it: start, each block (also as an
// `assistant` event), the stop reason with the message's usage, stop.
const message = (id, blocks, stop_reason, usage) => {
  stream({ type: "message_start", message: { id, model: `claude-${model}-test` } });
  for (const b of blocks) out({ type: "assistant", message: { id, model: `claude-${model}-test`, role: "assistant", content: [b] }, parent_tool_use_id: null });
  stream({ type: "message_delta", delta: { stop_reason }, usage });
  stream({ type: "message_stop" });
};

// LONG: Claude hits max_tokens and, like the real CLI, is told to carry on.
// The bridge must stop it at the first cut.
if (prompt.includes("LONG") && process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
  out({ type: "system", subtype: "init", model: `claude-${model}-test` });
  message("msg_cut", [{ type: "thinking", thinking: "Counting." }, { type: "text", text: `1 2 3 (cap ${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS})` }], "max_tokens", { input_tokens: 3, output_tokens: 40 });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: "Output token limit hit. Resume directly." }] }, parent_tool_use_id: null });
  await new Promise((r) => setTimeout(r, 3000));
  message("msg_more", [{ type: "text", text: "4 5 6 SHOULD_NOT_APPEAR" }], "end_turn", { input_tokens: 3, output_tokens: 40 });
  out({ type: "result", is_error: false, result: "API Error: SHOULD_NOT_APPEAR", usage: { input_tokens: 6, output_tokens: 80 }, modelUsage: {} });
  process.exit(0);
}

// NATIVE_CALL (or CALL_TOOL) with the caller's tools served natively: call the
// first one (NATIVE_TWO: twice), wait on each call's MCP result as the CLI
// does, then answer with the results. Not again once results are in the
// transcript (a run continued from scratch).
if (callerTools && /NATIVE_CALL|CALL_TOOL/.test(prompt) && !prompt.includes("<tool_result")) {
  out({ type: "system", subtype: "init", model: `claude-${model}-test` });
  const name = `mcp__caller__${callerTools[0].name}`;
  const calls = [{ type: "tool_use", id: `toolu_${randomBytes(6).toString("hex")}`, name, input: { city: "Paris" } }];
  if (prompt.includes("NATIVE_TWO")) calls.push({ type: "tool_use", id: `toolu_${randomBytes(6).toString("hex")}`, name, input: { city: "Rome" } });
  const note = `Let me check. instructions=${system.includes("# Tools")}`;
  message("msg_call", [{ type: "thinking", thinking: "Need the weather." }, { type: "text", text: note }, ...calls], "tool_use", { input_tokens: 4, output_tokens: 5 });
  const results = [];
  for (const c of calls) {
    const r = await rpc("tools/call", { name: callerTools[0].name, arguments: c.input, _meta: { "claudecode/toolUseId": c.id } });
    const said = r.content.map((x) => (x.type === "image" ? `[image ${x.mimeType}]` : x.text)).join("") + (r.isError ? " (error)" : "");
    results.push(said);
    out({ type: "user", message: { role: "user", content: [{ tool_use_id: c.id, type: "tool_result", content: r.content }] }, parent_tool_use_id: null });
  }
  const answer = `Weather: ${results.join("; ")}`;
  message("msg_answer", [{ type: "text", text: answer }], "end_turn", { input_tokens: 6, output_tokens: 7 });
  out({ type: "result", is_error: false, result: answer, usage: { input_tokens: 10, output_tokens: 12 }, modelUsage: { [`claude-${model}-test`]: {} }, duration_ms: 1 });
  process.exit(0);
}

// With tools offered (a schema with tool_calls), CALL_TOOL makes it call the
// first tool it's allowed to; otherwise it replies in `content`.
// WRITE_FIRST: Claude writes its answer as text, then calls StructuredOutput
// with only a note pointing at it (WRITE_FIRST_CALL: then calls a tool).
const written = prompt.includes("WRITE_FIRST") ? `Worked it out.\n<answer>42</answer>` : null;
let structured;
if (written && schema?.properties?.tool_calls) {
  const tool = schema.properties.tool_calls.items.anyOf[0].properties.name.const;
  structured = prompt.includes("WRITE_FIRST_CALL")
    ? { type: "tool_calls", content: "", tool_calls: [{ name: tool, arguments: { city: "Paris" } }] }
    : { type: "message", content: "See the answer above." };
} else if (schema?.properties?.tool_calls) {
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
  if (prompt.includes("WEB_SEARCH")) {
    // Claude Code runs its own WebSearch, says what it'll do next, then fetches a page.
    stream({ type: "message_start", message: { id: "msg_search", model: `claude-${model}-test` } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ws", name: "WebSearch", input: {} } });
    for (const piece of ['{"query": "Odda ', 'shops"}']) stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: piece } });
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "message_stop" });
    out({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_ws", type: "tool_result", content: "Links: SECRET_RESULTS" }] }, parent_tool_use_id: null });
    stream({ type: "message_start", message: { id: "msg_fetch", model: `claude-${model}-test` } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the shop's page." } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_wf", name: "WebFetch", input: {} } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"url": "https://example.com/shop", "prompt": "hours"}' } });
    stream({ type: "content_block_stop", index: 1 });
    stream({ type: "message_stop" });
    out({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_wf", type: "tool_result", content: "Open 07-23" }] }, parent_tool_use_id: null });
    stream({ type: "message_start", message: { id: "msg_final", model: `claude-${model}-test` } });
  }
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
if (written) {
  // As the real CLI prints it: the text, then the StructuredOutput call, in one message.
  assistant("msg_final", { type: "thinking", thinking: "Planning the answer." });
  assistant("msg_final", { type: "text", text: written });
  assistant("msg_final", { type: "tool_use", id: "toolu_so", name: "StructuredOutput", input: structured });
}
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
