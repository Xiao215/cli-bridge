// Claude Code's own web searches and page reads, followed through its event stream so a
// streamed reply can say what it's doing during a long turn. What they found stays inside
// Claude Code.

// Claude Code's own web tools, named as the Anthropic server tools they stand in for.
export const SERVER_TOOLS = { WebSearch: "web_search", WebFetch: "web_fetch" };

// Calls `started({ id, name, input })` once a search's or fetch's input is complete, and
// `finished({ id, name, failed })` once it returns. Feed it every top-level CLI event.
export function webTools({ started, finished }) {
  let open = new Map(); // the CLI's block index (restarts with each message) -> tool_use id
  const calls = new Map(); // tool_use id -> { name, json: its input so far }
  return (event) => {
    if (event.parent_tool_use_id) return;
    if (event.type === "user") {
      for (const r of Array.isArray(event.message?.content) ? event.message.content : []) {
        const call = r?.type === "tool_result" && calls.get(r.tool_use_id);
        if (!call) continue;
        calls.delete(r.tool_use_id);
        finished({ id: r.tool_use_id, name: call.name, failed: Boolean(r.is_error) });
      }
      return;
    }
    if (event.type !== "stream_event") return;
    const e = event.event;
    if (e?.type === "message_start") open = new Map();
    else if (e?.type === "content_block_start") {
      const b = e.content_block;
      if (b?.type === "tool_use" && SERVER_TOOLS[b.name]) {
        open.set(e.index, b.id);
        calls.set(b.id, { name: SERVER_TOOLS[b.name], json: "" });
      }
    } else if (e?.type === "content_block_delta" && open.has(e.index)) {
      if (e.delta?.type === "input_json_delta" && e.delta.partial_json) calls.get(open.get(e.index)).json += e.delta.partial_json;
    } else if (e?.type === "content_block_stop" && open.has(e.index)) {
      const id = open.get(e.index);
      open.delete(e.index);
      const call = calls.get(id);
      let input = {};
      try { input = JSON.parse(call.json || "{}"); } catch { /* input never finished */ }
      // Only what says which search or page it is: a fetch's prompt is Claude's own working.
      const said = call.name === "web_search" ? { query: String(input.query ?? "") } : { url: String(input.url ?? "") };
      started({ id, name: call.name, input: said });
    }
  };
}
