/**
 * Repo launchers under `scripts/<provider>/*.sh`.
 * The same repo path is used inside the container at `/workspace/...` via bind mount.
 */

import fs from "node:fs";
import path from "node:path";
import {
  assertSafeContainerName,
  dockerExec,
  dockerExecDetached,
  monitorLaunchExecEnv,
} from "./docker.js";
import { fetchInferenceModelIds } from "./sglang.js";
import type { LaunchArgPair, LaunchProvider } from "./launch-types.js";
import { findRepoRoot } from "./repo-root.js";

export type { LaunchArgPair, LaunchProvider } from "./launch-types.js";

const HOST_SCRIPT_DIR_CANDIDATES: Record<LaunchProvider, readonly string[]> = {
  sglang: ["scripts/sglang"]
} as const;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveLaunchScriptDirs(provider: LaunchProvider): { hostDir: string; containerDir: string } | null {
  const roots = [findRepoRoot(), process.cwd()];
  for (const root of roots) {
    for (const rel of HOST_SCRIPT_DIR_CANDIDATES[provider]) {
      const hostDir = path.join(root, rel);
      if (!isDir(hostDir)) continue;
      const containerDir = `/workspace/${rel}`;
      return { hostDir, containerDir };
    }
  }
  return null;
}

/** Path inside the container (see repo README: bind mount at `/workspace`). */
export const CONTAINER_SCRIPTS_DIR: Record<LaunchProvider, string> = {
  sglang: "/workspace/scripts/sglang",
} as const;

/**
 * Launch stdout/stderr are appended here. `docker logs` only shows the container's
 * main process; `docker exec -d` does not feed that log, so we tee to a file for the UI/API.
 */
export const LAUNCH_LOG_PATH: Record<LaunchProvider, string> = {
  sglang: "/workspace/.monitor/sglang-launch.log",
} as const;

const DEFAULT_LAUNCH_LOG_TAIL_LINES = Math.min(
  Math.max(1, Number(process.env.MONITOR_LAUNCH_LOG_TAIL ?? "800")),
  10_000,
);

const BASENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sh$/;

/** First line of a multi-line SGLang server invocation in a shell script. */
const SGLANG_LAUNCH_LINE_RE =
  /python3\s+-m\s+sglang\.launch_server\b|\bsglang\s+serve\b/;

/**
 * `pgrep -f` extended-regex pattern: `python -m sglang.launch_server` or the `sglang serve` CLI.
 * Passed as a single argv (no shell), and embedded in `sh -c` single-quoted snippets.
 */
const SGLANG_PGREP_ERE = String.raw`sglang\.launch_server|sglang serve`;

/**
 * `pgrep -f` extended regex for a running `vllm serve …` process.
 * Use `[v]llm serve` so the pattern does not match the `pgrep` command line itself (which would
 * otherwise contain the literal substring `vllm serve` and falsely report the server as running).
 */
const VLLM_PGREP_ERE = "[v]llm serve";

/** Render terminal CR behavior so progress bars update in-place. */
export function normalizeLaunchLogText(text: string): string {
  if (!text) return text;
  const lines: string[] = [];
  let current = "";
  let cursor = 0;

  const writeChar = (ch: string): void => {
    if (cursor >= current.length) {
      current += ch;
    } else {
      current = `${current.slice(0, cursor)}${ch}${current.slice(cursor + 1)}`;
    }
    cursor += 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\r") {
      if (text[i + 1] === "\n") {
        lines.push(current);
        current = "";
        cursor = 0;
        i += 1;
      } else {
        cursor = 0;
      }
      continue;
    }
    if (ch === "\n") {
      lines.push(current);
      current = "";
      cursor = 0;
      continue;
    }
    writeChar(ch);
  }

  lines.push(current);
  return lines.join("\n");
}

/** Flags merged from the Launch tab cluster section; listed first when appending to a script (SGLang). */
const INJECT_ARG_KEY_ORDER_SGLANG = ["--dist-init-addr", "--nnodes", "--node-rank"] as const;

function injectArgSortIndex(provider: LaunchProvider, key: string): number {
  const idx = INJECT_ARG_KEY_ORDER_SGLANG.indexOf(key as (typeof INJECT_ARG_KEY_ORDER_SGLANG)[number]);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

function collectArgKeysPresentAsLines(lines: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of lines) {
    const m = rawLine.match(/^(\s*)(--[A-Za-z0-9][A-Za-z0-9-]*)(?:\s+.*)?$/);
    if (m) keys.add(m[2] ?? "");
  }
  return keys;
}

