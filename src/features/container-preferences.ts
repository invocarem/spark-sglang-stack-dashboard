type ContainerRow = {
  Names: string;
  Image: string;
};

type PreferredContainer = {
  name: string;
  image: string;
};

type MonitorProvider = "sglang" | "vllm";

const PREFERRED_CONTAINERS: Record<MonitorProvider, readonly PreferredContainer[]> = {
  sglang: [
    { name: "sglang_node_tf5", image: "scitrera/dgx-spark-sglang:0.5.9-t5" },
    { name: "sglang_node", image: "lmsysorg/sglang:spark" },
  ],
  vllm: [
    { name: "vllm_node_tf5", image: "vllm-node-tf5:latest" },
    { name: "vllm_node_tf5_worker", image: "vllm-node-tf5:latest" },
    { name: "vllm_node", image: "vllm-node:latest" },
  ],
};

function firstContainerName(names: string): string {
  const first = names.trim().split(/\s+/)[0] ?? "";
  return first.startsWith("/") ? first.slice(1) : first;
}

function imageMatches(actual: string, expected: string): boolean {
  const a = actual.trim();
  const e = expected.trim();
  return a === e || a.startsWith(`${e}@`);
}

export function pickPreferredContainer(
  rows: readonly ContainerRow[],
  provider: MonitorProvider = "sglang",
): string | null {
  const preferredList = PREFERRED_CONTAINERS[provider];
  for (const preferred of preferredList) {
    const exact = rows.find((row) => firstContainerName(row.Names) === preferred.name);
    if (exact) return preferred.name;
  }

  for (const preferred of preferredList) {
    const byImage = rows.find((row) => imageMatches(row.Image, preferred.image));
    if (byImage) return firstContainerName(byImage.Names);
  }

  return null;
}
