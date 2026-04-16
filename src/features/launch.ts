/**
 * Starter tab: stack preset + `scripts/<provider>/*.sh`. **Start** calls `POST /api/launch` with `preset` + `script`
 * so the server runs the stack and the shell script in one request.
 * Server status: `GET /api/launch/status` (pgrep, then served model from ps /v1/models).
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
const btnRefreshStatus = document.querySelector<HTMLButtonElement>("#btn-launch-refresh-status");
const btnStopServer = document.querySelector<HTMLButtonElement>("#btn-launch-stop-server");
const btnStopStackPrimary = document.querySelector<HTMLButtonElement>("#btn-launch-stop-stack-primary");
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

type StackPreset = {
  id: string;
  label: string;
  containerName: string;
  image: string;
};

const selStackPreset = document.querySelector<HTMLSelectElement>("#sel-launch-stack-preset");
const btnLaunchStackRefresh = document.querySelector<HTMLButtonElement>("#btn-launch-stack-refresh");
const btnLaunchStackStop = document.querySelector<HTMLButtonElement>("#btn-launch-stack-stop");
const statusLaunchStackEl = document.querySelector<HTMLParagraphElement>("#status-launch-stack");
const launchStackScriptsLabel = document.querySelector<HTMLElement>("#launch-stack-scripts-label");

let stackPresets: StackPreset[] = [];

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
      ? "Starter — vLLM (<code>serve</code>)"
      : "Starter — SGLang (<code>launch_server</code> / <code>sglang serve</code>)";
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
  if (launchStackScriptsLabel) {
    launchStackScriptsLabel.textContent =
      provider === "vllm" ? "containers/vllm/run-docker*.sh" : "containers/sglang/run-docker*.sh";
  }
}

function stripSlashName(names: string): string {
  const n = names.trim().split(/\s+/)[0] ?? "";
  return n.startsWith("/") ? n.slice(1) : n;
}

function imageMatches(actual: string, expected: string): boolean {
  const a = actual.trim();
  const e = expected.trim();
  return a === e || a.startsWith(`${e}@`);
}

function selectedStackPreset(): StackPreset | undefined {
  const id = selStackPreset?.value.trim();
  if (!id) return undefined;
  return stackPresets.find((p) => p.id === id);
}

/** Container for status / Stop (inference): explicit Advanced picker, else preset’s Docker name. */
function statusTargetContainer(): string {
  const fromSelect = selContainer?.value.trim() ?? "";
  if (fromSelect) return fromSelect;
  return selectedStackPreset()?.containerName ?? "";
}

function isStackPresetContainerName(name: string): boolean {
  return stackPresets.some((p) => p.containerName === name);
}

function setStackHostStatus(message: string, isError = false): void {
  if (!statusLaunchStackEl) return;
  statusLaunchStackEl.textContent = message;
  statusLaunchStackEl.classList.toggle("error", isError);
}

function setStackToolbarBusy(busy: boolean): void {
  if (btnLaunchStackRefresh) btnLaunchStackRefresh.disabled = busy;
  if (btnLaunchStackStop) btnLaunchStackStop.disabled = busy;
  if (btnStopStackPrimary) btnStopStackPrimary.disabled = busy;
}

async function selectDefaultStackPresetFromRunningContainer(): Promise<void> {
  if (!selStackPreset || stackPresets.length === 0) return;
  try {
    const res = await fetch("/api/containers");
    const body = (await res.json()) as { containers?: ContainerRow[] };
    if (!res.ok) return;
    const rows = body.containers ?? [];
    if (rows.length === 0) return;

    for (const p of stackPresets) {
      const row = rows.find((r) => stripSlashName(r.Names) === p.containerName);
      if (row) {
        selStackPreset.value = p.id;
        return;
      }
    }

    for (const p of stackPresets) {
      const row = rows.find((r) => imageMatches(r.Image, p.image));
      if (row) {
        selStackPreset.value = p.id;
        return;
      }
    }
  } catch {
    /* keep selection */
  }
}

