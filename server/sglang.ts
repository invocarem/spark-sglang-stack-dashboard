/** Fetch Prometheus metrics from the SGLang HTTP server (host-published port). */

import { assistantFromCompletionBody } from "../lib/openai-completion-text.js";
import {
  benchmarkDefaultMaxTokens,
  benchmarkPreserveSeparateReasoning,
  benchmarkPreserveThinking,
} from "./benchmark-defaults.js";

const DEFAULT_BASE = process.env.SGLANG_BASE_URL ?? "http://127.0.0.1:30000";
const METRICS_PATH = process.env.SGLANG_METRICS_PATH ?? "/metrics";
const FETCH_TIMEOUT_MS = Number(process.env.SGLANG_FETCH_TIMEOUT_MS ?? "8000");
const MAX_RAW_CHARS = 256_000;
const MAX_HIGHLIGHT_LINES = 400;

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertSafeSglangUrl(urlString: string): URL {
  const u = new URL(urlString);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs allowed for SGLang");
  }
  const host = u.hostname.toLowerCase();
  if (process.env.SGLANG_ALLOW_ANY_HOST === "1") {
    return u;
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      "SGLang URL host must be localhost, 127.0.0.1, or ::1 (or set SGLANG_ALLOW_ANY_HOST=1)",
    );
  }
  return u;
}

/** HTTP origin for the SGLang server (same as metrics, without path). */
export function getSglangBaseUrl(): string {
  const full = process.env.SGLANG_METRICS_URL?.trim();
  if (full) {
    const u = assertSafeSglangUrl(full);
    return u.origin;
  }
  return assertSafeSglangUrl(DEFAULT_BASE).origin;
}

const MODELS_LIST_TIMEOUT_MS = Number(process.env.SGLANG_MODELS_TIMEOUT_MS ?? "4000");

function parseOpenAiModelsList(data: unknown): string[] | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = (data as { data?: unknown }).data;
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string"
    ) {
      ids.push((item as { id: string }).id);
    }
  }
  return ids.length > 0 ? ids : null;
}

/** OpenAI-style `GET /v1/models` on the inference base URL (for served model ids). */
export async function fetchInferenceModelIds(): Promise<string[] | null> {
  try {
    const base = getSglangBaseUrl();
    const url = new URL("/v1/models", `${base}/`);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), MODELS_LIST_TIMEOUT_MS);
    const res = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseOpenAiModelsList(data);
  } catch {
    return null;
  }
}

const CHAT_TIMEOUT_MS = Number(process.env.SGLANG_CHAT_TIMEOUT_MS ?? "120000");

type ChatRole = "system" | "user" | "assistant";

type ChatMessage = { role: ChatRole; content: string };

function isChatMessage(x: unknown): x is ChatMessage {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const role = o.role;
  if (role !== "system" && role !== "user" && role !== "assistant") return false;
  return typeof o.content === "string";
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isChatRequestBody(x: unknown): x is {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  separate_reasoning?: boolean;
  chat_template_kwargs?: Record<string, unknown>;
} {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.model !== "string" || !o.model.trim()) return false;
  if (!Array.isArray(o.messages) || o.messages.length === 0) return false;
  if (!o.messages.every(isChatMessage)) return false;
  if (o.separate_reasoning !== undefined && typeof o.separate_reasoning !== "boolean") {
    return false;
  }
  if (o.chat_template_kwargs !== undefined && !isPlainObject(o.chat_template_kwargs)) {
    return false;
  }
  return true;
}

export type ChatProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string; status?: number; bodyPreview?: string };