function missingEnabledArgOverrides(
  originalLines: readonly string[],
  argOverrides: readonly LaunchArgPair[],
  byKey: Map<string, LaunchArgPair>,
  provider: LaunchProvider,
): LaunchArgPair[] {
  const present = collectArgKeysPresentAsLines(originalLines);
  const out: LaunchArgPair[] = [];
  for (const ov of byKey.values()) {
    if (!ov.enabled || !ov.value.trim()) continue;
    if (present.has(ov.key)) continue;
    out.push(ov);
  }
  return out.sort((a, b) => {
    const ra = injectArgSortIndex(provider, a.key);
    const rb = injectArgSortIndex(provider, b.key);
    if (ra !== rb) return ra - rb;
    return a.key.localeCompare(b.key);
  });
}

function injectMissingArgsIntoRenderedLines(
  updated: string[],
  missing: LaunchArgPair[],
  provider: LaunchProvider,
): string[] {
  if (missing.length === 0) return updated;

  const launchLineRe = SGLANG_LAUNCH_LINE_RE;

  let start = -1;
  for (let i = 0; i < updated.length; i += 1) {
    if (launchLineRe.test(updated[i] ?? "")) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return updated;
  }

  let lastArgLine = -1;
  for (let i = start + 1; i < updated.length; i += 1) {
    if (/^\s+--/.test(updated[i] ?? "")) lastArgLine = i;
  }

  const baseIndent = "    ";
  const insertedLines: string[] = [];
  if (lastArgLine < 0) {
    const first = updated[start] ?? "";
    const t = first.trimEnd();
    const lineWithSlash = t.endsWith("\\") ? t : `${t} \\`;
    for (let j = 0; j < missing.length; j += 1) {
      const m = missing[j]!;
      const isLast = j === missing.length - 1;
      insertedLines.push(
        `${baseIndent}${m.key} ${quoteLaunchArgValue(m.value)}${isLast ? "" : " \\"}`,
      );
    }
    return [...updated.slice(0, start), lineWithSlash, ...insertedLines, ...updated.slice(start + 1)];
  }

  const indentMatch = (updated[lastArgLine] ?? "").match(/^(\s*)--/);
  const indent = indentMatch?.[1] ?? baseIndent;

  const prefix = updated.slice(0, lastArgLine);
  const suffix = updated.slice(lastArgLine + 1);
  const lastLineRaw = updated[lastArgLine] ?? "";
  const lastTrimmed = lastLineRaw.trimEnd();
  const lastWithSlash = lastTrimmed.endsWith("\\") ? lastTrimmed : `${lastTrimmed} \\`;

  const newMiddle: string[] = [];
  for (let j = 0; j < missing.length; j += 1) {
    const m = missing[j]!;
    const isLast = j === missing.length - 1;
    newMiddle.push(`${indent}${m.key} ${quoteLaunchArgValue(m.value)}${isLast ? "" : " \\"}`);
  }

  return [...prefix, lastWithSlash, ...newMiddle, ...suffix];
}

/** Allowed names for optional `export` lines prepended before `bash script.sh` (multi-node NCCL / torch). */
const LAUNCH_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shSingleQuoteForExport(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteLaunchArgValue(value: string): string {
  if (!value.length) return value;
  // Respect explicit shell quoting from the script/UI.
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value;
  }
  // Keep simple token values readable; quote anything shell-sensitive (JSON, spaces, etc.).
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return shSingleQuoteForExport(value);
}

/**
 * Validates env keys/values for `export` before launch. Values are single-quoted in the shell.
 * Returns an error message or `null` if ok.
 */
export function validateLaunchEnv(env: Record<string, string>): string | null {
  const entries = Object.entries(env).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return "Expected at least one non-empty variable";
  for (const [k, v] of entries) {
    if (!LAUNCH_ENV_KEY_RE.test(k)) {
      return `Invalid environment variable name: ${k}`;
    }
    if (v.length > 1024) {
      return `Value for ${k} is too long (max 1024 characters)`;
    }
    if (!/^[\x20-\x7e]*$/.test(v)) {
      return `Value for ${k} must be printable ASCII (no newlines)`;
    }
  }
  return null;
}

export function formatLaunchEnvPrefix(env: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v.length) continue;
    parts.push(`export ${k}=${shSingleQuoteForExport(v)}`);
  }
  return parts.join(" && ");
}

