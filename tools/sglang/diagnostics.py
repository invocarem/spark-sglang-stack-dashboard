#!/usr/bin/env python3
"""Diagnostics presets for Docker Tools → Diagnostics shell mode.

Each subcommand mirrors the former inline bash presets in docker-tools.ts.
Run inside the stack container, e.g.:

  python3 /workspace/tools/sglang/diagnostics.py quick_health
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

WORKSPACE = Path("/workspace")
MONITOR = WORKSPACE / ".monitor"
LAUNCH_LOG_TAIL = 200

_PKG_RE = re.compile(r"torch|vllm|sglang|transformers|xformers", re.I)
_RUNTIME_RE = re.compile(r"python|vllm|sglang", re.I)


def _run(*args: str) -> None:
    subprocess.run(list(args), check=False)


def quick_health() -> None:
    print("== host ==")
    _run("uname", "-a")
    print()
    print("== uptime ==")
    _run("uptime")
    print()
    print("== disk ==")
    _run("df", "-h")
    print()
    print("== memory ==")
    _run("free", "-h")


def gpu_status() -> None:
    _run("nvidia-smi")


def runtime_processes() -> None:
    r = subprocess.run(["ps", "aux"], capture_output=True, text=True, check=False)
    text = r.stdout or ""
    for line in text.splitlines():
        if _RUNTIME_RE.search(line):
            print(line)


def workspace_logs() -> None:
    print("== /workspace ==")
    if WORKSPACE.is_dir():
        _run("ls", "-lah", str(WORKSPACE))
    else:
        print(f"(missing {WORKSPACE})")
    print()
    print("== /workspace/.monitor ==")
    if MONITOR.is_dir():
        _run("ls", "-lah", str(MONITOR))
    else:
        print(f"(missing {MONITOR})")
    print()
    if not MONITOR.is_dir():
        return
    paths = sorted(MONITOR.glob("*launch.log"))
    if not paths:
        print("(no *launch.log files)")
        return
    for path in paths:
        print(f"== tail {path.name} (last {LAUNCH_LOG_TAIL} lines) ==")
        try:
            data = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            print(f"(read error: {exc})")
            continue
        for line in data[-LAUNCH_LOG_TAIL:]:
            print(line)
        print()


def python_env() -> None:
    subprocess.run([sys.executable, "-V"], check=False)
    r = subprocess.run(
        [sys.executable, "-m", "pip", "list"],
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        return
    for line in (r.stdout or "").splitlines():
        if _PKG_RE.search(line):
            print(line)


PRESETS: dict[str, tuple[str, Callable[[], None]]] = {
    "quick_health": ("Quick health (host, uptime, disk, memory)", quick_health),
    "gpu_status": ("GPU status (nvidia-smi)", gpu_status),
    "runtime_processes": ("LLM-related processes (ps aux filter)", runtime_processes),
    "workspace_logs": ("Workspace tree + launch log tails", workspace_logs),
    "python_env": ("Python version + key pip packages", python_env),
}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "preset",
        nargs="?",
        choices=list(PRESETS),
        help="Which diagnostic bundle to run",
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="Print preset ids and exit",
    )
    args = p.parse_args()
    if args.list:
        for pid, (desc, _) in PRESETS.items():
            print(f"{pid}\t{desc}")
        return 0
    if not args.preset:
        p.error("preset is required (or use --list)")
    _, fn = PRESETS[args.preset]
    fn()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
