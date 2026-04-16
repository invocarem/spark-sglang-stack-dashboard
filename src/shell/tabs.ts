/** Tab strip for the main column: Starter, Logs, Tools, Metrics, Benchmark. */

export type ShellTabId = "starter" | "logs" | "docker" | "metrics" | "benchmark";

export type ShellTabsOptions = {
  /** Fired when the user switches to the Metrics tab (first load / refresh). */
  onMetricsTabSelect: () => void | Promise<void>;
  /** Optional: refresh log tail when opening the Logs tab. */
  onLogsTabSelect?: () => void | Promise<void>;
  /** Optional: e.g. lazy-load benchmark-only resources. */
  onBenchmarkTabSelect?: () => void | Promise<void>;
};

export function initShellTabs(options: ShellTabsOptions): void {
  const { onMetricsTabSelect, onLogsTabSelect, onBenchmarkTabSelect } = options;
  const tabStarter = document.querySelector<HTMLButtonElement>("#tab-starter");
  const tabLogs = document.querySelector<HTMLButtonElement>("#tab-logs");
  const tabDocker = document.querySelector<HTMLButtonElement>("#tab-docker");
  const tabMetrics = document.querySelector<HTMLButtonElement>("#tab-metrics");
  const tabBenchmark = document.querySelector<HTMLButtonElement>("#tab-benchmark");
  const panelStarter = document.querySelector<HTMLDivElement>("#panel-starter");
  const panelLogs = document.querySelector<HTMLDivElement>("#panel-logs");
  const panelDocker = document.querySelector<HTMLDivElement>("#panel-docker");
  const panelMetrics = document.querySelector<HTMLDivElement>("#panel-metrics");
  const panelBenchmark = document.querySelector<HTMLDivElement>("#panel-benchmark");

  function selectTab(which: ShellTabId): void {
    const starterOn = which === "starter";
    const logsOn = which === "logs";
    const dockerOn = which === "docker";
    const metricsOn = which === "metrics";
    const benchmarkOn = which === "benchmark";

    tabStarter?.setAttribute("aria-selected", starterOn ? "true" : "false");
    tabLogs?.setAttribute("aria-selected", logsOn ? "true" : "false");
    tabDocker?.setAttribute("aria-selected", dockerOn ? "true" : "false");
    tabMetrics?.setAttribute("aria-selected", metricsOn ? "true" : "false");
    tabBenchmark?.setAttribute("aria-selected", benchmarkOn ? "true" : "false");

    panelStarter?.classList.toggle("hidden", !starterOn);
    panelLogs?.classList.toggle("hidden", !logsOn);
    panelDocker?.classList.toggle("hidden", !dockerOn);
    panelMetrics?.classList.toggle("hidden", !metricsOn);
    panelBenchmark?.classList.toggle("hidden", !benchmarkOn);

    if (panelStarter) panelStarter.hidden = !starterOn;
    if (panelLogs) panelLogs.hidden = !logsOn;
    if (panelDocker) panelDocker.hidden = !dockerOn;
    if (panelMetrics) panelMetrics.hidden = !metricsOn;
    if (panelBenchmark) panelBenchmark.hidden = !benchmarkOn;

    if (logsOn && onLogsTabSelect) {
      void onLogsTabSelect();
    }
    if (metricsOn) {
      void onMetricsTabSelect();
    }
    if (benchmarkOn && onBenchmarkTabSelect) {
      void onBenchmarkTabSelect();
    }
  }

  tabStarter?.addEventListener("click", () => selectTab("starter"));
  tabLogs?.addEventListener("click", () => selectTab("logs"));
  tabDocker?.addEventListener("click", () => selectTab("docker"));
  tabMetrics?.addEventListener("click", () => selectTab("metrics"));
  tabBenchmark?.addEventListener("click", () => selectTab("benchmark"));

  selectTab("starter");
}