function formatLaunchEnvExportLines(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v.trim()) continue;
    lines.push(`export ${k}=${shSingleQuoteForExport(v.trim())}`);
  }
  return lines.join("\n");
}

/** Apply Starter-tab arg overrides to a launch `.sh` file (same rules as `runLaunchScriptInContainer`). */
export function renderLaunchScriptTextWithArgOverrides(
  scriptText: string,
  argOverrides: LaunchArgPair[] | undefined,
  provider: LaunchProvider,
): string {
  let renderedScript = scriptText;
  if (!argOverrides || argOverrides.length === 0) return renderedScript;
  const lines = renderedScript.split(/\r?\n/);
  const byKey = new Map(argOverrides.map((a) => [a.key, a]));
  const updated = lines.flatMap((rawLine) => {
    const m = rawLine.match(/^(\s*)(--[A-Za-z0-9][A-Za-z0-9-]*)(?:\s+.*)?$/);
    if (!m) return [rawLine];
    const key = m[2] ?? "";
    const ov = byKey.get(key);
    if (!ov) return [rawLine];
    if (!ov.enabled && provider === "sglang" && key === "--enable-metrics") {
      return [rawLine];
    }
    if (!ov.enabled) return [];
    const indent = m[1] ?? "";
    const hasSlash = rawLine.trimEnd().endsWith("\\");
    return [`${indent}${ov.key} ${quoteLaunchArgValue(ov.value)}${hasSlash ? " \\" : ""}`];
  });
  const missing = missingEnabledArgOverrides(lines, argOverrides, byKey, provider);
  const finalLines = injectMissingArgsIntoRenderedLines(updated, missing, provider);
  return `${finalLines.join("\n")}\n`;
}

export type WriteMonitorLaunchBundleResult =
  | { ok: true; containerWrapperPath: string }
  | { ok: false; error: string };

/** Drop existing rendered files so we can recreate them as the dashboard user (avoids EACCES on root-owned bind-mount artifacts). */
function unlinkForRewrite(absPath: string, monitorDir: string): WriteMonitorLaunchBundleResult | null {
  try {
    fs.unlinkSync(absPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    if (err.code === "EACCES" || err.code === "EPERM") {
      return {
        ok: false,
        error: `Permission denied on ${absPath} (${err.code}). Files under .monitor/ are often owned by root after Docker wrote them through the bind mount. Fix once from the repo root: sudo chown -R "$(id -un)" "${monitorDir}"`,
      };
    }
    return { ok: false, error: `Could not replace ${absPath}: ${err.message}` };
  }
  return null;
}

function writeFileSyncMonitor(
  absPath: string,
  content: string,
  mode: number,
  monitorDir: string,
): WriteMonitorLaunchBundleResult | null {
  try {
    fs.writeFileSync(absPath, content, { mode });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EACCES" || err.code === "EPERM") {
      return {
        ok: false,
        error: `Permission denied writing ${absPath} (${err.code}). From the repo root: sudo chown -R "$(id -un)" "${monitorDir}"`,
      };
    }
    return { ok: false, error: `Could not write ${absPath}: ${err.message}` };
  }
  return null;
}

/**
 * Writes `.monitor/monitor-launch-<script>.rendered.body.sh` plus `.rendered.sh` wrapper on the host repo
 * (bind-mounted at `/workspace/.monitor/…`). Used for `docker exec -d … bash /workspace/…/monitor-launch-*.rendered.sh`
 * when PID&nbsp;1 is `sleep infinity` (Starter) or an existing idle stack (Advanced).
 */
