import type { Context, Hono } from "hono";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  listRunningContainers,
  runToolInContainer,
  assertSafeContainerName,
  runDiagnosticsInContainer,
  validateDiagnosticsCommand,
  validatePipelineSegments,
  TOOLS,
  DEFAULT_TOOL_ID,
  getToolMeta,
} from "../docker.js";
import {
  type LaunchProvider,
  getLaunchLogTail,
  getLaunchServerStatus,
  listLaunchScripts,
  runLaunchScriptInContainer,
  stopLaunchServerInContainer,
} from "../launch-scripts.js";
import { getLaunchClusterDefaultsFromEnv } from "../launch-cluster-defaults.js";
import { listStackPresets } from "../stack-presets.js";
import {
  getStackContainerLogs,
  getStackContainerStatus,
  runStackPreset,
  stopStackContainer,
} from "../stack-run.js";
import { findRepoRoot } from "../repo-root.js";

type ProviderId = "sglang";

function pickProvider(c: Context): ProviderId {
  const q = c.req.query("provider")?.trim().toLowerCase();
  if (q === "sglang") return q;
  const h = c.req.header("x-monitor-provider")?.trim().toLowerCase();
  if (h === "sglang" ) return h;
  const env = process.env.MONITOR_PROVIDER?.trim().toLowerCase();
  if (env === "sglang") return env;
  return "sglang";
}

function launchProvider(c: Context): LaunchProvider {
  return pickProvider(c);
}

type ScriptResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runResetLogScript(provider: LaunchProvider): Promise<ScriptResult> {
  const scriptPath = path.join(findRepoRoot(), "tools", "sglang", "reset_log.py");
  const repoRoot = findRepoRoot();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath, "--provider", provider, "--repo-root", repoRoot], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function registerCoreRoutes(app: Hono): void {
  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/tools", (c) =>
    c.json({
      tools: TOOLS.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        format: t.format,
        needsPipeline: "kind" in t && t.kind === "pipe_probe",
      })),
    }),
  );

  app.get("/api/containers", async (c) => {
    try {
      const containers = await listRunningContainers();
      return c.json({ containers });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/stack/presets", (c) =>
    c.json({
      presets: listStackPresets(pickProvider(c)).map((p) => ({
        id: p.id,
        label: p.label,
        containerName: p.containerName,
        image: p.image,
      })),
    }),
  );

  app.post("/api/stack/run", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Expected JSON object" }, 400);
    }
    const preset = typeof (body as Record<string, unknown>).preset === "string"
      ? (body as Record<string, string>).preset.trim()
      : "";
    if (!preset) {
      return c.json({ error: "Missing preset" }, 400);
    }
    const result = await runStackPreset(preset);
    if (!result.ok) {
      return c.json(
        { error: result.error, stderr: result.stderr },
        /already in use|port is already allocated|Conflict/i.test(result.error ?? "")
          ? 409
          : 400,
      );
    }
    return c.json({
      ok: true,
      container: result.container,
      started: result.started,
      message: result.message,
    });
  });

  app.post("/api/stack/stop", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Expected JSON object" }, 400);
    }
    const container =
      typeof (body as Record<string, unknown>).container === "string"
        ? (body as Record<string, string>).container.trim()
        : "";
    if (!container) {
      return c.json({ error: "Missing container" }, 400);
    }
    const result = await stopStackContainer(container);
    if (!result.ok) {
      return c.json({ error: result.error, stderr: result.stderr }, 400);
    }
    return c.json({ ok: true, message: result.message });
  });

  app.get("/api/stack/status", async (c) => {
    const container = c.req.query("container")?.trim() ?? "";
    if (!container) {
      return c.json({ error: "Missing query parameter: container" }, 400);
    }
    const result = await getStackContainerStatus(container);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 400);
    }
    return c.json(result);
  });

  app.get("/api/stack/logs", async (c) => {
    const container = c.req.query("container")?.trim() ?? "";
    if (!container) {
      return c.json({ error: "Missing query parameter: container" }, 400);
    }
    const linesRaw = c.req.query("lines");
    const parsed =
      linesRaw !== undefined && linesRaw !== ""
        ? Number(linesRaw)
        : 400;
    const lines = Number.isFinite(parsed) ? parsed : 400;
    const result = await getStackContainerLogs(container, lines);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error, stderr: result.stderr }, 400);
    }
    return c.json({ ok: true, text: result.text });
  });

  app.get("/api/probe", async (c) => {
    const container = c.req.query("container");
    if (!container?.trim()) {
      return c.json({ error: "Missing query parameter: container" }, 400);
    }
    try {
      assertSafeContainerName(container);
    } catch {
      return c.json({ parseError: "Invalid container name" }, 400);
    }

    const toolParam = c.req.query("tool")?.trim() || DEFAULT_TOOL_ID;
    const meta = getToolMeta(toolParam);
    if (!meta) {
      return c.json(
        { error: "Unknown tool", tool: toolParam, valid: TOOLS.map((t) => t.id) },
        400,
      );
    }

    let pipeLeft: string | undefined;
    let pipeRight: string | undefined;
    if ("kind" in meta && meta.kind === "pipe_probe") {
      const left = c.req.query("left") ?? "";
      const right = c.req.query("right") ?? "";
      const blocked = validatePipelineSegments(left, right);
      if (blocked) {
        return c.json(
          {
            error: blocked,
            tool: toolParam,
            hint: "Add query parameters left= and right= (e.g. left=env&right=grep+NC)",
          },
          400,
        );
      }
      pipeLeft = left.trim();
      pipeRight = right.trim();
    }

    let result;
    try {
      result = await runToolInContainer(
        container,
        toolParam,
        pipeLeft !== undefined && pipeRight !== undefined
          ? { pipeLeft, pipeRight }
          : undefined,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }

    const { code, stdout, stderr } = result;
    if (code !== 0) {
      return c.json(
        {
          error: "Docker command failed",
          tool: toolParam,
          exitCode: code,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
        },
        502,
      );
    }

    const out = stdout.trim();
    const err = stderr.trim();

    if (meta.format === "json") {
      try {
        const data = JSON.parse(out) as unknown;
        return c.json({ container, tool: toolParam, format: "json", data });
      } catch {
        return c.json(
          {
            error: "Tool did not return valid JSON",
            tool: toolParam,
            stdout: out.slice(0, 4000),
            stderr: err,
          },
          502,
        );
      }
    }

    return c.json({
      container,
      tool: toolParam,
      format: "text",
      stdout: out,
      stderr: err || undefined,
    });
  });

  app.post("/api/diagnostics/exec", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Expected JSON object" }, 400);
    }
    const o = body as Record<string, unknown>;
    const container = typeof o.container === "string" ? o.container.trim() : "";
    const command = typeof o.command === "string" ? o.command.trim() : "";
    const timeoutMsRaw = typeof o.timeoutMs === "number" ? o.timeoutMs : undefined;
    if (!container) return c.json({ error: "Missing container" }, 400);
    if (!command) return c.json({ error: "Missing command" }, 400);
    try {
      assertSafeContainerName(container);
    } catch {
      return c.json({ error: "Invalid container name" }, 400);
    }
    const blocked = validateDiagnosticsCommand(command);
    if (blocked) {
      return c.json({ error: blocked }, 400);
    }
    const timeoutMs =
      timeoutMsRaw && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.min(120_000, Math.trunc(timeoutMsRaw)))
        : 15_000;
    try {
      const result = await runDiagnosticsInContainer(container, command, { timeoutMs });
      const statusCode = result.timedOut ? 408 : result.code === 0 ? 200 : 502;
      return c.json(
        {
          ok: result.code === 0 && !result.timedOut,
          container,
          command,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
        },
        statusCode,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/launch-scripts", (c) => {
    try {
      return c.json({ scripts: listLaunchScripts(launchProvider(c)) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message, scripts: [] }, 500);
    }
  });

  app.get("/api/launch/cluster-defaults", (c) => c.json(getLaunchClusterDefaultsFromEnv()));

  app.get("/api/launch/status", async (c) => {
    const container = c.req.query("container")?.trim() ?? "";
    if (!container) {
      return c.json({ error: "Missing query parameter: container" }, 400);
    }
    const status = await getLaunchServerStatus(launchProvider(c), container);
    if (!status.ok) {
      return c.json({ error: status.error, running: null, servedModel: null }, 502);
    }
    return c.json({
      running: status.running,
      detail: status.detail ?? null,
      servedModel: status.servedModel,
    });
  });

  app.get("/api/launch/log", async (c) => {
    const container = c.req.query("container")?.trim() ?? "";
    if (!container) {
      return c.json({ error: "Missing query parameter: container" }, 400);
    }
    const linesParam = c.req.query("lines")?.trim() ?? "";
    const parsed = Number(linesParam);
    const lines =
      linesParam && Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
    const result = await getLaunchLogTail(launchProvider(c), container, lines);
    if (!result.ok) {
      return c.json({ error: result.error, text: null, missing: null }, 502);
    }
    return c.json({
      text: result.text,
      missing: result.missing === true,
    });
  });

  app.post("/api/launch/log/reset", async (c) => {
    const provider = launchProvider(c);
    try {
      const result = await runResetLogScript(provider);
      const stdout = result.stdout.trim();
      if (result.code !== 0) {
        let detail: unknown = undefined;
        try {
          detail = stdout ? JSON.parse(stdout) : undefined;
        } catch {
          detail = undefined;
        }
        return c.json(
          {
            error: "reset_log.py failed",
            provider,
            detail,
            stderr: result.stderr.trim() || undefined,
          },
          500,
        );
      }
      try {
        const payload = JSON.parse(stdout) as Record<string, unknown>;
        return c.json(payload);
      } catch {
        return c.json(
          {
            error: "reset_log.py returned non-JSON output",
            provider,
            stdout: stdout.slice(0, 1000),
            stderr: result.stderr.trim() || undefined,
          },
          500,
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message, provider }, 500);
    }
  });

  app.post("/api/launch", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Expected JSON object" }, 400);
    }
    const o = body as Record<string, unknown>;
    const container = typeof o.container === "string" ? o.container.trim() : "";
    const script = typeof o.script === "string" ? o.script.trim() : "";
    const argOverrides = Array.isArray(o.argOverrides)
      ? o.argOverrides
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          key: typeof x.key === "string" ? x.key : "",
          value: typeof x.value === "string" ? x.value : "",
          enabled: x.enabled === false ? false : true,
        }))
      : undefined;
    let launchEnv: Record<string, string> | undefined;
    if (o.launchEnv !== undefined && o.launchEnv !== null) {
      if (typeof o.launchEnv !== "object" || Array.isArray(o.launchEnv)) {
        return c.json({ error: "launchEnv must be a JSON object of string values" }, 400);
      }
      launchEnv = {};
      for (const [k, v] of Object.entries(o.launchEnv as Record<string, unknown>)) {
        if (typeof v !== "string") {
          return c.json({ error: `launchEnv.${k} must be a string` }, 400);
        }
        launchEnv[k] = v;
      }
    }
    if (!container) {
      return c.json({ error: "Missing container" }, 400);
    }
    if (!script) {
      return c.json({ error: "Missing script" }, 400);
    }
    const result = await runLaunchScriptInContainer(
      launchProvider(c),
      container,
      script,
      argOverrides,
      launchEnv,
    );
    if (!result.ok) {
      const code = result.conflict ? 409 : 400;
      return c.json(
        { error: result.error, stderr: result.stderr, conflict: result.conflict === true },
        code,
      );
    }
    return c.json({
      ok: true,
      detached: true,
      message:
        "Start requested (detached). Refresh status below or open Metrics while the server initializes.",
    });
  });

  app.post("/api/launch/stop", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Expected JSON object" }, 400);
    }
    const o = body as Record<string, unknown>;
    const container = typeof o.container === "string" ? o.container.trim() : "";
    if (!container) {
      return c.json({ error: "Missing container" }, 400);
    }
    const result = await stopLaunchServerInContainer(launchProvider(c), container);
    if (!result.ok) {
      return c.json({ error: result.error, stderr: result.stderr }, 502);
    }
    return c.json({
      ok: true,
      wasRunning: result.wasRunning,
      message: result.message,
    });
  });
}
