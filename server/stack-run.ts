/**
 * Host API: start/stop whitelisted stack containers (`docker run`, start, stop).
 * Preset ids and images are defined in `stack-presets.ts`.
 *
 * Each preset mirrors the flags in repo `containers/sglang/run-docker*.sh` (SGLang). 
 * Multi-node: `MONITOR_CLUSTER_APPLY` or `MONITOR_STACK_SGLANG_CLUSTER_RUNTIME=1` adds
 * `--network host`, `--privileged`, optional `/dev/infiniband`, `memlock` ulimit; see `launch-cluster-defaults.ts`.
 *
 * **Starter tab (preset + script):** `launch-scripts.writeMonitorLaunchBundle` writes
 * `.monitor/monitor-launch-<script>.rendered.{body,sh}.sh`; the API runs `docker run … sleep infinity` (PID&nbsp;1 idle),
 * records the exact `docker run` in `.monitor/monitor-stack-<preset>.docker-run.sh`, then `docker exec -d` runs the
 * wrapper (see `.monitor/monitor-launch-<script>.docker-exec.sh`) so SGLang can exit without tearing down the stack.
 *
 * **`POST /api/stack/run` (stack only):** `runStackPreset` in **idle** mode keeps `sleep infinity` so other tools can `docker exec`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeContainerName, dockerHost } from "./docker.js";
import {
  getSglangStackDockerEnvForClusterRun,
  shouldInjectSglangStackClusterDockerEnv,
  shouldUseSglangClusterDockerRuntime,
} from "./launch-cluster-defaults.js";
import { findRepoRoot } from "./repo-root.js";
import {
  getStackPreset,
  STACK_PRESET_CONTAINER_NAMES,
  type StackPreset,
} from "./stack-presets.js";

/** Published host port for SGLang stack presets (maps to container :30000; matches `scripts/sglang/*.sh`). */
function sglangStackHostPort(): string {
  const n = Number(process.env.MONITOR_STACK_HOST_PORT ?? "30000");
  if (!Number.isFinite(n) || n < 1 || n > 65535) return "30000";
  return String(Math.trunc(n));
}