/** POST /v1/chat/completions on the SGLang server (OpenAI-compatible). */
export async function forwardChatCompletions(
  body: unknown,
): Promise<ChatProxyResult> {
  if (!isChatRequestBody(body)) {
    return {
      ok: false,
      error:
        "Expected JSON with non-empty model (string) and messages (array of { role, content })",
      status: 400,
    };
  }

  let base: string;
  try {
    base = getSglangBaseUrl();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, status: 400 };
  }

  const url = new URL("/v1/chat/completions", `${base}/`);
  const payload: Record<string, unknown> = {
    model: body.model.trim(),
    messages: body.messages,
    stream: false,
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
  };
  if (typeof body.separate_reasoning === "boolean") {
    payload.separate_reasoning = body.separate_reasoning;
  }
  if (body.chat_template_kwargs !== undefined && isPlainObject(body.chat_template_kwargs)) {
    payload.chat_template_kwargs = body.chat_template_kwargs;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 8000) };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `SGLang HTTP ${res.status}`,
        status: res.status,
        bodyPreview:
          typeof parsed === "object" && parsed !== null
            ? JSON.stringify(parsed).slice(0, 4000)
            : String(parsed).slice(0, 4000),
      };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function getSglangMetricsUrl(): string {
  const full = process.env.SGLANG_METRICS_URL?.trim();
  if (full) {
    return assertSafeSglangUrl(full).toString();
  }
  const base = assertSafeSglangUrl(DEFAULT_BASE);
  return new URL(METRICS_PATH, base).toString();
}

export type SglangMetricsResult =
  | {
      ok: true;
      url: string;
      status: number;
      contentType: string | null;
      highlightLines: string[];
      rawPreview: string;
      rawTruncated: boolean;
      fetchedAt: string;
    }
  | {
      ok: false;
      url: string;
      error: string;
      status?: number;
      bodyPreview?: string;
      fetchedAt: string;
    };

function extractSglangLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.toLowerCase().includes("sglang")) {
      out.push(line.trimEnd());
      if (out.length >= MAX_HIGHLIGHT_LINES) break;
    }
  }
  return out;
}

export async function fetchSglangMetrics(): Promise<SglangMetricsResult> {
  const fetchedAt = new Date().toISOString();
  let url: string;
  try {
    url = getSglangMetricsUrl();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      url: "(could not resolve SGLANG_METRICS_URL / SGLANG_BASE_URL)",
      error: msg,
      fetchedAt,
    };
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    const contentType = res.headers.get("content-type");
    const text = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        url,
        error: `HTTP ${res.status}`,
        status: res.status,
        bodyPreview: text.slice(0, 4000),
        fetchedAt,
      };
    }

    const truncated = text.length > MAX_RAW_CHARS;
    const rawPreview = truncated ? text.slice(0, MAX_RAW_CHARS) : text;

    return {
      ok: true,
      url,
      status: res.status,
      contentType,
      highlightLines: extractSglangLines(text),
      rawPreview,
      rawTruncated: truncated,
      fetchedAt,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, url, error: msg, fetchedAt };
  }
}

const BENCHMARK_MAX_REQUESTS = Number(process.env.SGLANG_BENCHMARK_MAX_REQUESTS ?? "200");
const BENCHMARK_MAX_CONCURRENCY = Number(process.env.SGLANG_BENCHMARK_MAX_CONCURRENCY ?? "32");
/** Max chars of assistant text returned as `sampleContent` (request index 0). */
const BENCHMARK_SAMPLE_MAX_CHARS = Number(process.env.SGLANG_BENCHMARK_SAMPLE_MAX_CHARS ?? "32000");

