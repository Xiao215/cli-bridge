// A reply made of several text blocks comes back whole, in every format; the
// CLI's own `result` is only the last block. Thinking goes beside it, never in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSE, useServer } from "./helpers.mjs";

const { post } = useServer(18797);
const noThinking = useServer(18798, { THINKING_SUMMARIES: "0" });
const user = (content) => [{ role: "user", content }];

const FULL = /^Part one\. echo .*prompt="MULTI_BLOCK"\n<answer>A<\/answer>\n\nClosing note\.$/s;
const REASONING = "Weighing the options.\n\nChecking once more.";

test("chat completions: every text block of the final reply, in order", async () => {
  const j = await (await post("/v1/chat/completions", { messages: user("MULTI_BLOCK") })).json();
  const { message, finish_reason } = j.choices[0];
  assert.match(message.content, FULL);
  // Not an earlier turn, a sub-agent, or thinking.
  assert.doesNotMatch(message.content, /EARLIER_TURN|SUBAGENT|Weighing|Checking once/);
  assert.equal(message.reasoning_content, REASONING);
  assert.equal(finish_reason, "stop");
  assert.deepEqual(j.usage, { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } });
});

test("chat completions, streaming: the same text and reasoning as without streaming", async () => {
  const r = await post("/v1/chat/completions", { stream: true, messages: user("MULTI_BLOCK") });
  const chunks = parseSSE(await r.text()).map((e) => e.data).slice(0, -1);
  const join = (field) => chunks.map((c) => c.choices[0]?.delta?.[field] ?? "").join("");
  assert.match(join("content"), FULL);
  assert.equal(join("reasoning_content"), REASONING);
  assert.doesNotMatch(join("content"), /SUBAGENT|Weighing/);
});

test("Anthropic messages and /ask return the whole reply too", async () => {
  const m = await (await post("/v1/messages", { max_tokens: 100, messages: user("MULTI_BLOCK") })).json();
  assert.equal(m.content.length, 1);
  assert.match(m.content[0].text, FULL);
  const a = await (await post("/ask", { prompt: "MULTI_BLOCK" })).json();
  assert.match(a.reply, FULL);
});

test("thinking summaries are asked for by default", async () => {
  const j = await (await post("/v1/chat/completions", { messages: user("hi") })).json();
  assert.match(j.choices[0].message.content, /thinking_display=summarized/);
  assert.equal(j.choices[0].message.reasoning_content, "hmm");
});

test("THINKING_SUMMARIES=0: no thinking flag, the reply still whole", async () => {
  const j = await (await noThinking.post("/v1/chat/completions", { messages: user("MULTI_BLOCK") })).json();
  assert.match(j.choices[0].message.content, FULL);
  assert.match(j.choices[0].message.content, /thinking_display= /);
});

// With tools offered, Claude answers through StructuredOutput. When it writes
// its answer as text first and passes only a note in content, the text is
// still the reply: before the note, never dropped.
const WEATHER = {
  type: "function",
  function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
};
const WRITTEN = "Worked it out.\n<answer>42</answer>\n\nSee the answer above.";

test("tools: text written before StructuredOutput is part of the reply", async () => {
  const j = await (await post("/v1/chat/completions", { messages: user("WRITE_FIRST"), tools: [WEATHER] })).json();
  const { message, finish_reason } = j.choices[0];
  assert.equal(message.content, WRITTEN);
  assert.equal(message.reasoning_content, "Planning the answer.");
  assert.equal(finish_reason, "stop");
  const r = await post("/v1/chat/completions", { stream: true, messages: user("WRITE_FIRST"), tools: [WEATHER] });
  const chunks = parseSSE(await r.text()).map((e) => e.data).slice(0, -1);
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join(""), WRITTEN);
  const m = await (await post("/v1/messages", { max_tokens: 100, messages: user("WRITE_FIRST"), tools: [{ name: "get_weather", input_schema: { type: "object" } }] })).json();
  assert.deepEqual(m.content, [{ type: "text", text: WRITTEN }]);
});

test("tools: text written before a tool call comes back beside the call", async () => {
  const j = await (await post("/v1/chat/completions", { messages: user("WRITE_FIRST_CALL"), tools: [WEATHER] })).json();
  const { message, finish_reason } = j.choices[0];
  assert.equal(message.content, "Worked it out.\n<answer>42</answer>");
  assert.equal(message.tool_calls[0].function.name, "get_weather");
  assert.equal(finish_reason, "tool_calls");
});

test("tools: Claude is told only StructuredOutput reaches the caller, content whole", async () => {
  const j = await (await post("/v1/chat/completions", { messages: user("hi"), tools: [WEATHER] })).json();
  const system = j.choices[0].message.content;
  assert.match(system, /Only what you pass to StructuredOutput reaches the caller\./);
  assert.match(system, /never a note pointing to text written elsewhere/);
});
