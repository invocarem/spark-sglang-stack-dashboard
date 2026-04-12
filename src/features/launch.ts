/**
 * Launch tab: run provider scripts (`scripts/sglang/*.sh` or `scripts/vllm/*.sh`)
 * inside the stack container via `docker exec` (detached).
 * Launch server detection: `GET /api/launch/status` (pgrep, then served model from ps /v1/models).
 */

import {
  type MonitorProvider,
  getMonitorProvider,
  onMonitorProviderChange,
  withProviderQuery,
} from "../app/provider";
import {
  getStoredStackLaunchMode,
  setStoredStackLaunchMode,
  STACK_LAUNCH_MODE_EVENT,
} from "../app/stack-launch-mode";
import { getPreferredModel, setPreferredModel } from "../sglang/model-prefs";
import { pickPreferredContainer } from "./container-preferences";

type ContainerRow = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
};

type LaunchScriptInfo = {
  id: string;
  label: string;
  pathInContainer: string;
  launchArgs: LaunchArgPair[];
};

type LaunchArgPair = {
  key: string;
  value: string;
  enabled: boolean;
};

const btnRefresh = document.querySelector<HTMLButtonElement>("#btn-launch-refresh-containers");
const btnCheck = document.querySelector<HTMLButtonElement>("#btn-launch-check-server");
const selContainer = document.querySelector<HTMLSelectElement>("#sel-launch-container");
const selScript = document.querySelector<HTMLSelectElement>("#sel-launch-script");
const launchArgsList = document.querySelector<HTMLDivElement>("#launch-args-list");
const launchArgsEmpty = document.querySelector<HTMLDivElement>("#launch-args-empty");
const btnRun = document.querySelector<HTMLButtonElement>("#btn-launch-run");
const btnStopServer = document.querySelector<HTMLButtonElement>("#btn-launch-stop-server");
const statusServerEl = document.querySelector<HTMLParagraphElement>("#status-launch-server");
const statusDetailEl = document.querySelector<HTMLParagraphElement>("#status-launch-detail");
const statusScriptEl = document.querySelector<HTMLParagraphElement>("#status-launch-script");
const btnApplyModel = document.querySelector<HTMLButtonElement>("#btn-launch-apply-model");
const launchTitle = document.querySelector<HTMLHeadingElement>("#launch-title");
const launchScriptDirLabel = document.querySelector<HTMLElement>("#launch-script-dir-label");
const launchCmdLabel = document.querySelector<HTMLElement>("#launch-cmd-label");
const launchHostDirLabel = document.querySelector<HTMLElement>("#launch-host-dir-label");
const launchContainerDirLabel = document.querySelector<HTMLElement>("#launch-container-dir-label");
const launchLogPathLabel = document.querySelector<HTMLElement>("#launch-log-path-label");
const launchMetricsLabel = document.querySelector<HTMLElement>("#launch-metrics-label");
const launchArgsCmdLabel = document.querySelector<HTMLElement>("#launch-args-cmd-label");
const launchClusterSection = document.querySelector<HTMLElement>("#launch-cluster-section");
const chkLaunchCluster = document.querySelector<HTMLInputElement>("#chk-launch-cluster");
const launchClusterNccl = document.querySelector<HTMLInputElement>("#launch-cluster-nccl");
const launchClusterGloo = document.querySelector<HTMLInputElement>("#launch-cluster-gloo");
const launchClusterMasterAddr = document.querySelector<HTMLInputElement>("#launch-cluster-master-addr");
const launchClusterMasterPort = document.querySelector<HTMLInputElement>("#launch-cluster-master-port");
const launchClusterDistInit = document.querySelector<HTMLInputElement>("#launch-cluster-dist-init");
const launchClusterNnodes = document.querySelector<HTMLInputElement>("#launch-cluster-nnodes");
const launchClusterNodeRank = document.querySelector<HTMLInputElement>("#launch-cluster-node-rank");
const launchClusterFields = document.querySelector<HTMLElement>("#launch-cluster-fields");
const launchClusterSglangCliFields = document.querySelector<HTMLElement>("#launch-cluster-sglang-cli-fields");

/** `true` = pgrep saw SGLang server process; `false` = not running; `null` = not checked or unknown */
let lastServerRunning: boolean | null = null;
let lastServedModel: string | null = null;
const scriptsById = new Map<string, LaunchScriptInfo>();

