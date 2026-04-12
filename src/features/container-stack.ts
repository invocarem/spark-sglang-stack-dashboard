/**
 * Container tab: start/stop stack presets on the host (`docker run` / start / stop). Each preset mirrors
 * `containers/sglang/*.sh` or `containers/vllm/run-docker.sh`; the server uses a detached main process
 * for the Launch tab. Use the shell scripts directly for `-it … bash`.
 */

import { type MonitorProvider, getMonitorProvider, onMonitorProviderChange, withProviderQuery } from "../app/provider";
import {
  getStoredStackLaunchMode,
  setStoredStackLaunchMode,
  STACK_LAUNCH_MODE_EVENT,
  type StackLaunchMode,
} from "../app/stack-launch-mode";

type StackPreset = {
  id: string;
  label: string;
  containerName: string;
  image: string;
};

type ContainerRow = {
  Names: string;
  Image: string;
  State: string;
};

const selPreset = document.querySelector<HTMLSelectElement>("#sel-stack-preset");
const btnRun = document.querySelector<HTMLButtonElement>("#btn-stack-run");
const btnStop = document.querySelector<HTMLButtonElement>("#btn-stack-stop");
const btnRefresh = document.querySelector<HTMLButtonElement>("#btn-stack-refresh");
const statusEl = document.querySelector<HTMLParagraphElement>("#status-stack");
const containerScriptLabel = document.querySelector<HTMLElement>("#container-script-label");
const containerLaunchScriptLabel = document.querySelector<HTMLElement>("#container-launch-script-label");
const stackModeWrap = document.querySelector<HTMLElement>("#container-stack-mode-wrap");
const radioStackModeSingle = document.querySelector<HTMLInputElement>("#radio-stack-mode-single");
const radioStackModeCluster = document.querySelector<HTMLInputElement>("#radio-stack-mode-cluster");

let presets: StackPreset[] = [];

function setStackModeRadios(mode: StackLaunchMode): void {
  if (!radioStackModeSingle || !radioStackModeCluster) return;
  if (mode === "single") {
    radioStackModeSingle.checked = true;
  } else {
    radioStackModeCluster.checked = true;
  }
}

/** When localStorage is unset, infer from API defaults (matches Launch tab first load). */
async function syncStackModeRadiosFromServerAndStorage(): Promise<void> {
  if (getMonitorProvider() !== "sglang" || !stackModeWrap) return;
  try {
    const res = await fetch(withProviderQuery("/api/launch/cluster-defaults"));
    const body = (await res.json()) as {
      applyCluster?: boolean;
      monitorClusterApplySetInEnv?: boolean;
    };
    if (!res.ok) {
      stackModeWrap.hidden = false;
      stackModeWrap.style.display = "";
      const stored = getStoredStackLaunchMode();
      setStackModeRadios(stored ?? "single");
      return;
    }

    if (body.monitorClusterApplySetInEnv === true) {
      stackModeWrap.hidden = true;
      stackModeWrap.style.display = "none";
      return;
    }

    stackModeWrap.hidden = false;
    stackModeWrap.style.display = "";

    const stored = getStoredStackLaunchMode();
    let inferred: StackLaunchMode = "single";
    if (body.applyCluster === true) inferred = "cluster";
    const mode = stored ?? inferred;
    setStackModeRadios(mode);
  } catch {
    if (stackModeWrap) {
      stackModeWrap.hidden = false;
      stackModeWrap.style.display = "";
      const stored = getStoredStackLaunchMode();
      setStackModeRadios(stored ?? "single");
    }
  }
}

function updateStackModeVisibility(provider: MonitorProvider): void {
  if (!stackModeWrap) return;
  if (provider === "vllm") {
    stackModeWrap.hidden = true;
    stackModeWrap.style.display = "none";
    return;
  }
  void syncStackModeRadiosFromServerAndStorage();
}

function updateContainerCopy(provider: MonitorProvider): void {
  if (containerScriptLabel) {
    containerScriptLabel.textContent =
      provider === "vllm"
        ? "containers/vllm/run-docker*.sh"
        : "containers/sglang/run-docker*.sh";
  }
  if (containerLaunchScriptLabel) {
    containerLaunchScriptLabel.textContent =
      provider === "vllm" ? "scripts/vllm/*.sh" : "scripts/sglang/*.sh";
  }
  updateStackModeVisibility(provider);
}

function stripSlashName(names: string): string {
  const n = names.trim().split(/\s+/)[0] ?? "";
  return n.startsWith("/") ? n.slice(1) : n;
}

function selectedPreset(): StackPreset | undefined {
  const id = selPreset?.value.trim();
  if (!id) return undefined;
  return presets.find((p) => p.id === id);
}

function setStatus(message: string, isError = false): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setToolbarBusy(busy: boolean): void {
  if (btnRun) btnRun.disabled = busy;
  if (btnStop) btnStop.disabled = busy;
  if (btnRefresh) btnRefresh.disabled = busy;
}

function imageMatches(actual: string, expected: string): boolean {
  const a = actual.trim();
  const e = expected.trim();
  return a === e || a.startsWith(`${e}@`);
}