function shmSize(): string {
  const s = process.env.MONITOR_STACK_SHM_SIZE?.trim();
  return s || "32g";
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type WriteMonitorStackDockerRunScriptResult =
  | { ok: true; hostPath: string }
  | { ok: false; error: string };

/**
 * Writes `.monitor/monitor-stack-<preset.id>.docker-run.sh` with the exact `docker` argv used for this stack
 * (flags, `-e` pairs, image, PID&nbsp;1 command) for auditing and manual replay.
 */
export function writeMonitorStackDockerRunScript(
  preset: StackPreset,
  argv: string[],
): WriteMonitorStackDockerRunScriptResult {
  const repoRoot = findRepoRoot();
  const mon = path.join(repoRoot, ".monitor");
  try {
    fs.mkdirSync(mon, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, error: `Could not create ${mon}: ${err.message}` };
  }
  const safeId = preset.id.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const hostPath = path.join(mon, `monitor-stack-${safeId}.docker-run.sh`);
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# Stack: ${preset.label} (${preset.id})`,
    `# Container: ${preset.containerName} | Image: ${preset.image}`,
    `# Generated ${new Date().toISOString()} — refresh via Starter or stack run from the dashboard.`,
    "#",
    "docker \\",
  ];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const isLast = i === argv.length - 1;
    lines.push(`  ${shSingleQuote(a)}${isLast ? "" : " \\"}`);
  }
  lines.push("");
  const content = `${lines.join("\n")}\n`;
  try {
    try {
      fs.unlinkSync(hostPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
    fs.writeFileSync(hostPath, content, { mode: 0o755 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EACCES" || err.code === "EPERM") {
      return {
        ok: false,
        error: `Permission denied writing ${hostPath} (${err.code}). From the repo root: sudo chown -R "$(id -un)" "${mon}"`,
      };
    }
    return { ok: false, error: `Could not write ${hostPath}: ${err.message}` };
  }
  return { ok: true, hostPath };
}

/**
 * `docker` argv (no leading `docker`) for SGLang stack presets — same as `runStackPreset` uses for `docker run`.
 * `mainCommand` is appended after the image (default: `sleep infinity` for idle stack-only mode).
 */
export function buildSglangDockerRunArgv(
  preset: StackPreset,
  mainCommand: string[] = ["sleep", "infinity"],
): string[] {
  const repoRoot = findRepoRoot();
  const localDir = path.join(os.homedir(), "huggingface");
  const hfCache = path.join(os.homedir(), ".cache", "huggingface");
  const shm = shmSize();
  const hostPublish = sglangStackHostPort();
  const containerPublish = "30000";

  const wantClusterDockerEnv = shouldInjectSglangStackClusterDockerEnv();
  const wantClusterRuntime = shouldUseSglangClusterDockerRuntime();
  const presetSupportsCluster = preset.provider === "sglang";
  const clusterStackEnv = wantClusterDockerEnv && presetSupportsCluster;
  const clusterRuntime = wantClusterRuntime && presetSupportsCluster;

  const args: string[] = ["run", "-d", "--gpus", "all"];
  if (clusterRuntime) {
    args.push("--network", "host");
    args.push("--privileged");
    if (fs.existsSync("/dev/infiniband")) {
      args.push("-v", "/dev/infiniband:/dev/infiniband");
    }
    args.push("--ulimit", "memlock=-1:-1");
  }
  args.push(
    "--name",
    preset.containerName,
    "--shm-size",
    shm,
    ...(clusterRuntime ? [] : ["-p", `${hostPublish}:${containerPublish}`]),
    "-v",
    `${hfCache}:/root/.cache/huggingface`,
    "-v",
    `${localDir}:/data/hf`,
     "-v",
    `${repoRoot}:/workspace`,
    "--ipc=host",
    "--rm",
  );
  const token = process.env.HF_TOKEN?.trim();
  if (token) {
    args.push("-e", `HF_TOKEN=${token}`);
  }
  if (clusterStackEnv) {
    for (const [k, v] of Object.entries(getSglangStackDockerEnvForClusterRun())) {
      args.push("-e", `${k}=${v}`);
    }
  }
  for (const e of preset.extraEnv) {
    args.push("-e", e);
  }
  args.push(preset.image, ...mainCommand);
  return args;
}

export type RunStackPresetMode =
  | { kind: "idle" }
  | { kind: "replace"; mainCommand: string[] };

async function containerState(
  name: string,
): Promise<{ kind: "missing" } | { kind: "running" } | { kind: "stopped" }> {
  const r = await dockerHost(["inspect", "-f", "{{.State.Running}}", name]);
  if (r.code !== 0) return { kind: "missing" };
  return r.stdout.trim() === "true" ? { kind: "running" } : { kind: "stopped" };
}

export type RunStackResult =
  | { ok: true; container: string; started: boolean; message: string }
  | { ok: false; error: string; stderr?: string };

export type StackContainerStatus =
  | { ok: true; state: "running"; container: string; image: string }
  | { ok: true; state: "stopped"; container: string }
  | { ok: true; state: "missing"; container: string }
  | { ok: false; error: string };

/** Inspect a whitelisted stack container (running / stopped / missing). */
export async function getStackContainerStatus(containerName: string): Promise<StackContainerStatus> {
  const name = containerName.trim();
  if (!STACK_PRESET_CONTAINER_NAMES.has(name)) {
    return { ok: false, error: "Container name is not a known stack preset." };
  }
  try {
    assertSafeContainerName(name);
  } catch {
    return { ok: false, error: "Invalid container name." };
  }

  const runningProbe = await dockerHost(["inspect", "-f", "{{.State.Running}}", name]);
  if (runningProbe.code !== 0) {
    return { ok: true, state: "missing", container: name };
  }
  if (runningProbe.stdout.trim() !== "true") {
    return { ok: true, state: "stopped", container: name };
  }

  const img = await dockerHost(["inspect", "-f", "{{.Config.Image}}", name]);
  const image = img.code === 0 && img.stdout.trim() ? img.stdout.trim() : "unknown";
  return { ok: true, state: "running", container: name, image };
}

const STACK_LOG_TAIL_MAX = 10_000;

export type StackContainerLogsResult =
  | { ok: true; text: string }
  | { ok: false; error: string; stderr?: string };

/** `docker logs --tail` for a whitelisted stack container. */
export async function getStackContainerLogs(
  containerName: string,
  tailLines: number,
): Promise<StackContainerLogsResult> {
  const name = containerName.trim();
  if (!STACK_PRESET_CONTAINER_NAMES.has(name)) {
    return { ok: false, error: "Container name is not a known stack preset." };
  }
  try {
    assertSafeContainerName(name);
  } catch {
    return { ok: false, error: "Invalid container name." };
  }
  const n = Math.min(Math.max(1, Math.trunc(tailLines)), STACK_LOG_TAIL_MAX);
  const r = await dockerHost(["logs", "--tail", String(n), name]);
  if (r.code !== 0) {
    const err = (r.stderr.trim() || r.stdout.trim()).slice(0, 400);
    return {
      ok: false,
      error: err || `docker logs failed (exit ${r.code ?? "?"})`,
      stderr: r.stderr.trim() || undefined,
    };
  }
  return { ok: true, text: r.stdout };
}

export async function runStackPreset(
  presetId: string,
  mode: RunStackPresetMode = { kind: "idle" },
): Promise<RunStackResult> {
  const preset = getStackPreset(presetId);
  if (!preset) {
    return { ok: false, error: "Unknown stack preset." };
  }
  try {
    assertSafeContainerName(preset.containerName);
  } catch {
    return { ok: false, error: "Invalid container name in preset." };
  }

  if (mode.kind === "replace") {
    if (mode.mainCommand.length === 0) {
      return { ok: false, error: "replace mode requires a non-empty mainCommand." };
    }
    const args = buildSglangDockerRunArgv(preset, mode.mainCommand);
    const recorded = writeMonitorStackDockerRunScript(preset, args);
    if (!recorded.ok) {
      return { ok: false, error: recorded.error };
    }
    await dockerHost(["rm", "-f", preset.containerName]);
    const run = await dockerHost(args);
    if (run.code !== 0) {
      const err = (run.stderr.trim() || run.stdout.trim()).slice(0, 1200);
      return {
        ok: false,
        error: err || `docker run failed (exit ${run.code ?? "?"})`,
        stderr: run.stderr.trim() || undefined,
      };
    }
    const clusterStackEnv = shouldInjectSglangStackClusterDockerEnv() && preset.provider === "sglang";
    const clusterRuntime = shouldUseSglangClusterDockerRuntime() && preset.provider === "sglang";
    const hostPublish = sglangStackHostPort();
    const containerPublish = "30000";
    const scriptHint = path.basename(recorded.hostPath);
    return {
      ok: true,
      container: preset.containerName,
      started: true,
      message: `Created ${preset.containerName}: PID 1 is ${mode.mainCommand.join(" ")}. Exact host \`docker run\` is in .monitor/${scriptHint}.${clusterStackEnv ? " Cluster \`.env\` NCCL/distributed env applied." : ""}${clusterRuntime ? " Cluster runtime: --network host, --privileged, memlock; /dev/infiniband when present." : ` Published ${hostPublish}→${containerPublish}.`} Image: ${preset.image}.`,
    };
  }

  const args = buildSglangDockerRunArgv(preset);
  const recorded = writeMonitorStackDockerRunScript(preset, args);
  if (!recorded.ok) {
    return { ok: false, error: recorded.error };
  }
  const scriptHint = path.basename(recorded.hostPath);

  const state = await containerState(preset.containerName);
  const clusterStackEnv = shouldInjectSglangStackClusterDockerEnv() && preset.provider === "sglang";
  const clusterRuntime = shouldUseSglangClusterDockerRuntime() && preset.provider === "sglang";
  const hostPublish = sglangStackHostPort();
  const containerPublish = "30000";

  if (state.kind === "running") {
    return {
      ok: true,
      container: preset.containerName,
      started: false,
      message: `Container ${preset.containerName} is already running. Refreshed .monitor/${scriptHint}.`,
    };
  }

  if (state.kind === "stopped") {
    const start = await dockerHost(["start", preset.containerName]);
    if (start.code !== 0) {
      const err = (start.stderr.trim() || start.stdout.trim()).slice(0, 800);
      return {
        ok: false,
        error: err || `docker start failed (exit ${start.code ?? "?"})`,
        stderr: start.stderr.trim() || undefined,
      };
    }
    return {
      ok: true,
      container: preset.containerName,
      started: true,
      message: `Started existing container ${preset.containerName}. Refreshed .monitor/${scriptHint}.`,
    };
  }

  const run = await dockerHost(args);
  if (run.code !== 0) {
    const err = (run.stderr.trim() || run.stdout.trim()).slice(0, 1200);
    return {
      ok: false,
      error: err || `docker run failed (exit ${run.code ?? "?"})`,
      stderr: run.stderr.trim() || undefined,
    };
  }

  return {
    ok: true,
    container: preset.containerName,
    started: true,
    message: `Created and started ${preset.containerName} (same flags as ${preset.matchesScript}; PID 1 is sleep infinity for stack-only / exec workflows). Exact host \`docker run\` is in .monitor/${scriptHint}.${clusterStackEnv ? " Cluster \`.env\` NCCL/distributed env applied." : ""}${clusterRuntime ? " Cluster runtime: --network host, --privileged, memlock; /dev/infiniband when present on host." : ""} ${clusterRuntime ? `Host network mode (service port ${containerPublish}).` : `Published ${hostPublish}→${containerPublish}.`} Repo at /workspace.`,
  };
}

export type StopStackResult =
  | { ok: true; message: string }
  | { ok: false; error: string; stderr?: string };

/** Stop a stack container by name (whitelist only — see `STACK_PRESET_CONTAINER_NAMES`). */
export async function stopStackContainer(containerName: string): Promise<StopStackResult> {
  const name = containerName.trim();
  if (!STACK_PRESET_CONTAINER_NAMES.has(name)) {
    return { ok: false, error: "Container name is not a known stack preset." };
  }
  try {
    assertSafeContainerName(name);
  } catch {
    return { ok: false, error: "Invalid container name." };
  }

  const state = await containerState(name);
  if (state.kind === "missing") {
    return { ok: true, message: `No container named ${name}.` };
  }
  if (state.kind === "stopped") {
    return { ok: true, message: `Container ${name} is already stopped.` };
  }

  const stop = await dockerHost(["stop", name]);
  if (stop.code !== 0) {
    const err = (stop.stderr.trim() || stop.stdout.trim()).slice(0, 800);
    return {
      ok: false,
      error: err || `docker stop failed (exit ${stop.code ?? "?"})`,
      stderr: stop.stderr.trim() || undefined,
    };
  }
  return { ok: true, message: `Stopped ${name} (with --rm it may be removed).` };
}
