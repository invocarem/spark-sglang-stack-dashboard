/**
 * Load test: concurrent non-streaming chat completions via `POST /api/benchmark`.
 *
 * The HTTP response returns only after every scheduled request finishes (or times out server-side).
 * Console stays quiet until then — use Network → POST …/benchmark (pending).
 *
 * Server defaults (when max tokens field is empty): `max_tokens` 256 and, for SGLang,
 * `separate_reasoning: false` plus `chat_template_kwargs.enable_thinking: false` (Qwen3) so load
 * tests do not spend tens of seconds on visible “thinking” text. Opt out with BENCHMARK_PRESERVE_* env.
 */

import { getMonitorProvider, withProviderHeaders, withProviderQuery } from "../app/provider";

/** Max wait for the whole benchmark HTTP response (all completions on the server). */
const BENCHMARK_FETCH_TIMEOUT_MS = 900_000;

type BenchmarkOk = {
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
  /** Omitted by older dashboard API versions. */
  sampleContent?: string | null;
};

type TaskBenchmarkOk = {
  ok: true;
  model: string;
  input: string;
  wallTimeMs: number;
  cases: number;
  passed: number;
  failed: number;
  passRate: number;
  byCategory: Record<string, { pass: number; fail: number }>;
  results: Array<{
    id: string;
    category: string;
    ok: boolean;
    reason: string;
    latencyMs: number;
    preview?: string;
  }>;
};

type BenchMode = "load" | "task";

type BenchHistoryEntry =
  | {
      mode: "load";
      at: string;
      model: string;
      requests: number;
      concurrency: number;
      throughputRps: number;
      p95: number;
      failures: number;
    }
  | {
      mode: "task";
      at: string;
      model: string;
      input: string;
      cases: number;
      passRate: number;
      failed: number;
      wallTimeMs: number;
    };

const BENCH_HISTORY_KEY = "monitor.benchmark.history.v1";
const BENCH_HISTORY_LIMIT = 20;

const modelEl = document.querySelector<HTMLInputElement>("#bench-model");
const modeEl = document.querySelector<HTMLSelectElement>("#bench-mode");
const messageEl = document.querySelector<HTMLTextAreaElement>("#bench-message");
const concurrencyEl = document.querySelector<HTMLInputElement>("#bench-concurrency");
const requestsEl = document.querySelector<HTMLInputElement>("#bench-requests");
const maxTokensEl = document.querySelector<HTMLInputElement>("#bench-max-tokens");
const taskInputEl = document.querySelector<HTMLInputElement>("#bench-task-input");
const taskTempEl = document.querySelector<HTMLInputElement>("#bench-task-temperature");
const taskMaxTokensEl = document.querySelector<HTMLInputElement>("#bench-task-max-tokens");
const loadMessageFieldEl = document.querySelector<HTMLElement>("#bench-load-message-field");
const loadControlsEl = document.querySelector<HTMLElement>("#bench-load-controls");
const taskControlsEl = document.querySelector<HTMLElement>("#bench-task-controls");
const btnRun = document.querySelector<HTMLButtonElement>("#bench-run");
const statusEl = document.querySelector<HTMLParagraphElement>("#bench-status");
const resultsEl = document.querySelector<HTMLPreElement>("#bench-results");
const diffEl = document.querySelector<HTMLPreElement>("#bench-diff");
const historyEl = document.querySelector<HTMLPreElement>("#bench-history");

function setBenchStatus(message: string, isError = false): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function providerLabel(): string {
  return getMonitorProvider() === "vllm" ? "vLLM" : "SGLang";
}

function formatResults(data: BenchmarkOk): string {
  const latencies = data.latenciesMs ?? [];
  const errors = data.errorSamples ?? [];
  const lines: string[] = [
    `Model: ${data.model}`,
    `Wall time: ${data.wallTimeMs} ms`,
    `Scheduled: ${data.requests} request(s), effective concurrency: ${data.concurrency}`,
    `Successes: ${data.successes} · Failures: ${data.failures}`,
    `Throughput (successful): ${(data.throughputRps ?? 0).toFixed(2)} req/s`,
    `Latency (ms) — p50: ${data.p50} · p95: ${data.p95} · p99: ${data.p99}`,
    "",
    "Per-request latencies (ms):",
    latencies.join(", "),
  ];
  if (errors.length > 0) {
    lines.push("", "Error samples:");
    for (const s of errors) lines.push(`- ${s}`);
  }
  const sample = data.sampleContent;
  if (typeof sample === "string" && sample.length > 0) {
    lines.push(
      "",
      "Sample assistant reply (request #1 / index 0; all requests use the same prompt):",
      "—".repeat(48),
      sample,
    );
  } else if (sample === null) {
    lines.push(
      "",
      "Sample assistant reply: unavailable (request #1 did not succeed or had no parseable content).",
    );
  }
  return lines.join("\n");
}

