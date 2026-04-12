/**
 * Metrics tab: `GET /api/metrics` (core API, provider-aware).
 */

import { fetchSglangConfig } from "../sglang/config";
import { getMonitorProvider, withProviderHeaders, withProviderQuery } from "../app/provider";

type MetricsOk = {
  ok: true;
  url: string;
  status: number;
  contentType: string | null;
  highlightLines: string[];
  rawPreview: string;
  rawTruncated: boolean;
  fetchedAt: string;
};

type MetricsErr = {
  ok: false;
  url: string;
  error: string;
  status?: number;
  bodyPreview?: string;
  fetchedAt: string;
};

const metricsConfigEl = document.querySelector<HTMLParagraphElement>("#metrics-config");
const btnMetricsRefresh = document.querySelector<HTMLButtonElement>("#btn-metrics-refresh");
const selMetricsInterval = document.querySelector<HTMLSelectElement>("#sel-metrics-interval");
const statusMetrics = document.querySelector<HTMLParagraphElement>("#status-metrics");
const metricsHighlights = document.querySelector<HTMLPreElement>("#metrics-highlights");
const metricsRaw = document.querySelector<HTMLPreElement>("#metrics-raw");
const chkMetricsRaw = document.querySelector<HTMLInputElement>("#chk-metrics-raw");

let metricsPollTimer: ReturnType<typeof setInterval> | null = null;
let metricsLoadedOnce = false;

function providerLabel(): string {
  return getMonitorProvider() === "vllm" ? "vLLM" : "SGLang";
}

function providerKeyword(): string {
  return getMonitorProvider() === "vllm" ? "vllm" : "sglang";
}

function setMetricsStatus(message: string, isError = false): void {
  if (!statusMetrics) return;
  statusMetrics.textContent = message;
  statusMetrics.classList.toggle("error", isError);
}

function applyRawVisibility(): void {
  if (!metricsRaw || !chkMetricsRaw) return;
  const show = chkMetricsRaw.checked;
  metricsRaw.classList.toggle("hidden", !show);
}

function stopMetricsPoll(): void {
  if (metricsPollTimer !== null) {
    clearInterval(metricsPollTimer);
    metricsPollTimer = null;
  }
}

function startMetricsPollFromUi(): void {
  stopMetricsPoll();
  const ms = Number(selMetricsInterval?.value ?? "0");
  if (!Number.isFinite(ms) || ms <= 0) return;
  metricsPollTimer = setInterval(() => void fetchMetricsDisplay(), ms);
}

async function loadMetricsConfigLine(): Promise<void> {
  if (!metricsConfigEl) return;
  const { ok, config } = await fetchSglangConfig();
  if (!ok) {
    metricsConfigEl.textContent = config.error ?? "Config error";
    return;
  }
  const parts = [
    `Metrics URL: ${config.metricsUrl ?? "—"}`,
    config.inferenceBaseUrl ? ` · Inference: ${config.inferenceBaseUrl}` : "",
    config.hint ? ` — ${config.hint}` : "",
  ];
  metricsConfigEl.textContent = parts.join("");
}

async function fetchMetricsDisplay(): Promise<void> {
  if (!metricsHighlights || !metricsRaw) return;
  setMetricsStatus("Fetching /metrics…");
  if (btnMetricsRefresh) btnMetricsRefresh.disabled = true;
  try {
    const res = await fetch(withProviderQuery("/api/metrics"), {
      headers: withProviderHeaders(),
    });
    const body = (await res.json()) as MetricsOk | MetricsErr;

    if (!body.ok || !res.ok) {
      const err = body as MetricsErr;
      metricsHighlights.textContent = err.bodyPreview
        ? `Error: ${err.error}\n\n--- response body ---\n${err.bodyPreview}`
        : `Error: ${err.error}\nURL: ${err.url}\nTime: ${err.fetchedAt}`;
      metricsRaw.textContent = "—";
      setMetricsStatus(
        `${err.error} (see URL in config). Is ${providerLabel()} running with metrics enabled?`,
        true,
      );
      return;
    }

    const ok = body as MetricsOk;
    const lines = ok.highlightLines;
    metricsHighlights.textContent =
      lines.length > 0
        ? lines.join("\n")
        : `(No lines containing "${providerKeyword()}" in /metrics — server responded but no matching series. Showing status only. HTTP ${ok.status}, ${ok.contentType ?? "unknown content-type"})`;

    let rawText = ok.rawPreview;
    if (ok.rawTruncated) {
      rawText += `\n\n--- truncated (${ok.rawPreview.length} chars shown) ---`;
    }
    metricsRaw.textContent = rawText;
    applyRawVisibility();

    setMetricsStatus(`OK — ${ok.fetchedAt} — ${lines.length} highlighted line(s)`);
  } catch (e) {
    metricsHighlights.textContent = "";
    metricsRaw.textContent = "—";
    setMetricsStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    if (btnMetricsRefresh) btnMetricsRefresh.disabled = false;
  }
}

export async function ensureMetricsSession(): Promise<void> {
  if (metricsLoadedOnce) {
    startMetricsPollFromUi();
    return;
  }
  metricsLoadedOnce = true;
  await loadMetricsConfigLine();
  await fetchMetricsDisplay();
  startMetricsPollFromUi();
}

export function initMetrics(): void {
  btnMetricsRefresh?.addEventListener("click", () => void fetchMetricsDisplay());
  selMetricsInterval?.addEventListener("change", () => {
    startMetricsPollFromUi();
    if (Number(selMetricsInterval?.value ?? "0") > 0) void fetchMetricsDisplay();
  });
  chkMetricsRaw?.addEventListener("change", () => applyRawVisibility());
}