async function loadStackPresets(): Promise<void> {
  if (!selStackPreset) return;
  try {
    const res = await fetch(withProviderQuery("/api/stack/presets"));
    const body = (await res.json()) as { presets?: StackPreset[]; error?: string };
    if (!res.ok) {
      selStackPreset.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = body.error ?? "Failed to load presets";
      selStackPreset.appendChild(opt);
      setStackHostStatus(body.error ?? "Could not load stack presets.", true);
      return;
    }
    stackPresets = body.presets ?? [];
    selStackPreset.innerHTML = "";
    if (stackPresets.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no presets)";
      selStackPreset.appendChild(opt);
      setStackHostStatus("No stack presets configured on the server.");
      return;
    }
    for (const p of stackPresets) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.label} (${p.containerName})`;
      selStackPreset.appendChild(opt);
    }
    await selectDefaultStackPresetFromRunningContainer();
    setStackHostStatus("Pick a preset; Start will run the stack if needed.");
  } catch (e) {
    selStackPreset.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(error)";
    selStackPreset.appendChild(opt);
    setStackHostStatus(e instanceof Error ? e.message : String(e), true);
  }
}

async function refreshStackHostStatus(): Promise<void> {
  const p = selectedStackPreset();
  if (!p) {
    setStackHostStatus("Select a stack preset.", true);
    return;
  }
  try {
    const res = await fetch("/api/containers");
    const body = (await res.json()) as { containers?: ContainerRow[]; error?: string };
    if (!res.ok) {
      setStackHostStatus(body.error ?? `Could not list containers (${res.status}).`, true);
      return;
    }
    const rows = body.containers ?? [];
    const row = rows.find((r) => stripSlashName(r.Names) === p.containerName);
    if (row) {
      setStackHostStatus(
        `Stack container running — ${p.containerName} (${row.Image}), state: ${row.State}.`,
      );
    } else {
      setStackHostStatus(
        `Stack container not running — ${p.containerName} is not in docker ps. Start will run it.`,
      );
    }
  } catch (e) {
    setStackHostStatus(e instanceof Error ? e.message : String(e), true);
  }
}

async function stopStackHost(): Promise<void> {
  const container = statusTargetContainer();
  if (!container) {
    setStackHostStatus("Pick a stack preset (or a container under Advanced).", true);
    return;
  }
  if (!isStackPresetContainerName(container)) {
    setStackHostStatus(
      `Cannot stop “${container}” here — not a stack preset container. Use Docker directly, or pick a preset container.`,
      true,
    );
    return;
  }
  setStackToolbarBusy(true);
  setStackHostStatus(`Stopping ${container}…`);
  try {
    const res = await fetch("/api/stack/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ container }),
    });
    const body = (await res.json()) as { ok?: boolean; message?: string; error?: string; stderr?: string };
    if (!res.ok) {
      const parts = [body.error ?? `HTTP ${res.status}`];
      if (body.stderr) parts.push(body.stderr);
      setStackHostStatus(parts.join(" — "), true);
      return;
    }
    setStackHostStatus(body.message ?? "Stopped.");
    await refreshStackHostStatus();
    await loadContainers();
  } catch (e) {
    setStackHostStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    setStackToolbarBusy(false);
    updateRunButtonState();
  }
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

/** Apply stored single/cluster preference over cluster checkbox (when `.env` does not override). */
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
  if (!btnRun || !selScript) return;
  const presetId = selStackPreset?.value.trim() ?? "";
  const s = selScript.value.trim();
  const blocked = lastServerRunning === true;
  /** Preset implies a target container name; Start will run the stack if `docker ps` is empty. */
  btnRun.disabled = !presetId || !s || blocked;
  if (blocked) {
    btnRun.title =
      "SGLang appears to be running (last check). Stop SGLang first, or use Advanced to check another container.";
  } else {
    btnRun.removeAttribute("title");
  }
  const target = statusTargetContainer();
  if (btnStopServer) {
    btnStopServer.disabled = !target;
  }
  if (btnStopStackPrimary) {
    const can = Boolean(target && isStackPresetContainerName(target));
    btnStopStackPrimary.disabled = !can;
    if (target && !can) {
      btnStopStackPrimary.title = `“${target}” is not a stack preset container — stop it with Docker, or pick a preset container.`;
    } else {
      btnStopStackPrimary.title =
        "docker stop for the stack container (preset or Advanced target). Stops SGLang too; with --rm the container is removed.";
    }
  }
}

async function refreshLaunchStatus(): Promise<void> {
  const container = statusTargetContainer();
  if (!container) {
    lastServerRunning = null;
    lastServedModel = null;
    setApplyModelButton(false);
    setServerStatusLine("idle", "Pick a stack preset to see SGLang status.", null);
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
        ? `Running — served model: ${lastServedModel}. Start disabled.`
        : `Running — served model not detected yet (Advanced → Check server). Start disabled.`;
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
      setServerStatusLine("ok", "Not running — you can Start a launch script.", body.detail?.trim() || null);
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
  if (!selContainer) return;
  setScriptStatus("Loading containers…");
  if (btnRefresh) btnRefresh.disabled = true;
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
        "No running containers. Choose a preset and click Start — the server creates or starts the stack, then runs the script.",
        null,
      );
      setScriptStatus("No running containers yet (Start will bring up the stack).", true);
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
    const sp = selectedStackPreset();
    const preferred =
      sp && rows.some((r) => stripSlashName(r.Names) === sp.containerName)
        ? sp.containerName
        : pickPreferredContainer(rows, getMonitorProvider());
    if (preferred) selContainer.value = preferred;
    setScriptStatus(`Loaded ${rows.length} container(s).`);
    await refreshLaunchStatus();
  } catch (e) {
    setScriptStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    if (btnRefresh) btnRefresh.disabled = false;
  }
}

async function stopLaunchServer(): Promise<void> {
  const container = statusTargetContainer();
  if (!container) {
    setScriptStatus("Pick a stack preset (or a container under Advanced).", true);
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
  if (!selScript || !btnRun) return;
  const preset = selectedStackPreset();
  if (!preset) {
    setScriptStatus("Pick a stack preset.", true);
    return;
  }
  const script = selScript.value.trim();
  if (!script) {
    setScriptStatus("Pick a launch script.", true);
    return;
  }
  const argOverrides = mergeClusterQuickOverrides(collectLaunchArgsOverrides(script));
  const launchEnv = buildClusterLaunchEnv();

  setScriptStatus(`Starting stack and ${script}…`);
  btnRun.disabled = true;
  try {
    const res = await fetch(withProviderQuery("/api/launch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: preset.id,
        script,
        argOverrides,
        ...(launchEnv ? { launchEnv } : {}),
      }),
    });
    const raw = await res.text();
    let body: {
      ok?: boolean;
      message?: string;
      error?: string;
      stderr?: string;
      conflict?: boolean;
    } = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        const hint =
          raw.trimStart().startsWith("<") || raw.includes("<!DOCTYPE")
            ? " Got HTML instead of JSON — use npm run dev (or vite preview with API on :8787), not a static file server alone."
            : "";
        setScriptStatus(
          `Invalid JSON from server (HTTP ${res.status}).${hint} First bytes: ${raw.slice(0, 160).replace(/\s+/g, " ")}`,
          true,
        );
        return;
      }
    }

    if (!res.ok) {
      const parts = [body.error ?? `HTTP ${res.status}`];
      if (body.stderr) parts.push(body.stderr);
      setScriptStatus(parts.join(" — "), true);
      if (res.status === 409) {
        lastServerRunning = true;
        await refreshLaunchStatus();
      }
      await refreshStackHostStatus();
      return;
    }

    await refreshStackHostStatus();
    await loadContainers();
    if (selContainer && preset.containerName) {
      const c = preset.containerName;
      const hasOption = Array.from(selContainer.options).some((o) => o.value === c);
      if (!hasOption && c) {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        selContainer.appendChild(opt);
      }
      selContainer.value = c;
    }
    await refreshLaunchStatus();

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

export function initStarter(): void {
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
  selStackPreset?.addEventListener("change", () => {
    void refreshStackHostStatus();
    void loadContainers();
  });
  btnLaunchStackRefresh?.addEventListener("click", () => void refreshStackHostStatus());
  btnLaunchStackStop?.addEventListener("click", () => void stopStackHost());
  btnStopStackPrimary?.addEventListener("click", () => void stopStackHost());
  btnRefreshStatus?.addEventListener("click", () =>
    void (async () => {
      if (btnRefreshStatus) btnRefreshStatus.disabled = true;
      try {
        await refreshStackHostStatus();
        await refreshLaunchStatus();
      } finally {
        if (btnRefreshStatus) btnRefreshStatus.disabled = false;
      }
    })(),
  );
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
      await loadStackPresets();
      await refreshStackHostStatus();
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
    await loadStackPresets();
    await refreshStackHostStatus();
    await loadScripts();
    await loadContainers();
  })();
}

/** @deprecated Use `initStarter` */
export const initLaunch = initStarter;
