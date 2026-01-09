@echo off
title Google Workspace Email Backup - Dev Launcher
echo ===========================================
echo Starting Google Workspace Email Backup
echo ===========================================
echo.

REM Pastikan dijalankan dari root project
cd /d "%~dp0"

REM === VALIDASI FOLDER ===
if not exist backend (
    echo [ERROR] Folder backend tidak ditemukan
    pause
    exit /b 1
)

if not exist frontend (
    echo [ERROR] Folder frontend tidak ditemukan
    pause
    exit /b 1
)

REM === VALIDASI NODE & NPM ===
where node >nul 2>&1 || (
    echo [ERROR] Node.js tidak ditemukan
    pause
    exit /b 1
)

where npm >nul 2>&1 || (
    echo [ERROR] npm tidak ditemukan
    pause
    exit /b 1
)

echo [OK] Environment siap
echo.

REM === AUTO KILL PORT ===
echo Checking and freeing ports...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3010') do (
    echo Killing PID %%a on port 3010...
    taskkill /F /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000') do (
    echo Killing PID %%a on port 3000...
    taskkill /F /PID %%a >nul 2>&1
)

echo Ports cleaned.
echo.

REM === START BACKEND ===
echo Starting Backend Server...
start "Backend Server" cmd /c "cd backend && npm run dev:windows"
echo Backend start command executed.
timeout /t 5 /nobreak >nul

REM === OPTIONAL HEALTH CHECK (JIKA ADA) ===
REM node backend\check-health.js

REM === START FRONTEND ===
echo Starting Frontend Server...
start "Frontend App" cmd /c "cd frontend && set PORT=3000 && npm start"
echo Frontend start command executed.
echo.

REM === INFO ===
echo ===========================================
echo Services are starting...
echo Backend  : http://localhost:3010
echo Frontend : http://localhost:3000
echo ===========================================
echo.
echo Close this window to keep services running
pause >nul
