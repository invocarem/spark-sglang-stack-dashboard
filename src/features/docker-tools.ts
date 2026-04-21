/**
 * Tools tab: host `docker logs` / `docker inspect` plus launch script log tails.
 * Most useful here is launch script output (`/api/launch/log?lines=50`) for model loading.
 */

import { pickPreferredContainer } from "./container-preferences";
import { getMonitorProvider, onMonitorProviderChange, withProviderQuery } from "../app/provider";
import { getPreferredModel, onPreferredModelChange } from "../sglang/model-prefs";

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
const fieldTransfer = document.querySelector<HTMLDivElement>("#field-transfer");
const fieldTransferExtra = document.querySelector<HTMLDivElement>("#field-transfer-extra");
const selTransferRole = document.querySelector<HTMLSelectElement>("#sel-transfer-role");
const inputTransferModelDir = document.querySelector<HTMLInputElement>("#input-transfer-model-dir");
const inputTransferMasterAddr = document.querySelector<HTMLInputElement>("#input-transfer-master-addr");
const inputTransferMasterPort = document.querySelector<HTMLInputElement>("#input-transfer-master-port");
const selTransferTimeout = document.querySelector<HTMLSelectElement>("#sel-transfer-timeout");
const fieldTransferWorkerSrc = document.querySelector<HTMLLabelElement>("#field-transfer-worker-src");
const inputTransferWorkerSrc = document.querySelector<HTMLInputElement>("#input-transfer-worker-src");
const fieldTransferAllFiles = document.querySelector<HTMLLabelElement>("#field-transfer-all-files");
const chkTransferAllFiles = document.querySelector<HTMLInputElement>("#chk-transfer-all-files");
const fieldDownload = document.querySelector<HTMLDivElement>("#field-download");
const inputDownloadModelId = document.querySelector<HTMLInputElement>("#input-download-model-id");
const inputDownloadSaveDir = document.querySelector<HTMLInputElement>("#input-download-save-dir");
const selDownloadTimeout = document.querySelector<HTMLSelectElement>("#sel-download-timeout");
const fieldBenchmark = document.querySelector<HTMLDivElement>("#field-benchmark");
const inputBenchBaseUrl = document.querySelector<HTMLInputElement>("#input-bench-base-url");
const inputBenchBackend = document.querySelector<HTMLInputElement>("#input-bench-backend");
const inputBenchDataset = document.querySelector<HTMLInputElement>("#input-bench-dataset");
const inputBenchNumPrompts = document.querySelector<HTMLInputElement>("#input-bench-num-prompts");
const inputBenchRandomIn = document.querySelector<HTMLInputElement>("#input-bench-random-in");
const inputBenchRandomOut = document.querySelector<HTMLInputElement>("#input-bench-random-out");
const inputBenchMaxConcurrency = document.querySelector<HTMLInputElement>("#input-bench-max-concurrency");
const inputBenchModel = document.querySelector<HTMLInputElement>("#input-bench-model");
const inputBenchHfModel = document.querySelector<HTMLInputElement>("#input-bench-hf-model");
const inputBenchTokenizer = document.querySelector<HTMLInputElement>("#input-bench-tokenizer");
const textareaBenchExtraBody = document.querySelector<HTMLTextAreaElement>("#textarea-bench-extra-body");
const selBenchTimeout = document.querySelector<HTMLSelectElement>("#sel-bench-timeout");
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

type ToolsMode = "tools" | "diagnostics" | "transfer" | "download" | "benchmark";

function getToolsMode(): ToolsMode {
  const v = selMode?.value;
  if (v === "diagnostics") return "diagnostics";
  if (v === "transfer") return "transfer";
  if (v === "download") return "download";
  if (v === "benchmark") return "benchmark";
  return "tools";
}

function isDiagnosticsMode(): boolean {
  return getToolsMode() === "diagnostics";
}

function isTransferMode(): boolean {
  return getToolsMode() === "transfer";
}

function isDownloadMode(): boolean {
  return getToolsMode() === "download";
}

function isBenchmarkMode(): boolean {
  return getToolsMode() === "benchmark";
}