function updateLaunchCopy(provider: MonitorProvider): void {
  const isVllm = provider === "vllm";
  if (launchClusterSection) {
    launchClusterSection.hidden = false;
  }
  if (launchClusterSglangCliFields) {
    launchClusterSglangCliFields.hidden = isVllm;
  }
  if (launchClusterFields) {
    launchClusterFields.style.opacity = chkLaunchCluster?.checked ? "1" : "0.55";
  }
  if (launchTitle) {
    launchTitle.innerHTML = isVllm
      ? "Launch vLLM (<code>serve</code>)"
      : "Launch SGLang (<code>launch_server</code> / <code>sglang serve</code>)";
  }
  const hostDir = isVllm ? "./scripts/vllm" : "./scripts/sglang";
  const containerDir = isVllm ? "/workspace/scripts/vllm" : "/workspace/scripts/sglang";
  const cmd = isVllm ? "vllm serve" : "python3 -m sglang.launch_server or sglang serve";
  const logPath = isVllm ? "/workspace/.monitor/vllm-launch.log" : "/workspace/.monitor/sglang-launch.log";
  if (launchScriptDirLabel) launchScriptDirLabel.textContent = hostDir;
  if (launchCmdLabel) launchCmdLabel.textContent = cmd;
  if (launchHostDirLabel) launchHostDirLabel.textContent = hostDir;
  if (launchContainerDirLabel) launchContainerDirLabel.textContent = containerDir;
  if (launchLogPathLabel) launchLogPathLabel.textContent = logPath;
  if (launchMetricsLabel) launchMetricsLabel.textContent = isVllm ? "vLLM metrics" : "SGLang metrics";
  if (launchArgsCmdLabel) launchArgsCmdLabel.textContent = cmd;
}

function stripSlashName(names: string): string {
  const n = names.trim().split(/\s+/)[0] ?? "";
  return n.startsWith("/") ? n.slice(1) : n;
}

function setScriptStatus(message: string, isError = false): void {
  if (!statusScriptEl) return;
  statusScriptEl.textContent = message;
  statusScriptEl.classList.toggle("error", isError);
}

function setServerStatusLine(
  kind: "idle" | "loading" | "ok" | "error",
  text: string,
  detail: string | null = null,
): void {
  if (!statusServerEl) return;
  statusServerEl.textContent = text;
  statusServerEl.classList.toggle("error", kind === "error");
  statusServerEl.classList.toggle("launch-server--running", kind === "ok" && lastServerRunning === true);
  if (statusDetailEl) {
    const d = detail?.trim();
    if (d) {
      statusDetailEl.hidden = false;
      statusDetailEl.textContent = d;
    } else {
      statusDetailEl.hidden = true;
      statusDetailEl.textContent = "";
    }
  }
}

function setApplyModelButton(visible: boolean, modelLabel?: string): void {
  if (!btnApplyModel) return;
  btnApplyModel.hidden = !visible;
  btnApplyModel.classList.toggle("hidden", !visible);
  if (visible && modelLabel) {
    btnApplyModel.textContent = `Use “${modelLabel}” for Chat / Benchmark`;
  }
}

function renderLaunchArgs(scriptId: string): void {
  if (!launchArgsList || !launchArgsEmpty) return;
  launchArgsList.innerHTML = "";
  const info = scriptsById.get(scriptId);
  const args = info?.launchArgs ?? [];
  if (args.length === 0) {
    launchArgsEmpty.hidden = false;
    launchArgsEmpty.textContent = "No launch args detected from this script.";
    return;
  }
  launchArgsEmpty.hidden = true;
  for (const [index, arg] of args.entries()) {
    const row = document.createElement("label");
    row.className = "launch-arg-row";
    row.dataset.argIndex = String(index);

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = arg.enabled !== false;
    enabled.className = "launch-arg-enabled";
    enabled.setAttribute("aria-label", `Enable ${arg.key}`);

    const key = document.createElement("code");
    key.textContent = arg.key;
    key.className = "launch-arg-key";

    const value = document.createElement("input");
    value.type = "text";
    value.value = arg.value ?? "";
    value.className = "launch-arg-value";
    value.setAttribute("aria-label", `${arg.key} value`);

    row.appendChild(enabled);
    row.appendChild(key);
    row.appendChild(value);
    launchArgsList.appendChild(row);
  }
}

