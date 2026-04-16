/**
 * Tools tab: host `docker logs` / `docker inspect` plus launch script log tails.
 * Most useful here is launch script output (`/api/launch/log?lines=50`) for model loading.
 */

import { pickPreferredContainer } from "./container-preferences";
import { getMonitorProvider, onMonitorProviderChange, withProviderQuery } from "../app/provider";

type ContainerRow = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
};

type ToolInfo = {
  id: string;
  label: string;
  description: string;
  format: "json" | "text";
  needsPipeline?: boolean;
};

type DiagnosticsPreset = {
  id: string;
  label: string;
  command: string;
};

const DEFAULT_TOOL_ID = "collect_env";
const TOOL_LAUNCH_LOG_200 = "launch_log_200";
const PIPE_PROBE_TOOL_ID = "pipe_probe";
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 15000;

/** Must match `WORKSPACE_TOOLS` in server/docker.ts (`/workspace/tools` in container). */
const DIAGNOSTICS_PY = "python3 /workspace/tools/sglang/diagnostics.py";

const DIAGNOSTICS_PRESETS: readonly DiagnosticsPreset[] = [
  {
    id: "quick_health",
    label: "Quick health check",
    command: `${DIAGNOSTICS_PY} quick_health`,
  },
  {
    id: "gpu_status",
    label: "GPU status (nvidia-smi)",
    command: `${DIAGNOSTICS_PY} gpu_status`,
  },
  {
    id: "runtime_processes",
    label: "LLM runtime processes",
    command: `${DIAGNOSTICS_PY} runtime_processes`,
  },
  {
    id: "workspace_logs",
    label: "Workspace + launch logs",
    command: `${DIAGNOSTICS_PY} workspace_logs`,
  },
  {
    id: "python_env",
    label: "Python env summary",
    command: `${DIAGNOSTICS_PY} python_env`,
  },
] as const;

function launchLogPathForProvider(): string {
  return getMonitorProvider() === "vllm"
    ? "/workspace/.monitor/vllm-launch.log"
    : "/workspace/.monitor/sglang-launch.log";
}

