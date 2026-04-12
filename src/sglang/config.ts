import { withProviderQuery } from "../app/provider";

/**
 * Shared client access to `GET /api/config` (core), with legacy fallback.
 */

export type SglangConfig = {
  metricsUrl?: string;
  inferenceBaseUrl?: string;
  host?: string;
  hint?: string;
  /** Optional default from dashboard API (`SGLANG_DEFAULT_MODEL`); used when nothing is stored locally. */
  defaultModel?: string;
  error?: string;
};

export async function fetchSglangConfig(): Promise<{ ok: boolean; config: SglangConfig }> {
  try {
    const primary = await fetch(withProviderQuery("/api/config"));
    if (primary.ok) {
      const config = (await primary.json()) as SglangConfig;
      const ok = primary.ok && !config.error;
      return { ok, config };
    }
    const fallback = await fetch(withProviderQuery("/api/sglang/config"));
    const config = (await fallback.json()) as SglangConfig;
    const ok = fallback.ok && !config.error;
    return { ok, config };
  } catch {
    return { ok: false, config: { error: "Could not reach dashboard API for config." } };
  }
}
