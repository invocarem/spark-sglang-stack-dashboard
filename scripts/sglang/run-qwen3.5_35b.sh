#!/bin/bash

# Configuration variables
MODEL="Qwen/Qwen3.5-35B-A3B"
SERVED_MODEL_NAME="qwen3.5-35b"
MEM_FRACTION_STATIC=0.8
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
TOOL_CALL_PARSER="qwen3_coder"

python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser qwen3 \
    --speculative-algo NEXTN \
    --speculative-num-steps 3 \
    --speculative-eagle-topk 1 \
    --speculative-num-draft-tokens 4 \
    --attention-backend ${ATTENTION_BACKEND} \
    --mamba-scheduler-strategy extra_buffer \
    --trust-remote-code
