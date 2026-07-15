/**
 * Provider Management Extension
 *
 * Manage custom providers in ~/.pi/agent/models.json
 *
 * Commands:
 *   /provider add       - Add a new provider (self-check + adaptive compat)
 *   /provider copy      - Copy an existing provider to a new name
 *   /provider edit      - Edit an existing provider (self-check on save)
 *   /provider remove    - Remove an existing provider
 *   /provider test      - Test provider connectivity & performance
 *   /provider check     - Re-probe capabilities and rewrite compat/reasoning
 *   /provider status    - View provider details & refresh
 *   /provider archive   - Move active provider to archivedProviders
 *   /provider archived  - Open archived provider list and reactivate
 *   /provider activate  - Reactivate archived provider
 *
 * Self-check (OpenAI-family): after add/edit save (and via /provider check),
 * probes the endpoint for max tokens field, store, stream usage, developer role,
 * and reasoning_effort. Unsupported features are written as false / stripped so
 * models.json matches what the gateway actually accepts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { enhancedSelect, fuzzyMatch } from "../_shared/enhanced-select";
import { selectActiveEntity, selectArchivedEntity, stripArchived, browseArchived, archiveEntity } from "../_shared/entity-crud";
import { editDraft, field, type EditField } from "../_shared/edit-menu";
import { ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { fetchWithTimeout } from "../_shared/fetch-utils";

// ─── Constants ────────────────────────────────────────────────────────

const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const DEFAULT_USER_AGENT = "MyCustomClient/1.0";
const TEST_MAX_TOKENS = 1;
const STREAM_BUFFER_LIMIT = 500;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 128_000;
const TABLE_WIDTH = 80;
const TABLE_MIN_COL_WIDTH = 28;
const API_KEY_PREVIEW_LENGTH = 8;
const MS_PER_SECOND = 1000;
const CONTEXT_THRESHOLD_THOUSAND = 1_000;
const CONTEXT_THRESHOLD_MILLION = 1_000_000;
const PROVIDER_TEST_FETCH_TIMEOUT_MS = 30 * MS_PER_SECOND;

function withDefaultHeaders(headers?: Record<string, string>): Record<string, string> {
  const merged = { ...(headers ?? {}) };
  const hasUserAgent = Object.keys(merged).some((key) => key.toLowerCase() === "user-agent");
  if (!hasUserAgent) merged["User-Agent"] = DEFAULT_USER_AGENT;
  return merged;
}

const API_TYPES: { value: string; label: string }[] = [
  { value: "openai-completions", label: "Openai-completions (OpenAI 兼容)" },
  { value: "anthropic-messages", label: "Anthropic-messages (Claude 兼容)" },
  { value: "openai-responses", label: "Openai-responses" },
  { value: "google-generative-ai", label: "Google-generative-ai" },
  { value: "mistral-conversations", label: "Mistral-conversations" },
];

const INPUT_TYPES: { value: string[]; label: string }[] = [
  { value: ["text"], label: "Text" },
  { value: ["text", "image"], label: "Text + Image" },
];

// ─── Interfaces ───────────────────────────────────────────────────────

interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface ProviderConfig {
  baseUrl: string;
  api: string;
  apiKey: string;
  headers?: Record<string, string>;
  name?: string;
  compat?: Record<string, boolean | string>;
  models: ModelConfig[];
}

interface ArchivedProviderConfig extends ProviderConfig {
  archivedAt: string;
}

interface ModelsJson {
  providers: Record<string, ProviderConfig>;
  archivedProviders?: Record<string, ArchivedProviderConfig>;
}

interface PerfResult {
  success: boolean;
  message: string;
  availableModels?: string[];
  timing: {
    connectMs: number;
    ttfbMs: number;
    totalMs: number;
  };
}

/** Result of post-add/edit capability probe + adaptive compat rewrite. */
interface AdaptResult {
  ok: boolean;
  message: string;
  changes: string[];
  availableModels?: string[];
}

interface ParsedApiError {
  /** Human-readable error message (from error.message or top-level message). */
  message: string;
  /** OpenAI error type, e.g. "invalid_request_error". */
  type?: string;
  /** Offending parameter path, e.g. "reasoning_effort" or "messages[0].role". */
  param?: string;
  /** Machine code, e.g. "unknown_parameter", "unsupported_value". */
  code?: string;
}

interface ChatProbeOutcome {
  ok: boolean;
  status: number;
  body: string;
  /** True when the request reached the API and auth was accepted (even if params were bad). */
  reachable: boolean;
  /** Structured error parsed from the response body, when available. */
  error?: ParsedApiError;
}

// ─── File I/O ─────────────────────────────────────────────────────────

function readModelsJson(): ModelsJson {
  const data = readJsonSafe<ModelsJson>(MODELS_JSON_PATH, { providers: {}, archivedProviders: {} } as ModelsJson);
  data.providers ??= {};
  data.archivedProviders ??= {};
  return data;
}

// ── File I/O — delegated to _shared/json-io ───────────────────────────

function writeModelsJson(data: ModelsJson): void {
  ensureDir(path.dirname(MODELS_JSON_PATH));
  writeJsonAtomic(MODELS_JSON_PATH, data, { backup: true });
}

/** Deep-clone provider configs without JSON.parse/stringify edge cases. */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Shared remote-model multi-column section used by test/status views. */
function formatRemoteModelsSection(
  remoteModels: string[],
  registeredIds: string[],
  titlePrefix = "Remote models",
): string[] {
  if (remoteModels.length === 0) return [];
  const activeModels = registeredIds.filter((id) => remoteModels.includes(id));
  const otherModels = remoteModels.filter((m) => !registeredIds.includes(m));
  const lines: string[] = [];
  lines.push(`── ${titlePrefix} (${remoteModels.length}) ──`);
  lines.push("");
  const displayItems: string[] = [];
  for (const m of activeModels) displayItems.push(`[*] ${m}`);
  for (const m of otherModels) displayItems.push(`    ${m}`);
  lines.push(...buildMultiColumnTable(displayItems, TABLE_WIDTH, TABLE_MIN_COL_WIDTH));
  lines.push("");
  lines.push("[*] = currently registered");
  return lines;
}

function resolveApiKey(key: string): string {
  if (key.startsWith("$")) {
    const envVar = key.slice(1);
    return process.env[envVar] ?? key;
  }
  return key;
}

// ─── Formatting helpers ───────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < MS_PER_SECOND) return `${Math.round(ms)}ms`;
  return `${(ms / MS_PER_SECOND).toFixed(2)}s`;
}

function padRight(s: string, width: number): string {
  const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, width - visibleLen));
}

function buildMultiColumnTable(
  items: string[],
  containerWidth: number,
  minColWidth: number
): string[] {
  if (items.length === 0) return [];
  const maxLen = Math.max(...items.map((s) => s.length));
  const colWidth = Math.max(minColWidth, maxLen + 4);
  const cols = Math.max(1, Math.floor(containerWidth / colWidth));
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += cols) {
    const rowItems = items.slice(i, i + cols);
    rows.push(rowItems.map((item) => padRight(item, colWidth)).join(""));
  }
  return rows;
}

