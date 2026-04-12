/**
 * Shared preference: single-node vs multi-node (cluster) for Launch tab (SGLang / vLLM).
 * Stored in localStorage and synced between Container and Launch tabs.
 */

export const STACK_LAUNCH_MODE_KEY = "monitor-sglang-launch-mode";

export type StackLaunchMode = "single" | "cluster";

export const STACK_LAUNCH_MODE_EVENT = "monitor-stack-launch-mode";

export function getStoredStackLaunchMode(): StackLaunchMode | null {
  try {
    const v = localStorage.getItem(STACK_LAUNCH_MODE_KEY);
    if (v === "single" || v === "cluster") return v;
  } catch {
    /* private mode */
  }
  return null;
}

export function setStoredStackLaunchMode(mode: StackLaunchMode): void {
  try {
    localStorage.setItem(STACK_LAUNCH_MODE_KEY, mode);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(
    new CustomEvent(STACK_LAUNCH_MODE_EVENT, { detail: { mode } }),
  );
}