function formatTaskResults(data: TaskBenchmarkOk): string {
  const categories = Object.entries(data.byCategory).map(
    ([k, v]) => `${k}: ${v.pass} pass / ${v.fail} fail`,
  );
  const failed = data.results.filter((r) => !r.ok).slice(0, 10);
  const lines: string[] = [
    `Model: ${data.model}`,
    `Input: ${data.input}`,
    `Wall time: ${data.wallTimeMs} ms`,
    `Cases: ${data.cases} · Passed: ${data.passed} · Failed: ${data.failed}`,
    `Pass rate: ${(data.passRate * 100).toFixed(2)}%`,
    "",
    "By category:",
    ...(categories.length > 0 ? categories : ["(none)"]),
  ];
  if (failed.length > 0) {
    lines.push("", "Failed samples:");
    for (const row of failed) {
      lines.push(`- ${row.id} [${row.category}] ${row.reason}`);
    }
  }
  return lines.join("\n");
}

function getMode(): BenchMode {
  return modeEl?.value === "task" ? "task" : "load";
}

function setModeUI(): void {
  const mode = getMode();
  const task = mode === "task";
  loadMessageFieldEl?.classList.toggle("hidden", task);
  loadControlsEl?.classList.toggle("hidden", task);
  taskControlsEl?.classList.toggle("hidden", !task);
}

function readHistory(): BenchHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(BENCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as BenchHistoryEntry[];
  } catch {
    return [];
  }
}

function writeHistory(rows: BenchHistoryEntry[]): void {
  window.localStorage.setItem(BENCH_HISTORY_KEY, JSON.stringify(rows.slice(0, BENCH_HISTORY_LIMIT)));
}

function appendHistory(row: BenchHistoryEntry): BenchHistoryEntry[] {
  const next = [row, ...readHistory()];
  writeHistory(next);
  return next;
}

function renderHistory(): void {
  if (!historyEl) return;
  const rows = readHistory();
  if (rows.length === 0) {
    historyEl.textContent = "No run history yet.";
    return;
  }
  const lines: string[] = ["Recent runs:"];
  for (const r of rows.slice(0, 10)) {
    if (r.mode === "load") {
      lines.push(
        `- ${r.at} load model=${r.model} p95=${r.p95}ms tput=${r.throughputRps.toFixed(2)} req/s fail=${r.failures}/${r.requests}`,
      );
    } else {
      lines.push(
        `- ${r.at} task model=${r.model} pass=${(r.passRate * 100).toFixed(2)}% fail=${r.failed}/${r.cases} input=${r.input}`,
      );
    }
  }
  historyEl.textContent = lines.join("\n");
}

function renderDiff(current: BenchHistoryEntry): void {
  if (!diffEl) return;
  const baseline = readHistory().find((x) => x.mode === current.mode);
  if (!baseline) {
    diffEl.textContent = "No baseline yet. This run is now your baseline for this mode.";
    return;
  }
  if (current.mode === "load" && baseline.mode === "load") {
    const dp95 = current.p95 - baseline.p95;
    const dtput = current.throughputRps - baseline.throughputRps;
    const dfail = current.failures - baseline.failures;
    diffEl.textContent =
      `Compared to previous load run (${baseline.at}):\n` +
      `- p95: ${baseline.p95} -> ${current.p95} ms (${dp95 >= 0 ? "+" : ""}${dp95} ms)\n` +
      `- throughput: ${baseline.throughputRps.toFixed(2)} -> ${current.throughputRps.toFixed(2)} req/s (${dtput >= 0 ? "+" : ""}${dtput.toFixed(2)})\n` +
      `- failures: ${baseline.failures} -> ${current.failures} (${dfail >= 0 ? "+" : ""}${dfail})`;
    return;
  }
  if (current.mode === "task" && baseline.mode === "task") {
    const dpass = (current.passRate - baseline.passRate) * 100;
    const dfail = current.failed - baseline.failed;
    diffEl.textContent =
      `Compared to previous task run (${baseline.at}):\n` +
      `- pass rate: ${(baseline.passRate * 100).toFixed(2)} -> ${(current.passRate * 100).toFixed(2)}% (${dpass >= 0 ? "+" : ""}${dpass.toFixed(2)} pts)\n` +
      `- failed: ${baseline.failed} -> ${current.failed} (${dfail >= 0 ? "+" : ""}${dfail})\n` +
      `- cases: ${baseline.cases} -> ${current.cases}`;
    return;
  }
}