// ─── Performance test ─────────────────────────────────────────────────

async function testProviderPerformance(
  baseUrl: string,
  apiKey: string,
  api: string,
  models: ModelConfig[],
  headers?: Record<string, string>
): Promise<PerfResult> {
  const resolvedKey = resolveApiKey(apiKey);
  const requestHeaders = withDefaultHeaders(headers);
  const cleanBase = baseUrl.replace(/\/$/, "");
  const initStart = performance.now();

  try {
    if (api === "anthropic-messages") {
      // ── Anthropic: connectivity test ──
      const connectStart = performance.now();
      const resp = await fetchWithTimeout(`${cleanBase}/messages`, {
        method: "POST",
        headers: {
          ...requestHeaders,
          "x-api-key": resolvedKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: models[0]?.id ?? "claude-3-haiku-20240307",
          max_tokens: TEST_MAX_TOKENS,
          messages: [{ role: "user", content: "hi" }],
        }),
      }, PROVIDER_TEST_FETCH_TIMEOUT_MS);
      const ttfb = performance.now() - connectStart;

      if (resp.status === 401) {
        return {
          success: false,
          message: "Invalid API key",
          timing: { connectMs: ttfb, ttfbMs: ttfb, totalMs: ttfb },
        };
      }

      // ── Anthropic: latency test (models endpoint) ──
      let latencyMs = ttfb;
      try {
        const latStart = performance.now();
        await fetchWithTimeout(`${cleanBase}/models`, {
          method: "GET",
          headers: {
            ...requestHeaders,
            "x-api-key": resolvedKey,
            "anthropic-version": "2023-06-01",
          },
        }, PROVIDER_TEST_FETCH_TIMEOUT_MS);
        latencyMs = performance.now() - latStart;
      } catch (_error) {
        latencyMs = ttfb;
      }

      return {
        success: true,
        message: "Connection successful (Anthropic API)",
        timing: { connectMs: ttfb, ttfbMs: ttfb, totalMs: latencyMs },
      };
    } else {
      // ── OpenAI-compatible: latency + TTFT via streaming ──
      const reqStart = performance.now();
      const resp = await fetchWithTimeout(`${cleanBase}/chat/completions`, {
        method: "POST",
        headers: {
          ...requestHeaders,
          Authorization: `Bearer ${resolvedKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: models[0]?.id ?? "gpt-3.5-turbo",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: TEST_MAX_TOKENS,
          stream: true,
        }),
      }, PROVIDER_TEST_FETCH_TIMEOUT_MS);

      if (resp.status === 401) {
        const elapsed = performance.now() - reqStart;
        return {
          success: false,
          message: "Invalid API key",
          timing: { connectMs: elapsed, ttfbMs: elapsed, totalMs: elapsed },
        };
      }

      const connectMs = performance.now() - reqStart;
      let ttfbMs = connectMs;

      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let firstChunk = true;
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstChunk) {
              ttfbMs = performance.now() - reqStart;
              firstChunk = false;
            }
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > STREAM_BUFFER_LIMIT) break; // enough data
          }
          reader.cancel();
        } catch (_error) {
          reader.cancel().catch(() => undefined);
        }
      }

      const totalMs = performance.now() - reqStart;

      // ── Fetch available models ──
      let availableModels: string[] | undefined;
      try {
        const modelsResp = await fetchWithTimeout(`${cleanBase}/models`, {
          headers: { ...requestHeaders, Authorization: `Bearer ${resolvedKey}` },
        }, PROVIDER_TEST_FETCH_TIMEOUT_MS);
        if (modelsResp.ok) {
          const data = (await modelsResp.json()) as { data?: Array<{ id: string }> };
          availableModels = data.data?.map((m) => m.id);
        }
      } catch (_error) {
        // Model listing is optional for connection tests.
      }

      return {
        success: true,
        message: "Connection successful",
        availableModels,
        timing: {
          connectMs: Math.round(connectMs),
          ttfbMs: Math.round(ttfbMs),
          totalMs: Math.round(totalMs),
        },
      };
    }
  } catch (error) {
    const elapsed = performance.now() - initStart;
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      timing: { connectMs: elapsed, ttfbMs: elapsed, totalMs: elapsed },
    };
  }
}

// ─── Capability self-check + adaptive compat ──────────────────────────

const DEFAULT_THINKING_LEVEL_MAP: Record<string, string | null> = {
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "max",
};

function isOpenAiFamily(api: string): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

/**
 * Parse an OpenAI-style error body into structured fields.
 *
 * Handles the common shapes:
 *   { "error": { "message", "type", "param", "code" } }
 *   { "error": "string message" }
 *   { "message": "...", "code": "..." }
 * Returns undefined when the body is not JSON or has no recognizable error.
 */
function parseApiError(body: string): ParsedApiError | undefined {
  const trimmed = body.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const root = (json && typeof json === "object") ? json as Record<string, unknown> : undefined;
  if (!root) return undefined;

  const err = root.error;
  const asString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

  if (typeof err === "string") {
    return { message: err };
  }
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      message: asString(e.message) ?? asString(root.message) ?? "",
      type: asString(e.type),
      param: asString(e.param),
      code: asString(e.code),
    };
  }
  // Fallback: top-level message/code (some gateways flatten the shape).
  const topMessage = asString(root.message) ?? asString(root.detail);
  if (topMessage || asString(root.code)) {
    return {
      message: topMessage ?? "",
      code: asString(root.code),
      param: asString(root.param),
      type: asString(root.type),
    };
  }
  return undefined;
}

/** Machine codes that reliably mean "this parameter is not accepted". */
const UNSUPPORTED_PARAM_CODES = new Set([
  "unknown_parameter",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_parameter",
  "parameter_not_supported",
  "extra_forbidden",
]);

/** Normalize a param path for loose comparison ("body.reasoning_effort" ~ "reasoning_effort"). */
function paramMatches(param: string | undefined, target: string): boolean {
  if (!param) return false;
  const p = param.toLowerCase();
  const t = target.toLowerCase();
  // Match the last path segment: "reasoning_effort", "body.reasoning_effort",
  // "messages[0].role", etc. Split on . [ ] and compare the final token.
  const lastSegment = p.split(/[.\[\]]+/).filter(Boolean).pop();
  return p === t || lastSegment === t;
}

/**
 * Decide whether a probe failure means `param` is unsupported.
 *
 * Priority:
 *   1. Structured error.param + a known unsupported code → definitive.
 *   2. Structured error.param matches target (any code) → likely.
 *   3. Text regex over the message → best-effort fallback.
 */
function looksLikeUnsupportedParam(outcome: ChatProbeOutcome | string, param: string): boolean {
  const body = typeof outcome === "string" ? outcome : outcome.body;
  const err = typeof outcome === "string" ? parseApiError(outcome) : (outcome.error ?? parseApiError(outcome.body));

  if (err) {
    const code = err.code?.toLowerCase();
    // 1) param explicitly named
    if (paramMatches(err.param, param)) {
      if (!code) return true;
      return UNSUPPORTED_PARAM_CODES.has(code) || /unknown|unsupported|invalid|not_?supported|forbidden/.test(code);
    }
    // 2) code says a param is unsupported and the message names it
    if (code && UNSUPPORTED_PARAM_CODES.has(code) && err.message.toLowerCase().includes(param.toLowerCase())) {
      return true;
    }
    // 3) message-only structured error: fall through to regex over the message
  }

  return regexUnsupportedParam(body, param);
}

/** Text-only fallback for providers that return non-structured errors. */
function regexUnsupportedParam(body: string, param: string): boolean {
  const lower = body.toLowerCase();
  const p = param.toLowerCase();
  if (!lower.includes(p)) return false;
  return (
    /unknown|unsupported|unrecognized|invalid|not (?:be )?supported|extra fields? not permitted|unexpected|does not support|not allowed/.test(lower)
    || /"param"\s*:\s*"[^"]*"/.test(lower)
  );
}

function looksLikeDeveloperRoleError(outcome: ChatProbeOutcome | string): boolean {
  const body = typeof outcome === "string" ? outcome : outcome.body;
  const err = typeof outcome === "string" ? parseApiError(outcome) : (outcome.error ?? parseApiError(outcome.body));

  if (err) {
    // Structured: param points at a message role, or message clearly rejects the developer role.
    if (paramMatches(err.param, "role") || (err.param && err.param.toLowerCase().includes("messages"))) {
      if (err.message.toLowerCase().includes("developer")) return true;
    }
    const m = err.message.toLowerCase();
    if (m.includes("developer") && /role|unsupported|invalid|unknown|not (?:be )?supported/.test(m)) return true;
  }

  const lower = body.toLowerCase();
  return (
    (lower.includes("developer") && /unknown|unsupported|invalid|not (?:be )?supported|role/.test(lower))
    || /invalid.*role|role.*invalid|unsupported.*role/.test(lower)
  );
}

function looksLikeReasoningError(outcome: ChatProbeOutcome | string): boolean {
  const body = typeof outcome === "string" ? outcome : outcome.body;
  if (looksLikeUnsupportedParam(outcome, "reasoning_effort")) return true;
  if (looksLikeUnsupportedParam(outcome, "reasoning")) return true;

  const err = typeof outcome === "string" ? parseApiError(outcome) : (outcome.error ?? parseApiError(outcome.body));
  const text = (err?.message || body).toLowerCase();
  return (
    /reasoning[_ ]?effort|enable_thinking|thinking/.test(text)
    && /unknown|unsupported|invalid|not (?:be )?supported|not allowed/.test(text)
  );
}

async function readResponseBody(resp: Response, limit = 2000): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

async function probeOpenAiChat(
  cleanBase: string,
  resolvedKey: string,
  requestHeaders: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ChatProbeOutcome> {
  try {
    const resp = await fetchWithTimeout(`${cleanBase}/chat/completions`, {
      method: "POST",
      headers: {
        ...requestHeaders,
        Authorization: `Bearer ${resolvedKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, PROVIDER_TEST_FETCH_TIMEOUT_MS);
    const text = await readResponseBody(resp);
    // 401/403 = auth, not capability. 2xx / 4xx param errors are useful.
    const reachable = resp.status !== 401 && resp.status !== 403;
    return {
      ok: resp.ok,
      status: resp.status,
      body: text,
      reachable,
      error: resp.ok ? undefined : parseApiError(text),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      reachable: false,
    };
  }
}

function baseChatBody(modelId: string, maxTokensField: "max_completion_tokens" | "max_tokens"): Record<string, unknown> {
  return {
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    [maxTokensField]: TEST_MAX_TOKENS,
    stream: false,
  };
}

/**
 * Probe an OpenAI-compatible provider and rewrite compat/model flags so the
 * written config matches what the endpoint actually accepts.
 *
 * Detects: max tokens field, store, stream usage, developer role,
 * reasoning_effort / reasoning content requirements.
 */
async function selfCheckAndAdaptProvider(
  provider: ProviderConfig,
  preferredReasoning?: boolean,
): Promise<AdaptResult> {
  const changes: string[] = [];
  const modelId = provider.models[0]?.id;
  if (!modelId) {
    return { ok: false, message: "No model id to probe", changes };
  }

  // Anthropic / Google / Mistral: only connectivity is checked today.
  if (!isOpenAiFamily(provider.api)) {
    const perf = await testProviderPerformance(
      provider.baseUrl,
      provider.apiKey,
      provider.api,
      provider.models,
      provider.headers,
    );
    return {
      ok: perf.success,
      message: perf.success
        ? `Connectivity OK (${provider.api}); detailed compat probe is OpenAI-family only`
        : perf.message,
      changes,
      availableModels: perf.availableModels,
    };
  }

  const resolvedKey = resolveApiKey(provider.apiKey);
  const requestHeaders = withDefaultHeaders(provider.headers);
  const cleanBase = provider.baseUrl.replace(/\/$/, "");
  const wantReasoning = preferredReasoning !== undefined
    ? preferredReasoning
    : provider.models.some((m) => m.reasoning);

  // Start from a conservative baseline, then enable features we can prove work.
  let maxTokensField: "max_completion_tokens" | "max_tokens" = "max_completion_tokens";
  let supportsStore = false;
  let supportsDeveloperRole = false;
  let supportsUsageInStreaming = true;
  let supportsReasoningEffort = false;
  let requiresReasoningContent = false;
  let reasoningOk = false;

  // 1) Baseline chat — try max_completion_tokens first, fall back to max_tokens.
  let baseline = await probeOpenAiChat(
    cleanBase, resolvedKey, requestHeaders, baseChatBody(modelId, "max_completion_tokens"),
  );
  if (!baseline.reachable) {
    return {
      ok: false,
      message: baseline.status === 401 || baseline.status === 403
        ? `Auth failed (HTTP ${baseline.status})`
        : `Unreachable: ${baseline.body || `HTTP ${baseline.status}`}`,
      changes,
    };
  }
  if (!baseline.ok) {
    if (looksLikeUnsupportedParam(baseline, "max_completion_tokens")) {
      maxTokensField = "max_tokens";
      changes.push('maxTokensField → "max_tokens" (max_completion_tokens rejected)');
      baseline = await probeOpenAiChat(
        cleanBase, resolvedKey, requestHeaders, baseChatBody(modelId, "max_tokens"),
      );
    }
  }
  if (!baseline.ok && baseline.reachable) {
    // Still failing with a basic body — surface the error; keep probing best-effort.
    changes.push(`baseline chat failed HTTP ${baseline.status}: ${baseline.body.slice(0, 160)}`);
  }

  // 2) store field
  {
    const body = { ...baseChatBody(modelId, maxTokensField), store: false };
    const r = await probeOpenAiChat(cleanBase, resolvedKey, requestHeaders, body);
    if (r.ok) {
      supportsStore = true;
      changes.push("supportsStore → true");
    } else if (r.reachable && looksLikeUnsupportedParam(r, "store")) {
      supportsStore = false;
    }
  }

  // 3) stream_options.include_usage
  {
    const body = {
      ...baseChatBody(modelId, maxTokensField),
      stream: true,
      stream_options: { include_usage: true },
    };
    const r = await probeOpenAiChat(cleanBase, resolvedKey, requestHeaders, body);
    if (r.ok) {
      supportsUsageInStreaming = true;
    } else if (r.reachable && (
      looksLikeUnsupportedParam(r, "stream_options")
      || looksLikeUnsupportedParam(r, "include_usage")
    )) {
      supportsUsageInStreaming = false;
      changes.push("supportsUsageInStreaming → false");
    }
  }

  // 4) developer role (only relevant when reasoning is desired / system-ish roles matter)
  {
    const body = {
      ...baseChatBody(modelId, maxTokensField),
      messages: [
        { role: "developer", content: "You are a test." },
        { role: "user", content: "hi" },
      ],
    };
    const r = await probeOpenAiChat(cleanBase, resolvedKey, requestHeaders, body);
    if (r.ok) {
      supportsDeveloperRole = true;
      changes.push("supportsDeveloperRole → true");
    } else if (r.reachable && looksLikeDeveloperRoleError(r)) {
      supportsDeveloperRole = false;
    }
  }

  // 5) reasoning_effort
  if (wantReasoning) {
    const body = {
      ...baseChatBody(modelId, maxTokensField),
      reasoning_effort: "low",
    };
    const r = await probeOpenAiChat(cleanBase, resolvedKey, requestHeaders, body);
    if (r.ok) {
      supportsReasoningEffort = true;
      reasoningOk = true;
      changes.push("supportsReasoningEffort → true (reasoning_effort accepted)");
    } else if (r.reachable && looksLikeReasoningError(r)) {
      supportsReasoningEffort = false;
      reasoningOk = false;
      changes.push("supportsReasoningEffort → false (reasoning_effort rejected)");
    } else if (r.ok === false && r.reachable) {
      // Ambiguous failure — treat as unsupported to keep config safe.
      supportsReasoningEffort = false;
      reasoningOk = false;
      changes.push(`supportsReasoningEffort → false (probe HTTP ${r.status})`);
    }
  } else {
    supportsReasoningEffort = false;
    reasoningOk = false;
    changes.push("reasoning disabled by preference / model flag");
  }

  // 6) reasoning_content on assistant (only if reasoning stays on)
  if (reasoningOk) {
    const body = {
      ...baseChatBody(modelId, maxTokensField),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning_content: "" },
        { role: "user", content: "ok" },
      ],
    };
    const r = await probeOpenAiChat(cleanBase, resolvedKey, requestHeaders, body);
    if (r.ok) {
      // Accepted empty reasoning_content — many gateways that need it on replay also accept it.
      requiresReasoningContent = true;
      changes.push("requiresReasoningContentOnAssistantMessages → true");
    } else if (r.reachable && looksLikeUnsupportedParam(r, "reasoning_content")) {
      requiresReasoningContent = false;
      changes.push("requiresReasoningContentOnAssistantMessages → false");
    } else {
      // If the server requires it only on some paths, keep conservative false unless user wants reasoning.
      requiresReasoningContent = false;
    }
  }

  // Apply compat
  const nextCompat: Record<string, boolean | string> = {
    ...(provider.compat ?? {}),
    supportsStore,
    supportsDeveloperRole,
    supportsReasoningEffort,
    supportsUsageInStreaming,
    maxTokensField,
    requiresReasoningContentOnAssistantMessages: requiresReasoningContent,
  };
  provider.compat = nextCompat;

  // Apply per-model reasoning flags
  const enableReasoning = wantReasoning && reasoningOk;
  for (const model of provider.models) {
    const before = model.reasoning;
    model.reasoning = enableReasoning;
    if (enableReasoning) {
      model.thinkingLevelMap ??= { ...DEFAULT_THINKING_LEVEL_MAP };
    } else if (model.thinkingLevelMap) {
      delete model.thinkingLevelMap;
    }
    if (before !== model.reasoning) {
      changes.push(`model ${model.id}: reasoning ${before} → ${model.reasoning}`);
    }
  }

  // Optional: list remote models
  let availableModels: string[] | undefined;
  try {
    const modelsResp = await fetchWithTimeout(`${cleanBase}/models`, {
      headers: { ...requestHeaders, Authorization: `Bearer ${resolvedKey}` },
    }, PROVIDER_TEST_FETCH_TIMEOUT_MS);
    if (modelsResp.ok) {
      const data = (await modelsResp.json()) as { data?: Array<{ id: string }> };
      availableModels = data.data?.map((m) => m.id);
    }
  } catch {
    // optional
  }

  const ok = baseline.ok || baseline.reachable;
  const summaryParts = [
    ok ? "self-check OK" : "self-check partial",
    `maxTokens=${maxTokensField}`,
    `reasoning=${enableReasoning}`,
    `store=${supportsStore}`,
    `developerRole=${supportsDeveloperRole}`,
    `streamUsage=${supportsUsageInStreaming}`,
  ];
  return {
    ok,
    message: summaryParts.join(" · "),
    changes,
    availableModels,
  };
}

function formatAdaptSummary(result: AdaptResult): string {
  const lines = [`${result.ok ? "✅" : "⚠️"} ${result.message}`];
  if (result.changes.length > 0) {
    lines.push("Adaptive changes:");
    for (const c of result.changes.slice(0, 12)) lines.push(`  • ${c}`);
    if (result.changes.length > 12) lines.push(`  … +${result.changes.length - 12} more`);
  }
  return lines.join("\n");
}

// ─── Extension entry ──────────────────────────────────────────────────

export default function providerExtension(pi: ExtensionAPI) {
  pi.registerCommand("provider", {
    description: "Manage providers (add / copy / edit / remove / test / check / status / archive)",
    getArgumentCompletions: (prefix) => {
      const actions = ["add", "copy", "edit", "remove", "test", "check", "status", "archive", "archived", "activate"];
      const filtered = actions.filter((a) => fuzzyMatch(a, prefix));
      if (filtered.length > 0) return filtered.map((a) => ({ value: a, label: a }));
      // Secondary completion: after action, suggest provider names (fuzzy, case-insensitive, supports CJK)
      const parts = prefix.split(/\s+/);
      const nameActions = ["copy", "edit", "check", "archive", "activate", "unarchive", "restore"];
      if (parts.length === 2 && nameActions.includes(parts[0])) {
        const names = Object.keys(readModelsJson().providers || {}).filter((n) => fuzzyMatch(n, parts[1] || ""));
        if (names.length > 0) return names.map((n) => ({ value: `${parts[0]} ${n}`, label: `${parts[0]} ${n}` }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const argStr = (args || "").trim();
      const firstSpace = argStr.indexOf(" ");
      const action = (firstSpace === -1 ? argStr : argStr.slice(0, firstSpace)).toLowerCase();
      const nameArg = firstSpace === -1 ? "" : argStr.slice(firstSpace + 1).trim();

      const known = new Set([
        "add", "copy", "edit", "remove", "test", "check", "status",
        "archive", "archived", "list", "activate", "unarchive", "restore",
      ]);
      const runAction = async (cmd: string, named = ""): Promise<void> => {
        if (cmd === "add") return handleAdd(ctx);
        if (cmd === "copy") return handleCopy(ctx, named);
        if (cmd === "edit") return handleEdit(ctx, named);
        if (cmd === "remove") return handleRemove(ctx);
        if (cmd === "test") return handleTest(ctx);
        if (cmd === "check") return handleCheck(ctx, named);
        if (cmd === "status") return handleStatus(ctx);
        if (cmd === "archive") return handleArchive(ctx, named);
        if (cmd === "archived" || cmd === "list") return handleArchived(ctx);
        if (cmd === "activate" || cmd === "unarchive" || cmd === "restore") return handleActivate(ctx, named);
      };

      if (action && known.has(action)) return runAction(action, nameArg);

      const selected = await enhancedSelect(ctx, "Provider management", [
        "Add       — Add a new provider (self-check)",
        "Copy      — Copy provider to a new name",
        "Edit      — Edit an existing provider (self-check on save)",
        "Remove    — Remove a provider",
        "Test      — Test provider connectivity",
        "Check     — Re-probe capabilities & adapt compat",
        "Status    — View provider details",
        "Archive   — Move active provider to archived",
        "Archived  — Open archived list / reactivate",
      ], { fuzzy: true });
      if (!selected) return;
      return runAction(selected.split(" ")[0].toLowerCase());
    },
  });

  function notifyModelRegistration(
    ctx: ExtensionCommandContext,
    providerName: string,
    modelId: string | undefined,
    verb: string,
  ): void {
    if (!modelId) {
      ctx.ui.notify(`Provider ${verb}, but no model id was available to register.`, "warning");
      return;
    }
    const registered = ctx.modelRegistry.find(providerName, modelId);
    if (registered) {
      ctx.ui.notify(`✅ Model registered: ${providerName}/${modelId}`, "info");
    } else {
      ctx.ui.notify(
        `Provider ${verb}, but model registry did not expose ${providerName}/${modelId}. Try /reload if /model still does not show it.`,
        "warning",
      );
    }
  }

  // ── Select provider helper ──────────────────────────────────────────
  async function selectProvider(
    ctx: ExtensionCommandContext,
    title: string
  ): Promise<{ name: string; config: ProviderConfig } | undefined> {
    const config = readModelsJson();
    return selectActiveEntity(ctx, title, config.providers, { fuzzy: true });
  }

  async function selectArchivedProvider(
    ctx: ExtensionCommandContext,
    title: string
  ): Promise<{ name: string; config: ArchivedProviderConfig } | undefined> {
    const config = readModelsJson();
    return selectArchivedEntity(ctx, title, config.archivedProviders ?? {}, { fuzzy: true });
  }

  // ── Add ─────────────────────────────────────────────────────────────
  async function handleAdd(ctx: ExtensionCommandContext) {
    const providerName = await ctx.ui.input("Provider name (config key):");
    if (!providerName) return ctx.ui.notify("Cancelled", "info");

    const config = readModelsJson();
    if (config.providers[providerName]) {
      const overwrite = await ctx.ui.confirm(
        "Provider exists",
        `"${providerName}" already exists. Overwrite?`
      );
      if (!overwrite) return ctx.ui.notify("Cancelled", "info");
    }
    if (config.archivedProviders?.[providerName]) {
      const activate = await ctx.ui.confirm(
        "Archived provider exists",
        `"${providerName}" is archived. Reactivate it instead of creating a new one?`
      );
      if (activate) return handleActivate(ctx, providerName);
      return ctx.ui.notify("Cancelled", "info");
    }

    const baseUrl = await ctx.ui.input("Base URL (e.g. https://api.example.com/v1):");
    if (!baseUrl) return ctx.ui.notify("Cancelled", "info");

    const apiKey = await ctx.ui.input("API key (supports $ENV_VAR):");
    if (!apiKey) return ctx.ui.notify("Cancelled", "info");

    const apiTypeChoice = await enhancedSelect(ctx, 
      "API type",
      API_TYPES.map((t) => t.label)
    );
    if (!apiTypeChoice) return ctx.ui.notify("Cancelled", "info");
    const apiType = API_TYPES.find((t) => t.label === apiTypeChoice)?.value ?? "openai-completions";

    const modelId = await ctx.ui.input("Model ID (e.g. gpt-4, claude-3-opus):");
    if (!modelId) return ctx.ui.notify("Cancelled", "info");

    const modelNameInput = await ctx.ui.input(`Display name (leave empty for "${modelId}"):`);
    const modelName = modelNameInput || modelId;

    const inputChoice = await enhancedSelect(ctx, 
      "Input types",
      INPUT_TYPES.map((t) => t.label)
    );
    const inputTypes = INPUT_TYPES.find((t) => t.label === inputChoice)?.value ?? ["text"];

    // Preference only — actual capability is decided by self-check below.
    const preferReasoning = await ctx.ui.confirm(
      "Reasoning",
      "Prefer extended thinking if the endpoint supports it? (will self-check and auto-disable if unsupported)",
    );

    // Conservative defaults; self-check rewrites compat + model.reasoning.
    const newProvider: ProviderConfig = {
      baseUrl,
      api: apiType,
      apiKey,
      headers: withDefaultHeaders(),
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens",
        requiresReasoningContentOnAssistantMessages: false,
      },
      models: [
        {
          id: modelId,
          name: modelName,
          reasoning: false,
          input: inputTypes,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };

    ctx.ui.notify(`Self-checking "${providerName}" capabilities…`, "info");
    const adapt = await selfCheckAndAdaptProvider(newProvider, preferReasoning);
    if (!adapt.ok) {
      const stillSave = await ctx.ui.confirm(
        "Self-check failed",
        `${adapt.message}\n\nSave provider config anyway (with best-effort adaptive flags)?`,
      );
      if (!stillSave) return ctx.ui.notify("Cancelled — provider not saved", "info");
    }

    config.providers[providerName] = newProvider;
    writeModelsJson(config);

    ctx.modelRegistry.refresh();
    ctx.ui.notify(`Provider "${providerName}" added`, "info");
    ctx.ui.notify(formatAdaptSummary(adapt), adapt.ok ? "info" : "warning");
    notifyModelRegistration(ctx, providerName, modelId, "written");
    return;
  }

  // ── Copy ────────────────────────────────────────────────────────────
  async function handleCopy(ctx: ExtensionCommandContext, nameArg = "") {
    const config = readModelsJson();
    let sourceName = nameArg.trim();

    if (!sourceName) {
      const result = await selectProvider(ctx, "Copy provider");
      if (!result) return;
      sourceName = result.name;
    }

    const source = config.providers[sourceName];
    if (!source) {
      ctx.ui.notify(`Provider not found: ${sourceName}`, "error");
      return;
    }

    const targetName = await ctx.ui.input(`Copy "${sourceName}" to (new provider name):`);
    if (!targetName?.trim()) return ctx.ui.notify("Cancelled", "info");
    const trimmedName = targetName.trim();

    if (trimmedName === sourceName) {
      ctx.ui.notify("Source and target name are the same", "warning");
      return;
    }

    if (config.providers[trimmedName]) {
      const overwrite = await ctx.ui.confirm(
        "Provider exists",
        `"${trimmedName}" already exists. Overwrite?`
      );
      if (!overwrite) return ctx.ui.notify("Cancelled", "info");
    }

    if (config.archivedProviders?.[trimmedName]) {
      ctx.ui.notify(`"${trimmedName}" exists in archived providers. Activate or remove it first.`, "warning");
      return;
    }

    // Deep copy the provider config
    const copiedConfig: ProviderConfig = deepClone(source);
    config.providers[trimmedName] = copiedConfig;
    writeModelsJson(config);

    ctx.modelRegistry.refresh();
    const firstModelId = copiedConfig.models[0]?.id;
    ctx.ui.notify(`📋 Provider "${sourceName}" copied to "${trimmedName}"`, "info");
    notifyModelRegistration(ctx, trimmedName, firstModelId, "copied");
  }

  // ── Edit ────────────────────────────────────────────────────────────
  async function handleEdit(ctx: ExtensionCommandContext, nameArg = "") {
    const config = readModelsJson();
    let name = nameArg.trim();

    if (!name) {
      const result = await selectProvider(ctx, "Edit provider");
      if (!result) return;
      name = result.name;
    }

    const provider = config.providers[name];
    if (!provider) {
      ctx.ui.notify(`Provider not found: ${name}`, "error");
      return;
    }

    const draft: ProviderConfig = deepClone(provider);
    let draftName = name;

    const result = await editDraft(ctx, () => `Edit provider: ${draftName}`, [
      field("Config name", () => draftName, async (ctx) => {
        const newName = await ctx.ui.input(`Config name [${draftName}]:`);
        if (newName) draftName = newName.trim();
        if (!draftName) {
          draftName = name;
          ctx.ui.notify("Config name cannot be empty", "warning");
        }
      }),
      field("Endpoint", () => draft.baseUrl, async (ctx) => {
        const baseUrl = await ctx.ui.input(`Base URL [${draft.baseUrl}]:`);
        if (baseUrl) draft.baseUrl = baseUrl;
      }),
      {
        label: "API key",
        row: () => `API key: ${draft.apiKey ? draft.apiKey.slice(0, API_KEY_PREVIEW_LENGTH) + "*".repeat(Math.max(0, draft.apiKey.length - API_KEY_PREVIEW_LENGTH)) : "<empty>"}`,
        edit: async () => {
          const apiKey = await ctx.ui.input("API key (Enter to keep current; supports $ENV_VAR):");
          if (apiKey) draft.apiKey = apiKey;
        },
      },
      field("Name field", () => draft.name ?? "<unset>", async (ctx) => {
        const displayName = await ctx.ui.input(`Display name/name field [${draft.name ?? ""}] (Enter to keep, '-' to clear):`);
        if (displayName === "-") delete draft.name;
        else if (displayName) draft.name = displayName;
      }),
      {
        label: "API type",
        row: () => `API type: ${API_TYPES.find((t) => t.value === draft.api)?.label ?? draft.api}`,
        edit: async () => {
          const apiTypeChoice = await enhancedSelect(ctx, "API type", API_TYPES.map((t) => t.label));
          if (apiTypeChoice) draft.api = API_TYPES.find((t) => t.label === apiTypeChoice)?.value ?? draft.api;
        },
      },
      {
        label: "Models",
        row: () => `Models: ${draft.models.length > 0 ? draft.models.map((m) => `${m.name} (${m.id})`).join(", ") : "<none>"}`,
        edit: async () => {
          if (draft.models.length === 0) {
            ctx.ui.notify("No models to edit", "info");
            return;
          }
          const modelChoice = await enhancedSelect(ctx,
            "Edit model",
            draft.models.map((m, i) => `${i + 1}. ${m.name} (${m.id})`)
          );
          if (!modelChoice) return;
          const index = Number(modelChoice.split(".")[0]) - 1;
          const model = draft.models[index];
          if (!model) { ctx.ui.notify("Model not found", "error"); return; }

          await editDraft(ctx, `Edit model: ${model.name}`, [
            field("ID", () => model.id, async (ctx) => {
              const val = await ctx.ui.input(`Model ID [${model.id}]:`);
              if (val) model.id = val.trim();
            }),
            field("Name", () => model.name, async (ctx) => {
              const val = await ctx.ui.input(`Display name [${model.name}]:`);
              if (val) model.name = val.trim();
            }),
            field("Context window", () => String(model.contextWindow), async (ctx) => {
              const val = await ctx.ui.input(`Context window tokens [${model.contextWindow}]:`);
              if (val) {
                const n = Number(val);
                if (!Number.isFinite(n) || n <= 0) ctx.ui.notify("Invalid context window", "warning");
                else model.contextWindow = n;
              }
            }),
            field("Max output", () => String(model.maxTokens), async (ctx) => {
              const val = await ctx.ui.input(`Max output tokens [${model.maxTokens}]:`);
              if (val) {
                const n = Number(val);
                if (!Number.isFinite(n) || n <= 0) ctx.ui.notify("Invalid max output tokens", "warning");
                else model.maxTokens = n;
              }
            }),
          ], { saveLabel: "s Save", discardLabel: "x Back" });
        },
      },
    ], {
      beforeSave: async (ctx) => {
        if (!draftName.trim()) {
          ctx.ui.notify("Config name cannot be empty", "warning");
          return false;
        }
        if (draftName !== name && config.providers[draftName]) {
          const overwrite = await ctx.ui.confirm("Provider exists", `Provider "${draftName}" already exists. Overwrite it?`);
          if (!overwrite) return false;
        }
        return true;
      },
    });

    if (result === "discard" || result === undefined) {
      return ctx.ui.notify("Discarded provider edits", "info");
    }

    // Self-check + adaptive compat before persist (same path as /provider add).
    const toSave: ProviderConfig = {
      ...draft,
      headers: withDefaultHeaders(draft.headers),
    };
    const preferReasoning = toSave.models.some((m) => m.reasoning)
      || Boolean(toSave.compat?.supportsReasoningEffort);

    ctx.ui.notify(`Self-checking "${draftName}" capabilities…`, "info");
    const adapt = await selfCheckAndAdaptProvider(toSave, preferReasoning);
    if (!adapt.ok) {
      const stillSave = await ctx.ui.confirm(
        "Self-check failed",
        `${adapt.message}\n\nSave edited provider anyway (with best-effort adaptive flags)?`,
      );
      if (!stillSave) return ctx.ui.notify("Cancelled — edits not saved", "info");
    }

    if (draftName !== name) delete config.providers[name];
    config.providers[draftName] = toSave;
    writeModelsJson(config);
    ctx.modelRegistry.refresh();
    ctx.ui.notify(`Provider "${name}" saved as "${draftName}"`, "info");
    ctx.ui.notify(formatAdaptSummary(adapt), adapt.ok ? "info" : "warning");
    ctx.ui.notify("Run /reload or restart Pi if model list does not refresh", "info");
  }

  // ── Remove ──────────────────────────────────────────────────────────
  async function handleRemove(ctx: ExtensionCommandContext) {
    const result = await selectProvider(ctx, "Remove provider");
    if (!result) return;

    const confirmed = await ctx.ui.confirm(
      "Confirm deletion",
      `Delete provider "${result.name}"? This cannot be undone.`
    );
    if (!confirmed) return ctx.ui.notify("Cancelled", "info");

    const config = readModelsJson();
    delete config.providers[result.name];
    writeModelsJson(config);
    ctx.modelRegistry.refresh();

    ctx.ui.notify(`Provider "${result.name}" removed`, "info");
    ctx.ui.notify("Run /reload or restart Pi to apply", "info");
  }

  // ── Archive ─────────────────────────────────────────────────────────
  async function handleArchive(ctx: ExtensionCommandContext, nameArg = "") {
    const config = readModelsJson();
    let name = nameArg.trim();

    if (!name) {
      const result = await selectProvider(ctx, "Archive provider");
      if (!result) return;
      name = result.name;
    }

    const provider = config.providers[name];
    if (!provider) {
      ctx.ui.notify(`Provider not found: ${name}`, "error");
      return;
    }

    const confirmed = await ctx.ui.confirm(
      "Archive provider",
      `Move "${name}" from active providers to archivedProviders?`
    );
    if (!confirmed) return ctx.ui.notify("Cancelled", "info");

    config.archivedProviders ??= {};
    archiveEntity(name, config.providers, config.archivedProviders as Record<string, ArchivedProviderConfig>, null);
    writeModelsJson(config);
    ctx.modelRegistry.refresh();

    ctx.ui.notify(`📦 Provider "${name}" archived`, "info");
    ctx.ui.notify("Run /reload or restart Pi to apply", "info");
  }

  // ── Archived / Reactivate ───────────────────────────────────────────
  async function handleArchived(ctx: ExtensionCommandContext) {
    const config = readModelsJson();
    const archived = config.archivedProviders ?? {};
    await browseArchived(ctx, archived, {
      fuzzy: true,
      extraActions: [{
        label: "Details  — Show archived provider details",
        match: "Details",
        run: async (name: string) => {
          const a = archived[name];
          if (!a) return;
          const modelCount = a.models?.length ?? 0;
          const lines = [
            `Provider : ${name}`,
            `Endpoint : ${a.baseUrl}`,
            `API      : ${a.api}`,
            `Archived : ${a.archivedAt}`,
            `Models   : ${modelCount}`,
            "",
            ...a.models.map((m) => `  - ${m.name} (${m.id})`),
            "",
            `Use /provider activate ${name} to reactivate.`,
          ];
          await enhancedSelect(ctx, `Details: ${name}`, lines);
        },
      }],
      onRestore: async (name: string) => handleActivate(ctx, name),
      onDelete: async (name: string) => {
        const fresh = readModelsJson();
        delete fresh.archivedProviders![name];
        writeModelsJson(fresh);
        ctx.ui.notify(`Deleted archived: ${name}`, "info");
      },
    });
  }

  async function handleActivate(ctx: ExtensionCommandContext, nameArg = "") {
    const config = readModelsJson();
    let name = nameArg.trim();

    if (!name) {
      const result = await selectArchivedProvider(ctx, "Activate archived provider");
      if (!result) return;
      name = result.name;
    }

    const archived = config.archivedProviders?.[name];
    if (!archived) {
      ctx.ui.notify(`Archived provider not found: ${name}`, "error");
      return;
    }

    if (config.providers[name]) {
      const overwrite = await ctx.ui.confirm(
        "Provider exists",
        `Active provider "${name}" already exists. Overwrite with archived version?`
      );
      if (!overwrite) return ctx.ui.notify("Cancelled", "info");
    }

    const provider = stripArchived(archived);
    config.providers[name] = {
      ...provider,
      headers: withDefaultHeaders(provider.headers),
    };
    delete config.archivedProviders![name];
    writeModelsJson(config);

    const freshConfig = readModelsJson();
    const restored = freshConfig.providers[name];
    const restoredModels = restored?.models?.length ?? 0;
    if (!restored || restoredModels === 0) {
      ctx.ui.notify(`Failed to reactivate "${name}": provider or models not found after write`, "error");
      return;
    }

    ctx.modelRegistry.refresh();
    const firstModelId = restored.models[0]?.id;
    ctx.ui.notify(`✅ Provider "${name}" reactivated (${restoredModels} model(s))`, "info");
    notifyModelRegistration(ctx, name, firstModelId, "restored");
    return;
  }

  // ── Test ────────────────────────────────────────────────────────────
  async function handleTest(ctx: ExtensionCommandContext) {
    const result = await selectProvider(ctx, "Test provider");
    if (!result) return;

    const { name, config: provider } = result;
    ctx.ui.notify(`Testing "${name}"...`, "info");

    const perf = await testProviderPerformance(
      provider.baseUrl,
      provider.apiKey,
      provider.api,
      provider.models,
      provider.headers
    );

    if (!perf.success) {
      ctx.ui.notify(`Failed: ${perf.message}`, "error");
      return;
    }

    // ── Header ──
    const lines: string[] = [];
    lines.push(`Provider: ${name}`);
    lines.push(`Endpoint: ${provider.baseUrl}`);
    lines.push(`API: ${provider.api}`);
    lines.push("");

    // ── Performance metrics ──
    lines.push("── Performance ──");
    lines.push(`  Status     : ${perf.message}`);
    lines.push(`  Latency    : ${fmtMs(perf.timing.totalMs)}`);
    lines.push(`  TTFB       : ${fmtMs(perf.timing.ttfbMs)}`);
    lines.push(`  Connect    : ${fmtMs(perf.timing.connectMs)}`);
    lines.push("");

    // ── Available models table ──
    const remoteModels = perf.availableModels ?? [];
    const registeredIds = provider.models.map((m) => m.id);

    if (remoteModels.length > 0) {
      lines.push(...formatRemoteModelsSection(remoteModels, registeredIds, "Available models"));
    } else if (provider.models.length > 0) {
      lines.push("── Registered models ──");
      lines.push("");
      const displayItems = provider.models.map((m) => `[${m.id}]`);
      lines.push(...buildMultiColumnTable(displayItems, TABLE_WIDTH, TABLE_MIN_COL_WIDTH));
      lines.push("");
      lines.push("[*] = currently registered");
    }

    await enhancedSelect(ctx, "Test results", lines);
  }

  /** Re-probe capabilities and rewrite compat/reasoning flags in models.json. */
  async function handleCheck(ctx: ExtensionCommandContext, nameArg = "") {
    const config = readModelsJson();
    let name = nameArg.trim();

    if (!name) {
      const result = await selectProvider(ctx, "Self-check provider");
      if (!result) return;
      name = result.name;
    }

    const provider = config.providers[name];
    if (!provider) {
      ctx.ui.notify(`Provider not found: ${name}`, "error");
      return;
    }

    const currentReasoning = provider.models.some((m) => m.reasoning)
      || Boolean(provider.compat?.supportsReasoningEffort);
    const preferReasoning = await ctx.ui.confirm(
      "Reasoning preference",
      currentReasoning
        ? "Keep trying extended thinking if supported? (will auto-disable if unsupported)"
        : "Enable extended thinking if the endpoint supports it?",
    );

    ctx.ui.notify(`Self-checking "${name}"...`, "info");
    const draft = deepClone(provider);
    const adapt = await selfCheckAndAdaptProvider(draft, preferReasoning);

    if (!adapt.ok) {
      const stillSave = await ctx.ui.confirm(
        "Self-check failed",
        `${adapt.message}\n\nWrite best-effort adaptive flags to models.json anyway?`,
      );
      if (!stillSave) {
        ctx.ui.notify(formatAdaptSummary(adapt), "warning");
        return;
      }
    }

    config.providers[name] = draft;
    writeModelsJson(config);
    ctx.modelRegistry.refresh();
    ctx.ui.notify(`Provider "${name}" updated from self-check`, "info");
    ctx.ui.notify(formatAdaptSummary(adapt), adapt.ok ? "info" : "warning");
  }

  // ── Status rendering helpers (shared by handleStatus) ─────────────────

  /** Format a context-window token count as K/M for compact display. */
  function fmtContextWindow(tokens: number): string {
    if (tokens >= CONTEXT_THRESHOLD_MILLION) return `${(tokens / CONTEXT_THRESHOLD_MILLION).toFixed(0)}M`;
    if (tokens >= CONTEXT_THRESHOLD_THOUSAND) return `${(tokens / CONTEXT_THRESHOLD_THOUSAND).toFixed(0)}K`;
    return `${tokens}`;
  }

  /** Build the lines to display for a provider status view. */
  function renderProviderStatus(
    providerName: string,
    provider: ProviderConfig,
    perf: PerfResult
  ): string[] {
    const apiLabel = API_TYPES.find((t) => t.value === provider.api)?.label ?? provider.api;
    const statusIcon = perf.success ? "[OK]" : "[FAIL]";
    const lines: string[] = [];

    // ── Provider info ──
    lines.push(`Provider    : ${providerName}`);
    lines.push(`Endpoint    : ${provider.baseUrl}`);
    lines.push(`API         : ${apiLabel}`);
    lines.push(`API key     : ${provider.apiKey.slice(0, API_KEY_PREVIEW_LENGTH)}${"*".repeat(Math.max(0, provider.apiKey.length - API_KEY_PREVIEW_LENGTH))}`);
    lines.push(`Status      : ${statusIcon} ${perf.message}`);
    lines.push("");

    // ── Performance ──
    lines.push("── Performance ──");
    lines.push(`  Latency   : ${fmtMs(perf.timing.totalMs)}`);
    lines.push(`  TTFB      : ${fmtMs(perf.timing.ttfbMs)}`);
    lines.push(`  Connect   : ${fmtMs(perf.timing.connectMs)}`);
    lines.push("");

    // ── Compatibility ──
    if (provider.compat) {
      lines.push("── Compatibility ──");
      for (const [key, value] of Object.entries(provider.compat)) {
        lines.push(`  ${key}: ${String(value)}`);
      }
      lines.push("");
    }

    // ── Models ──
    lines.push(`── Models (${provider.models.length}) ──`);
    lines.push("");
    for (const m of provider.models) {
      const inputs = m.input.join(", ");
      const ctxWin = fmtContextWindow(m.contextWindow);
      lines.push(`  ${m.name} (${m.id})`);
      lines.push(`    Reasoning  : ${m.reasoning ? "Yes" : "No"}`);
      lines.push(`    Input      : ${inputs}`);
      lines.push(`    Context    : ${ctxWin} tokens`);
      lines.push(`    Max output : ${m.maxTokens} tokens`);
      if (m.thinkingLevelMap) {
        const levels = Object.entries(m.thinkingLevelMap)
          .map(([k, v]) => `${k}:${v ?? "-"}`)
          .join(", ");
        lines.push(`    Thinking   : ${levels}`);
      }
      lines.push("");
    }

        // ── Remote models ──
    const remoteModels = perf.availableModels ?? [];
    const registeredIds = provider.models.map((m) => m.id);
    lines.push(...formatRemoteModelsSection(remoteModels, registeredIds));

    return lines;
  }

  // ── Status ──────────────────────────────────────────────────────────
  async function handleStatus(ctx: ExtensionCommandContext) {
    while (true) {
      const result = await selectProvider(ctx, "View provider status");
      if (!result) return;

      const providerName = result.name;
      let provider = result.config;

      // Inner loop: show status, then ask refresh/back/exit
      while (true) {
        ctx.ui.notify("Testing connection...", "info");

        const perf = await testProviderPerformance(
          provider.baseUrl,
          provider.apiKey,
          provider.api,
          provider.models,
          provider.headers
        );

        const lines = renderProviderStatus(providerName, provider, perf);
        await enhancedSelect(ctx, `Status: ${providerName}`, lines);

        // ── Next action ──
        const action = await enhancedSelect(ctx, "Next action", [
          "Refresh — Re-test this provider",
          "Back    — Select another provider",
          "Exit    — Return to chat",
        ]);
        if (!action) return;

        const cmd = action.split(" ")[0].toLowerCase();
        if (cmd === "refresh") {
          const freshConfig = readModelsJson();
          const freshProvider = freshConfig.providers[providerName];
          if (!freshProvider) {
            ctx.ui.notify("Provider no longer exists", "error");
            break; // back to outer loop
          }
          provider = freshProvider;
          continue; // re-show status
        } else if (cmd === "back") {
          break; // back to outer loop (provider selection)
        } else {
          return; // exit
        }
      }
    }
  }
}
