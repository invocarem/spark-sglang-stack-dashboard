/**
 * Defaults for dashboard `POST /api/benchmark` so completions finish in reasonable time.
 * Override with BENCHMARK_DEFAULT_MAX_TOKENS, BENCHMARK_PRESERVE_SEPARATE_REASONING,
 * and BENCHMARK_PRESERVE_THINKING (SGLang / Qwen3).
 */

export function benchmarkDefaultMaxTokens(): number {
  const raw = process.env.BENCHMARK_DEFAULT_MAX_TOKENS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return 256;
}

/** When true, do not send `separate_reasoning: false` (SGLang keeps split CoT; latencies can be very high). */
export function benchmarkPreserveSeparateReasoning(): boolean {
  const r = process.env.BENCHMARK_PRESERVE_SEPARATE_REASONING?.trim().toLowerCase();
  return r === "1" || r === "true" || r === "yes" || r === "on";
}

/**
 * When true, do not send `chat_template_kwargs.enable_thinking: false` (Qwen3 still emits long “thinking” text).
 */
export function benchmarkPreserveThinking(): boolean {
  const r = process.env.BENCHMARK_PRESERVE_THINKING?.trim().toLowerCase();
  return r === "1" || r === "true" || r === "yes" || r === "on";
}
