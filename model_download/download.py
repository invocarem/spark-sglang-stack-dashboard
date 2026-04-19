#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer, GenerationConfig
from huggingface_hub import snapshot_download

def download_with_transformers(model_id: str, save_dir: str = "./models") -> str | None:
    model_id = model_id.strip()
    if not model_id:
        print("Error: model_id is empty", file=sys.stderr)
        return None

    print(f"Downloading {model_id}...")
    
    try:
        model_path = os.path.join(save_dir, model_id.replace("/", "_"))
        os.makedirs(model_path, exist_ok=True)

        # Use snapshot_download to get ALL files (including processor configs)
        print("Downloading all model files using snapshot_download...")
        snapshot_download(
            repo_id=model_id,
            local_dir=model_path,
            ignore_patterns=["*.h5", "*.ot", "*.msgpack"],  # Ignore unnecessary files
        )

        print(f"Successfully saved to: {model_path}")
        
        # Verify downloaded files
        files = os.listdir(model_path)
        print(f"Downloaded {len(files)} files:")
        for f in sorted(files):
            print(f"  - {f}")
            
        return os.path.abspath(model_path)

    except Exception as e:
        print(f"Error downloading {model_id}: {e}", file=sys.stderr)
        return None

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download a Hugging Face model with all required files",
    )
    parser.add_argument(
        "--model-id",
        required=True,
        help='Model id (e.g. "org/name" or "gpt2")',
    )
    parser.add_argument(
        "--save-dir",
        default="/data/hf",
        help="Parent directory inside the container (default: /data/hf)",
    )
    args = parser.parse_args()
    path = download_with_transformers(args.model_id.strip(), save_dir=args.save_dir.strip())
    return 0 if path else 1

if __name__ == "__main__":
    raise SystemExit(main())