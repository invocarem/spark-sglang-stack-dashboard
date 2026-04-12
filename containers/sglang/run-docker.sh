docker run --gpus all \
    --name sglang_node_tf5 \
    --network host \
    --shm-size 32g \
    -p 30000:30000 \
    -p 5000:5000 \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    -v $(pwd):/workspace \
    --env "HF_TOKEN=$HF_TOKEN" \
    --ipc=host \
    -it --rm \
    scitrera/dgx-spark-sglang:0.5.9-t5 \
    bash
