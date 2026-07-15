#!/usr/bin/env node
/**
 * detect-test.mjs — smoke tests for the structured API-error detection logic.
 *
 * These mirror the pure helpers in extensions/provider/index.ts so we can
 * validate detection against realistic gateway payloads without a live API.
 * Keep this in sync when the detectors change.
 *
 *   node scripts/detect-test.mjs
 */

function parseApiError(body) {
  const trimmed = body.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  let json;
  try { json = JSON.parse(trimmed); } catch { return undefined; }
  const root = (json && typeof json === "object") ? json : undefined;
  if (!root) return undefined;
  const err = root.error;
  const asString = (v) => (typeof v === "string" && v ? v : undefined);
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object") {
    const e = err;
    return {
      message: asString(e.message) ?? asString(root.message) ?? "",
      type: asString(e.type), param: asString(e.param), code: asString(e.code),
    };
  }
  const topMessage = asString(root.message) ?? asString(root.detail);
  if (topMessage || asString(root.code)) {
    return { message: topMessage ?? "", code: asString(root.code), param: asString(root.param), type: asString(root.type) };
  }
  return undefined;
}
const UNSUPPORTED_PARAM_CODES = new Set(["unknown_parameter","unsupported_parameter","unsupported_value","invalid_parameter","parameter_not_supported","extra_forbidden"]);
function paramMatches(param, target) {
  if (!param) return false;
  const p = param.toLowerCase(), t = target.toLowerCase();
  const lastSegment = p.split(/[.\[\]]+/).filter(Boolean).pop();
  return p === t || lastSegment === t;
}
function regexUnsupportedParam(body, param) {
  const lower = body.toLowerCase(), p = param.toLowerCase();
  if (!lower.includes(p)) return false;
  return (/unknown|unsupported|unrecognized|invalid|not (?:be )?supported|extra fields? not permitted|unexpected|does not support|not allowed/.test(lower) || /"param"\s*:\s*"[^"]*"/.test(lower));
}
function looksLikeUnsupportedParam(outcome, param) {
  const body = typeof outcome === "string" ? outcome : outcome.body;
  const err = typeof outcome === "string" ? parseApiError(outcome) : (outcome.error ?? parseApiError(outcome.body));
  if (err) {
    const code = err.code?.toLowerCase();
    if (paramMatches(err.param, param)) {
      if (!code) return true;
      return UNSUPPORTED_PARAM_CODES.has(code) || /unknown|unsupported|invalid|not_?supported|forbidden/.test(code);
    }
    if (code && UNSUPPORTED_PARAM_CODES.has(code) && err.message.toLowerCase().includes(param.toLowerCase())) return true;
  }
  return regexUnsupportedParam(body, param);
}
function looksLikeReasoningError(outcome) {
  const body = typeof outcome === "string" ? outcome : outcome.body;
  if (looksLikeUnsupportedParam(outcome, "reasoning_effort")) return true;
  if (looksLikeUnsupportedParam(outcome, "reasoning")) return true;
  const err = typeof outcome === "string" ? parseApiError(outcome) : (outcome.error ?? parseApiError(outcome.body));
  const text = (err?.message || body).toLowerCase();
  return (/reasoning[_ ]?effort|enable_thinking|thinking/.test(text) && /unknown|unsupported|invalid|not (?:be )?supported|not allowed/.test(text));
}
function looksLikeDeveloperRoleError(outcome) {
  const body = typeof outcome === "string" ? outcome : outcome.body;
  const err = typeof outcome === "string" ? parseApiError(outcome) : (outcome.error ?? parseApiError(outcome.body));
  if (err) {
    if (paramMatches(err.param, "role") || (err.param && err.param.toLowerCase().includes("messages"))) {
      if (err.message.toLowerCase().includes("developer")) return true;
    }
    const m = err.message.toLowerCase();
    if (m.includes("developer") && /role|unsupported|invalid|unknown|not (?:be )?supported/.test(m)) return true;
  }
  const lower = body.toLowerCase();
  return ((lower.includes("developer") && /unknown|unsupported|invalid|not (?:be )?supported|role/.test(lower)) || /invalid.*role|role.*invalid|unsupported.*role/.test(lower));
}

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got=${got} want=${want})`);
  ok ? pass++ : fail++;
}

// OpenAI structured: unknown_parameter on reasoning_effort
const oaReasoning = { body: JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort", type: "invalid_request_error", param: "reasoning_effort", code: "unknown_parameter" } }) };
eq("OpenAI reasoning_effort unsupported", looksLikeUnsupportedParam(oaReasoning, "reasoning_effort"), true);
eq("OpenAI reasoning via reasoning err", looksLikeReasoningError(oaReasoning), true);

// OpenAI structured: max_completion_tokens unsupported
const oaMaxTok = { body: JSON.stringify({ error: { message: "Unsupported parameter: 'max_completion_tokens'", type: "invalid_request_error", param: "max_completion_tokens", code: "unsupported_parameter" } }) };
eq("max_completion_tokens unsupported", looksLikeUnsupportedParam(oaMaxTok, "max_completion_tokens"), true);
eq("store NOT flagged by maxtok err", looksLikeUnsupportedParam(oaMaxTok, "store"), false);

// store param error with path prefix
const storeErr = { body: JSON.stringify({ error: { message: "body.store: extra fields not permitted", param: "body.store", code: "extra_forbidden" } }) };
eq("store via body.store path", looksLikeUnsupportedParam(storeErr, "store"), true);

// stream_options nested
const streamErr = { body: JSON.stringify({ error: { message: "Extra inputs are not permitted", param: "stream_options.include_usage", code: "extra_forbidden" } }) };
eq("stream_options via nested path", looksLikeUnsupportedParam(streamErr, "stream_options"), true);
eq("include_usage via nested path", looksLikeUnsupportedParam(streamErr, "include_usage"), true);

// developer role rejected (structured)
const devErr = { body: JSON.stringify({ error: { message: "Invalid value for 'role': 'developer' is not supported.", param: "messages[0].role", code: "invalid_value" } }) };
eq("developer role structured", looksLikeDeveloperRoleError(devErr), true);

// developer role rejected (plain text gateway)
const devText = { body: "400 Bad Request: the 'developer' role is not supported by this model" };
eq("developer role plaintext", looksLikeDeveloperRoleError(devText), true);

// a SUCCESS body must not be flagged
const okBody = { body: JSON.stringify({ id: "chatcmpl-x", choices: [{ message: { role: "assistant", content: "hi" } }] }) };
eq("success not flagged (reasoning)", looksLikeReasoningError(okBody), false);
eq("success not flagged (store)", looksLikeUnsupportedParam(okBody, "store"), false);
eq("success not flagged (developer)", looksLikeDeveloperRoleError(okBody), false);

// unrelated error (rate limit) must not be mistaken for param unsupported
const rate = { body: JSON.stringify({ error: { message: "Rate limit reached for requests", type: "rate_limit_error", code: "rate_limit_exceeded" } }) };
eq("rate limit not store", looksLikeUnsupportedParam(rate, "store"), false);
eq("rate limit not reasoning", looksLikeReasoningError(rate), false);

// model-not-found must not be treated as reasoning unsupported
const noModel = { body: JSON.stringify({ error: { message: "The model 'foo' does not exist", code: "model_not_found", param: "model" } }) };
eq("model not found not reasoning", looksLikeReasoningError(noModel), false);
eq("model not found not store", looksLikeUnsupportedParam(noModel, "store"), false);

// plaintext reasoning rejection (non-JSON gateway)
const rtext = { body: "Error: parameter reasoning_effort is not supported on this endpoint" };
eq("plaintext reasoning unsupported", looksLikeReasoningError(rtext), true);

// flattened top-level shape
const flat = { body: JSON.stringify({ message: "unknown field: store", code: "unknown_parameter", param: "store" }) };
eq("flattened top-level store", looksLikeUnsupportedParam(flat, "store"), true);

// error.message string form
const strErr = { body: JSON.stringify({ error: "reasoning_effort: unsupported parameter" }) };
eq("error-string reasoning", looksLikeReasoningError(strErr), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
