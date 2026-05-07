import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  fetchSglangMetrics,
  forwardChatCompletions,
  getSglangBaseUrl,
  getSglangMetricsUrl,
  runSglangBenchmark,
  runSglangTaskBenchmark,
} from "../sglang.js";
type ProviderId = "sglang" ;

function pickProvider(c: Context): ProviderId {
  return "sglang";
}

function buildConfig(provider: ProviderId) {
  const metricsUrl =  getSglangMetricsUrl();
  const inferenceBaseUrl = getSglangBaseUrl();
  const u = new URL(metricsUrl);
  const defaultModel = process.env.SGLANG_DEFAULT_MODEL?.trim() || undefined;
  return {
    provider,
    metricsUrl,
    inferenceBaseUrl,
    host: u.host,
    hint:
         "Launch SGLang with --enable-metrics (scripts in this repo include it). Prometheus text is served at /metrics on the server port.",
    ...(defaultModel ? { defaultModel } : {}),
  };
}

async function handleChatCompletions(c: Context, provider: ProviderId) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const result = await forwardChatCompletions(body);
  if (!result.ok) {
    const status = (result.status ?? 502) as ContentfulStatusCode;
    const preview = result.bodyPreview;
    if (preview !== undefined) {
      try {
        return c.json(
          { error: result.error, detail: JSON.parse(preview) as unknown },
          status,
        );
      } catch {
        return c.json({ error: result.error, detail: preview }, status);
      }
    }
    return c.json({ error: result.error }, status);
  }
  return c.json(result.body, result.status as ContentfulStatusCode);
}

async function handleBenchmark(c: Context, provider: ProviderId) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const result =  await runSglangBenchmark(body);
  if (!result.ok) {
    const status = result.status as ContentfulStatusCode;
    return c.json({ error: result.error }, status);
  }
  return c.json(result);
}

async function handleMetrics(c: Context, provider: ProviderId) {
  const result =  await fetchSglangMetrics();
  if (!result.ok) {
    return c.json(result, 502);
  }
  return c.json({ ...result, provider });
}

async function handleTaskBenchmark(c: Context, provider: ProviderId) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const result = await runSglangTaskBenchmark(body);
  if (!result.ok) {
    const status = result.status as ContentfulStatusCode;
    return c.json({ error: result.error }, status);
  }
  return c.json(result);
}

export function registerInferenceRoutes(app: Hono): void {
  // Core routes.
  app.get("/api/config", (c) => {
    const provider = pickProvider(c);
    try {
      return c.json(buildConfig(provider));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });
  app.get("/api/metrics", (c) => handleMetrics(c, pickProvider(c)));
  app.post("/api/chat/completions", (c) => handleChatCompletions(c, pickProvider(c)));
  app.post("/api/benchmark", (c) => handleBenchmark(c, pickProvider(c)));
  app.post("/api/benchmark/task", (c) => handleTaskBenchmark(c, pickProvider(c)));

  // Legacy aliases kept for compatibility while the frontend migrates.
  app.get("/api/sglang/config", (c) => {
    try {
      return c.json(buildConfig("sglang"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 400);
    }
  });
  app.get("/api/sglang/metrics", (c) => handleMetrics(c, "sglang"));
  app.post("/api/sglang/chat/completions", (c) => handleChatCompletions(c, "sglang"));
  app.post("/api/sglang/benchmark", (c) => handleBenchmark(c, "sglang"));
  app.post("/api/sglang/benchmark/task", (c) => handleTaskBenchmark(c, "sglang"));
}