function collectLaunchArgsOverrides(scriptId: string): LaunchArgPair[] {
  const info = scriptsById.get(scriptId);
  if (!launchArgsList || !info) return [];
  const rows = Array.from(launchArgsList.querySelectorAll<HTMLLabelElement>(".launch-arg-row"));
  return rows.map((row, i) => {
    const key =
      row.querySelector<HTMLElement>(".launch-arg-key")?.textContent?.trim() ??
      info.launchArgs[i]?.key ??
      "";
    const value = row.querySelector<HTMLInputElement>(".launch-arg-value")?.value ?? "";
    const enabled = row.querySelector<HTMLInputElement>(".launch-arg-enabled")?.checked ?? true;
    return { key, value, enabled };
  });
}

/** When cluster mode is on, merge dist / nnodes / node-rank from the cluster form into launch arg pairs. */
/** Prefer UI overrides; fall back to script defaults from `/api/launch-scripts`. */
function servedModelNameFromLaunchArgs(
  scriptId: string,
  argOverrides: LaunchArgPair[],
): string | null {
  const pick = (pairs: LaunchArgPair[]): string | null => {
    for (const p of pairs) {
      if (p.key !== "--served-model-name") continue;
      if (p.enabled === false) continue;
      const v = p.value?.trim() ?? "";
      if (v) return v;
    }
    return null;
  };
  return pick(argOverrides) ?? pick(scriptsById.get(scriptId)?.launchArgs ?? []);
}

function mergeClusterQuickOverrides(pairs: LaunchArgPair[]): LaunchArgPair[] {
  if (!chkLaunchCluster?.checked) return pairs;
  const out = pairs.map((p) => ({ ...p }));
  const set = (key: string, value: string): void => {
    if (!value) return;
    const i = out.findIndex((p) => p.key === key);
    if (i >= 0) out[i] = { ...out[i], value, enabled: true };
    else out.push({ key, value, enabled: true });
  };

  const provider = getMonitorProvider();
  if (provider === "vllm") {
    const masterAddr = launchClusterMasterAddr?.value?.trim() ?? "";
    const masterPort = launchClusterMasterPort?.value?.trim() ?? "";
    const nnodes = launchClusterNnodes?.value?.trim() ?? "";
    const nodeRank = launchClusterNodeRank?.value?.trim() ?? "";
    set("--master-addr", masterAddr);
    set("--master-port", masterPort);
    set("--nnodes", nnodes);
    set("--node-rank", nodeRank);
    return out;
  }

  const distInit = launchClusterDistInit?.value?.trim() ?? "";
  const nnodes = launchClusterNnodes?.value?.trim() ?? "";
  const nodeRank = launchClusterNodeRank?.value?.trim() ?? "";
  set("--dist-init-addr", distInit);
  set("--nnodes", nnodes);
  set("--node-rank", nodeRank);
  return out;
}

/** When true, `MONITOR_CLUSTER_APPLY` is set in `.env` — Launch follows API only; ignore localStorage for cluster checkbox. */
let clusterDefaultsDeferToEnvOnly = false;

async function applyClusterDefaultsFromEnvFile(): Promise<void> {
  const provider = getMonitorProvider();
  if (provider !== "sglang" && provider !== "vllm") {
    clusterDefaultsDeferToEnvOnly = false;
    return;
  }
  try {
    const res = await fetch(withProviderQuery("/api/launch/cluster-defaults"));
    const body = (await res.json()) as {
      launchEnv?: Record<string, string>;
      distInit?: string;
      nnodes?: string;
      nodeRank?: string;
      applyCluster?: boolean;
      monitorClusterApplySetInEnv?: boolean;
    };
    if (!res.ok) return;

    clusterDefaultsDeferToEnvOnly = body.monitorClusterApplySetInEnv === true;

    const setIfEmpty = (el: HTMLInputElement | null, value: string | undefined): void => {
      if (!el || !(value && value.trim())) return;
      if (!el.value.trim()) el.value = value.trim();
    };

    const le = body.launchEnv ?? {};
    setIfEmpty(launchClusterNccl, le.NCCL_SOCKET_IFNAME);
    setIfEmpty(launchClusterGloo, le.GLOO_SOCKET_IFNAME);
    setIfEmpty(launchClusterMasterAddr, le.MASTER_ADDR);
    setIfEmpty(launchClusterMasterPort, le.MASTER_PORT);
    if (provider === "sglang") {
      setIfEmpty(launchClusterDistInit, body.distInit);
    }
    if (provider === "sglang" || provider === "vllm") {
      setIfEmpty(launchClusterNnodes, body.nnodes);
      setIfEmpty(launchClusterNodeRank, body.nodeRank);
    }

    if (chkLaunchCluster) {
      if (clusterDefaultsDeferToEnvOnly) {
        chkLaunchCluster.checked = body.applyCluster === true;
        if (launchClusterFields) {
          launchClusterFields.style.opacity = chkLaunchCluster.checked ? "1" : "0.55";
        }
      } else if (body.applyCluster === true) {
        chkLaunchCluster.checked = true;
        if (launchClusterFields) {
          launchClusterFields.style.opacity = "1";
        }
      }
    }
  } catch {
    /* optional: dev server down or old API */
  }
}

