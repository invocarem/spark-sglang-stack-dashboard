#!/bin/bash

# Configuration variables
MODEL="/models/minimax"
SERVED_MODEL_NAME="minimax"
CONTEXT_LENGTH=32768
MEM_FRACTION_STATIC=0.8
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
TOOL_CALL_PARSER="minimax-m2"

# Launch the server with single device
python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser minimax-append-think \
    --mem-fraction-static 0.94