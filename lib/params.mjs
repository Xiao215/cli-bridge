// Request settings the CLIs can and can't apply.
//
// max_tokens is applied for Claude (see runClaude). Sampling settings are not:
// neither CLI has a way to set them. A request that sets one to anything but
// the value that applies anyway still runs, but gets a warning for each, in a
// `Warning` header, a `warnings` list in the reply and the service's log, so
// it's never silently different from what was asked.

import { HttpError } from "./http.mjs";

export function maxTokensOf(value, { gemini, warnings }) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "max_tokens must be a positive integer");
  if (gemini) {
    warnings.push("max_tokens isn't supported with Gemini models; the reply is not capped");
    return null;
  }
  return n;
}

const ignored = (name, value, why = "the CLI has no setting for it") =>
  `${name}=${JSON.stringify(value)} was ignored: ${why}`;

// OpenAI chat completions.
export function openAIWarnings(body) {
  const w = [];
  if (body.temperature != null && body.temperature !== 1) w.push(ignored("temperature", body.temperature, "the model runs at its default"));
  if (body.top_p != null && body.top_p !== 1) w.push(ignored("top_p", body.top_p));
  const stop = body.stop;
  if (stop != null && !(Array.isArray(stop) && stop.length === 0)) w.push(ignored("stop", stop));
  if (body.seed != null) w.push(ignored("seed", body.seed));
  if (body.presence_penalty) w.push(ignored("presence_penalty", body.presence_penalty));
  if (body.frequency_penalty) w.push(ignored("frequency_penalty", body.frequency_penalty));
  if (body.logit_bias && Object.keys(body.logit_bias).length) w.push(ignored("logit_bias", body.logit_bias));
  if (body.logprobs) w.push(ignored("logprobs", body.logprobs, "log probabilities aren't available"));
  if (body.top_logprobs != null) w.push(ignored("top_logprobs", body.top_logprobs, "log probabilities aren't available"));
  if (body.n != null && body.n !== 1) w.push(ignored("n", body.n, "only one choice is returned"));
  return w;
}

// Anthropic messages.
export function anthropicWarnings(body) {
  const w = [];
  if (body.temperature != null && body.temperature !== 1) w.push(ignored("temperature", body.temperature, "the model runs at its default"));
  if (body.top_p != null) w.push(ignored("top_p", body.top_p));
  if (body.top_k != null) w.push(ignored("top_k", body.top_k));
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) w.push(ignored("stop_sequences", body.stop_sequences));
  if (body.thinking != null) w.push(ignored("thinking", body.thinking, "thinking is up to the CLI; set output_config.effort instead"));
  return w;
}

// Sends the warnings with the response (before its headers go out) and logs them.
export function warn(res, warnings) {
  if (!warnings.length) return;
  for (const w of warnings) console.warn(`[warning] ${w}`);
  res.setHeader("Warning", warnings.map((w) => `299 cli-bridge "${w.replaceAll('"', "'")}"`));
}
