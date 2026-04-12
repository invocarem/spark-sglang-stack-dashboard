/** Tab strip for the main column: Container, Launch, Logs, Tools, Metrics, Benchmark. */

export type ShellTabId = "container" | "launch" | "logs" | "docker" | "metrics" | "benchmark";

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
  const tabContainer = document.querySelector<HTMLButtonElement>("#tab-container");
  const tabLaunch = document.querySelector<HTMLButtonElement>("#tab-launch");
  const tabLogs = document.querySelector<HTMLButtonElement>("#tab-logs");
  const tabDocker = document.querySelector<HTMLButtonElement>("#tab-docker");
  const tabMetrics = document.querySelector<HTMLButtonElement>("#tab-metrics");
  const tabBenchmark = document.querySelector<HTMLButtonElement>("#tab-benchmark");
  const panelContainer = document.querySelector<HTMLDivElement>("#panel-container");
  const panelLaunch = document.querySelector<HTMLDivElement>("#panel-launch");
  const panelLogs = document.querySelector<HTMLDivElement>("#panel-logs");
  const panelDocker = document.querySelector<HTMLDivElement>("#panel-docker");
  const panelMetrics = document.querySelector<HTMLDivElement>("#panel-metrics");
  const panelBenchmark = document.querySelector<HTMLDivElement>("#panel-benchmark");

  function selectTab(which: ShellTabId): void {
    const containerOn = which === "container";
    const launchOn = which === "launch";
    const logsOn = which === "logs";
    const dockerOn = which === "docker";
    const metricsOn = which === "metrics";
    const benchmarkOn = which === "benchmark";

    tabContainer?.setAttribute("aria-selected", containerOn ? "true" : "false");
    tabLaunch?.setAttribute("aria-selected", launchOn ? "true" : "false");
    tabLogs?.setAttribute("aria-selected", logsOn ? "true" : "false");
    tabDocker?.setAttribute("aria-selected", dockerOn ? "true" : "false");
    tabMetrics?.setAttribute("aria-selected", metricsOn ? "true" : "false");
    tabBenchmark?.setAttribute("aria-selected", benchmarkOn ? "true" : "false");

    panelContainer?.classList.toggle("hidden", !containerOn);
    panelLaunch?.classList.toggle("hidden", !launchOn);
    panelLogs?.classList.toggle("hidden", !logsOn);
    panelDocker?.classList.toggle("hidden", !dockerOn);
    panelMetrics?.classList.toggle("hidden", !metricsOn);
    panelBenchmark?.classList.toggle("hidden", !benchmarkOn);

    if (panelContainer) panelContainer.hidden = !containerOn;
    if (panelLaunch) panelLaunch.hidden = !launchOn;
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

  tabContainer?.addEventListener("click", () => selectTab("container"));
  tabLaunch?.addEventListener("click", () => selectTab("launch"));
  tabLogs?.addEventListener("click", () => selectTab("logs"));
  tabDocker?.addEventListener("click", () => selectTab("docker"));
  tabMetrics?.addEventListener("click", () => selectTab("metrics"));
  tabBenchmark?.addEventListener("click", () => selectTab("benchmark"));

  selectTab("container");
}
