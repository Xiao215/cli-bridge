// POST /v1/messages — the Anthropic Messages format, for the Anthropic SDKs and
// tools that take an Anthropic base URL.

import { randomUUID } from "node:crypto";
import { isGemini, runModel } from "./backends.mjs";
import { effortOf, maxTurnsOf, resolveModel, toolServers } from "./claude.mjs";
import { modelOf, outputOf } from "./cli.mjs";
import { documentPart, imagePart, nativeTools, readToolReply, toClaudeInput, toolDef, toolResultsAtEnd } from "./conversation.mjs";
import { anthropicWarnings, maxTokensOf, warn } from "./params.mjs";
import { HttpError, disconnectSignal, eventStream, readJson, sendJson } from "./http.mjs";
import { THINKING_SUMMARIES } from "./config.mjs";
import { SERVER_TOOLS } from "./web-events.mjs";

export async function messages(req, res) {
  const body = await readJson(req);
  const { tools, webSearch } = parseTools(body.tools);
  const convo = {
    system: systemText(body.system),
    turns: parseMessages(body.messages),
    tools,
    toolChoice: parseToolChoice(body.tool_choice),
  };
  const model = resolveModel(body.model);

  let jsonSchema = null;
  const format = body.output_config?.format ?? body.output_format;
  if (format) {
    if (format.type !== "json_schema" || !format.schema) throw new HttpError(400, 'output format must be {"type": "json_schema", "schema": …}');
    jsonSchema = format.schema;
  }
  const gemini = isGemini(model);
  const warnings = anthropicWarnings(body);
  const maxTokens = maxTokensOf(body.max_tokens, { gemini, warnings });
  warn(res, warnings);
  // Your tools go to Claude as real tools when they can (see nativeTools);
  // otherwise they're described in the system prompt.
  const native = nativeTools({ ...convo, replySchema: jsonSchema, gemini });
  // With tools too, the schema is the shape of the final reply, as on the real API.
  const input = toClaudeInput({ ...convo, ...(native ? { tools: [] } : {}), replySchema: jsonSchema, gemini });
  const usingTools = Boolean(input.jsonSchema);
  if (usingTools) jsonSchema = input.jsonSchema;

  const request = {
    system: input.system,
    content: input.content,
    model,
    jsonSchema,
    signal: disconnectSignal(res),
    mcpServers: toolServers(body.mcp_servers),
    maxTurns: maxTurnsOf(body.max_turns),
    effort: effortOf(body.output_config?.effort),
    webSearch,
    maxTokens,
    callerTools: native ? convo.tools : [],
    toolResults: native ? toolResultsAtEnd(convo.turns) : null,
  };
  const contentOf = (result) => {
    if (result.stop === "length") return [{ type: "text", text: result.result ?? "" }];
    const out = outputOf(result);
    if (!usingTools && !result.calls) return [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }];
    const { text, calls } = result.calls ? { text: result.result ?? "", calls: result.calls } : readToolReply(out, "toolu_", result.written);
    return [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
    ];
  };
  const stopReason = (content, result) =>
    result.stop === "length" ? "max_tokens" : content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  const id = `msg_${randomUUID().replaceAll("-", "")}`;

  if (!body.stream) {
    const result = await runModel(request);
    const content = contentOf(result);
    return sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model: modelOf(result, model),
      content,
      stop_reason: stopReason(content, result),
      stop_sequence: null,
      usage: anthropicUsage(result),
      ...(result.paused_run ? { paused_run: result.paused_run } : {}),
      ...(warnings.length ? { warnings } : {}),
    });
  }

  // Streaming: the same event sequence the Anthropic API sends.
  const send = eventStream(res);
  const emit = (type, data) => send({ type, ...data }, type);
  let shownModel = model;
  let started = false;
  let streamedText = false;
  let index = 0;
  let textOpen = false;
  const start = () => {
    if (started) return;
    started = true;
    emit("message_start", {
      message: { id, type: "message", role: "assistant", model: shownModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  };
  const text = (t) => {
    start();
    if (!textOpen) {
      textOpen = true;
      emit("content_block_start", { index, content_block: { type: "text", text: "" } });
    }
    emit("content_block_delta", { index, delta: { type: "text_delta", text: t } });
  };
  const closeText = () => {
    if (!textOpen) return;
    emit("content_block_stop", { index: index++ });
    textOpen = false;
  };
  // Claude Code's thinking summaries and its own web searches and fetches pass through live, as the real API
  // streams thinking blocks and server tool calls, so a caller can show what's happening during a long turn.
  // `open` maps the CLI's block index (it restarts with each message) to the block opened here.
  let open = new Map();
  const searches = new Map(); // WebSearch/WebFetch tool_use id -> { kind: "web_search" | "web_fetch", json: its input so far }
  const openBlock = (cliIndex, block) => {
    closeText();
    start();
    open.set(cliIndex, { index, type: block.type });
    emit("content_block_start", { index: index++, content_block: block });
  };
  const passThrough = (event) => {
    const e = event.event;
    if (e?.type === "message_start") open = new Map();
    else if (e?.type === "content_block_start") {
      const b = e.content_block;
      if (b?.type === "thinking" && THINKING_SUMMARIES) openBlock(e.index, { type: "thinking", thinking: "", signature: "" });
      else if (b?.type === "tool_use" && SERVER_TOOLS[b.name]) {
        searches.set(b.id, { kind: SERVER_TOOLS[b.name], json: "" });
        openBlock(e.index, { type: "server_tool_use", id: b.id, name: SERVER_TOOLS[b.name], input: {} });
        open.get(e.index).id = b.id;
      }
    } else if (e?.type === "content_block_delta" && open.has(e.index)) {
      const at = open.get(e.index), d = e.delta;
      if (at.type === "thinking" && d?.type === "thinking_delta" && d.thinking) emit("content_block_delta", { index: at.index, delta: { type: "thinking_delta", thinking: d.thinking } });
      else if (at.type === "server_tool_use" && d?.type === "input_json_delta" && d.partial_json) {
        searches.get(at.id).json += d.partial_json;
        emit("content_block_delta", { index: at.index, delta: { type: "input_json_delta", partial_json: d.partial_json } });
      }
    } else if (e?.type === "content_block_stop" && open.has(e.index)) {
      emit("content_block_stop", { index: open.get(e.index).index });
      open.delete(e.index);
    }
  };
  // The search's results stay inside Claude Code; the caller hears only that it finished.
  const searchDone = (event) => {
    for (const r of Array.isArray(event.message?.content) ? event.message.content : []) {
      const call = r?.type === "tool_result" && searches.get(r.tool_use_id);
      if (!call) continue;
      searches.delete(r.tool_use_id);
      closeText();
      start();
      const kind = call.kind;
      let url = "";
      try { url = JSON.parse(call.json).url || ""; } catch { /* input never finished */ }
      const content = kind === "web_search" ? []
        : r.is_error ? { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" }
        : { type: "web_fetch_result", url, content: { type: "document", source: { type: "text", media_type: "text/plain", data: "" } } };
      emit("content_block_start", { index, content_block: { type: `${kind}_tool_result`, tool_use_id: r.tool_use_id, content } });
      emit("content_block_stop", { index: index++ });
    }
  };

  let result;
  try {
    result = await runModel({
      ...request,
      onEvent: (event) => {
        if (event.type === "system" && event.subtype === "init" && event.model) shownModel = event.model;
        // Top-level text, thinking and web searches; never a sub-agent's output.
        if (jsonSchema || event.parent_tool_use_id) return;
        if (event.type === "user") return searchDone(event);
        if (event.type !== "stream_event") return;
        passThrough(event);
        const delta = event.event?.delta;
        if (event.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
          streamedText = true;
          text(delta.text);
        }
      },
    });
  } catch (e) {
    if (!res.headersSent) throw e;
    if (e.status !== 499) emit("error", { error: { type: anthropicErrorType(e.type), message: e.message } });
    return res.end();
  }

  start();
  const content = contentOf(result);
  for (const block of content) {
    if (block.type === "text") {
      if (!streamedText && block.text) text(block.text);
      continue;
    }
    closeText();
    emit("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    emit("content_block_stop", { index: index++ });
  }
  closeText();
  const usage = anthropicUsage(result);
  emit("message_delta", {
    delta: { stop_reason: stopReason(content, result), stop_sequence: null },
    usage,
    ...(result.paused_run ? { paused_run: result.paused_run } : {}),
  });
  emit("message_stop", {});
  res.end();
}

function anthropicUsage(result) {
  const u = result.usage || {};
  return {
    input_tokens: u.input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
  };
}

export function anthropicErrorType(type) {
  const known = ["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error"];
  return known.includes(type) ? type : "api_error";
}

// --- parsing ----------------------------------------------------------------------

function systemText(system) {
  if (system == null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (b?.type === "text" ? b.text : "")).join("\n\n");
  throw new HttpError(400, "`system` must be a string or an array of text blocks");
}

function parseMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array");
  }
  return messages.map((m) => {
    if (m?.role !== "user" && m?.role !== "assistant") throw new HttpError(400, `Unsupported role "${m?.role}"`);
    return { role: m.role, parts: blocks(m.content) };
  });
}

function blocks(content, { inToolResult = false } = {}) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content == null && inToolResult) return [];
  if (!Array.isArray(content)) throw new HttpError(400, "Message content must be a string or an array of blocks");
  return content.flatMap((b) => {
    switch (b?.type) {
      case "text":
        return [{ type: "text", text: b.text ?? "" }];
      case "image":
        if (b.source?.type !== "base64") throw new HttpError(400, "Images must be base64 sources; image URLs aren't fetched");
        return [imagePart(b.source.media_type, b.source.data)];
      case "document":
        if (b.source?.type !== "base64") throw new HttpError(400, "Documents must be base64 PDF sources");
        return [documentPart(b.source.media_type, b.source.data, b.title)];
      case "thinking":
      case "redacted_thinking":
        return []; // earlier reasoning; not needed to continue
      case "server_tool_use":
      case "web_search_tool_result":
      case "web_fetch_tool_result":
        return []; // a web search Claude Code ran itself (streamed back to the caller); what it found is in the text
      case "tool_use":
        if (inToolResult) break;
        return [{ type: "tool_call", id: b.id, name: b.name, input: b.input }];
      case "tool_result":
        if (inToolResult) break;
        return [{ type: "tool_result", id: b.tool_use_id, is_error: Boolean(b.is_error), parts: blocks(b.content, { inToolResult: true }) }];
    }
    throw new HttpError(400, `Unsupported content block "${b?.type}"`);
  });
}

