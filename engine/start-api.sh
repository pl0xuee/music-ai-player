#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Launch the ACE-Step 1.5 REST API for Music AI Player.
#
# This replaces the vendored start_api_server_rocm.sh, which is written for
# RDNA3 and is actively wrong for this machine. Two changes matter:
#
#   1. HSA_OVERRIDE_GFX_VERSION
#      The vendor script defaults it to 11.0.0, forcing an RDNA3 arch ID. The
#      RX 9070 XT is RDNA4 (gfx1201) with NATIVE ROCm support since 6.4, so any
#      override misreports the ISA and breaks kernel selection. We explicitly
#      unset it. (The vendor's own RDNA4 ROCm manual never sets one either.)
#
#   2. The interactive git-update prompt
#      The vendor script blocks on `read -rp "Update now?"`. That deadlocks any
#      programmatic spawn -- which is exactly how the Tauri app launches this.
#      Not reproduced here; use `git -C ACE-Step-1.5 pull` deliberately instead.
#
# Runs in the foreground and logs to stdout. The app supervises it as a child
# process; run it by hand for Phase 0 and for debugging.
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACESTEP_DIR="${SCRIPT_DIR}/ACE-Step-1.5"
VENV_PY="${ACESTEP_DIR}/venv_rocm/bin/python"

HOST="${ACESTEP_HOST:-127.0.0.1}"
PORT="${ACESTEP_PORT:-8001}"

[[ -x "$VENV_PY" ]] || {
    echo "[error] venv missing at ${VENV_PY}" >&2
    echo "        Run ./engine/setup.sh first." >&2
    exit 1
}

# ---- ROCm / RDNA4 environment ------------------------------------------------

# Do NOT set an arch override on RDNA4. Unset any inherited value so a stray
# export in the parent shell cannot silently break generation.
unset HSA_OVERRIDE_GFX_VERSION

# Use MIOpen's heuristic kernel picker. Without this the first VAE decode hangs
# for MINUTES per conv layer while it exhaustively benchmarks. Non-negotiable.
export MIOPEN_FIND_MODE="FAST"

# Force the PyTorch LM backend. The nano-vllm path needs flash_attn, which has
# no usable ROCm build. This is the vendor's documented AMD workaround.
export ACESTEP_LM_BACKEND="pt"

# 16 GB VRAM is comfortably over the 6 GB threshold, so the LM stays enabled.
export ACESTEP_INIT_LLM="${ACESTEP_INIT_LLM:-auto}"

export TOKENIZERS_PARALLELISM="false"

# Belt and braces: setup.sh installs the package editable, but if that step was
# skipped the repo root on PYTHONPATH still makes `import acestep` resolve.
export PYTHONPATH="${ACESTEP_DIR}${PYTHONPATH:+:${PYTHONPATH}}"

# Keeps fragmentation down across a long batch run.
export PYTORCH_HIP_ALLOC_CONF="${PYTORCH_HIP_ALLOC_CONF:-expandable_segments:True}"

echo "============================================"
echo "  ACE-Step 1.5 REST API  (RDNA4 / gfx1201)"
echo "============================================"
echo "  endpoint : http://${HOST}:${PORT}"
echo "  openapi  : http://${HOST}:${PORT}/docs"
echo "  arch ovr : <unset>  (correct for RDNA4)"
echo "  miopen   : ${MIOPEN_FIND_MODE}"
echo "  lm       : ${ACESTEP_LM_BACKEND} (init=${ACESTEP_INIT_LLM})"
echo

"$VENV_PY" -c "
import torch
assert torch.cuda.is_available(), 'No GPU visible to PyTorch'
print(f'  GPU      {torch.cuda.get_device_name(0)}')
print(f'  HIP      {getattr(torch.version, \"hip\", None)}')
" || {
    echo "[error] PyTorch cannot see the GPU. Re-run ./engine/setup.sh." >&2
    exit 1
}
echo
echo "Starting server (first run downloads model weights -- this is slow)..."
echo

cd "$ACESTEP_DIR"
exec "$VENV_PY" -u acestep/api_server.py --host "$HOST" --port "$PORT"
