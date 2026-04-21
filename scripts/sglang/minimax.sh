#!/bin/bash

# Configuration variables
MODEL="/data/hf/saricles_MiniMax-M2.7-NVFP4-GB10"
SERVED_MODEL_NAME="minimax"
CONTEXT_LENGTH=65536
MEM_FRACTION_STATIC=0.85
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
TOOL_CALL_PARSER="minimax-m2"

# Launch the server with single device
python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 4}' \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser minimax-append-think \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --max-total-tokens ${CONTEXT_LENGTH} \
    --max-running-requests 2 \
    --kv-cache-dtype auto \
    --quantization modelopt_fp4 \
    --trust-remote-code 