async function selectDefaultPresetFromRunningContainer(): Promise<void> {
  if (!selPreset || presets.length === 0) return;
  try {
    const res = await fetch("/api/containers");
    const body = (await res.json()) as { containers?: ContainerRow[] };
    if (!res.ok) return;
    const rows = body.containers ?? [];
    if (rows.length === 0) return;

    // Prefer exact running container-name match first.
    for (const p of presets) {
      const row = rows.find((r) => stripSlashName(r.Names) === p.containerName);
      if (row) {
        selPreset.value = p.id;
        return;
      }
    }

    // If name does not match, fall back to image match.
    for (const p of presets) {
      const row = rows.find((r) => imageMatches(r.Image, p.image));
      if (row) {
        selPreset.value = p.id;
        return;
      }
    }
  } catch {
    // Keep current selection on lookup failures.
  }
}

async function loadPresets(): Promise<void> {
  if (!selPreset) return;
  try {
    const res = await fetch(withProviderQuery("/api/stack/presets"));
    const body = (await res.json()) as { presets?: StackPreset[]; error?: string };
    if (!res.ok) {
      selPreset.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = body.error ?? "Failed to load presets";
      selPreset.appendChild(opt);
      setStatus(body.error ?? "Could not load stack presets.", true);
      return;
    }
    presets = body.presets ?? [];
    selPreset.innerHTML = "";
    if (presets.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no presets)";
      selPreset.appendChild(opt);
      setStatus("No stack presets configured on the server.");
      return;
    }
    for (const p of presets) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.label} (${p.containerName})`;
      selPreset.appendChild(opt);
    }
    await selectDefaultPresetFromRunningContainer();
    await syncStackModeRadiosFromServerAndStorage();
    setStatus("Pick a preset, then start or stop the host container.");
  } catch (e) {
    selPreset.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(error)";
    selPreset.appendChild(opt);
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
}

async function refreshStatus(): Promise<void> {
  const p = selectedPreset();
  if (!p) {
    setStatus("Select a preset.", true);
    return;
  }
  try {
    const res = await fetch("/api/containers");
    const body = (await res.json()) as { containers?: ContainerRow[]; error?: string };
    if (!res.ok) {
      setStatus(body.error ?? `Could not list containers (${res.status}).`, true);
      return;
    }
    const rows = body.containers ?? [];
    const row = rows.find((r) => stripSlashName(r.Names) === p.containerName);
    if (row) {
      setStatus(
        `Running — ${p.containerName} (${row.Image}), state: ${row.State}. Open the Launch tab to run a script inside it.`,
      );
    } else {
      setStatus(
        `Not running — ${p.containerName} is not in docker ps. Use Start to create or run it.`,
      );
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
}

async function runStack(): Promise<void> {
  const p = selectedPreset();
  if (!p) {
    setStatus("Select a preset.", true);
    return;
  }
  setToolbarBusy(true);
  setStatus(`Starting ${p.containerName}…`);
  try {
    const res = await fetch("/api/stack/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: p.id }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      message?: string;
      error?: string;
      stderr?: string;
    };
    if (!res.ok) {
      const parts = [body.error ?? `HTTP ${res.status}`];
      if (body.stderr) parts.push(body.stderr);
      setStatus(parts.join(" — "), true);
      return;
    }
    setStatus(body.message ?? "Started.");
    await refreshStatus();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    setToolbarBusy(false);
  }
}

async function stopStack(): Promise<void> {
  const p = selectedPreset();
  if (!p) {
    setStatus("Select a preset.", true);
    return;
  }
  setToolbarBusy(true);
  setStatus(`Stopping ${p.containerName}…`);
  try {
    const res = await fetch("/api/stack/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ container: p.containerName }),
    });
    const body = (await res.json()) as { ok?: boolean; message?: string; error?: string; stderr?: string };
    if (!res.ok) {
      const parts = [body.error ?? `HTTP ${res.status}`];
      if (body.stderr) parts.push(body.stderr);
      setStatus(parts.join(" — "), true);
      return;
    }
    setStatus(body.message ?? "Stopped.");
    await refreshStatus();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    setToolbarBusy(false);
  }
}

export function initContainerStack(): void {
  updateContainerCopy(getMonitorProvider());
  radioStackModeSingle?.addEventListener("change", () => {
    if (radioStackModeSingle?.checked) setStoredStackLaunchMode("single");
  });
  radioStackModeCluster?.addEventListener("change", () => {
    if (radioStackModeCluster?.checked) setStoredStackLaunchMode("cluster");
  });
  window.addEventListener(STACK_LAUNCH_MODE_EVENT, () => {
    const m = getStoredStackLaunchMode();
    if (m) setStackModeRadios(m);
  });
  selPreset?.addEventListener("change", () => void refreshStatus());
  btnRun?.addEventListener("click", () => void runStack());
  btnStop?.addEventListener("click", () => void stopStack());
  btnRefresh?.addEventListener("click", () => void refreshStatus());
  onMonitorProviderChange(() => {
    updateContainerCopy(getMonitorProvider());
    void (async () => {
      await loadPresets();
      await refreshStatus();
    })();
  });
  void (async () => {
    await loadPresets();
    await refreshStatus();
  })();
}
