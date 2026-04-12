#!/bin/bash

# Configuration variables
MODEL="Intel/Qwen3.5-122B-A10B-int4-AutoRound"
SERVED_MODEL_NAME="qwen3.5-122b"
CONTEXT_LENGTH=131072
MEM_FRACTION_STATIC=0.85
TENSOR_PARALLEL=1
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
FP8_GEMM_BACKEND="triton"
TOOL_CALL_PARSER="qwen3_coder"

SGLANG_USE_AITER=1 python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --context-length ${CONTEXT_LENGTH} \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --moe-runner-backend triton \
    --fp8-gemm-backend ${FP8_GEMM_BACKEND} \
    --disable-cuda-graph \
    --disable-radix-cache \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser qwen3 \
    --mamba-scheduler-strategy no_buffer \
    --tokenizer-path ${MODEL} \
    --kv-cache-dtype bf16 \
    --enable-cache-report \
    --trust-remote-code