export function writeMonitorLaunchBundle(
  provider: LaunchProvider,
  scriptBasename: string,
  argOverrides: LaunchArgPair[] | undefined,
  launchEnv: Record<string, string> | undefined,
): WriteMonitorLaunchBundleResult {
  if (!isAllowedLaunchScript(provider, scriptBasename)) {
    return { ok: false, error: "Unknown or disallowed script" };
  }
  if (
    argOverrides !== undefined &&
    !argOverrides.every(
      (a) =>
        typeof a.key === "string" &&
        a.key.startsWith("--") &&
        a.key.length > 2 &&
        /^[A-Za-z0-9-]+$/.test(a.key.slice(2)) &&
        typeof a.value === "string" &&
        typeof a.enabled === "boolean",
    )
  ) {
    return { ok: false, error: "Invalid argOverrides format" };
  }

  let filteredEnv: Record<string, string> = {};
  if (launchEnv !== undefined && Object.keys(launchEnv).length > 0) {
    for (const [k, v] of Object.entries(launchEnv)) {
      if (typeof k === "string" && typeof v === "string" && v.trim().length > 0) {
        filteredEnv[k.trim()] = v.trim();
      }
    }
    if (Object.keys(filteredEnv).length > 0) {
      const err = validateLaunchEnv(filteredEnv);
      if (err) {
        return { ok: false, error: err };
      }
    } else {
      filteredEnv = {};
    }
  }

  const dirs = resolveLaunchScriptDirs(provider);
  if (!dirs) {
    return {
      ok: false,
      error: `No launch scripts directory found for ${providerName(provider)}. Expected \`scripts/${provider}\` under MONITOR_REPO_ROOT/current repo.`,
    };
  }
  const hostScriptPath = path.join(dirs.hostDir, scriptBasename);
  let raw = "";
  try {
    raw = fs.readFileSync(hostScriptPath, "utf8");
  } catch {
    return { ok: false, error: "Could not read launch script" };
  }
  const body = renderLaunchScriptTextWithArgOverrides(raw, argOverrides, provider);
  const repoRoot = findRepoRoot();
  const mon = path.join(repoRoot, ".monitor");
  fs.mkdirSync(mon, { recursive: true });
  const fileBase = `monitor-launch-${scriptBasename}`;
  const bodyName = `${fileBase}.rendered.body.sh`;
  const wrapName = `${fileBase}.rendered.sh`;
  const hostBodyPath = path.join(mon, bodyName);
  const hostWrapPath = path.join(mon, wrapName);
  for (const p of [hostBodyPath, hostWrapPath]) {
    const u = unlinkForRewrite(p, mon);
    if (u) return u;
  }
  const w1 = writeFileSyncMonitor(hostBodyPath, body, 0o755, mon);
  if (w1) return w1;
  const logPath = LAUNCH_LOG_PATH[provider];
  const bodyContainerPath = `/workspace/.monitor/${bodyName}`;
  const exportBlock = formatLaunchEnvExportLines(filteredEnv);
  const exportSection = exportBlock ? `${exportBlock}\n` : "";
  const wrapper = `#!/usr/bin/env bash
set -euo pipefail
${exportSection}mkdir -p /workspace/.monitor
LOG=${logPath}
printf '%s\\n' "---- $(date +%Y-%m-%dT%H:%M:%S%z) starting ${scriptBasename} ----" >>"$LOG"
cd /workspace
if command -v script >/dev/null 2>&1; then
  script -qefc 'bash ${bodyContainerPath}' - >>"$LOG" 2>&1
else
  bash '${bodyContainerPath}' >>"$LOG" 2>&1
fi
`;
  const w2 = writeFileSyncMonitor(hostWrapPath, wrapper, 0o755, mon);
  if (w2) return w2;
  return { ok: true, containerWrapperPath: `/workspace/.monitor/${wrapName}` };
}

function shSingleQuoteForDockerExec(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes `.monitor/monitor-launch-<script>.docker-exec.sh` documenting the host `docker exec -d` used after
 * `monitor-stack-*.docker-run.sh` (same argv the dashboard runs).
 */
export function writeMonitorDockerExecHelper(
  provider: LaunchProvider,
  opts: {
    scriptBasename: string;
    containerName: string;
    wrapperContainerPath: string;
  },
): WriteMonitorLaunchBundleResult {
  if (!isAllowedLaunchScript(provider, opts.scriptBasename)) {
    return { ok: false, error: "Unknown or disallowed script" };
  }
  try {
    assertSafeContainerName(opts.containerName);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid container name" };
  }
  const wrap = opts.wrapperContainerPath.trim();
  if (!wrap.startsWith("/workspace/.monitor/") || !wrap.endsWith(".rendered.sh")) {
    return { ok: false, error: "Invalid wrapper path" };
  }

  const repoRoot = findRepoRoot();
  const mon = path.join(repoRoot, ".monitor");
  fs.mkdirSync(mon, { recursive: true });
  const name = `monitor-launch-${opts.scriptBasename}.docker-exec.sh`;
  const hostPath = path.join(mon, name);
  const u = unlinkForRewrite(hostPath, mon);
  if (u) return u;

  const logPath = LAUNCH_LOG_PATH[provider];
  const env = monitorLaunchExecEnv();
  const envLines: string[] = [];
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\n\r\0]/.test(v)) continue;
      envLines.push(`  -e ${shSingleQuoteForDockerExec(`${k}=${v}`)} \\`);
    }
  }
  const envBlock = envLines.length > 0 ? `${envLines.join("\n")}\n` : "";
  const script = `#!/usr/bin/env bash
set -euo pipefail
# After the stack exists (PID 1: sleep infinity), run the launch wrapper inside the container.
# Flags / script: monitor-launch-${opts.scriptBasename}.rendered.body.sh — runtime log: ${logPath}
docker exec -d \\
${envBlock}  ${shSingleQuoteForDockerExec(opts.containerName)} \\
  bash ${shSingleQuoteForDockerExec(wrap)}
`;
  const w = writeFileSyncMonitor(hostPath, script, 0o755, mon);
  if (w) return w;
  return { ok: true, containerWrapperPath: wrap };
}