function syncTransferRoleSubfields(): void {
  const worker = selTransferRole?.value === "worker";
  fieldTransferWorkerSrc?.classList.toggle("hidden", !worker);
  fieldTransferAllFiles?.classList.toggle("hidden", worker);
}

function setToolsModeUI(mode: ToolsMode): void {
  const diagnostics = mode === "diagnostics";
  const transfer = mode === "transfer";
  const download = mode === "download";
  const benchmark = mode === "benchmark";
  const tools = mode === "tools";

  fieldToolSelect?.classList.toggle("hidden", diagnostics || transfer || download || benchmark);
  fieldDiagPreset?.classList.toggle("hidden", !diagnostics);
  fieldDiagCommand?.classList.toggle("hidden", !diagnostics);
  fieldDiagTimeout?.classList.toggle("hidden", !diagnostics);
  fieldTransfer?.classList.toggle("hidden", !transfer);
  fieldTransferExtra?.classList.toggle("hidden", !transfer);
  fieldDownload?.classList.toggle("hidden", !download);
  fieldBenchmark?.classList.toggle("hidden", !benchmark);

  if (tools) {
    syncPipeProbeVisibility();
  } else {
    fieldPipeProbe?.classList.add("hidden");
  }
  if (transfer) {
    syncTransferRoleSubfields();
  }

  if (!btnRun) return;
  if (transfer) btnRun.textContent = "Start transfer";
  else if (download) btnRun.textContent = "Download model";
  else if (benchmark) btnRun.textContent = "Run benchmark";
  else if (diagnostics) btnRun.textContent = "Run diagnostics";
  else btnRun.textContent = "Run";
}

function syncPipeProbeVisibility(): void {
  const show =
    getToolsMode() === "tools" && selTool?.value === PIPE_PROBE_TOOL_ID;
  fieldPipeProbe?.classList.toggle("hidden", !show);
}

function prefillTransferModelDirFromPrefs(): void {
  const m = getPreferredModel().trim();
  if (m.startsWith("/") && inputTransferModelDir && !inputTransferModelDir.value.trim()) {
    inputTransferModelDir.value = m;
  }
}

function prefillDownloadModelIdFromPrefs(): void {
  const m = getPreferredModel().trim();
  if (
    m.includes("/") &&
    !m.startsWith("/") &&
    inputDownloadModelId &&
    !inputDownloadModelId.value.trim()
  ) {
    inputDownloadModelId.value = m;
  }
}

