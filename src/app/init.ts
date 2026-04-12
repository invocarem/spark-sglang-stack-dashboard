/**
 * Browser boot: shell layout + feature modules under `src/features/`.
 * Server handlers live in `server/`; each feature owns its DOM + `/api/...` calls.
 */

import { initSharedModelInputs } from "./model-sync";
import { initProviderFooter } from "./provider";
import { initBenchmark } from "../features/benchmark";
import { initChat } from "../features/chat";
import { initContainerStack } from "../features/container-stack";
import { initDockerTools } from "../features/docker-tools";
import { initLogs, onLogsTabSelected } from "../features/logs";
import { initLaunch } from "../features/launch";
import { ensureMetricsSession, initMetrics } from "../features/metrics";
import { initShellTabs } from "../shell/tabs";

export function initApp(): void {
  initProviderFooter();
  initLogs();
  initContainerStack();
  initShellTabs({
    onMetricsTabSelect: () => void ensureMetricsSession(),
    onLogsTabSelect: () => void onLogsTabSelected(),
  });
  void initSharedModelInputs();
  initLaunch();
  initDockerTools();
  initMetrics();
  initChat();
  initBenchmark();
}
