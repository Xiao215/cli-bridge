// Your tools as real tools: served to Claude over MCP, the run paused on its
// calls and continued with your results. Also max_tokens, and warnings for
// settings that can't be applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSE, useServer } from "./helpers.mjs";

const { base, post } = useServer(18799);
const quick = useServer(18800, { PAUSE_SECONDS: "1" });
const one = useServer(18801, { MAX_PAUSED: "1" });

const WEATHER = {
  type: "function",
  function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
};
const ANTHROPIC_WEATHER = { name: "get_weather", description: "Weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } } } };
const user = (content) => ({ role: "user", content });
const paused = async (url = base) => (await (await fetch(`${url}/health`)).json()).paused;

// The first request of a tool round trip, and the messages to send back with results.
async function call(srv, prompt, extra = {}) {
  const messages = [user(prompt)];
  const j = await (await srv.post("/v1/chat/completions", { messages, tools: [WEATHER], ...extra })).json();
  const message = j.choices[0].message;
  return { j, message, followUp: (...results) => [...messages, message, ...message.tool_calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: results[i] }))] };
}

test("OpenAI: a native tool call pauses the run, and the results continue it", async () => {
  const { j, message, followUp } = await call({ post }, "NATIVE_CALL weather?");
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  // Native: no tool instructions in the system prompt; the reply is Claude's own text.
  assert.equal(message.content, "Let me check. instructions=false");
  assert.equal(message.reasoning_content, "Need the weather.");
  const [c] = message.tool_calls;
  assert.match(c.id, /^toolu_/);
  assert.deepEqual([c.type, c.function.name, JSON.parse(c.function.arguments)], ["function", "get_weather", { city: "Paris" }]);
  assert.deepEqual(j.usage, { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(await paused(), 1);

  const k = await (await post("/v1/chat/completions", { messages: followUp("18C"), tools: [WEATHER] })).json();
  assert.equal(k.choices[0].finish_reason, "stop");
  assert.equal(k.choices[0].message.content, "Weather: 18C");
  // This request's usage only, not the whole process's.
  assert.deepEqual(k.usage, { prompt_tokens: 6, completion_tokens: 7, total_tokens: 13, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(await paused(), 0);
});

test("OpenAI: parallel calls are answered one by one from the results sent together", async () => {
  const { message, followUp } = await call({ post }, "NATIVE_CALL NATIVE_TWO");
  assert.deepEqual(message.tool_calls.map((c) => JSON.parse(c.function.arguments).city), ["Paris", "Rome"]);
  const k = await (await post("/v1/chat/completions", { messages: followUp("18C", "20C"), tools: [WEATHER] })).json();
  assert.equal(k.choices[0].message.content, "Weather: 18C; 20C");
});

test("Anthropic: tool_use blocks, then tool_result (an error too) continues the run", async () => {
  const messages = [user("NATIVE_CALL weather?")];
  const m = await (await post("/v1/messages", { max_tokens: 1000, messages, tools: [ANTHROPIC_WEATHER] })).json();
  assert.equal(m.stop_reason, "tool_use");
  assert.equal(m.content[0].text, "Let me check. instructions=false");
  const use = m.content[1];
  assert.deepEqual([use.type, use.name, use.input], ["tool_use", "get_weather", { city: "Paris" }]);
  const n = await (
    await post("/v1/messages", {
      max_tokens: 1000,
      tools: [ANTHROPIC_WEATHER],
      messages: [...messages, { role: "assistant", content: m.content }, user([{ type: "tool_result", tool_use_id: use.id, is_error: true, content: "no data" }])],
    })
  ).json();
  assert.equal(n.stop_reason, "end_turn");
  assert.deepEqual(n.content, [{ type: "text", text: "Weather: no data (error)" }]);
});

test("streaming: tool calls at the end, then the continuation streams", async () => {
  const messages = [user("NATIVE_CALL")];
  const r = parseSSE(await (await post("/v1/chat/completions", { stream: true, messages, tools: [WEATHER] })).text()).map((e) => e.data).slice(0, -1);
  const call = r.find((c) => c.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.equal(call.function.name, "get_weather");
  assert.equal(r.at(-1).choices[0].finish_reason, "tool_calls");
  const assistant = { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] };
  const s = parseSSE(
    await (await post("/v1/chat/completions", { stream: true, tools: [WEATHER], messages: [...messages, assistant, { role: "tool", tool_call_id: call.id, content: "18C" }] })).text(),
  ).map((e) => e.data).slice(0, -1);
  assert.equal(s.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "Weather: 18C");
  assert.equal(s.at(-1).choices[0].finish_reason, "stop");
});

test("results no paused run is waiting for start over, with the conversation as a transcript", async () => {
  const assistant = { role: "assistant", content: null, tool_calls: [{ id: "toolu_unknown", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] };
  const j = await (
    await post("/v1/chat/completions", { tools: [WEATHER], messages: [user("NATIVE_CALL"), assistant, { role: "tool", tool_call_id: "toolu_unknown", content: "18C" }] })
  ).json();
  assert.equal(j.choices[0].finish_reason, "stop");
  assert.match(j.choices[0].message.content, /<tool_result id=\\"toolu_unknown\\">\\n18C/);
  assert.match(j.choices[0].message.content, /native_tools=\[\{"name":"get_weather"/);
});

test("results sent with different settings start over, and the paused run is stopped", async () => {
  const { followUp } = await call({ post }, "NATIVE_CALL");
  assert.equal(await paused(), 1);
  const k = await (await post("/v1/chat/completions", { messages: followUp("18C"), tools: [WEATHER], reasoning_effort: "high" })).json();
  assert.match(k.choices[0].message.content, /effort=high .*<tool_result/);
  assert.equal(await paused(), 0);
});

test("a paused run that isn't continued in time is stopped; late results start over", async () => {
  const { followUp } = await call(quick, "NATIVE_CALL");
  assert.equal(await paused(quick.base), 1);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await paused(quick.base), 0);
  const k = await (await quick.post("/v1/chat/completions", { messages: followUp("18C"), tools: [WEATHER] })).json();
  assert.match(k.choices[0].message.content, /<tool_result/);
});

test("at most MAX_PAUSED runs wait; the oldest is stopped first", async () => {
  const a = await call(one, "NATIVE_CALL first");
  const b = await call(one, "NATIVE_CALL second");
  assert.equal(await paused(one.base), 1);
  const late = await (await one.post("/v1/chat/completions", { messages: a.followUp("18C"), tools: [WEATHER] })).json();
  assert.match(late.choices[0].message.content, /<tool_result/);
  const kept = await (await one.post("/v1/chat/completions", { messages: b.followUp("20C"), tools: [WEATHER] })).json();
  assert.equal(kept.choices[0].message.content, "Weather: 20C");
});

test("forced tool choice and Gemini keep the described tools", async () => {
  const j = await (await post("/v1/chat/completions", { messages: [user("hi")], tools: [WEATHER], tool_choice: "required" })).json();
  assert.equal(j.choices[0].message.content, "Checking."); // the fake's StructuredOutput call
  assert.equal(j.choices[0].message.tool_calls[0].function.name, "get_weather");
  const p = await (await post("/v1/chat/completions", { messages: [user("hi")], tools: [WEATHER], parallel_tool_calls: false })).json();
  assert.doesNotMatch(p.choices[0].message.content ?? "", /native_tools/);
});

test("the MCP endpoint needs no API key but a live run's token; mcp_servers can't take the name 'caller'", async () => {
  const r = await fetch(`${base}/mcp/${"0".repeat(32)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
  const bad = await post("/v1/chat/completions", { messages: [user("hi")], mcp_servers: [{ name: "caller", url: "http://127.0.0.1:9/mcp" }] });
  assert.equal(bad.status, 400);
});

test("max_tokens caps the reply: stopped at the first cut, finish_reason length", async () => {
  const j = await (await post("/v1/chat/completions", { messages: [user("LONG")], max_tokens: 40 })).json();
  assert.equal(j.choices[0].finish_reason, "length");
  assert.equal(j.choices[0].message.content, "1 2 3 (cap 40)");
  assert.equal(j.choices[0].message.reasoning_content, "Counting.");
  assert.equal(j.usage.completion_tokens, 40);
  // max_completion_tokens wins, as on the API.
  const c = await (await post("/v1/chat/completions", { messages: [user("LONG")], max_tokens: 40, max_completion_tokens: 30 })).json();
  assert.equal(c.choices[0].message.content, "1 2 3 (cap 30)");
  const s = parseSSE(await (await post("/v1/chat/completions", { stream: true, messages: [user("LONG")], max_tokens: 40 })).text()).map((e) => e.data).slice(0, -1);
  assert.equal(s.at(-1).choices[0].finish_reason, "length");
  assert.doesNotMatch(JSON.stringify(s), /SHOULD_NOT_APPEAR/);
  const m = await (await post("/v1/messages", { max_tokens: 40, messages: [user("LONG")] })).json();
  assert.equal(m.stop_reason, "max_tokens");
  assert.deepEqual(m.content, [{ type: "text", text: "1 2 3 (cap 40)" }]);
  const a = await (await post("/ask", { prompt: "LONG", max_tokens: 40 })).json();
  assert.deepEqual([a.reply, a.stop_reason], ["1 2 3 (cap 40)", "length"]);
  assert.equal((await post("/v1/chat/completions", { messages: [user("hi")], max_tokens: 0 })).status, 400);
});

test("settings that can't be applied are warned about, never silently dropped", async () => {
  const r = await post("/v1/chat/completions", { messages: [user("hi")], temperature: 0.2, seed: 7, top_p: 1, n: 1 });
  const j = await r.json();
  assert.deepEqual(j.warnings, [
    "temperature=0.2 was ignored: the model runs at its default",
    "seed=7 was ignored: the CLI has no setting for it",
  ]);
  assert.match(r.headers.get("warning"), /^299 cli-bridge "temperature=0\.2 was ignored.*", 299 cli-bridge "seed=7/);
  // Values that apply anyway: no warning.
  const quiet = await post("/v1/chat/completions", { messages: [user("hi")], temperature: 1, stop: [] });
  assert.equal(quiet.headers.get("warning"), null);
  assert.equal((await quiet.json()).warnings, undefined);
  const m = await (await post("/v1/messages", { max_tokens: 50, messages: [user("hi")], top_k: 5, stop_sequences: ["END"] })).json();
  assert.deepEqual(m.warnings.map((w) => w.split("=")[0]), ["top_k", "stop_sequences"]);
  const g = await (await post("/v1/chat/completions", { model: "gemini", messages: [user("hi")], max_tokens: 10 })).json();
  assert.deepEqual(g.warnings, ["max_tokens isn't supported with Gemini models; the reply is not capped"]);
  // Streaming replies carry them in the header.
  const s = await post("/v1/chat/completions", { stream: true, messages: [user("hi")], seed: 1 });
  assert.match(s.headers.get("warning"), /seed=1/);
  await s.text();
});