function prefillBenchServedModelFromPrefs(): void {
  const m = getPreferredModel().trim();
  if (
    inputBenchModel &&
    !inputBenchModel.value.trim() &&
    m.includes("/") &&
    !m.startsWith("/")
  ) {
    inputBenchModel.value = m;
  }
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
  if (isTransferMode()) {
    const modelDir = inputTransferModelDir?.value.trim() ?? "";
    const masterAddr = inputTransferMasterAddr?.value.trim() ?? "";
    const masterPortRaw = Number(inputTransferMasterPort?.value ?? 29500);
    const role = selTransferRole?.value === "worker" ? "worker" : "master";
    const timeoutMsRaw = Number(selTransferTimeout?.value ?? 3_600_000);
    const workerSrc = inputTransferWorkerSrc?.value.trim() || "/tmp/.model_transfer_unused";
    const allFiles = chkTransferAllFiles?.checked === true;

    if (!modelDir) {
      setDockerStatus("Enter the model directory (HF weights folder inside the container).", true);
      return;
    }
    if (!masterAddr) {
      setDockerStatus("Enter the master address (IP or hostname the worker uses to reach the sender).", true);
      return;
    }

    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.trunc(timeoutMsRaw) : 3_600_000;
    const masterPort =
      Number.isFinite(masterPortRaw) && masterPortRaw >= 1 && masterPortRaw <= 65535
        ? Math.trunc(masterPortRaw)
        : 29500;

    setDockerStatus(`Starting HF transfer (${role}) in ${container}…`);
    btnRun.disabled = true;
    outEl.textContent = "";
    if (outMetaEl) {
      outMetaEl.textContent = "—";
      outMetaEl.classList.add("hidden");
    }

    const t0 = Date.now();
    const tick = window.setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setDockerStatus(`HF transfer (${role}) in ${container}… ${s}s (live output below)`);
    }, 1000);

    try {
      const res = await fetch("/api/model-transfer/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          container,
          role,
          modelDir,
          masterAddr,
          masterPort,
          worldSize: 2,
          workerSrcDir: workerSrc,
          allFiles,
          timeoutMs,
        }),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        setDockerStatus(errBody.error ?? `Run failed (${res.status})`, true);
        return;
      }

      const hostLog = res.headers.get("X-Monitor-Tool-Log")?.trim() ?? "";

      const reader = res.body?.getReader();
      if (!reader) {
        setDockerStatus("No response body from server.", true);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let outAcc = "";
      let endEvent: {
        exitCode: number | null;
        timedOut: boolean;
        truncated: boolean;
        durationMs: number;
      } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: {
            kind?: string;
            stream?: string;
            text?: string;
            exitCode?: number | null;
            timedOut?: boolean;
            truncated?: boolean;
            durationMs?: number;
            message?: string;
          };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          if (ev.kind === "chunk" && typeof ev.text === "string") {
            outAcc += ev.text;
            outEl.textContent = normalizeProbeText(outAcc).trimEnd() || "…";
          } else if (ev.kind === "end") {
            endEvent = {
              exitCode: ev.exitCode ?? null,
              timedOut: ev.timedOut === true,
              truncated: ev.truncated === true,
              durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
            };
          } else if (ev.kind === "error" && typeof ev.message === "string") {
            setDockerStatus(ev.message, true);
            return;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer) as {
            kind?: string;
            text?: string;
            exitCode?: number | null;
            timedOut?: boolean;
            truncated?: boolean;
            durationMs?: number;
          };
          if (ev.kind === "chunk" && typeof ev.text === "string") {
            outAcc += ev.text;
            outEl.textContent = normalizeProbeText(outAcc).trimEnd() || "(No output.)";
          } else if (ev.kind === "end") {
            endEvent = {
              exitCode: ev.exitCode ?? null,
              timedOut: ev.timedOut === true,
              truncated: ev.truncated === true,
              durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
            };
          }
        } catch {
          /* ignore trailing garbage */
        }
      }

      outEl.textContent = normalizeProbeText(outAcc).trim() || "(No output.)";
      if (outMetaEl && endEvent) {
        const metaLines = [
          `hostLog: ${hostLog || "—"}`,
          `container: ${container}`,
          `role: ${role}`,
          `modelDir: ${modelDir}`,
          `master: ${masterAddr}:${String(masterPort)}`,
          `exitCode: ${String(endEvent.exitCode ?? "null")}`,
          `durationMs: ${String(endEvent.durationMs ?? "n/a")}`,
          `timedOut: ${endEvent.timedOut ? "yes" : "no"}`,
          `truncated: ${endEvent.truncated ? "yes" : "no"}`,
        ];
        outMetaEl.textContent = metaLines.join("\n");
        outMetaEl.classList.remove("hidden");
      }

      const ok = endEvent !== null && endEvent.exitCode === 0 && !endEvent.timedOut;
      if (!endEvent) {
        setDockerStatus("Transfer ended without status from server.", true);
        return;
      }
      setDockerStatus(
        endEvent.timedOut
          ? "Transfer timed out (increase timeout if the model is large)."
          : ok
            ? "Transfer finished."
            : "Transfer finished with errors (see output).",
        endEvent.timedOut || !ok,
      );
    } catch (e) {
      outEl.textContent = "";
      if (outMetaEl) {
        outMetaEl.textContent = "—";
        outMetaEl.classList.add("hidden");
      }
      setDockerStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      window.clearInterval(tick);
      btnRun.disabled = false;
    }
    return;
  }

  if (isDownloadMode()) {
    const modelId = inputDownloadModelId?.value.trim() ?? "";
    const saveDir = inputDownloadSaveDir?.value.trim() || "/data/hf";
    const timeoutMsRaw = Number(selDownloadTimeout?.value ?? 3_600_000);

    if (!modelId) {
      setDockerStatus("Enter the Hugging Face model id (e.g. org/name).", true);
      return;
    }

    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.trunc(timeoutMsRaw) : 3_600_000;

    setDockerStatus(`Downloading ${modelId} in ${container}…`);
    btnRun.disabled = true;
    outEl.textContent = "";
    if (outMetaEl) {
      outMetaEl.textContent = "—";
      outMetaEl.classList.add("hidden");
    }

    const t0 = Date.now();
    const tick = window.setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setDockerStatus(`Downloading ${modelId} in ${container}… ${s}s (live output below)`);
    }, 1000);

    try {
      const res = await fetch("/api/model-download/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          container,
          modelId,
          saveDir,
          timeoutMs,
        }),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        setDockerStatus(errBody.error ?? `Run failed (${res.status})`, true);
        return;
      }

      const hostLog = res.headers.get("X-Monitor-Tool-Log")?.trim() ?? "";

      const reader = res.body?.getReader();
      if (!reader) {
        setDockerStatus("No response body from server.", true);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let outAcc = "";
      let endEvent: {
        exitCode: number | null;
        timedOut: boolean;
        truncated: boolean;
        durationMs: number;
      } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: {
            kind?: string;
            stream?: string;
            text?: string;
            exitCode?: number | null;
            timedOut?: boolean;
            truncated?: boolean;
            durationMs?: number;
            message?: string;
          };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          if (ev.kind === "chunk" && typeof ev.text === "string") {
            outAcc += ev.text;
            outEl.textContent = normalizeProbeText(outAcc).trimEnd() || "…";
          } else if (ev.kind === "end") {
            endEvent = {
              exitCode: ev.exitCode ?? null,
              timedOut: ev.timedOut === true,
              truncated: ev.truncated === true,
              durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
            };
          } else if (ev.kind === "error" && typeof ev.message === "string") {
            setDockerStatus(ev.message, true);
            return;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer) as {
            kind?: string;
            text?: string;
            exitCode?: number | null;
            timedOut?: boolean;
            truncated?: boolean;
            durationMs?: number;
          };
          if (ev.kind === "chunk" && typeof ev.text === "string") {
            outAcc += ev.text;
            outEl.textContent = normalizeProbeText(outAcc).trimEnd() || "(No output.)";
          } else if (ev.kind === "end") {
            endEvent = {
              exitCode: ev.exitCode ?? null,
              timedOut: ev.timedOut === true,
              truncated: ev.truncated === true,
              durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
            };
          }
        } catch {
          /* ignore trailing garbage */
        }
      }

      outEl.textContent = normalizeProbeText(outAcc).trim() || "(No output.)";
      if (outMetaEl && endEvent) {
        const metaLines = [
          `hostLog: ${hostLog || "—"}`,
          `container: ${container}`,
          `modelId: ${modelId}`,
          `saveDir: ${saveDir}`,
          `exitCode: ${String(endEvent.exitCode ?? "null")}`,
          `durationMs: ${String(endEvent.durationMs ?? "n/a")}`,
          `timedOut: ${endEvent.timedOut ? "yes" : "no"}`,
          `truncated: ${endEvent.truncated ? "yes" : "no"}`,
        ];
        outMetaEl.textContent = metaLines.join("\n");
        outMetaEl.classList.remove("hidden");
      }

      const ok = endEvent !== null && endEvent.exitCode === 0 && !endEvent.timedOut;
      if (!endEvent) {
        setDockerStatus("Download ended without status from server.", true);
        return;
      }
      setDockerStatus(
        endEvent.timedOut
          ? "Download timed out (increase timeout for large models)."
          : ok
            ? "Download finished."
            : "Download finished with errors (see output).",
        endEvent.timedOut || !ok,
      );
    } catch (e) {
      outEl.textContent = "";
      if (outMetaEl) {
        outMetaEl.textContent = "—";
        outMetaEl.classList.add("hidden");
      }
      setDockerStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      window.clearInterval(tick);
      btnRun.disabled = false;
    }
    return;
  }

  if (isBenchmarkMode()) {
    const baseUrl = inputBenchBaseUrl?.value.trim() ?? "";
    const backend = inputBenchBackend?.value.trim() ?? "";
    const datasetName = inputBenchDataset?.value.trim() ?? "";
    const numPromptsRaw = Number(inputBenchNumPrompts?.value ?? "10");
    const randomInRaw = Number(inputBenchRandomIn?.value ?? "128");
    const randomOutRaw = Number(inputBenchRandomOut?.value ?? "128");
    const maxConcRaw = inputBenchMaxConcurrency?.value.trim() ?? "";
    const model = inputBenchModel?.value.trim() ?? "";
    const hfModel = inputBenchHfModel?.value.trim() ?? "";
    const tokenizer = inputBenchTokenizer?.value.trim() ?? "";
    const extraBody = textareaBenchExtraBody?.value.trim() ?? "";
    const timeoutMsRaw = Number(selBenchTimeout?.value ?? 3_600_000);

    if (!baseUrl) {
      setDockerStatus("Enter the API base URL (e.g. http://127.0.0.1:30000).", true);
      return;
    }
    if (!Number.isFinite(numPromptsRaw) || numPromptsRaw < 1 || numPromptsRaw > 1_000_000) {
      setDockerStatus("Num prompts must be between 1 and 1000000.", true);
      return;
    }
    if (!Number.isFinite(randomInRaw) || randomInRaw < 1 || randomInRaw > 1_000_000) {
      setDockerStatus("Random input length must be between 1 and 1000000.", true);
      return;
    }
    if (!Number.isFinite(randomOutRaw) || randomOutRaw < 1 || randomOutRaw > 1_000_000) {
      setDockerStatus("Random output length must be between 1 and 1000000.", true);
      return;
    }

    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.trunc(timeoutMsRaw) : 3_600_000;

    let maxConcurrency: number | null = null;
    if (maxConcRaw) {
      const n = Number(maxConcRaw);
      if (!Number.isFinite(n) || n < 1 || n > 65_535) {
        setDockerStatus("Max concurrency must be between 1 and 65535, or leave empty for unlimited.", true);
        return;
      }
      maxConcurrency = Math.trunc(n);
    }

    setDockerStatus(`Running benchmark_sglang.py in ${container}…`);
    btnRun.disabled = true;
    outEl.textContent = "";
    if (outMetaEl) {
      outMetaEl.textContent = "—";
      outMetaEl.classList.add("hidden");
    }

    const t0 = Date.now();
    const tick = window.setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setDockerStatus(`Benchmark in ${container}… ${s}s (live output below)`);
    }, 1000);

    try {
      const res = await fetch("/api/benchmark-sglang/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          container,
          baseUrl,
          backend,
          datasetName,
          numPrompts: Math.trunc(numPromptsRaw),
          randomInputLen: Math.trunc(randomInRaw),
          randomOutputLen: Math.trunc(randomOutRaw),
          maxConcurrency,
          model,
          hfModel,
          tokenizer,
          extraRequestBody: extraBody || null,
          timeoutMs,
        }),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        setDockerStatus(errBody.error ?? `Run failed (${res.status})`, true);
        return;
      }

      const hostLog = res.headers.get("X-Monitor-Tool-Log")?.trim() ?? "";

      const reader = res.body?.getReader();
      if (!reader) {
        setDockerStatus("No response body from server.", true);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let outAcc = "";
      let endEvent: {
        exitCode: number | null;
        timedOut: boolean;
        truncated: boolean;
        durationMs: number;
      } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: {
            kind?: string;
            stream?: string;
            text?: string;
            exitCode?: number | null;
            timedOut?: boolean;
            truncated?: boolean;
            durationMs?: number;
            message?: string;
          };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          if (ev.kind === "chunk" && typeof ev.text === "string") {
            outAcc += ev.text;
            outEl.textContent = normalizeProbeText(outAcc).trimEnd() || "…";
          } else if (ev.kind === "end") {
            endEvent = {
              exitCode: ev.exitCode ?? null,
              timedOut: ev.timedOut === true,
              truncated: ev.truncated === true,
              durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
            };
          } else if (ev.kind === "error" && typeof ev.message === "string") {
            setDockerStatus(ev.message, true);
            return;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer) as {
            kind?: string;
            text?: string;
            exitCode?: number | null;
            timedOut?: boolean;
            truncated?: boolean;
            durationMs?: number;
          };
          if (ev.kind === "chunk" && typeof ev.text === "string") {
            outAcc += ev.text;
            outEl.textContent = normalizeProbeText(outAcc).trimEnd() || "(No output.)";
          } else if (ev.kind === "end") {
            endEvent = {
              exitCode: ev.exitCode ?? null,
              timedOut: ev.timedOut === true,
              truncated: ev.truncated === true,
              durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
            };
          }
        } catch {
          /* ignore trailing garbage */
        }
      }

      outEl.textContent = normalizeProbeText(outAcc).trim() || "(No output.)";
      if (outMetaEl && endEvent) {
        const metaLines = [
          `hostLog: ${hostLog || "—"}`,
          `container: ${container}`,
          `baseUrl: ${baseUrl}`,
          `numPrompts: ${String(numPromptsRaw)}`,
          `exitCode: ${String(endEvent.exitCode ?? "null")}`,
          `durationMs: ${String(endEvent.durationMs ?? "n/a")}`,
          `timedOut: ${endEvent.timedOut ? "yes" : "no"}`,
          `truncated: ${endEvent.truncated ? "yes" : "no"}`,
        ];
        outMetaEl.textContent = metaLines.join("\n");
        outMetaEl.classList.remove("hidden");
      }

      const ok = endEvent !== null && endEvent.exitCode === 0 && !endEvent.timedOut;
      if (!endEvent) {
        setDockerStatus("Benchmark ended without status from server.", true);
        return;
      }
      setDockerStatus(
        endEvent.timedOut
          ? "Benchmark timed out (increase timeout or reduce prompts / output length)."
          : ok
            ? "Benchmark finished."
            : "Benchmark finished with errors (see output).",
        endEvent.timedOut || !ok,
      );
    } catch (e) {
      outEl.textContent = "";
      if (outMetaEl) {
        outMetaEl.textContent = "—";
        outMetaEl.classList.add("hidden");
      }
      setDockerStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      window.clearInterval(tick);
      btnRun.disabled = false;
    }
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
    const mode = getToolsMode();
    setToolsModeUI(mode);
    if (mode === "diagnostics") {
      setDockerStatus("Diagnostics shell enabled. Commands run with docker exec -i … bash -lc.");
    } else if (mode === "transfer") {
      prefillTransferModelDirFromPrefs();
      setDockerStatus(
        "Model transfer (NCCL): start master first, then worker. Log output streams live while model_transfer.py runs.",
      );
    } else if (mode === "download") {
      prefillDownloadModelIdFromPrefs();
      setDockerStatus(
        "Hugging Face download (snapshot_download + live log). Progress lines and disk heartbeats stream below while the job runs.",
      );
    } else if (mode === "benchmark") {
      prefillBenchServedModelFromPrefs();
      setDockerStatus(
        "Runs benchmark_sglang.py (sglang.bench_serving) in the container with your parameters. Output streams below.",
      );
    } else {
      setDockerStatus("Structured tools enabled.");
    }
  });
  selTransferRole?.addEventListener("change", () => {
    syncTransferRoleSubfields();
  });
  selDiagPreset?.addEventListener("change", () => {
    const selected = DIAGNOSTICS_PRESETS.find((p) => p.id === selDiagPreset.value);
    if (selected && inputDiagCommand) inputDiagCommand.value = selected.command;
  });
  onMonitorProviderChange(() => {
    void loadContainers();
  });
  loadDiagnosticsPresets();
  setToolsModeUI("tools");
  prefillTransferModelDirFromPrefs();
  prefillDownloadModelIdFromPrefs();
  prefillBenchServedModelFromPrefs();
  onPreferredModelChange((model) => {
    const m = model.trim();
    if (inputTransferModelDir && !inputTransferModelDir.value.trim() && m.startsWith("/")) {
      inputTransferModelDir.value = m;
    }
    if (
      inputDownloadModelId &&
      !inputDownloadModelId.value.trim() &&
      m.includes("/") &&
      !m.startsWith("/")
    ) {
      inputDownloadModelId.value = m;
    }
    if (
      inputBenchModel &&
      !inputBenchModel.value.trim() &&
      m.includes("/") &&
      !m.startsWith("/")
    ) {
      inputBenchModel.value = m;
    }
  });
  void loadTools();
  void loadContainers();
}
