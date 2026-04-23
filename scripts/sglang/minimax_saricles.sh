#!/bin/bash

# Configuration variables
MODEL="/data/hf/saricles_MiniMax-M2.7-NVFP4-GB10"
SERVED_MODEL_NAME="minimax"
CONTEXT_LENGTH=65536
MEM_FRACTION_STATIC=0.88
TENSOR_PARALLEL=2
HOST="0.0.0.0"
PORT=30000
ATTENTION_BACKEND="flashinfer"
FP8_GEMM_BACKEND="cutlass"
TOOL_CALL_PARSER="minimax-m2"
REASONING_PARSER="minimax-append-think"
CUDA_GRAPH_MAX_BS=4
MAX_RUNNING_REQUESTS=4
CHUNKED_PREFILL_SIZE=2048

# Launch the server with single device
OMP_NUM_THREADS=8 SGLANG_ENABLE_SPEC_V2=true python3 -m sglang.launch_server \
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
    --reasoning-parser ${REASONING_PARSER} \
    --mem-fraction-static ${MEM_FRACTION_STATIC} \
    --max-running-requests ${MAX_RUNNING_REQUESTS} \
    --kv-cache-dtype fp8_e4m3 \
    --quantization modelopt_fp4 \
    --cuda-graph-max-bs ${CUDA_GRAPH_MAX_BS} \
    --chunked-prefill-size ${CHUNKED_PREFILL_SIZE} \
    --max-prefill-tokens=${CHUNKED_PREFILL_SIZE} \
    --fp8-gemm-backend ${FP8_GEMM_BACKEND} \
    --enable-flashinfer-allreduce-fusion \
    --disable-piecewise-cuda-graph \
    --schedule-conservativeness 0.7 \
    --preferred-sampling-params '{"temperature":1.0,"top_p":0.95,"top_k":40,"min_p":0.1}' \
    --trust-remote-code 