@echo off
REM GPU Worker setup — run this on the PC (Windows with NVIDIA GPU)

echo === Polymarket GPU Worker Setup ===
echo.

REM 1. Check Python
python --version || (echo ERROR: Python 3.10+ required & exit /b 1)

REM 2. Create virtual environment
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

call venv\Scripts\activate.bat

REM 3. Install PyTorch with CUDA
echo Installing PyTorch with CUDA 12.1 support...
pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

REM 4. Install remaining dependencies
echo Installing dependencies...
pip install -r requirements.txt

REM 5. Verify CUDA
python -c "import torch; print(f'PyTorch: {torch.__version__}'); print(f'CUDA: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0)}' if torch.cuda.is_available() else 'WARNING: No CUDA')"

echo.
echo === Setup complete ===
echo Start the server with:  python server.py
echo Or:                     venv\Scripts\activate ^& uvicorn server:app --host 0.0.0.0 --port 8899
