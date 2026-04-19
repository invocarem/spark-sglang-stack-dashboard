#!/usr/bin/env python3
# Stack (SGLang GB10 image): pip install transformers torch — use transformers to download.

from __future__ import annotations

import argparse
import json
import os
import sys

from transformers import AutoConfig, AutoModel, AutoTokenizer


def download_with_transformers(model_id: str, save_dir: str = "./models") -> str | None:
    """
    Download model and tokenizer using transformers (config, tokenizer, weights).

    Args:
        model_id: Model identifier (e.g. "bert-base-uncased", "Qwen/Qwen3.5-2B").
        save_dir: Directory to save under; a subfolder named from model_id (slashes -> _) is created.

    Returns:
        Path to saved model directory, or None on failure.
    """
    model_id = model_id.strip()
    if not model_id:
        print("Error: model_id is empty", file=sys.stderr)
        return None

    print(f"Downloading {model_id}...")

    try:
        model_path = os.path.join(save_dir, model_id.replace("/", "_"))
        os.makedirs(model_path, exist_ok=True)

        print("Downloading configuration...")
        config = AutoConfig.from_pretrained(model_id, trust_remote_code=True)
        config.save_pretrained(model_path)

        print("Downloading tokenizer...")
        tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        tokenizer.save_pretrained(model_path)

        print("Downloading model weights...")
        model = AutoModel.from_pretrained(model_id, trust_remote_code=True)
        model.save_pretrained(model_path)

        metadata = {
            "model_id": model_id,
            "model_type": model.config.model_type,
            "save_path": os.path.abspath(model_path),
            "vocab_size": model.config.vocab_size if hasattr(model.config, "vocab_size") else None,
            "hidden_size": model.config.hidden_size if hasattr(model.config, "hidden_size") else None,
        }

        with open(os.path.join(model_path, "download_info.json"), "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

        print(f"Successfully saved to: {model_path}")
        print(f"Model info: {metadata['model_type']} with vocab_size={metadata['vocab_size']}")
        return os.path.abspath(model_path)

    except Exception as e:
        print(f"Error downloading {model_id}: {e}", file=sys.stderr)
        return None


def load_downloaded_model(model_path: str):
    """Load a previously downloaded model (optional helper)."""
    print(f"Loading model from {model_path}...")
    try:
        tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        model = AutoModel.from_pretrained(model_path, trust_remote_code=True)
        print("Model loaded successfully!")
        return model, tokenizer
    except Exception as e:
        print(f"Error loading model: {e}", file=sys.stderr)
        return None, None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download a Hugging Face model with transformers (config, tokenizer, weights).",
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
