@echo off
setlocal enabledelayedexpansion
title LOCALS ONLY — Starting All Services

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   LOCALS ONLY — Starting All Services                ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

REM Ensure .env has localhost bindings
set "GPU_WORKER_URL=http://127.0.0.1:8899"
set "GPU_WORKER_HOST=127.0.0.1"
set "LATENCY_ENGINE_URL=http://127.0.0.1:8900"
set "BIND_HOST=127.0.0.1"

REM ═══════════════════════════════════════════════════════
REM  1. Start GPU Worker (Python FastAPI)
REM ═══════════════════════════════════════════════════════
echo [1/4] Starting GPU Worker on port 8899...

if exist "gpu-worker\venv\Scripts\python.exe" (
    start "GPU Worker" cmd /k "cd /d %ROOT%gpu-worker && venv\Scripts\activate.bat && set GPU_WORKER_HOST=127.0.0.1 && set GPU_WORKER_PORT=8899 && python server.py"
    echo  ✓ GPU Worker starting (127.0.0.1:8899^)
) else (
    echo  ⚠ GPU Worker venv not found — run setup-pc.bat first
    echo    Continuing without GPU worker...
)

REM Give GPU worker a moment to initialize
timeout /t 3 /nobreak >nul

REM ═══════════════════════════════════════════════════════
REM  2. Start Rust Latency Engine
REM ═══════════════════════════════════════════════════════
echo [2/4] Starting Rust Latency Engine on port 8900...

set "RUST_EXE=%ROOT%rust-engine\target\release\crypto-latency-engine.exe"
if exist "!RUST_EXE!" (
    start "Rust Engine" cmd /k "cd /d %ROOT%rust-engine && set API_PORT=8900 && set PAPER_MODE=true && ..\rust-engine\target\release\crypto-latency-engine.exe"
    echo  ✓ Rust Engine starting (127.0.0.1:8900^)
) else (
    echo  ⚠ Rust binary not found — run setup-pc.bat first
    echo    Continuing without Rust engine...
)

timeout /t 2 /nobreak >nul

REM ═══════════════════════════════════════════════════════
REM  3. Start API Server + Bot
REM ═══════════════════════════════════════════════════════
echo [3/4] Starting API Server on port 3001...

start "API Server" cmd /k "cd /d %ROOT% && set GPU_WORKER_URL=http://127.0.0.1:8899 && set LATENCY_ENGINE_URL=http://127.0.0.1:8900 && set BIND_HOST=127.0.0.1 && node polymarket.js server -p 3001 --ws-port 8080"
echo  ✓ API Server starting (127.0.0.1:3001^)

timeout /t 3 /nobreak >nul

REM ═══════════════════════════════════════════════════════
REM  4. Start Vite Dev Server (Dashboard)
REM ═══════════════════════════════════════════════════════
echo [4/4] Starting Dashboard on port 3000...

start "Dashboard" cmd /k "cd /d %ROOT% && npx vite --host 127.0.0.1 --port 3000"
echo  ✓ Dashboard starting (127.0.0.1:3000^)

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   All services starting!                             ║
echo  ║                                                      ║
echo  ║   Dashboard:  http://localhost:3000                   ║
echo  ║   API:        http://localhost:3001/api               ║
echo  ║   GPU Worker: http://localhost:8899/health            ║
echo  ║   Rust:       http://localhost:8900/status            ║
echo  ║                                                      ║
echo  ║   All bound to 127.0.0.1 — no network exposure       ║
echo  ║   Run stop-all.bat to shut everything down            ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

REM Wait then health check
timeout /t 8 /nobreak >nul

echo Checking services...
echo.

curl -s http://127.0.0.1:8899/health >nul 2>&1
if errorlevel 1 (echo  ⚠ GPU Worker: not ready yet) else (echo  ✓ GPU Worker: healthy)

curl -s http://127.0.0.1:8900/status >nul 2>&1
if errorlevel 1 (echo  ⚠ Rust Engine: not ready yet) else (echo  ✓ Rust Engine: healthy)

curl -s http://127.0.0.1:3001/health >nul 2>&1
if errorlevel 1 (echo  ⚠ API Server: not ready yet) else (echo  ✓ API Server: healthy)

curl -s http://127.0.0.1:3000 >nul 2>&1
if errorlevel 1 (echo  ⚠ Dashboard: not ready yet) else (echo  ✓ Dashboard: healthy)

echo.
echo Opening dashboard in browser...
timeout /t 2 /nobreak >nul
start http://localhost:3000

pause
