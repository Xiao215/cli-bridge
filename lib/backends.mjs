// Which CLI answers a request: Gemini models go to the Antigravity CLI,
// everything else to Claude Code.

import { runClaude } from "./claude.mjs";
import { runGemini } from "./gemini.mjs";

export function isGemini(model) {
  return /^gemini(-|$)/.test(model);
}

export function runModel(request) {
  return isGemini(request.model) ? runGemini(request) : runClaude(request);
}
