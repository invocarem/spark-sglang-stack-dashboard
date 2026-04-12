# Stack monitor: run vllm-starter/worker.sh (which calls run_cluster.sh for the Ray worker).
# REPO_ROOT, HF_CACHE, VLLM_IMAGE are set by the generated .monitor/monitor-stack-*.rendered.sh wrapper.
cd "${REPO_ROOT}/vllm-starter"
exec bash ./worker.sh
