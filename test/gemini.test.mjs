// Gemini models, through the Antigravity CLI (test/fake-agy.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KEY, PNG, parseSSE, startupMessage, useServer } from "./helpers.mjs";

const LOG = path.join(tmpdir(), `fake-agy-${process.pid}.log`);
writeFileSync(LOG, "");
const { base, post } = useServer(18793, { FAKE_AGY_LOG: LOG });
const chat = (body) => post("/v1/chat/completions", { model: "gemini-9-flash-high", ...body });
const user = (content) => [{ role: "user", content }];
const replyOf = async (r) => (await r.json()).choices[0].message.content;
const lastCall = () => JSON.parse(readFileSync(LOG, "utf8").trim().split("\n").at(-1));
const WEATHER = {
  type: "function",
  function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
};

test("startup message lists the Gemini models, or says how to set them up", async () => {
  assert.match(await startupMessage(18794), /Gemini via the Antigravity CLI: gemini-9-flash-high\n/);
  const signedOut = await startupMessage(18795, { FAKE_AGY_LOGGED_OUT: "1" });
  assert.match(signedOut, /⚠ The Antigravity CLI isn't signed in/);
  const missing = await startupMessage(18796, { AGY_CLI: "/nonexistent/agy" });
  assert.match(missing, /Gemini: optional\. Install the Antigravity CLI/);
  assert.doesNotMatch(missing, /⚠/);
});

test("gemini-* models run agy in a sandbox, with the system prompt in the message", async () => {
  const r = await chat({ messages: [{ role: "system", content: "Be terse." }, ...user("hello")] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, "gemini-9-flash-high");
  assert.match(j.choices[0].message.content, /^echo model=gemini-9-flash-high effort= sandbox=true files=\[\]/);
  assert.deepEqual(j.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 } });

  const { args, prompt } = lastCall();
  assert.ok(args.includes("--disable-slash-commands"));
  assert.match(prompt, /^You are answering as a chat model through an API/);
  assert.match(prompt, /Don't search the web/);
  assert.match(prompt, /<instructions>\nBe terse\.\n<\/instructions>\n\nhello$/);
});

test("model names: gemini-* names go to agy as-is, \"gemini\" lets agy choose, others still go to Claude", async () => {
  assert.match(await replyOf(await chat({ model: "Gemini-9-Flash-High", messages: user("x") })), /model=gemini-9-flash-high /);
  assert.match(await replyOf(await chat({ model: "gemini", messages: user("x") })), /model=gemini-default /);
  assert.ok(!lastCall().args.includes("--model"));
  assert.match(await replyOf(await chat({ model: "gpt-4o-mini", messages: user("x") })), /model=haiku /);
});

test("effort and web search pass through; mcp_servers and max_turns are refused", async () => {
  assert.match(await replyOf(await chat({ reasoning_effort: "high", messages: user("x") })), /effort=high /);
  await chat({ web_search_options: {}, messages: user("x") });
  assert.match(lastCall().prompt, /You may search the web/);
  const mcp = await chat({ messages: user("x"), mcp_servers: [{ name: "a", url: "http://127.0.0.1:1/mcp" }] });
  assert.equal(mcp.status, 400);
  assert.equal((await chat({ messages: user("x"), max_turns: 3 })).status, 400);
});

test("images and PDFs are saved in the request's folder, then removed", async () => {
  const content = await replyOf(
    await chat({
      messages: user([
        { type: "text", text: "compare" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "file", file: { filename: "notes.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
      ]),
    }),
  );
  assert.match(content, /files=\["attachment-1\.png","attachment-2\.pdf"\]/);
  const { prompt } = lastCall();
  assert.match(prompt, /compare\n\[attached: attachment-1\.png\]\n\[attached: attachment-2\.pdf \(notes\.pdf\)\]$/);
  assert.match(prompt, /open them with view_file/);
  const root = path.join(tmpdir(), "cli-bridge-gemini");
  assert.ok(!existsSync(root) || readdirSync(root).length === 0);
});

test("tool calls: Gemini replies with them as JSON, not through StructuredOutput", async () => {
  const j = await (await chat({ messages: user("CALL_TOOL weather?"), tools: [WEATHER] })).json();
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { city: "Paris" });
  const { args, prompt } = lastCall();
  assert.ok(JSON.parse(args[args.indexOf("--json-schema") + 1]).properties.tool_calls);
  assert.match(prompt, /To use them, reply with type "tool_calls"/);
  assert.doesNotMatch(prompt, /StructuredOutput/);
});

test("/ask with a JSON schema, and stats per Gemini model", async () => {
  const j = await (await post("/ask", { prompt: "hi", model: "gemini-9-flash-high", json_schema: { type: "object" } })).json();
  assert.deepEqual(j.reply, { ok: true });
  const stats = await (await fetch(`${base}/stats`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  assert.ok(stats.tokens["gemini-9-flash-high"].requests >= 1);
});

test("streaming: OpenAI chunks and Anthropic events carry Gemini's text", async () => {
  const openai = parseSSE(await (await chat({ stream: true, messages: user("stream me") })).text());
  const text = openai.filter((e) => e.data !== "[DONE]").map((e) => e.data.choices[0]?.delta?.content ?? "").join("");
  assert.match(text, /^echo model=gemini-9-flash-high .*prompt=.*stream me"$/s); // no trailing newline
  assert.equal(openai[0].data.model, "gemini-9-flash-high");
  assert.equal(openai.at(-1).data, "[DONE]");

  const anthropic = parseSSE(
    await (await post("/v1/messages", { model: "gemini-9-flash-high", max_tokens: 100, stream: true, messages: user("stream me") })).text(),
  );
  const deltas = anthropic.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("");
  assert.match(deltas, /stream me"$/);
  assert.equal(anthropic.at(-1).event, "message_stop");
});

test("errors: signed out -> 503, quota -> 429, unknown model -> 400, denied tool -> 502, timeout -> 504", async () => {
  const login = await chat({ messages: user("FAIL_LOGIN") });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error.message, /run `agy` on the host to sign in/);
  const quota = await chat({ messages: user("FAIL_QUOTA") });
  assert.equal(quota.status, 429);
  assert.equal((await quota.json()).error.type, "rate_limit_error");
  const model = await chat({ model: "gemini-nope", messages: user("x") });
  assert.equal(model.status, 400);
  assert.match((await model.json()).error.message, /gemini-nope is not recognized/);
  const denied = await chat({ messages: user("TRY_COMMAND") });
  assert.equal(denied.status, 502);
  assert.match((await denied.json()).error.message, /tried to use RunCommand/);
  assert.equal((await chat({ messages: user("SLOW") })).status, 504);
});

test("streaming: a mid-stream failure ends with an error chunk", async () => {
  const events = parseSSE(await (await chat({ stream: true, messages: user("FAIL_MIDSTREAM") })).text());
  assert.match(events.at(-1).data.error.message, /agy CLI exited without a result/);
});
