#!/bin/bash

# Configuration variables
MODEL="/minimax_model"
SERVED_MODEL_NAME="minimax"
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
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --reasoning-parser minimax \
    --tool-call-parser minimax-m2 \  
    --quantization modelopt_fp4 \   
    --kv-cache-dtype bf16 \
    --attention-backend flashinfer \
    --mem-fraction-static 0.85