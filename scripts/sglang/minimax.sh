#!/bin/bash

# Configuration variables
MODEL="/data/hf/saricles_MiniMax-M2.7-NVFP4-GB10"
SERVED_MODEL_NAME="minimax"
CONTEXT_LENGTH=65536
MEM_FRACTION_STATIC=0.90
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="triton"
TOOL_CALL_PARSER="minimax-m2"
CUDA_GRAPH_MAX_BS=2

# Launch the server with single device
SGLANG_ENABLE_SPEC_V2=true python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --context-length ${CONTEXT_LENGTH} \
    --model-loader-extra-config '{"enable_multithread_load": true}' \
    --load-format safetensors \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser minimax-append-think \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --max-running-requests 2 \
    --kv-cache-dtype auto \
    --quantization modelopt_fp4 \
    --disable-piecewise-cuda-graph \
    --cuda-graph-max-bs ${CUDA_GRAPH_MAX_BS} \
    --trust-remote-code 