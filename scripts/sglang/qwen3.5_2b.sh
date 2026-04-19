#!/bin/bash

# Configuration variables
MODEL="/data/hf/Qwen_Qwen3.5-2B"
SERVED_MODEL_NAME="qwen3.5-2b"
CONTEXT_LENGTH=32768
MEM_FRACTION_STATIC=0.8
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
TOOL_CALL_PARSER="qwen3_coder"

# Launch the server with single device
python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --context-length ${CONTEXT_LENGTH} \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser qwen3 \
    --trust-remote-code