/** Apply Container tab / localStorage preference over cluster checkbox. */
function applyStoredStackLaunchModeToClusterUI(): void {
  const provider = getMonitorProvider();
  if (
    (provider !== "sglang" && provider !== "vllm") ||
    !chkLaunchCluster ||
    clusterDefaultsDeferToEnvOnly
  ) {
    return;
  }
  const m = getStoredStackLaunchMode();
  if (m === null) return;
  chkLaunchCluster.checked = m === "cluster";
  if (launchClusterFields) {
    launchClusterFields.style.opacity = chkLaunchCluster.checked ? "1" : "0.55";
  }
}

function buildClusterLaunchEnv(): Record<string, string> | undefined {
  if (!chkLaunchCluster?.checked) return undefined;
  const env: Record<string, string> = {};
  const put = (name: string, el: HTMLInputElement | null): void => {
    const v = el?.value?.trim() ?? "";
    if (v) env[name] = v;
  };
  put("NCCL_SOCKET_IFNAME", launchClusterNccl);
  put("GLOO_SOCKET_IFNAME", launchClusterGloo);
  put("MASTER_ADDR", launchClusterMasterAddr);
  put("MASTER_PORT", launchClusterMasterPort);
  return Object.keys(env).length > 0 ? env : undefined;
}

function updateRunButtonState(): void {
  if (!btnRun || !selContainer || !selScript) return;
  const c = selContainer.value.trim();
  const s = selScript.value.trim();
  const blocked = lastServerRunning === true;
  btnRun.disabled = !c || !s || blocked;
  if (blocked) {
    btnRun.title = "A launch server appears to be running in this container (last check). Stop it or pick another container.";
  } else {
    btnRun.removeAttribute("title");
  }
  if (btnStopServer) {
    btnStopServer.disabled = !c;
  }
}

async function refreshLaunchStatus(): Promise<void> {
  if (!selContainer) return;
  const container = selContainer.value.trim();
  if (!container) {
    lastServerRunning = null;
    lastServedModel = null;
    setApplyModelButton(false);
    setServerStatusLine("idle", "Select a container and script.", null);
    updateRunButtonState();
    return;
  }

  setServerStatusLine("loading", `Checking ${container}…`, null);
  if (btnCheck) btnCheck.disabled = true;
  if (btnStopServer) btnStopServer.disabled = true;
  try {
    const res = await fetch(
      withProviderQuery(`/api/launch/status?container=${encodeURIComponent(container)}`),
    );
    const body = (await res.json()) as {
      running?: boolean | null;
      detail?: string | null;
      servedModel?: string | null;
      error?: string;
    };

    if (!res.ok) {
      lastServerRunning = null;
      lastServedModel = null;
      setApplyModelButton(false);
      setServerStatusLine(
        "error",
        body.error ?? `Could not check launch server (HTTP ${res.status}).`,
        null,
      );
      updateRunButtonState();
      return;
    }

    if (body.running === null || body.running === undefined) {
      lastServerRunning = null;
      lastServedModel = null;
      setApplyModelButton(false);
      setServerStatusLine("error", body.error ?? "Unexpected status response.", null);
      updateRunButtonState();
      return;
    }

    lastServerRunning = body.running;
    if (body.running) {
      lastServedModel =
        typeof body.servedModel === "string" && body.servedModel.length > 0
          ? body.servedModel
          : null;
      const main = lastServedModel
        ? `Running — served model: ${lastServedModel}. Run script disabled.`
        : `Running — served model not detected yet (retry Check). Run script disabled.`;
      setServerStatusLine("ok", main, body.detail?.trim() || null);
      if (lastServedModel && getPreferredModel().trim() !== lastServedModel) {
        setPreferredModel(lastServedModel);
        setScriptStatus(
          `Model id updated to “${lastServedModel}” for Chat and Benchmark (matches running server).`,
        );
      }
      const needsManualApply =
        lastServedModel !== null && getPreferredModel().trim() !== lastServedModel;
      setApplyModelButton(needsManualApply, lastServedModel ?? undefined);
    } else {
      lastServedModel = null;
      setApplyModelButton(false);
      setServerStatusLine("ok", "Not running — you can run a script.", body.detail?.trim() || null);
    }
    updateRunButtonState();
  } catch (e) {
    lastServerRunning = null;
    lastServedModel = null;
    setApplyModelButton(false);
    setServerStatusLine("error", e instanceof Error ? e.message : String(e), null);
    updateRunButtonState();
  } finally {
    if (btnCheck) btnCheck.disabled = false;
    updateRunButtonState();
  }
}

