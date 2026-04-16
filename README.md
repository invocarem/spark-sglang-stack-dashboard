# Spark SGLang Stack Dashboard

A local dashboard for launching, monitoring, and testing SGLang container stacks.

It includes:

- A Vite frontend for stack controls, logs, chat, and benchmarking.
- A Hono API server for Docker operations and SGLang proxy endpoints.
- Launch helpers for multi-node SGLang (master/worker scripts in this repo).

## Requirements

- Node.js 20+ and npm
- Docker (with permission to run `docker` commands)
- Python 3 (used by launch helper scripts)
- Access to your SGLang host/container network

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env .env.local.backup
# edit .env for your host/network/model settings
```

3. Run API + frontend in development:

```bash
npm run dev
```

4. Open the UI:

- Frontend: `http://127.0.0.1:5173`
- API health: `http://127.0.0.1:8787/api/health`

## Environment Variables

Commonly used settings (from `.env`):

- `MONITOR_API_PORT`: API server port (default `8787`)
- `MONITOR_REPO_ROOT`: absolute repo path for script generation
- `SGLANG_BASE_URL`: base URL for inference proxy
- `SGLANG_METRICS_URL`: metrics endpoint URL
- `SGLANG_DEFAULT_MODEL`: default model shown in UI (optional)
- `SGLANG_ALLOW_ANY_HOST`: set `1` to relax host checks for remote endpoints

Cluster launch-related settings:

- `MONITOR_CLUSTER_APPLY`
- `MONITOR_CLUSTER_NCCL_SOCKET_IFNAME`
- `MONITOR_CLUSTER_GLOO_SOCKET_IFNAME`
- `MONITOR_CLUSTER_MASTER_ADDR`
- `MONITOR_CLUSTER_MASTER_PORT`
- `MONITOR_CLUSTER_DIST_INIT_ADDR`
- `MONITOR_CLUSTER_NNODES`
- `MONITOR_CLUSTER_NODE_RANK`

NCCL/distributed settings:

- `NCCL_IB_HCA`
- `NCCL_DEBUG`
- `NCCL_IB_DISABLE`
- `NCCL_IB_GID_INDEX`
- `NCCL_IB_TIMEOUT`
- `NCCL_IB_RETRY_CNT`
- `WORLD_SIZE`
- `MASTER_ADDR`
- `MASTER_PORT`
- `TORCH_DISTRIBUTED_TIMEOUT`

## Useful Commands

- `npm run dev` - run API + frontend in watch mode
- `npm run build` - build frontend and server
- `npm run start` - run compiled server from `dist/`
- `npm run test` - run unit tests with Vitest

## Launch Scripts

This repo includes two sample direct launch scripts:

- `run_master.sh`
- `run_worker.sh`

These run `python3 -m sglang.launch_server` inside Docker with multi-node flags (`--nnodes`, `--node-rank`, `--dist-init-addr`) and metrics enabled through the launch args used by the dashboard flow.

Adjust model path, NIC names, and addresses before use.

## API Surface (high level)

- Core/ops routes under `/api/*` (health, containers, presets, launch, stack, diagnostics)
- Inference routes:
  - `GET /api/config`
  - `GET /api/metrics`
  - `POST /api/chat/completions`
  - `POST /api/benchmark`

Legacy aliases under `/api/sglang/*` are still available for compatibility.