async function runBenchmark(): Promise<void> {
  if (!btnRun || !resultsEl) return;
  const mode = getMode();
  const model = modelEl?.value?.trim() ?? "";
  const message = messageEl?.value?.trim() ?? "";
  const concurrency = Number(concurrencyEl?.value ?? "4");
  const requests = Number(requestsEl?.value ?? "20");
  const maxTokRaw = maxTokensEl?.value?.trim();
  const max_tokens = maxTokRaw && maxTokRaw.length > 0 ? Number(maxTokRaw) : undefined;
  const taskInput = taskInputEl?.value?.trim() ?? "tools/task_benchmark_seed.jsonl";
  const taskTemperature = Number(taskTempEl?.value ?? "0.2");
  const taskMaxTokens = Number(taskMaxTokensEl?.value ?? "1024");

  if (!model) {
    setBenchStatus("Set the model on the Launch tab (or the Model field here).", true);
    return;
  }
  if (mode === "load" && !message) {
    setBenchStatus("Enter a prompt message.", true);
    return;
  }
  if (mode === "load" && (!Number.isFinite(concurrency) || concurrency < 1)) {
    setBenchStatus("Concurrency must be >= 1.", true);
    return;
  }
  if (mode === "load" && (!Number.isFinite(requests) || requests < 1)) {
    setBenchStatus("Request count must be >= 1.", true);
    return;
  }
  if (mode === "load" && max_tokens !== undefined && (!Number.isFinite(max_tokens) || max_tokens <= 0)) {
    setBenchStatus("max_tokens must be a positive number if set.", true);
    return;
  }
  if (mode === "task" && !taskInput) {
    setBenchStatus("Task input JSONL path is required.", true);
    return;
  }
  if (mode === "task" && (!Number.isFinite(taskTemperature) || taskTemperature < 0)) {
    setBenchStatus("Task temperature must be >= 0.", true);
    return;
  }
  if (mode === "task" && (!Number.isFinite(taskMaxTokens) || taskMaxTokens <= 0)) {
    setBenchStatus("Task max_tokens must be > 0.", true);
    return;
  }

  btnRun.disabled = true;
  resultsEl.textContent = "";
  setBenchStatus(mode === "task" ? "Running task benchmark…" : "Running benchmark…");

  const started = Date.now();
  const tick = window.setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    if (mode === "load") {
      setBenchStatus(
        `Running benchmark… ${s}s (waiting for the dashboard API; it finishes all ${Math.floor(requests)} request(s) to ${providerLabel()} first). Open DevTools → Network → POST …/benchmark if this stays pending.`,
      );
    } else {
      setBenchStatus(
        `Running task benchmark… ${s}s (evaluating task JSONL through ${providerLabel()} chat completions).`,
      );
    }
  }, 1000);

  const ac = new AbortController();
  const kill = window.setTimeout(() => ac.abort(), BENCHMARK_FETCH_TIMEOUT_MS);

  try {
    const body: Record<string, unknown> =
      mode === "load"
        ? {
            model,
            message,
            concurrency: Math.floor(concurrency),
            requests: Math.floor(requests),
            ...(max_tokens !== undefined ? { max_tokens: Math.floor(max_tokens) } : {}),
          }
        : {
            model,
            input: taskInput,
            temperature: taskTemperature,
            max_tokens: Math.floor(taskMaxTokens),
          };

    const res = await fetch(withProviderQuery(mode === "load" ? "/api/benchmark" : "/api/benchmark/task"), {
      method: "POST",
      headers: withProviderHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    const rawText = await res.text();
    let data: unknown;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      setBenchStatus(
        `Non-JSON response (HTTP ${res.status}). Is the dashboard API running (port 8787 with \`npm run dev\`)? Body: ${rawText.slice(0, 180)}`,
        true,
      );
      return;
    }

    if (!res.ok) {
      const err =
        typeof data === "object" && data !== null && "error" in data && data.error !== undefined
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`;
      setBenchStatus(err, true);
      return;
    }
    if (typeof data !== "object" || data === null || !("ok" in data) || (data as { ok?: boolean }).ok !== true) {
      setBenchStatus("Unexpected response from benchmark API.", true);
      return;
    }

    if (mode === "load") {
      const result = data as BenchmarkOk;
      resultsEl.textContent = formatResults(result);
      const entry: BenchHistoryEntry = {
        mode: "load",
        at: new Date().toISOString(),
        model: result.model,
        requests: result.requests,
        concurrency: result.concurrency,
        throughputRps: result.throughputRps,
        p95: result.p95,
        failures: result.failures,
      };
      renderDiff(entry);
      appendHistory(entry);
      renderHistory();
      setBenchStatus(`Done — ${result.successes} ok, ${result.failures} failed.`);
    } else {
      const result = data as TaskBenchmarkOk;
      resultsEl.textContent = formatTaskResults(result);
      const entry: BenchHistoryEntry = {
        mode: "task",
        at: new Date().toISOString(),
        model: result.model,
        input: result.input,
        cases: result.cases,
        passRate: result.passRate,
        failed: result.failed,
        wallTimeMs: result.wallTimeMs,
      };
      renderDiff(entry);
      appendHistory(entry);
      renderHistory();
      setBenchStatus(
        `Done — pass rate ${(result.passRate * 100).toFixed(2)}% (${result.passed}/${result.cases}).`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      setBenchStatus(
        `Benchmark HTTP timed out after ${BENCHMARK_FETCH_TIMEOUT_MS / 1000}s. Check that ${providerLabel()} is up and consider fewer requests, lower concurrency, or lower max_tokens (large max_tokens makes each completion much slower).`,
        true,
      );
    } else {
      setBenchStatus(e instanceof Error ? e.message : String(e), true);
    }
  } finally {
    window.clearInterval(tick);
    window.clearTimeout(kill);
    btnRun.disabled = false;
  }
}

export function initBenchmark(): void {
  btnRun?.addEventListener("click", () => void runBenchmark());
  modeEl?.addEventListener("change", () => setModeUI());
  setModeUI();
  renderHistory();
}