function normalizeProbeText(text: string): string {
  if (!text) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Shown when `GET /api/tools` fails; ids must match `apps/monitor/server/docker.ts` `TOOLS`. */
const FALLBACK_PROBE_TOOLS: readonly { id: string; text: string }[] = [
  { id: DEFAULT_TOOL_ID, text: "collect_env.py — Full stack JSON" },
  {
    id: "docker_inspect",
    text: "docker inspect (image labels) — OCI labels (e.g. dev.scitrera.sglang_version)",
  },
];

const sel = document.querySelector<HTMLSelectElement>("#sel-container");
const selTool = document.querySelector<HTMLSelectElement>("#sel-tool");
const selMode = document.querySelector<HTMLSelectElement>("#sel-diagnostics-mode");
const selDiagPreset = document.querySelector<HTMLSelectElement>("#sel-diag-preset");
const selDiagTimeout = document.querySelector<HTMLSelectElement>("#sel-diag-timeout");
const inputDiagCommand = document.querySelector<HTMLTextAreaElement>("#input-diag-command");
const fieldToolSelect = document.querySelector<HTMLLabelElement>("#field-tool-select");
const fieldDiagPreset = document.querySelector<HTMLLabelElement>("#field-diag-preset");
const fieldDiagCommand = document.querySelector<HTMLLabelElement>("#field-diag-command");
const fieldDiagTimeout = document.querySelector<HTMLLabelElement>("#field-diag-timeout");
const fieldPipeProbe = document.querySelector<HTMLDivElement>("#field-pipe-probe");
const inputPipeLeft = document.querySelector<HTMLInputElement>("#input-pipe-left");
const inputPipeRight = document.querySelector<HTMLInputElement>("#input-pipe-right");
const btnRun = document.querySelector<HTMLButtonElement>("#btn-run");
const containerField = document.querySelector<HTMLDivElement>("#docker-container-field");
const statusDocker = document.querySelector<HTMLParagraphElement>("#status-docker");
const outEl = document.querySelector<HTMLPreElement>("#out");
const outMetaEl = document.querySelector<HTMLPreElement>("#out-meta");

function stripSlashName(names: string): string {
  const n = names.trim().split(/\s+/)[0] ?? "";
  return n.startsWith("/") ? n.slice(1) : n;
}

function setDockerStatus(message: string, isError = false): void {
  if (!statusDocker) return;
  statusDocker.textContent = message;
  statusDocker.classList.toggle("error", isError);
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isDiagnosticsMode(): boolean {
  return selMode?.value === "diagnostics";
}

function setDiagnosticsUIVisibility(enabled: boolean): void {
  fieldToolSelect?.classList.toggle("hidden", enabled);
  fieldDiagPreset?.classList.toggle("hidden", !enabled);
  fieldDiagCommand?.classList.toggle("hidden", !enabled);
  fieldDiagTimeout?.classList.toggle("hidden", !enabled);
  if (!enabled) {
    syncPipeProbeVisibility();
  } else {
    fieldPipeProbe?.classList.add("hidden");
  }
  if (!btnRun) return;
  btnRun.textContent = enabled ? "Run diagnostics" : "Run";
}

function syncPipeProbeVisibility(): void {
  const show = !isDiagnosticsMode() && selTool?.value === PIPE_PROBE_TOOL_ID;
  fieldPipeProbe?.classList.toggle("hidden", !show);
}

function formatProbeResponse(body: Record<string, unknown>): string {
  if (typeof body.error === "string" && body.error) {
    return prettyJson(body);
  }
  const fmt = body.format;
  if (fmt === "json" && "data" in body) {
    return prettyJson(body);
  }
  if (fmt === "text") {
    const parts: string[] = [];
    if (typeof body.stdout === "string" && body.stdout) parts.push(normalizeProbeText(body.stdout));
    if (typeof body.stderr === "string" && body.stderr) {
      parts.push("--- stderr ---");
      parts.push(normalizeProbeText(body.stderr));
    }
    if (parts.length === 0) return prettyJson(body);
    return parts.join("\n");
  }
  return prettyJson(body);
}

async function loadTools(): Promise<void> {
  if (!selTool) return;
  try {
    const res = await fetch("/api/tools");
    const body = (await res.json()) as { tools?: ToolInfo[]; error?: string };
    if (!res.ok) {
      selTool.innerHTML = "";
      for (const t of FALLBACK_PROBE_TOOLS) {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = `Fallback: ${t.text}`;
        selTool.appendChild(opt);
      }
      syncPipeProbeVisibility();
      return;
    }
    const tools = body.tools ?? [];
    selTool.innerHTML = "";
    const launchOpt = document.createElement("option");
    launchOpt.value = TOOL_LAUNCH_LOG_200;
    launchOpt.textContent = "Launch script log — last 50 lines";
    selTool.appendChild(launchOpt);
    for (const t of tools) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.label} — ${t.description}`;
      selTool.appendChild(opt);
    }
    selTool.value = TOOL_LAUNCH_LOG_200;
    syncPipeProbeVisibility();
  } catch {
    selTool.innerHTML = "";
    const launchOpt = document.createElement("option");
    launchOpt.value = TOOL_LAUNCH_LOG_200;
    launchOpt.textContent = "Launch script log — last 50 lines";
    selTool.appendChild(launchOpt);
    for (const t of FALLBACK_PROBE_TOOLS) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.text;
      selTool.appendChild(opt);
    }
    syncPipeProbeVisibility();
  }
}

function loadDiagnosticsPresets(): void {
  if (!selDiagPreset) return;
  selDiagPreset.innerHTML = "";
  for (const p of DIAGNOSTICS_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    selDiagPreset.appendChild(opt);
  }
  const first = DIAGNOSTICS_PRESETS[0];
  if (first) {
    selDiagPreset.value = first.id;
    if (inputDiagCommand) inputDiagCommand.value = first.command;
  }
  if (selDiagTimeout) selDiagTimeout.value = String(DEFAULT_DIAGNOSTICS_TIMEOUT_MS);
}

async function loadContainers(): Promise<void> {
  if (!sel) return;
  const previous = sel.value.trim();
  setDockerStatus("Loading containers…");
  try {
    const res = await fetch("/api/containers");
    const body = (await res.json()) as {
      containers?: ContainerRow[];
      error?: string;
    };
    if (!res.ok) {
      setDockerStatus(body.error ?? `Request failed (${res.status})`, true);
      return;
    }
    const rows = body.containers ?? [];
    sel.innerHTML = "";
    if (rows.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no running containers)";
      sel.appendChild(opt);
      if (containerField) containerField.hidden = false;
      const runHint = getMonitorProvider() === "vllm"
        ? "./containers/vllm/run-docker.sh"
        : "./containers/sglang/run-docker.sh";
      setDockerStatus(`No running containers. Start one with ${runHint}`);
      return;
    }
    for (const row of rows) {
      const opt = document.createElement("option");
      const name = stripSlashName(row.Names);
      opt.value = name;
      opt.textContent = `${name} — ${row.Image}`;
      sel.appendChild(opt);
    }
    if (previous && rows.some((row) => stripSlashName(row.Names) === previous)) {
      sel.value = previous;
    } else {
      const preferred = pickPreferredContainer(rows, getMonitorProvider());
      if (preferred) sel.value = preferred;
    }
    if (containerField) containerField.hidden = rows.length <= 1;
    setDockerStatus(`Loaded ${rows.length} container(s).`);
  } catch (e) {
    setDockerStatus(e instanceof Error ? e.message : String(e), true);
  }
}

async function runTool(): Promise<void> {
  if (!sel || !btnRun || !outEl || !selTool) return;
  await loadContainers();
  const container = sel.value.trim();
  if (!container) {
    setDockerStatus("Pick a container first.", true);
    return;
  }
  if (isDiagnosticsMode()) {
    const command = inputDiagCommand?.value.trim() ?? "";
    if (!command) {
      setDockerStatus("Diagnostics command is required.", true);
      return;
    }
    const timeoutMsRaw = Number(selDiagTimeout?.value ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.trunc(timeoutMsRaw)
      : DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
    setDockerStatus(`Running diagnostics in ${container}…`);
    btnRun.disabled = true;
    try {
      const res = await fetch("/api/diagnostics/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          container,
          command,
          timeoutMs,
        }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        exitCode?: number | null;
        stdout?: string;
        stderr?: string;
        timedOut?: boolean;
        truncated?: boolean;
        durationMs?: number;
      };
      const outParts: string[] = [];
      if (typeof body.stdout === "string" && body.stdout) outParts.push(normalizeProbeText(body.stdout));
      if (typeof body.stderr === "string" && body.stderr) {
        outParts.push("--- stderr ---");
        outParts.push(normalizeProbeText(body.stderr));
      }
      outEl.textContent = outParts.join("\n").trim() || "(No output.)";
      if (outMetaEl) {
        const metaLines = [
          `container: ${container}`,
          `command: ${command}`,
          `exitCode: ${String(body.exitCode ?? "null")}`,
          `durationMs: ${String(body.durationMs ?? "n/a")}`,
          `timedOut: ${body.timedOut === true ? "yes" : "no"}`,
          `truncated: ${body.truncated === true ? "yes" : "no"}`,
        ];
        outMetaEl.textContent = metaLines.join("\n");
        outMetaEl.classList.remove("hidden");
      }
      if (!res.ok) {
        setDockerStatus(
          body.error ?? (body.timedOut ? "Diagnostics command timed out." : `Run failed (${res.status})`),
          true,
        );
        return;
      }
      setDockerStatus("Diagnostics command completed.");
    } catch (e) {
      outEl.textContent = "";
      if (outMetaEl) {
        outMetaEl.textContent = "—";
        outMetaEl.classList.add("hidden");
      }
      setDockerStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      btnRun.disabled = false;
    }
    return;
  }

  const tool = selTool.value.trim() || DEFAULT_TOOL_ID;
  if (tool === PIPE_PROBE_TOOL_ID) {
    const left = inputPipeLeft?.value.trim() ?? "";
    const right = inputPipeRight?.value.trim() ?? "";
    if (!left || !right) {
      setDockerStatus("Enter both pipeline commands A and B (e.g. A=env, B=grep NC).", true);
      return;
    }
  }
  setDockerStatus(
    tool === TOOL_LAUNCH_LOG_200
      ? `Loading launch script log in ${container}…`
      : `Running ${tool} in ${container}…`,
  );
  btnRun.disabled = true;
  try {
    if (tool === TOOL_LAUNCH_LOG_200) {
      const res = await fetch(
        withProviderQuery(`/api/launch/log?container=${encodeURIComponent(container)}&lines=50`),
      );
      const body = (await res.json()) as {
        text?: string;
        missing?: boolean;
        error?: string;
      };
      if (!res.ok) {
        outEl.textContent = body.error ?? `HTTP ${res.status}`;
        setDockerStatus("Launch script log request failed.", true);
        return;
      }
      if (body.missing) {
        const logPath = launchLogPathForProvider();
        outEl.textContent =
          `(No launch log file yet. Run a script from the Launch tab once, or the container cannot read ${logPath}.)`;
        setDockerStatus("Launch log file not found.");
        return;
      }
      const text = typeof body.text === "string" ? normalizeProbeText(body.text) : "";
      outEl.textContent = text.trim() ? text : "(Log file is empty.)";
      setDockerStatus(`Launch script log (last 50 lines) — ${container}`);
      if (outMetaEl) {
        outMetaEl.textContent = "—";
        outMetaEl.classList.add("hidden");
      }
      return;
    }

    let probeUrl = `/api/probe?container=${encodeURIComponent(container)}&tool=${encodeURIComponent(tool)}`;
    if (tool === PIPE_PROBE_TOOL_ID) {
      const left = inputPipeLeft?.value.trim() ?? "";
      const right = inputPipeRight?.value.trim() ?? "";
      probeUrl += `&left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`;
    }
    const res = await fetch(probeUrl);
    const body = (await res.json()) as Record<string, unknown>;
    let display = formatProbeResponse(body);
    if (
      res.ok &&
      tool === "docker_logs" &&
      !String((body as { stdout?: string }).stdout ?? "").trim() &&
      !String((body as { stderr?: string }).stderr ?? "").trim()
    ) {
      display = `${display}\n\n---\nOutput may be redirected to /workspace/.monitor/sglang-launch.log. For LLM/load output, open the Logs tab and use “Launch script log”.`;
    }
    outEl.textContent = display;
    if (outMetaEl) {
      outMetaEl.textContent = "—";
      outMetaEl.classList.add("hidden");
    }
    if (!res.ok) {
      setDockerStatus(
        typeof body.error === "string" ? body.error : `Run failed (${res.status})`,
        true,
      );
      return;
    }
    setDockerStatus(`OK — ${tool}`);
  } catch (e) {
    outEl.textContent = "";
    setDockerStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    btnRun.disabled = false;
  }
}

export function initDockerTools(): void {
  btnRun?.addEventListener("click", () => void runTool());
  selTool?.addEventListener("change", () => {
    syncPipeProbeVisibility();
  });
  selMode?.addEventListener("change", () => {
    const diagnostics = isDiagnosticsMode();
    setDiagnosticsUIVisibility(diagnostics);
    setDockerStatus(
      diagnostics
        ? "Diagnostics shell enabled. Commands run with docker exec -i … bash -lc."
        : "Structured tools enabled.",
    );
  });
  selDiagPreset?.addEventListener("change", () => {
    const selected = DIAGNOSTICS_PRESETS.find((p) => p.id === selDiagPreset.value);
    if (selected && inputDiagCommand) inputDiagCommand.value = selected.command;
  });
  onMonitorProviderChange(() => {
    void loadContainers();
  });
  loadDiagnosticsPresets();
  setDiagnosticsUIVisibility(false);
  void loadTools();
  void loadContainers();
}
