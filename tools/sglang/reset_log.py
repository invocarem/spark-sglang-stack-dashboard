#!/usr/bin/env python3
"""
Reset provider launch log with a clear script entrypoint.

Flow:
1) Try host-side truncate at <repo>/.monitor/{provider}-launch.log
2) On permission error, fallback to `docker exec` and truncate
   /workspace/.monitor/{provider}-launch.log in a running container.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


CONTAINER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Reset launch log for monitor provider.")
    p.add_argument("--provider", choices=["sglang", "vllm"], required=True)
    p.add_argument("--repo-root", required=True)
    return p.parse_args()


def _log_name(provider: str) -> str:
    return "vllm-launch.log" if provider == "vllm" else "sglang-launch.log"


def _print_and_exit(payload: dict, code: int) -> int:
    print(json.dumps(payload, ensure_ascii=True))
    return code


def _truncate_host(host_path: Path) -> tuple[bool, str | None]:
    try:
        host_path.parent.mkdir(parents=True, exist_ok=True)
        host_path.write_text("", encoding="utf-8")
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _docker_ps_names() -> list[str]:
    r = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        return []
    names: list[str] = []
    for raw in r.stdout.splitlines():
        name = raw.strip()
        if name and CONTAINER_RE.match(name):
            names.append(name)
    return names


def _truncate_in_container(container: str, container_log_path: str) -> tuple[bool, str]:
    cmd = f"mkdir -p /workspace/.monitor && : > {container_log_path}"
    r = subprocess.run(
        ["docker", "exec", container, "sh", "-lc", cmd],
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode == 0:
        return True, ""
    err = (r.stderr or r.stdout or "").strip()
    return False, err


def main() -> int:
    args = _parse_args()
    provider = args.provider
    repo_root = Path(args.repo_root).resolve()
    log_file_name = _log_name(provider)
    host_log_path = repo_root / ".monitor" / log_file_name
    container_log_path = f"/workspace/.monitor/{log_file_name}"

    ok_host, host_error = _truncate_host(host_log_path)
    if ok_host:
        return _print_and_exit(
            {
                "ok": True,
                "provider": provider,
                "path": str(host_log_path),
                "resetBy": "host",
            },
            0,
        )

    docker_errors: list[str] = []
    for container in _docker_ps_names():
        ok, err = _truncate_in_container(container, container_log_path)
        if ok:
            return _print_and_exit(
                {
                    "ok": True,
                    "provider": provider,
                    "path": str(host_log_path),
                    "resetBy": "container",
                    "container": container,
                },
                0,
            )
        if err:
            docker_errors.append(f"{container}: {err}")

    return _print_and_exit(
        {
            "ok": False,
            "provider": provider,
            "path": str(host_log_path),
            "error": host_error or "host log reset failed",
            "dockerErrors": docker_errors[:5],
        },
        1,
    )


if __name__ == "__main__":
    raise SystemExit(main())
