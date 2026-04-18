export type MonitorProvider = "sglang" | "vllm";

const STORAGE_KEY = "monitor-provider";
const CHANGE_EVENT = "monitor-provider-changed";
const DEFAULT_PROVIDER: MonitorProvider = "sglang";

const selProvider = document.querySelector<HTMLSelectElement>("#sel-provider");
const statusProvider = document.querySelector<HTMLSpanElement>("#status-provider");
const btnResetLog = document.querySelector<HTMLButtonElement>("#btn-footer-reset-log");

function normalizeProvider(input: string | null | undefined): MonitorProvider {
  return DEFAULT_PROVIDER;
}

export function getMonitorProvider(): MonitorProvider {
  try {
    return normalizeProvider(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PROVIDER;
  }
}

export function setMonitorProvider(next: MonitorProvider): void {
  const value = normalizeProvider(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore storage failures (e.g. privacy mode).
  }
  window.dispatchEvent(new CustomEvent<MonitorProvider>(CHANGE_EVENT, { detail: value }));
}

export function onMonitorProviderChange(listener: (provider: MonitorProvider) => void): void {
  window.addEventListener(CHANGE_EVENT, (ev: Event) => {
    const custom = ev as CustomEvent<MonitorProvider>;
    listener(normalizeProvider(custom.detail));
  });
}

function updateFooter(provider: MonitorProvider): void {
  if (selProvider) selProvider.value = provider;
  if (btnResetLog) {
    btnResetLog.textContent = provider === "vllm" ? "Reset vLLM log" : "Reset SGLang log";
  }
  if (!statusProvider) return;
  if (provider === "vllm") {
    statusProvider.textContent = "vLLM selected. Metrics/config supported; chat and benchmark may be limited.";
    return;
  }
  statusProvider.textContent = "SGLang selected.";
}

export function withProviderQuery(path: string): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("provider", getMonitorProvider());
  return `${url.pathname}${url.search}`;
}

export function withProviderHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    "x-monitor-provider": getMonitorProvider(),
  };
}

export function initProviderFooter(): void {
  const current = getMonitorProvider();
  updateFooter(current);
  selProvider?.addEventListener("change", () => {
    const value = normalizeProvider(selProvider.value);
    setMonitorProvider(value);
  });
  onMonitorProviderChange((provider) => {
    updateFooter(provider);
  });
  btnResetLog?.addEventListener("click", () => {
    if (!btnResetLog || !statusProvider) return;
    const provider = getMonitorProvider();
    const providerLabel = provider === "vllm" ? "vLLM" : "SGLang";
    const ok = window.confirm(`Reset ${providerLabel} launch log now?`);
    if (!ok) return;
    void (async () => {
      btnResetLog.disabled = true;
      statusProvider.textContent = `Resetting ${providerLabel} launch log...`;
      statusProvider.classList.remove("error");
      try {
        const res = await fetch(withProviderQuery("/api/launch/log/reset"), {
          method: "POST",
          headers: withProviderHeaders({ "Content-Type": "application/json" }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          provider?: string;
        };
        if (!res.ok || body.ok !== true) {
          statusProvider.textContent = body.error ?? `Reset failed (HTTP ${res.status}).`;
          statusProvider.classList.add("error");
          return;
        }
        statusProvider.textContent = `${providerLabel} launch log reset.`;
        statusProvider.classList.remove("error");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusProvider.textContent = msg;
        statusProvider.classList.add("error");
      } finally {
        btnResetLog.disabled = false;
      }
    })();
  });
}
