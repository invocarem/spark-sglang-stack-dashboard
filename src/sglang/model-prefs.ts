/**
 * Shared preferred model metadata for Launch/Chat/Benchmark (localStorage + same-tab events).
 */

const STORAGE_KEY = "sglang-monitor-preferred-model";
const STORAGE_KEY_PATH = "sglang-monitor-preferred-model-path";
const CHANGE_EVENT = "sglang-preferred-model";

function normalizeToHfRepo(modelPath: string): string {
  const raw = modelPath.trim();
  if (!raw || !raw.startsWith("/")) return raw;

  const parts = raw.split("/").filter(Boolean);
  const hfIndex = parts.findIndex((p) => p.toLowerCase() === "hf");
  if (hfIndex < 0 || hfIndex + 1 >= parts.length) return raw;

  const suffix = parts.slice(hfIndex + 1);
  if (suffix.length >= 2) return suffix.join("/");

  const compact = suffix[0] ?? "";
  const underscore = compact.indexOf("_");
  if (underscore > 0 && underscore < compact.length - 1) {
    return `${compact.slice(0, underscore)}/${compact.slice(underscore + 1)}`;
  }
  return compact || raw;
}

export function getPreferredModel(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setPreferredModel(model: string): void {
  const v = model.trim();
  try {
    if (v) {
      localStorage.setItem(STORAGE_KEY, v);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(
    new CustomEvent(CHANGE_EVENT, { detail: { model: v, modelPath: getPreferredModelPath() } }),
  );
}

export function getPreferredModelPath(): string {
  try {
    return localStorage.getItem(STORAGE_KEY_PATH)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setPreferredModelPath(modelPath: string): void {
  const v = normalizeToHfRepo(modelPath);
  try {
    if (v) {
      localStorage.setItem(STORAGE_KEY_PATH, v);
    } else {
      localStorage.removeItem(STORAGE_KEY_PATH);
    }
  } catch {
    /* ignore quota / private mode */
  }
  window.dispatchEvent(
    new CustomEvent(CHANGE_EVENT, { detail: { model: getPreferredModel(), modelPath: v } }),
  );
}

/** Subscribe to model id changes from any tab or panel. */
export function onPreferredModelChange(handler: (model: string) => void): () => void {
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ model?: string; modelPath?: string }>).detail?.model;
    handler(typeof d === "string" ? d : "");
  };
  window.addEventListener(CHANGE_EVENT, fn);
  return () => window.removeEventListener(CHANGE_EVENT, fn);
}

/** Subscribe to model path changes from any tab or panel. */
export function onPreferredModelPathChange(handler: (modelPath: string) => void): () => void {
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ model?: string; modelPath?: string }>).detail?.modelPath;
    handler(typeof d === "string" ? d : "");
  };
  window.addEventListener(CHANGE_EVENT, fn);
  return () => window.removeEventListener(CHANGE_EVENT, fn);
}
