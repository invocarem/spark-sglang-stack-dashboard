/**
 * Stack dev-container presets (ids, Docker names, images, source scripts).
 * Host `docker run` / start / stop lives in `stack-run.ts`.
 */

export type StackProvider = "sglang" | "vllm";

export type StackPreset = {
  id: string;
  label: string;
  provider: StackProvider;
  /** vLLM: host script to render; SGLang: reference only (flags duplicated in stack-run). */
  matchesScript: string;
  containerName: string;
  image: string;
  /** Extra `docker run -e` pairs after HF_TOKEN (e.g. OpenAI/tiktoken image). */
  extraEnv: readonly string[];
};

export const STACK_PRESETS: readonly StackPreset[] = [
  {
    id: "dgx_spark_tf5",
    label: "SciTrera DGX Spark SGLang (tf5) dev2",
    provider: "sglang",
    matchesScript: "containers/sglang/run-docker.sh",
    containerName: "sglang_node_tf5",
    image: "scitrera/dgx-spark-sglang:0.5.9-dev2-acab24a7-t5",
    extraEnv: [],
  },
  {
    id: "lmsys_spark",
    label: "LM.Sys SGLang (spark)",
    provider: "sglang",
    matchesScript: "containers/sglang/run-docker-openai.sh",
    containerName: "sglang_node",
    image: "lmsysorg/sglang:spark",
    extraEnv: ["TIKTOKEN_ENCODINGS_BASE=/tiktoken_encodings"],
  }
 
] as const;

const PRESET_BY_ID = new Map(STACK_PRESETS.map((p) => [p.id, p]));

/** Whitelist for stack container APIs (`status`, `logs`, `stop`). */
export const STACK_PRESET_CONTAINER_NAMES: ReadonlySet<string> = new Set(
  STACK_PRESETS.map((p) => p.containerName),
);

export function getStackPreset(id: string): StackPreset | undefined {
  return PRESET_BY_ID.get(id);
}

export function listStackPresets(provider: StackProvider): StackPreset[] {
  return STACK_PRESETS.filter((p) => p.provider === provider);
}
