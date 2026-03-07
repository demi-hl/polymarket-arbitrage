@echo off
setlocal enabledelayedexpansion
title LOCALS ONLY — Full Stack Setup

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   LOCALS ONLY — Polymarket Arbitrage Bot Setup      ║
echo  ║   Full stack: Node + Rust + GPU Worker               ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

REM ═══════════════════════════════════════════════════════
REM  Step 1: Check Prerequisites
REM ═══════════════════════════════════════════════════════
echo [1/6] Checking prerequisites...
echo.

REM Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  ✗ Node.js not found. Install from https://nodejs.org ^(v18+^)
    echo    winget install OpenJS.NodeJS.LTS
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('node --version') do echo  ✓ Node.js %%i
)

REM Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  ✗ Python not found. Install from https://python.org ^(3.10+^)
    echo    winget install Python.Python.3.12
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('python --version') do echo  ✓ %%i
)

REM Rust
cargo --version >nul 2>&1
if errorlevel 1 (
    echo  ✗ Rust not found. Install from https://rustup.rs
    echo    winget install Rustlang.Rustup
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('cargo --version') do echo  ✓ %%i
)

REM NVIDIA GPU
nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo  ⚠ nvidia-smi not found — GPU worker will run on CPU
    set "HAS_GPU=0"
) else (
    for /f "tokens=4 delims= " %%i in ('nvidia-smi --query-gpu=name --format=csv,noheader') do (
        echo  ✓ GPU detected
    )
    set "HAS_GPU=1"
)

echo.

REM ═══════════════════════════════════════════════════════
REM  Step 2: Install Node Dependencies
REM ═══════════════════════════════════════════════════════
echo [2/6] Installing Node.js dependencies...
call npm install
if errorlevel 1 (
    echo  ✗ npm install failed
    exit /b 1
)
echo  ✓ Node dependencies installed
echo.

REM ═══════════════════════════════════════════════════════
REM  Step 3: Build React Dashboard
REM ═══════════════════════════════════════════════════════
echo [3/6] Building React dashboard...
call npx vite build
if errorlevel 1 (
    echo  ✗ Vite build failed
    exit /b 1
)
echo  ✓ Dashboard built to dist/
echo.

REM ═══════════════════════════════════════════════════════
REM  Step 4: Setup GPU Worker (Python)
REM ═══════════════════════════════════════════════════════
echo [4/6] Setting up GPU Worker...
cd /d "%ROOT%gpu-worker"

if not exist "venv" (
    echo  Creating Python virtual environment...
    python -m venv venv
)

call venv\Scripts\activate.bat

echo  Installing PyTorch with CUDA 12.1...
pip install --quiet --upgrade pip
pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu121

echo  Installing remaining dependencies...
pip install --quiet -r requirements.txt

REM Verify CUDA
python -c "import torch; gpu=torch.cuda.is_available(); print(f'  ✓ PyTorch {torch.__version__} — CUDA: {gpu}' + (f' — {torch.cuda.get_device_name(0)}' if gpu else ' (CPU fallback)'))"

call deactivate
cd /d "%ROOT%"
echo.

REM ═══════════════════════════════════════════════════════
REM  Step 5: Build Rust Latency Engine
REM ═══════════════════════════════════════════════════════
echo [5/6] Building Rust latency engine (this takes a few minutes first time)...
cd /d "%ROOT%rust-engine"
cargo build --release 2>nul
if errorlevel 1 (
    echo  ⚠ Rust build failed — latency engine will be unavailable
    echo    You can retry later with: cd rust-engine ^&^& cargo build --release
) else (
    echo  ✓ Rust engine built: target\release\crypto-latency-engine.exe
)
cd /d "%ROOT%"
echo.

REM ═══════════════════════════════════════════════════════
REM  Step 6: Create .env if missing
REM ═══════════════════════════════════════════════════════
echo [6/6] Checking configuration...

if not exist ".env" (
    echo  Creating .env from template...
    (
        echo MODE=paper
        echo INITIAL_CAPITAL=10000
        echo.
        echo # GPU Worker — localhost since everything runs on this machine
        echo GPU_WORKER_URL=http://127.0.0.1:8899
        echo.
        echo # Rust Engine
        echo LATENCY_ENGINE_URL=http://127.0.0.1:8900
        echo.
        echo # Bind all services to localhost only ^(no network exposure^)
        echo BIND_HOST=127.0.0.1
        echo GPU_WORKER_HOST=127.0.0.1
        echo.
        echo # Discord ^(optional^)
        echo DISCORD_BOT_TOKEN=
        echo DISCORD_CLIENT_ID=
        echo DISCORD_GUILD_ID=
        echo DISCORD_CHANNEL_ID=
        echo DISCORD_ALERT_DAILY_SUMMARY=false
        echo.
        echo # AI Chat ^(optional^)
        echo MOONSHOT_API_KEY=
        echo MOONSHOT_BASE_URL=https://api.moonshot.ai/v1
        echo MOONSHOT_MODEL=kimi-k2.5
        echo.
        echo # Search ^(optional^)
        echo BRAVE_API_KEY=
        echo.
        echo # Polymarket Live Trading ^(leave empty for paper mode^)
        echo POLYMARKET_KEY=
        echo POLYMARKET_API_KEY=
        echo POLYMARKET_API_SECRET=
        echo POLYMARKET_API_PASSPHRASE=
    ) > .env
    echo  ✓ Created .env — edit it to add your API keys
) else (
    echo  ✓ .env already exists
)

REM Create data directory if missing
if not exist "data" mkdir data
if not exist "data\settings.json" (
    echo {"positionSizing":{"mode":"fixed","fixedAmount":25,"percentage":2,"maxPerMarket":100},"risk":{"maxConcurrent":10,"stopLoss":15,"takeProfit":25},"tradingMode":"paper"} > data\settings.json
)
if not exist "data\x-sentiment-signals.json" echo [] > data\x-sentiment-signals.json

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   ✓ Setup Complete!                                  ║
echo  ║                                                      ║
echo  ║   Run:  start-all.bat                                ║
echo  ║   Stop: stop-all.bat                                 ║
echo  ║                                                      ║
echo  ║   Dashboard: http://localhost:3000                    ║
echo  ║   API:       http://localhost:3001                    ║
echo  ║   GPU:       http://localhost:8899                    ║
echo  ║   Rust:      http://localhost:8900                    ║
echo  ║                                                      ║
echo  ║   All services bound to localhost only                ║
echo  ║   No network exposure — LOCALS ONLY                  ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
pause