// Your own tools, and whether Anthropic's web search or web fetch server tool
// was asked for: those run inside Claude Code (WebSearch, WebFetch) for this
// request, as they run on Anthropic's side on the real API.
function parseTools(tools) {
  if (tools == null) return { tools: [], webSearch: false };
  if (!Array.isArray(tools)) throw new HttpError(400, "`tools` must be an array");
  let webSearch = false;
  const own = [];
  for (const t of tools) {
    if (/^web_(search|fetch)_/.test(t?.type ?? "")) {
      webSearch = true;
      continue;
    }
    if (t?.type && t.type !== "custom") throw new HttpError(400, `Server tool "${t.type}" isn't supported — only your own tools, web_search and web_fetch`);
    own.push(toolDef(t?.name, t?.description, t?.input_schema));
  }
  return { tools: own, webSearch };
}

function parseToolChoice(choice) {
  const parallel = choice?.disable_parallel_tool_use ? false : undefined;
  switch (choice?.type) {
    case undefined:
    case "auto":
      return { mode: "auto", parallel };
    case "any":
      return { mode: "required", parallel };
    case "tool":
      return { mode: "required", name: choice.name, parallel };
    case "none":
      return { mode: "none" };
  }
  throw new HttpError(400, 'tool_choice.type must be "auto", "any", "tool" or "none"');
}
