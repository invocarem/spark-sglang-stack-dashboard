#!/bin/bash

# Configuration variables
MODEL="Qwen/Qwen3.5-397B-A17B-GPTQ-Int4"
SERVED_MODEL_NAME="qwen3.5-397b"
CONTEXT_LENGTH=131072
MEM_FRACTION_STATIC=0.94
CHUNKED_PREFILL_SIZE=2048
MAX_RUNNING_REQUESTS=3
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
TOOL_CALL_PARSER="qwen3_coder"

# --mamba-scheduler-strategy extra_buffer
# Remove --disable-radix-cache (extra_buffer requires radix cache)
# Remove --disable-cuda-graph (enable CUDA graphs)

SGLANG_ENABLE_SPEC_V2=true SGLANG_USE_AITER=1 sglang serve \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --context-length ${CONTEXT_LENGTH} \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --watchdog-timeout 1200 \
    --model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 8}' \
    --attention-backend ${ATTENTION_BACKEND} \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --load-format auto \
    --reasoning-parser qwen3 \
    --mamba-scheduler-strategy no_buffer \
    --disable-radix-cache \
    --quantization moe_wna16 \
    --kv-cache-dtype fp8_e4m3 \
    --max-running-requests ${MAX_RUNNING_REQUESTS} \
    --max-prefill-tokens=${CHUNKED_PREFILL_SIZE} \
    --enable-cache-report \
    --preferred-sampling-params '{"temperature":0.6,"top_p":0.95,"top_k":20,"min_p":0.0,"presence_penalty":0.0,"repetition_penalty":1.0}' \
    --trust-remote-code 
