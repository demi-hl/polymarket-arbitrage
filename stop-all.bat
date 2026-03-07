@echo off
title LOCALS ONLY — Stopping All Services

echo.
echo  Stopping all services...
echo.

REM Kill Node processes (API server, dashboard)
tasklist /fi "WINDOWTITLE eq API Server*" 2>nul | find "cmd.exe" >nul && (
    taskkill /fi "WINDOWTITLE eq API Server*" /t /f >nul 2>&1
    echo  ✓ API Server stopped
)
tasklist /fi "WINDOWTITLE eq Dashboard*" 2>nul | find "cmd.exe" >nul && (
    taskkill /fi "WINDOWTITLE eq Dashboard*" /t /f >nul 2>&1
    echo  ✓ Dashboard stopped
)

REM Kill GPU Worker (Python)
tasklist /fi "WINDOWTITLE eq GPU Worker*" 2>nul | find "cmd.exe" >nul && (
    taskkill /fi "WINDOWTITLE eq GPU Worker*" /t /f >nul 2>&1
    echo  ✓ GPU Worker stopped
)

REM Kill Rust Engine
tasklist /fi "WINDOWTITLE eq Rust Engine*" 2>nul | find "cmd.exe" >nul && (
    taskkill /fi "WINDOWTITLE eq Rust Engine*" /t /f >nul 2>&1
    echo  ✓ Rust Engine stopped
)

REM Fallback: kill any remaining processes on our ports
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 " ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8899 " ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8900 " ^| findstr "LISTENING"') do (
    taskkill /pid %%a /f >nul 2>&1
)

echo.
echo  All services stopped.
echo.
pause