async function loadScripts(): Promise<void> {
  if (!selScript) return;
  try {
    const res = await fetch(withProviderQuery("/api/launch-scripts"));
    const body = (await res.json()) as {
      scripts?: LaunchScriptInfo[];
      error?: string;
    };
    selScript.innerHTML = "";
    scriptsById.clear();
    const scripts = body.scripts ?? [];
    if (!res.ok) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = body.error ?? "Failed to list scripts";
      selScript.appendChild(opt);
      setScriptStatus(body.error ?? "Could not list scripts for selected provider", true);
      return;
    }
    if (scripts.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      const provider = getMonitorProvider();
      opt.textContent = `(no .sh files in ./scripts/${provider})`;
      selScript.appendChild(opt);
      setScriptStatus(
        `No launch scripts found (repo ./scripts/${provider}). Set MONITOR_REPO_ROOT if the API runs outside the repo.`,
      );
      return;
    }
    for (const s of scripts) {
      scriptsById.set(s.id, s);
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.label} → ${s.pathInContainer}`;
      selScript.appendChild(opt);
    }
    renderLaunchArgs(selScript.value);
    setScriptStatus(`Loaded ${scripts.length} script(s) for ${getMonitorProvider()}.`);
  } catch (e) {
    selScript.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(error)";
    selScript.appendChild(opt);
    setScriptStatus(e instanceof Error ? e.message : String(e), true);
  }
  updateRunButtonState();
}

async function loadContainers(): Promise<void> {
  if (!selContainer || !btnRefresh) return;
  setScriptStatus("Loading containers…");
  btnRefresh.disabled = true;
  try {
    const res = await fetch("/api/containers");
    const body = (await res.json()) as {
      containers?: ContainerRow[];
      error?: string;
    };
    if (!res.ok) {
      setScriptStatus(body.error ?? `Request failed (${res.status})`, true);
      return;
    }
    const rows = body.containers ?? [];
    selContainer.innerHTML = "";
    if (rows.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no running containers)";
      selContainer.appendChild(opt);
      lastServerRunning = null;
      lastServedModel = null;
      setApplyModelButton(false);
      setServerStatusLine(
        "error",
        "No running containers. Start the stack from the Container tab for the selected provider.",
        null,
      );
      setScriptStatus("No running containers.", true);
      updateRunButtonState();
      return;
    }
    for (const row of rows) {
      const opt = document.createElement("option");
      const name = stripSlashName(row.Names);
      opt.value = name;
      opt.textContent = `${name} — ${row.Image}`;
      selContainer.appendChild(opt);
    }
    const preferred = pickPreferredContainer(rows, getMonitorProvider());
    if (preferred) selContainer.value = preferred;
    setScriptStatus(`Loaded ${rows.length} container(s).`);
    await refreshLaunchStatus();
  } catch (e) {
    setScriptStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    btnRefresh.disabled = false;
  }
}

async function stopLaunchServer(): Promise<void> {
  if (!selContainer) return;
  const container = selContainer.value.trim();
  if (!container) {
    setScriptStatus("Pick a container.", true);
    return;
  }
  setScriptStatus("Stopping launch_server…");
  if (btnStopServer) btnStopServer.disabled = true;
  if (btnCheck) btnCheck.disabled = true;
  try {
    const res = await fetch(withProviderQuery("/api/launch/stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ container }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      wasRunning?: boolean;
      message?: string;
      error?: string;
      stderr?: string;
    };
    if (!res.ok) {
      const parts = [body.error ?? `HTTP ${res.status}`];
      if (body.stderr) parts.push(body.stderr);
      setScriptStatus(parts.join(" — "), true);
      await refreshLaunchStatus();
      return;
    }
    setScriptStatus(body.message ?? "Stopped.");
    await refreshLaunchStatus();
  } catch (e) {
    setScriptStatus(e instanceof Error ? e.message : String(e), true);
    await refreshLaunchStatus();
  } finally {
    if (btnCheck) btnCheck.disabled = false;
    updateRunButtonState();
  }
}

async function runLaunchScript(): Promise<void> {
  if (!selContainer || !selScript || !btnRun) return;
  const container = selContainer.value.trim();
  const script = selScript.value.trim();
  if (!container) {
    setScriptStatus("Pick a container.", true);
    return;
  }
  if (!script) {
    setScriptStatus("Pick a launch script.", true);
    return;
  }
  if (lastServerRunning === true) {
    setScriptStatus("Launch server already running—use Check launch server or stop the process first.", true);
    return;
  }
  const argOverrides = mergeClusterQuickOverrides(collectLaunchArgsOverrides(script));
  const launchEnv = buildClusterLaunchEnv();

  setScriptStatus(`Starting ${script} in ${container}…`);
  btnRun.disabled = true;
  try {
    const res = await fetch(withProviderQuery("/api/launch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        container,
        script,
        argOverrides,
        ...(launchEnv ? { launchEnv } : {}),
      }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      message?: string;
      error?: string;
      stderr?: string;
      conflict?: boolean;
    };

    if (!res.ok) {
      const parts = [body.error ?? `HTTP ${res.status}`];
      if (body.stderr) parts.push(body.stderr);
      setScriptStatus(parts.join(" — "), true);
      if (res.status === 409) {
        lastServerRunning = true;
        await refreshLaunchStatus();
      }
      return;
    }

    const overrideHint =
      argOverrides.length > 0 || launchEnv
        ? " Launch args / cluster env applied."
        : "";
    let modelHint = "";
    if (getMonitorProvider() === "vllm") {
      const mid = servedModelNameFromLaunchArgs(script, argOverrides);
      if (mid) {
        setPreferredModel(mid);
        modelHint = ` Model id set to “${mid}” for Chat and Benchmark.`;
      }
    }
    setScriptStatus(
      `${body.message ?? "Started."}${overrideHint}${modelHint} Use the Logs tab (launch script log) to watch output while the model loads.`,
    );
    window.setTimeout(() => void refreshLaunchStatus(), 2000);
  } catch (e) {
    setScriptStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    updateRunButtonState();
  }
}

export function initLaunch(): void {
  updateLaunchCopy(getMonitorProvider());
  btnApplyModel?.addEventListener("click", () => {
    if (!lastServedModel) return;
    setPreferredModel(lastServedModel);
    setScriptStatus(`Model id set to “${lastServedModel}” for Chat and Benchmark.`);
  });
  selContainer?.addEventListener("change", () => {
    void refreshLaunchStatus();
  });
  selScript?.addEventListener("change", () => {
    renderLaunchArgs(selScript.value.trim());
    updateRunButtonState();
  });
  btnRefresh?.addEventListener("click", () => void loadContainers());
  btnCheck?.addEventListener("click", () => void refreshLaunchStatus());
  btnStopServer?.addEventListener("click", () => void stopLaunchServer());
  btnRun?.addEventListener("click", () => void runLaunchScript());
  chkLaunchCluster?.addEventListener("change", () => {
    if (launchClusterFields) {
      launchClusterFields.style.opacity = chkLaunchCluster.checked ? "1" : "0.55";
    }
    const p = getMonitorProvider();
    if ((p === "sglang" || p === "vllm") && chkLaunchCluster && !clusterDefaultsDeferToEnvOnly) {
      setStoredStackLaunchMode(chkLaunchCluster.checked ? "cluster" : "single");
    }
  });
  onMonitorProviderChange(() => {
    updateLaunchCopy(getMonitorProvider());
    lastServerRunning = null;
    lastServedModel = null;
    setApplyModelButton(false);
    void (async () => {
      await applyClusterDefaultsFromEnvFile();
      applyStoredStackLaunchModeToClusterUI();
      await loadScripts();
      await loadContainers();
    })();
  });
  window.addEventListener(STACK_LAUNCH_MODE_EVENT, () => {
    applyStoredStackLaunchModeToClusterUI();
  });
  void (async () => {
    await applyClusterDefaultsFromEnvFile();
    applyStoredStackLaunchModeToClusterUI();
    await loadScripts();
    await loadContainers();
  })();
}