type ScriptMeta = {
  launchArgs: LaunchArgPair[];
};

function parseSimpleAssignments(scriptText: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rawLine of scriptText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1] ?? "";
    let value = (m[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars.set(key, value);
  }
  return vars;
}

function parseLaunchArgsFromScriptText(scriptText: string): LaunchArgPair[] {
  const vars = parseSimpleAssignments(scriptText);
  const lines = scriptText.split(/\r?\n/);
  const out: LaunchArgPair[] = [];
  let inLaunch = false;
  let launchText = "";

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!inLaunch) {
      if (SGLANG_LAUNCH_LINE_RE.test(trimmed) ) {
        inLaunch = true;
      } else {
        continue;
      }
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    launchText += `${rawLine.replace(/\\\s*$/, "").trim()} `;
    if (!trimmed.endsWith("\\")) break;
  }

  const tokenRe =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\S+)/g;
  const tokens: string[] = [];
  for (const m of launchText.matchAll(tokenRe)) {
    const token = m[0] ?? "";
    if (token) tokens.push(token);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (!token.startsWith("--")) continue;
    const eqIdx = token.indexOf("=");
    let key = token;
    let rawValue = "";
    if (eqIdx > 2) {
      key = token.slice(0, eqIdx);
      rawValue = token.slice(eqIdx + 1);
    } else {
      const next = tokens[i + 1] ?? "";
      if (next && !next.startsWith("--")) {
        rawValue = next;
        i += 1;
      }
    }
    const varRef = rawValue.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    const value = varRef ? (vars.get(varRef[1] ?? "") ?? rawValue) : rawValue;
    out.push({ key, value, enabled: true });
  }
  return out;
}

function readScriptMeta(provider: LaunchProvider, scriptBasename: string): ScriptMeta {
  const dirs = resolveLaunchScriptDirs(provider);
  if (!dirs) return { launchArgs: [] };
  const fullPath = path.join(dirs.hostDir, scriptBasename);
  let text = "";
  try {
    text = fs.readFileSync(fullPath, "utf8");
  } catch {
    return { launchArgs: [] };
  }
  return {
    launchArgs: parseLaunchArgsFromScriptText(text),
  };
}

export function listLaunchScripts(provider: LaunchProvider): {
  id: string;
  label: string;
  pathInContainer: string;
  launchArgs: LaunchArgPair[];
}[] {
  const dirs = resolveLaunchScriptDirs(provider);
  if (!dirs) return [];
  const scriptsDir = dirs.hostDir;
  let names: string[] = [];
  try {
    names = fs.readdirSync(scriptsDir).filter((n) => n.endsWith(".sh") && BASENAME_RE.test(n));
  } catch {
    return [];
  }
  names.sort((a, b) => a.localeCompare(b));
  return names.map((id) => ({
    id,
    label: id,
    pathInContainer: `${dirs.containerDir}/${id}`,
    launchArgs: readScriptMeta(provider, id).launchArgs,
  }));
}

export function isAllowedLaunchScript(provider: LaunchProvider, basename: string): boolean {
  if (!BASENAME_RE.test(basename)) return false;
  return listLaunchScripts(provider).some((s) => s.id === basename);
}

export type LaunchServerStatus =
  | { ok: true; running: boolean; detail?: string; servedModel: string | null }
  | { ok: false; error: string };

/** Parse `--served-model-name` from a full `ps`/`cmdline` string. */
function parseServedModelFromArgs(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.match(/--served-model-name(?:=|\s+)(\S+)/);
  return m?.[1] ?? null;
}

