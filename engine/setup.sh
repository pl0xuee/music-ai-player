#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# ACE-Step 1.5 engine setup for Music AI Player
#
# Target hardware: AMD Radeon RX 9070 XT (RDNA4 / gfx1201) on CachyOS.
# Idempotent: safe to re-run. Skips steps that are already done.
#
#   ./engine/setup.sh
#
# Override the PyTorch ROCm wheel index if the default misbehaves:
#   ROCM_WHEEL=rocm6.4 ./engine/setup.sh
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACESTEP_DIR="${SCRIPT_DIR}/ACE-Step-1.5"
VENV_DIR="${ACESTEP_DIR}/venv_rocm"
PY_VERSION="3.11"

# System ROCm here is 7.2.x. PyTorch ROCm wheels bundle their own ROCm runtime,
# so this need not match the system exactly -- it only needs native gfx1201
# support, which landed in ROCm 6.4. rocm7.0 is the mature middle ground.
# Fallback ladder if generation fails or the GPU is not detected:
#   rocm7.0  ->  rocm7.2  ->  rocm6.4
ROCM_WHEEL="${ROCM_WHEEL:-rocm7.0}"

say()  { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------------------
say "Checking prerequisites"
# ------------------------------------------------------------------------------
command -v git >/dev/null || die "git not found. Install with: sudo pacman -S git"

if ! command -v uv >/dev/null; then
    die "uv not found. Install with: sudo pacman -S uv"
fi
echo "  uv  $(uv --version 2>&1 | awk '{print $2}')"
echo "  git $(git --version | awk '{print $3}')"

# Arch installs these under /opt/rocm/bin, which is not on the default PATH.
export PATH="/opt/rocm/bin:${PATH}"

if command -v rocminfo >/dev/null; then
    GFX="$(rocminfo 2>/dev/null | grep -o 'gfx[0-9]*' | head -1 || true)"
    GPU_NAME="$(rocminfo 2>/dev/null | grep -A2 'gfx1201' | grep 'Marketing Name' | head -1 | sed 's/.*: *//' || true)"
    echo "  GPU ISA: ${GFX:-unknown} ${GPU_NAME:+($GPU_NAME)}"
    if [[ -n "$GFX" && "$GFX" != "gfx1201" ]]; then
        warn "Expected gfx1201 (RX 9070 XT / RDNA4) but found '$GFX'."
        warn "start-api.sh assumes RDNA4 needs no HSA_OVERRIDE_GFX_VERSION -- recheck that."
    fi
else
    warn "rocminfo not found -- cannot verify GPU ISA."
    warn "Install with: sudo pacman -S rocminfo rocm-smi-lib"
fi

# ------------------------------------------------------------------------------
say "Installing Python ${PY_VERSION} via uv"
# ------------------------------------------------------------------------------
# ACE-Step requires exactly 3.11; this system's default is 3.14. uv keeps 3.11
# self-contained rather than polluting the system or building the AUR package.
uv python install "${PY_VERSION}"

# ------------------------------------------------------------------------------
say "Fetching ACE-Step 1.5"
# ------------------------------------------------------------------------------
if [[ -d "${ACESTEP_DIR}/.git" ]]; then
    echo "  Already cloned at ${ACESTEP_DIR} -- pulling latest"
    git -C "${ACESTEP_DIR}" pull --ff-only || warn "Pull failed; continuing with existing checkout."
else
    git clone --depth 1 https://github.com/ace-step/ACE-Step-1.5.git "${ACESTEP_DIR}"
fi

[[ -f "${ACESTEP_DIR}/requirements-rocm-linux.txt" ]] \
    || die "requirements-rocm-linux.txt missing -- unexpected repo layout."

# ------------------------------------------------------------------------------
say "Creating virtualenv (Python ${PY_VERSION})"
# ------------------------------------------------------------------------------
if [[ -x "${VENV_DIR}/bin/python" ]]; then
    echo "  venv already exists at ${VENV_DIR}"
else
    uv venv --python "${PY_VERSION}" "${VENV_DIR}"
fi

# uv pip needs to be pointed at the venv explicitly.
export VIRTUAL_ENV="${VENV_DIR}"

# ------------------------------------------------------------------------------
say "Installing PyTorch (${ROCM_WHEEL})"
# ------------------------------------------------------------------------------
echo "  This is a large download (~3-5 GB). Grab a coffee."
uv pip install --python "${VENV_DIR}/bin/python" \
    torch torchvision torchaudio \
    --index-url "https://download.pytorch.org/whl/${ROCM_WHEEL}"

# ------------------------------------------------------------------------------
say "Installing ACE-Step dependencies"
# ------------------------------------------------------------------------------
# Note: torchcodec is deliberately absent from this file -- it has no ROCm build
# and ACE-Step falls back to soundfile.
uv pip install --python "${VENV_DIR}/bin/python" \
    -r "${ACESTEP_DIR}/requirements-rocm-linux.txt"

# ------------------------------------------------------------------------------
say "Installing the acestep package itself (--no-deps)"
# ------------------------------------------------------------------------------
# requirements-rocm-linux.txt installs dependencies but NOT the package, so
# `import acestep` fails (running acestep/api_server.py puts the *script's*
# directory on sys.path, not the repo root).
#
# --no-deps is REQUIRED, not an optimisation: pyproject.toml pins
# torch==2.10.0+cu128 for linux/x86_64. A plain editable install would replace
# the ROCm torch we just installed with a CUDA build and break the GPU entirely.
uv pip install --python "${VENV_DIR}/bin/python" \
    -e "${ACESTEP_DIR}" --no-deps

# ------------------------------------------------------------------------------
say "Verifying GPU is visible to PyTorch"
# ------------------------------------------------------------------------------
# No HSA_OVERRIDE_GFX_VERSION here -- see start-api.sh for why RDNA4 must not
# have one set.
if "${VENV_DIR}/bin/python" - <<'PY'
import sys
import torch

hip = getattr(torch.version, "hip", None)
print(f"  torch   {torch.__version__}")
print(f"  HIP     {hip or 'MISSING (not a ROCm build!)'}")

if not torch.cuda.is_available():
    print("  GPU     NOT DETECTED")
    sys.exit(1)

print(f"  GPU     {torch.cuda.get_device_name(0)}")
props = torch.cuda.get_device_properties(0)
print(f"  VRAM    {props.total_memory / 1024**3:.1f} GiB")
print(f"  ISA     {getattr(props, 'gcnArchName', 'unknown')}")

# Prove compute actually works, not just that the device enumerates.
x = torch.randn(2048, 2048, device="cuda")
y = (x @ x).sum().item()
print(f"  matmul  OK ({y:.2f})")
PY
then
    say "Engine setup complete"
    cat <<EOF

  Next:  ./engine/start-api.sh      # launches the REST API on 127.0.0.1:8001
         ./engine/smoke-test.sh     # generates one track end to end

  First run downloads model weights (several GB) and will be slow.
EOF
else
    die "PyTorch cannot see the GPU.
  Try a different wheel:  ROCM_WHEEL=rocm7.2 ./engine/setup.sh
                          ROCM_WHEEL=rocm6.4 ./engine/setup.sh
  And confirm ROCm userspace is present:
                          sudo pacman -S rocminfo rocm-smi-lib"
fi
