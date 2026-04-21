#!/bin/bash

# Configuration variables
MODEL="/data/hf/lukealonso_MiniMax-M2.7-NVFP4"
SERVED_MODEL_NAME="minimax"
CONTEXT_LENGTH=32768
MEM_FRACTION_STATIC=0.88
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="flashinfer"
TOOL_CALL_PARSER="minimax-m2"
CUDA_GRAPH_MAX_BS=8
MAX_RUNNING_REQUESTS=4
CHUNKED_PREFILL_SIZE=8192

# Launch the server with single device
SGLANG_CUDA_GRAPH_BS="1,2,4,6,8" OMP_NUM_THREADS=16 SGLANG_ENABLE_SPEC_V2=true python3 -m sglang.launch_server \
    --model-path ${MODEL} \
    --served-model-name ${SERVED_MODEL_NAME} \
    --context-length ${CONTEXT_LENGTH} \
    --model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 8}' \
    --tp-size ${TENSOR_PARALLEL} \
    --host ${HOST} \
    --port ${PORT} \
    --enable-metrics \
    --attention-backend ${ATTENTION_BACKEND} \
    --tool-call-parser ${TOOL_CALL_PARSER} \
    --reasoning-parser minimax-append-think \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --max-running-requests ${MAX_RUNNING_REQUESTS} \
    --kv-cache-dtype bf16 \
    --quantization modelopt_fp4 \
    --cuda-graph-max-bs ${CUDA_GRAPH_MAX_BS} \
    --max-prefill-tokens=${CHUNKED_PREFILL_SIZE} \
    --disable-radix-cache \
    --schedule-conservativeness 0.7 \
    --preferred-sampling-params '{"temperature":1.0,"top_p":0.95,"top_k":40,"min_p":0.0}' \
    --trust-remote-code 