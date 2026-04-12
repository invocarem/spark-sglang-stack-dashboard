/**
 * Repo root on the host (for bind-mounting `./:/workspace`). Used by launch scripts listing and stack run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isRepoRoot(candidate: string): boolean {
  try {
    const scriptsDir = path.join(candidate, "scripts");
    const serverDir = path.join(candidate, "server");
    if (!fs.statSync(scriptsDir).isDirectory()) return false;
    if (!fs.statSync(serverDir).isDirectory()) return false;

    const pkgPath = path.join(candidate, "package.json");
    const pkgRaw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: unknown };
    return pkg.name === "spark-stack-monitor";
  } catch {
    return false;
  }
}

export function findRepoRoot(): string {
  const env = process.env.MONITOR_REPO_ROOT?.trim();
  if (env) {
    const resolved = path.resolve(env);
    if (isRepoRoot(resolved)) return resolved;
  }

  const fromCwd = path.resolve(process.cwd());
  if (isRepoRoot(fromCwd)) return fromCwd;

  for (let depth = 0; depth <= 8; depth++) {
    const root = path.resolve(__dirname, ...Array<string>(depth).fill(".."));
    if (isRepoRoot(root)) return root;
  }

  // Safe fallback for local development layouts.
  const fallback = path.resolve(__dirname, "..", "..", "..");
  return isRepoRoot(fallback) ? fallback : fromCwd;
}