/**
 * Detect SGLang via `pgrep -f` (`python -m sglang.launch_server` or `sglang serve`) inside the container.
 * When running, tries (1) `ps` args for `--served-model-name`, then (2) `GET /v1/models` on the host inference URL.
 */
function providerProcessPattern(provider: LaunchProvider): string {
  return  SGLANG_PGREP_ERE;
}

function providerName(provider: LaunchProvider): string {
  return "SGLang";
}

/** Best-effort readiness probe for OpenAI-compatible `/v1/models` from inside the container. */
async function probeOpenAiModelsInContainer(
  container: string,
  port: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const py =
    "import json,sys,urllib.request;" +
    `u='http://127.0.0.1:${port}/v1/models';` +
    "r=urllib.request.urlopen(u,timeout=2);" +
    "d=json.loads(r.read().decode('utf-8','ignore') or '{}');" +
    "m=d.get('data');" +
    "sys.exit(0 if isinstance(m,list) else 1)";
  const tryPy3 = await dockerExec(container, ["python3", "-c", py]);
  if (tryPy3.code === 0) return { ok: true };
  const missingPy3 = /\bpython3\b/i.test(`${tryPy3.stderr}\n${tryPy3.stdout}`) &&
    /(not found|can't open|executable file not found)/i.test(`${tryPy3.stderr}\n${tryPy3.stdout}`);
  if (!missingPy3) {
    const err = (tryPy3.stderr.trim() || tryPy3.stdout.trim() || "probe failed").slice(0, 220);
    return { ok: false, error: err };
  }
  const tryPy = await dockerExec(container, ["python", "-c", py]);
  if (tryPy.code === 0) return { ok: true };
  const err = (tryPy.stderr.trim() || tryPy.stdout.trim() || "probe failed").slice(0, 220);
  return { ok: false, error: err };
}

export async function getLaunchServerStatus(
  provider: LaunchProvider,
  container: string,
): Promise<LaunchServerStatus> {
  try {
    assertSafeContainerName(container);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid container name" };
  }
  const procPattern = providerProcessPattern(provider);
  const r = await dockerExec(container, ["pgrep", "-f", procPattern]);
  if (r.code === 1) {
    return { ok: true, running: false, servedModel: null };
  }
  if (r.code !== 0) {
    const err = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).slice(0, 400);
    return { ok: false, error: err || "pgrep failed (is procps installed in the container?)" };
  }

  const line = r.stdout.trim().split("\n")[0] ?? "";
  let servedModel: string | null = null;

  const psCmd =
    `pid=$(pgrep -f '${procPattern}' | head -1); [ -n "$pid" ] && ps -ww -p "$pid" -o args= 2>/dev/null || true`;
  const ps = await dockerExec(container, ["sh", "-c", psCmd]);
  if (ps.code === 0 && ps.stdout.trim()) {
    servedModel = parseServedModelFromArgs(ps.stdout);
  }


  if (provider === "sglang" && servedModel === null) {
    const ids = await fetchInferenceModelIds();
    if (ids && ids.length > 0) {
      servedModel = ids[0] ?? null;
    }
  }

  return {
    ok: true,
    running: true,
    detail: line.slice(0, 280),
    servedModel,
  };
}

export type RunLaunchResult =
  | { ok: true }
  | { ok: false; error: string; stderr?: string; conflict?: boolean };

export type LaunchLogResult =
  | { ok: true; text: string; missing?: boolean }
  | { ok: false; error: string };

/** Last lines of the launch log inside the container (for UI / API). */
export async function getLaunchLogTail(
  provider: LaunchProvider,
  container: string,
  tailLines: number = DEFAULT_LAUNCH_LOG_TAIL_LINES,
): Promise<LaunchLogResult> {
  try {
    assertSafeContainerName(container);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid container name" };
  }
  const logPath = LAUNCH_LOG_PATH[provider];
  const r = await dockerExec(container, [
    "tail",
    "-n",
    String(Math.min(Math.max(1, Math.trunc(tailLines)), 10_000)),
    logPath,
  ]);
  if (r.code !== 0) {
    const err = (r.stderr.trim() || r.stdout.trim()).slice(0, 200);
    if (/no such file|not such file/i.test(err) || r.code === 1) {
      return {
        ok: true,
        text: "",
        missing: true,
      };
    }
    return {
      ok: false,
      error: err || `tail failed (exit ${r.code ?? "?"})`,
    };
  }
  return { ok: true, text: normalizeLaunchLogText(r.stdout) };
}