function truncateSample(s: string): string {
  const max = Number.isFinite(BENCHMARK_SAMPLE_MAX_CHARS) && BENCHMARK_SAMPLE_MAX_CHARS > 0
    ? Math.floor(BENCHMARK_SAMPLE_MAX_CHARS)
    : 32000;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n… [truncated: ${s.length} chars total]`;
}

export type SglangBenchmarkOk = {
  ok: true;
  model: string;
  wallTimeMs: number;
  requests: number;
  concurrency: number;
  successes: number;
  failures: number;
  latenciesMs: number[];
  p50: number;
  p95: number;
  p99: number;
  throughputRps: number;
  errorSamples: string[];
  /** Assistant text for scheduled request #1 (index 0), when that call succeeded; same prompt for all slots. */
  sampleContent: string | null;
};

export type SglangBenchmarkErr = {
  ok: false;
  error: string;
  status: number;
};

function isBenchmarkBody(x: unknown): x is {
  model: string;
  message: string;
  concurrency: number;
  requests: number;
  max_tokens?: number;
} {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.model !== "string" || !o.model.trim()) return false;
  if (typeof o.message !== "string" || !o.message.trim()) return false;
  if (typeof o.concurrency !== "number" || !Number.isFinite(o.concurrency)) return false;
  if (typeof o.requests !== "number" || !Number.isFinite(o.requests)) return false;
  if (o.max_tokens !== undefined) {
    if (typeof o.max_tokens !== "number" || !Number.isFinite(o.max_tokens) || o.max_tokens <= 0) {
      return false;
    }
  }
  return true;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/** Synthetic load against `POST /v1/chat/completions` (non-streaming). */
export async function runSglangBenchmark(
  body: unknown,
): Promise<SglangBenchmarkOk | SglangBenchmarkErr> {
  if (!isBenchmarkBody(body)) {
    return {
      ok: false,
      status: 400,
      error:
        "Expected JSON: model (string), message (string), concurrency (number), requests (number), optional max_tokens (positive number)",
    };
  }

  const maxReq = Number.isFinite(BENCHMARK_MAX_REQUESTS) && BENCHMARK_MAX_REQUESTS > 0
    ? Math.floor(BENCHMARK_MAX_REQUESTS)
    : 200;
  const maxConc = Number.isFinite(BENCHMARK_MAX_CONCURRENCY) && BENCHMARK_MAX_CONCURRENCY > 0
    ? Math.floor(BENCHMARK_MAX_CONCURRENCY)
    : 32;

  let concurrency = Math.max(1, Math.floor(body.concurrency));
  let requests = Math.max(1, Math.floor(body.requests));
  if (concurrency > maxConc) {
    return { ok: false, status: 400, error: `concurrency must be <= ${maxConc}` };
  }
  if (requests > maxReq) {
    return { ok: false, status: 400, error: `requests must be <= ${maxReq}` };
  }

  concurrency = Math.min(concurrency, requests);

  const model = body.model.trim();
  const message = body.message.trim();
  const max_tokens =
    body.max_tokens !== undefined ? Math.floor(body.max_tokens) : benchmarkDefaultMaxTokens();
  const injectSeparateReasoning = !benchmarkPreserveSeparateReasoning();
  const injectThinkingOff = !benchmarkPreserveThinking();

  let benchmarkBase: string;
  try {
    benchmarkBase = getSglangBaseUrl();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 400, error: msg };
  }

  console.log(
    `[benchmark] start model=${JSON.stringify(model)} requests=${requests} concurrency=${concurrency} max_tokens=${max_tokens} separate_reasoning=${injectSeparateReasoning ? "false" : "(server default)"} enable_thinking=${injectThinkingOff ? "false (chat_template_kwargs)" : "(server default)"} → ${benchmarkBase}`,
  );

  const latenciesMs: number[] = [];
  let successes = 0;
  let failures = 0;
  const errorSamples: string[] = [];
  let sampleContent: string | null = null;

  let next = 0;
  const total = requests;

  async function oneShot(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= total) return;

      const payload = {
        model,
        messages: [{ role: "user" as const, content: message }],
        max_tokens,
        ...(injectSeparateReasoning ? { separate_reasoning: false as const } : {}),
        ...(injectThinkingOff
          ? { chat_template_kwargs: { enable_thinking: false } as const }
          : {}),
      };

      const t0 = Date.now();
      const result = await forwardChatCompletions(payload);
      const dt = Date.now() - t0;
      latenciesMs.push(dt);

      if (result.ok) {
        successes++;
        if (i === 0) {
          const raw = assistantFromCompletionBody(result.body);
          sampleContent = raw !== null ? truncateSample(raw) : null;
        }
      } else {
        failures++;
        if (errorSamples.length < 8) {
          const extra = result.bodyPreview ? ` ${result.bodyPreview.slice(0, 240)}` : "";
          errorSamples.push(`${result.error}${extra}`);
        }
      }
    }
  }

  const workers = Math.min(concurrency, total);
  const wallStart = Date.now();
  await Promise.all(Array.from({ length: workers }, () => oneShot()));
  const wallTimeMs = Date.now() - wallStart;

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const throughputRps = wallTimeMs > 0 ? successes / (wallTimeMs / 1000) : 0;

  return {
    ok: true,
    model,
    wallTimeMs,
    requests,
    concurrency: workers,
    successes,
    failures,
    latenciesMs,
    p50,
    p95,
    p99,
    throughputRps,
    errorSamples,
    sampleContent,
  };
}
