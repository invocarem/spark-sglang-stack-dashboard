/**
 * Defaults for the Launch tab “Multi-node cluster” block, from `process.env`
 * (typically set in repo-root `.env` — see `.env.example`).
 */

function pick(
  monitorKey: string | undefined,
  fallbackKey: string | undefined,
): string {
  const a = monitorKey?.trim() ?? "";
  const b = fallbackKey?.trim() ?? "";
  return a.length > 0 ? a : b;
}

export type LaunchClusterDefaultsResponse = {
  /** `export` keys sent with `POST /api/launch` when the user runs a script */
  launchEnv: Record<string, string>;
  distInit: string;
  nnodes: string;
  nodeRank: string;
  /** When true, the UI checks “Apply cluster options” on load */
  applyCluster: boolean;
  /**
   * True when `MONITOR_CLUSTER_APPLY` is set (non-empty) in `.env`.
   * Container tab hides Single/Cluster; Launch follows `.env` only (no localStorage override).
   */
  monitorClusterApplySetInEnv: boolean;
};

export function getLaunchClusterDefaultsFromEnv(): LaunchClusterDefaultsResponse {
  const nccl = pick(
    process.env.MONITOR_CLUSTER_NCCL_SOCKET_IFNAME,
    process.env.NCCL_SOCKET_IFNAME,
  );
  const gloo = pick(
    process.env.MONITOR_CLUSTER_GLOO_SOCKET_IFNAME,
    process.env.GLOO_SOCKET_IFNAME,
  );
  const masterAddr = pick(
    process.env.MONITOR_CLUSTER_MASTER_ADDR,
    process.env.MASTER_ADDR,
  );
  const masterPort = pick(
    process.env.MONITOR_CLUSTER_MASTER_PORT,
    process.env.MASTER_PORT,
  );

  const launchEnv: Record<string, string> = {};
  if (nccl) launchEnv.NCCL_SOCKET_IFNAME = nccl;
  if (gloo) launchEnv.GLOO_SOCKET_IFNAME = gloo;
  if (masterAddr) launchEnv.MASTER_ADDR = masterAddr;
  if (masterPort) launchEnv.MASTER_PORT = masterPort;

  const distInit =
    process.env.MONITOR_CLUSTER_DIST_INIT_ADDR?.trim() ||
    process.env.SGLANG_DIST_INIT_ADDR?.trim() ||
    "";
  const nnodes = process.env.MONITOR_CLUSTER_NNODES?.trim() || "";
  const nodeRank = process.env.MONITOR_CLUSTER_NODE_RANK?.trim() || "";

  const applyFlagRaw = process.env.MONITOR_CLUSTER_APPLY?.trim();
  const applyFlag = applyFlagRaw?.toLowerCase() ?? "";
  const monitorClusterApplySetInEnv = Boolean(applyFlagRaw && applyFlagRaw.length > 0);
  const hasAny =
    Object.keys(launchEnv).length > 0 || Boolean(distInit || nnodes || nodeRank);
  let applyCluster: boolean;
  if (applyFlag === "0" || applyFlag === "false" || applyFlag === "no") {
    applyCluster = false;
  } else if (applyFlag === "1" || applyFlag === "true" || applyFlag === "yes") {
    applyCluster = true;
  } else {
    applyCluster = hasAny;
  }

  return {
    launchEnv,
    distInit,
    nnodes,
    nodeRank,
    applyCluster,
    monitorClusterApplySetInEnv,
  };
}

/**
 * Extra `-e` variables for SGLang `docker run` (Container tab) when `MONITOR_CLUSTER_APPLY` is set in `.env`.
 * Mirrors `run_master.sh` / `run_worker.sh` NCCL and distributed settings; per-host values come from env
 * (e.g. `NCCL_IB_DISABLE=1` on worker, `0` on head).
 */
/** Same truthiness as `applyCluster` in `getLaunchClusterDefaultsFromEnv` (non-empty is not enough). */
export function shouldInjectSglangStackClusterDockerEnv(): boolean {
  const raw = process.env.MONITOR_CLUSTER_APPLY?.trim();
  if (!raw) return false;
  const f = raw.toLowerCase();
  if (f === "0" || f === "false" || f === "no") return false;
  return true;
}

/**
 * Extra SGLang stack `docker run` runtime flags (`--network host`, `--privileged`, IB mount, memlock).
 * Set `MONITOR_STACK_SGLANG_CLUSTER_RUNTIME=1` to enable without `MONITOR_CLUSTER_APPLY` (e.g. worker uses its own env files).
 */
export function shouldUseSglangClusterDockerRuntime(): boolean {
  const rt = process.env.MONITOR_STACK_SGLANG_CLUSTER_RUNTIME?.trim().toLowerCase();
  if (rt === "1" || rt === "true" || rt === "yes") return true;
  return shouldInjectSglangStackClusterDockerEnv();
}

export function getSglangStackDockerEnvForClusterRun(): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string): void => {
    const v = value.trim();
    if (v) out[key] = v;
  };

  put("CUDA_VISIBLE_DEVICES", process.env.CUDA_VISIBLE_DEVICES ?? "");
  put(
    "NCCL_SOCKET_IFNAME",
    pick(
      process.env.MONITOR_CLUSTER_NCCL_SOCKET_IFNAME,
      process.env.NCCL_SOCKET_IFNAME,
    ),
  );
  put(
    "GLOO_SOCKET_IFNAME",
    pick(
      process.env.MONITOR_CLUSTER_GLOO_SOCKET_IFNAME,
      process.env.GLOO_SOCKET_IFNAME,
    ),
  );
  put(
    "NCCL_IB_HCA",
    pick(process.env.MONITOR_CLUSTER_NCCL_IB_HCA, process.env.NCCL_IB_HCA),
  );
  put("NCCL_DEBUG", process.env.NCCL_DEBUG ?? "");
  put(
    "NCCL_IB_DISABLE",
    pick(
      process.env.MONITOR_CLUSTER_NCCL_IB_DISABLE,
      process.env.NCCL_IB_DISABLE,
    ),
  );
  put("NCCL_IB_GID_INDEX", process.env.NCCL_IB_GID_INDEX ?? "");
  put(
    "MASTER_ADDR",
    pick(process.env.MONITOR_CLUSTER_MASTER_ADDR, process.env.MASTER_ADDR),
  );
  put(
    "MASTER_PORT",
    pick(process.env.MONITOR_CLUSTER_MASTER_PORT, process.env.MASTER_PORT),
  );
  put(
    "WORLD_SIZE",
    pick(process.env.MONITOR_CLUSTER_WORLD_SIZE, process.env.WORLD_SIZE),
  );
  put("NCCL_IB_TIMEOUT", process.env.NCCL_IB_TIMEOUT ?? "");
  put("NCCL_IB_RETRY_CNT", process.env.NCCL_IB_RETRY_CNT ?? "");
  put(
    "NCCL_ASYNC_ERROR_HANDLING",
    process.env.NCCL_ASYNC_ERROR_HANDLING ?? "",
  );
  put("NCCL_BLOCKING_WAIT", process.env.NCCL_BLOCKING_WAIT ?? "");
  put(
    "TORCH_DISTRIBUTED_TIMEOUT",
    process.env.TORCH_DISTRIBUTED_TIMEOUT ?? "",
  );

  return out;
}