export async function runLaunchScriptInContainer(
  provider: LaunchProvider,
  container: string,
  scriptBasename: string,
  argOverrides?: LaunchArgPair[],
  launchEnv?: Record<string, string>,
): Promise<RunLaunchResult> {
  assertSafeContainerName(container);
  if (!isAllowedLaunchScript(provider, scriptBasename)) {
    return { ok: false, error: "Unknown or disallowed script" };
  }

  const probe = await getLaunchServerStatus(provider, container);
  if (!probe.ok) {
    return {
      ok: false,
      error: `Could not check if ${providerName(provider)} is already running: ${probe.error}`,
    };
  }
  if (probe.running) {
    return {
      ok: false,
      conflict: true,
      error: `${providerName(provider)} server already appears to be running in this container. Stop it first, or pick another container.`,
    };
  }

  const dirs = resolveLaunchScriptDirs(provider);
  if (!dirs) {
    return {
      ok: false,
      error: `No launch scripts directory found for ${providerName(provider)}. Expected \`scripts/${provider}\` under MONITOR_REPO_ROOT/current repo.`,
    };
  }
  const inContainer = `${dirs.containerDir}/${scriptBasename}`;
  const scriptCheck = await dockerExec(container, ["sh", "-c", `test -f "${inContainer}"`]);
  if (scriptCheck.code !== 0) {
    return {
      ok: false,
      error:
        `Launch script not found in container: ${inContainer}. ` +
        "This usually means the container /workspace mount is not the repo root. " +
        "Recreate the stack container so host repo root is mounted at /workspace.",
    };
  }
  const bundle = writeMonitorLaunchBundle(provider, scriptBasename, argOverrides, launchEnv);
  if (!bundle.ok) {
    return { ok: false, error: bundle.error };
  }
  const { code, stderr } = await dockerExecDetached(
    container,
    ["bash", bundle.containerWrapperPath],
    monitorLaunchExecEnv(),
  );
  if (code !== 0) {
    return {
      ok: false,
      error: `docker exec failed (exit ${code ?? "?"})`,
      stderr: stderr.trim() || undefined,
    };
  }
  return { ok: true };
}

/** Kill processes matching the same `pgrep -f` pattern as `getLaunchServerStatus`. */
function stopLaunchShell(provider: LaunchProvider): string {
  const procPattern = providerProcessPattern(provider);
  return `p=$(pgrep -f '${procPattern}'||true); [ -z "$p" ]&&exit 0; kill -TERM $p 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do q=$(pgrep -f '${procPattern}'||true); [ -z "$q" ]&&exit 0; sleep 1; done; p2=$(pgrep -f '${procPattern}'||true); [ -n "$p2" ]&&kill -KILL $p2 2>/dev/null; exit 0`;
}

export type StopLaunchResult =
  | { ok: true; wasRunning: boolean; message: string }
  | { ok: false; error: string; stderr?: string };

export async function stopLaunchServerInContainer(
  provider: LaunchProvider,
  container: string,
): Promise<StopLaunchResult> {
  try {
    assertSafeContainerName(container);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid container name" };
  }

  const before = await getLaunchServerStatus(provider, container);
  if (!before.ok) {
    return { ok: false, error: before.error };
  }
  if (!before.running) {
    return {
      ok: true,
      wasRunning: false,
      message: `${providerName(provider)} server is not running in this container.`,
    };
  }

  const r = await dockerExec(container, ["sh", "-c", stopLaunchShell(provider)]);
  if (r.code !== 0) {
    return {
      ok: false,
      error: `Stop command failed (exit ${r.code ?? "?"})`,
      stderr: (r.stderr.trim() || r.stdout.trim()) || undefined,
    };
  }

  const after = await getLaunchServerStatus(provider, container);
  if (!after.ok) {
    return {
      ok: true,
      wasRunning: true,
      message: `Stop completed but status could not be re-checked: ${after.error}`,
    };
  }
  if (after.running) {
    return {
      ok: false,
      error: `${providerName(provider)} still appears to be running after SIGTERM/SIGKILL. Try \`docker exec\` into the container or restart it.`,
    };
  }

  return {
    ok: true,
    wasRunning: true,
    message: `Stopped ${providerName(provider)} server in this container.`,
  };
}
