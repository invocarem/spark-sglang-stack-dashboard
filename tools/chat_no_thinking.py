#!/usr/bin/env python3
"""Smoke test: POST /v1/chat/completions with Qwen3-friendly knobs (enable_thinking off).

Use from the Tools page (docker exec) or locally against SGLang.

Env: CHAT_BASE_URL, BENCHMARK_BASE_URL, or SGLANG_BASE_URL (default http://127.0.0.1:30000).
Model id: CHAT_MODEL, CHAT_SERVED_MODEL, BENCHMARK_SERVED_MODEL, or BENCHMARK_MODEL; else first id from GET /v1/models;
if that fails, falls back to qwen3.5-397b (override with CHAT_FALLBACK_MODEL).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = (
    os.environ.get("CHAT_BASE_URL")
    or os.environ.get("BENCHMARK_BASE_URL")
    or os.environ.get("SGLANG_BASE_URL")
    or "http://127.0.0.1:30000"
)

# Last-resort served model id when env and GET /v1/models both fail (e.g. Docker cannot reach the API for listing).
_FALLBACK_DEFAULT = "qwen3.5-397b"


def _fallback_served_model() -> str:
    return (os.environ.get("CHAT_FALLBACK_MODEL") or "").strip() or _FALLBACK_DEFAULT


def _model_from_env() -> str | None:
    for k in ("CHAT_MODEL", "CHAT_SERVED_MODEL", "BENCHMARK_SERVED_MODEL", "BENCHMARK_MODEL"):
        v = (os.environ.get(k) or "").strip()
        if v:
            return v
    return None


def fetch_served_model_id(base_url: str, timeout_sec: float = 15.0) -> tuple[str | None, str]:
    """Return (model_id, diagnostic). Diagnostic is empty on success."""
    url = base_url.rstrip("/") + "/v1/models"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read().decode()
        data = json.loads(raw)
        rows = data.get("data")
        if not isinstance(rows, list) or len(rows) == 0:
            return None, "GET {}: response has no non-empty data[] list".format(url)
        first = rows[0]
        if isinstance(first, dict) and isinstance(first.get("id"), str):
            return first["id"], ""
        return None, "GET {}: first model entry has no string id".format(url)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        return None, "GET {}: HTTP {} — {}".format(url, e.code, body.strip())
    except urllib.error.URLError as e:
        return None, "GET {}: {}".format(url, e)
    except TimeoutError:
        return None, "GET {}: timeout after {}s".format(url, timeout_sec)
    except json.JSONDecodeError as e:
        return None, "GET {}: invalid JSON — {}".format(url, e)
    except OSError as e:
        return None, "GET {}: {}".format(url, e)


def main() -> None:
    p = argparse.ArgumentParser(description="POST chat completion with enable_thinking=false.")
    p.add_argument("--base-url", default=DEFAULT_BASE, help="SGLang OpenAI base (no /v1 suffix).")
    p.add_argument(
        "--model",
        default=_model_from_env(),
        help="Served model id (default: CHAT_* / BENCHMARK_* env or GET /v1/models).",
    )
    p.add_argument("--message", "-m", default="Say hello in one short sentence.", help="User message.")
    p.add_argument("--max-tokens", type=int, default=128, help="max_tokens for the completion.")
    args = p.parse_args()

    base = args.base_url.rstrip("/")
    model = args.model
    models_diag = ""
    if not model:
        model, models_diag = fetch_served_model_id(base)
    if not model:
        model = _fallback_served_model()
        print(
            "chat_no_thinking.py: using fallback model {!r} (could not resolve from env or GET /v1/models).\n"
            "  Base URL: {}\n"
            "  {}".format(model, base, models_diag or "(no detail)"),
            file=sys.stderr,
        )

    url = base + "/v1/chat/completions"
    body = {
        "model": model,
        "messages": [{"role": "user", "content": args.message}],
        "stream": False,
        "max_tokens": args.max_tokens,
        "separate_reasoning": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")[:4000]
        print(f"HTTP {e.code}: {err_body}", file=sys.stderr)
        raise SystemExit(1) from e
    except OSError as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(1) from e

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(raw[:8000])
        raise SystemExit(1)

    print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
