/**
 * Append-only logs under repo `.monitor/` for long Tools runs (HF download, model transfer),
 * mirroring how launch output lands in `.monitor/*-launch.log`.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./repo-root.js";

export type MonitorToolLogKind = "hf-download" | "model-transfer" | "benchmark-sglang";

export type MonitorToolLogSession = {
  /** Path relative to repo root, e.g. `.monitor/monitor-hf-download-….log` */
  relativePath: string;
  /** Same bytes as streamed to the client (NDJSON events → readable text). */
  appendStreamEvent(ev: unknown): void;
  end(): void;
};

function appendEventToStream(stream: fs.WriteStream, ev: unknown): void {
  if (typeof ev !== "object" || ev === null || !("kind" in ev)) return;
  const kind = (ev as { kind: string }).kind;
  if (kind === "chunk") {
    const e = ev as { stream?: string; text?: string };
    if (typeof e.text !== "string") return;
    const prefix = e.stream === "stderr" ? "[stderr] " : "[stdout] ";
    stream.write(prefix + e.text);
    return;
  }
  if (kind === "end") {
    const e = ev as {
      exitCode?: number | null;
      timedOut?: boolean;
      truncated?: boolean;
      durationMs?: number;
    };
    stream.write(
      `\n--- end exitCode=${String(e.exitCode ?? "null")} timedOut=${Boolean(e.timedOut)} truncated=${Boolean(e.truncated)} durationMs=${String(e.durationMs ?? "n/a")}\n`,
    );
    return;
  }
  if (kind === "error") {
    const e = ev as { message?: string };
    stream.write(`\n--- error ${String(e.message ?? "")}\n`);
  }
}

/**
 * Creates a new log file and writes a header. Returns `null` if the repo `.monitor` dir
 * cannot be used (permissions, missing repo root, etc.); streaming still works without a file.
 */
export function createMonitorToolLogSession(
  kind: MonitorToolLogKind,
  meta: Record<string, string | number | boolean | undefined>,
): MonitorToolLogSession | null {
  let root: string;
  try {
    root = findRepoRoot();
  } catch {
    return null;
  }

  const dir = path.join(root, ".monitor");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  const prefix =
    kind === "hf-download"
      ? "monitor-hf-download"
      : kind === "benchmark-sglang"
        ? "monitor-benchmark-sglang"
        : "monitor-model-transfer";
  const name = `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}.log`;
  const hostPath = path.join(dir, name);
  const relativePath = path.posix.join(".monitor", name);

  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(hostPath, { flags: "w", encoding: "utf8" });
  } catch {
    return null;
  }

  stream.on("error", (err) => {
    console.error(`[monitor] tool log ${relativePath}:`, err);
  });

  const headerLines = [
    "# Spark SGLang Stack Dashboard",
    `# kind: ${kind}`,
    `# started: ${new Date().toISOString()}`,
    ...Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `# ${k}: ${String(v)}`),
    `# hostLog: ${relativePath}`,
    "---",
    "",
  ];
  stream.write(headerLines.join("\n"));

  return {
    relativePath,
    appendStreamEvent(ev: unknown): void {
      appendEventToStream(stream, ev);
    },
    end(): void {
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    },
  };
}
