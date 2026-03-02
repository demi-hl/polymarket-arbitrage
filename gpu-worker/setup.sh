#!/usr/bin/env bash
# GPU Worker setup — run this on the PC (Linux/macOS with NVIDIA GPU)
set -e

echo "=== Polymarket GPU Worker Setup ==="
echo ""

# 1. Check Python
python3 --version || { echo "ERROR: Python 3.10+ required"; exit 1; }

# 2. Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# 3. Install PyTorch with CUDA
echo "Installing PyTorch with CUDA 12.1 support..."
pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# 4. Install remaining dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# 5. Verify CUDA
python3 -c "
import torch
print(f'PyTorch: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
    print(f'VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB')
else:
    print('WARNING: CUDA not detected — will run on CPU (slower)')
"

echo ""
echo "=== Setup complete ==="
echo "Start the server with:  python server.py"
echo "Or:                     source venv/bin/activate && uvicorn server:app --host 0.0.0.0 --port 8899"
