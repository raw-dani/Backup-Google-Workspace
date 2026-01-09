@echo off
echo ===================================================================
echo Starting Google Workspace Email Backup in Production Mode...
echo ===================================================================
echo.

REM === CHECK AND KILL EXISTING PROCESSES ===
echo [1/5] Checking and freeing ports...
echo.

REM Kill any processes on port 3001
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 2^>nul') do (
    echo Killing process %%a on port 3001...
    taskkill /F /PID %%a >nul 2>&1
    if %errorlevel% equ 0 (
        echo Successfully killed process %%a
    ) else (
        echo Failed to kill process %%a
    )
)

REM Kill any processes on port 3000 (frontend dev server)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 2^>nul') do (
    echo Killing process %%a on port 3000...
    taskkill /F /PID %%a >nul 2>&1
)

REM Wait a moment for processes to terminate
timeout /t 3 /nobreak >nul
echo.

@REM REM === SETUP ADMIN USER ===
@REM echo [2/5] Setting up admin user...
@REM cd backend
@REM echo Running npm run setup:admin...
@REM call npm run setup:admin
@REM if %errorlevel% neq 0 (
@REM     echo ERROR: Failed to setup admin user (error code: %errorlevel%)
@REM     echo This might be normal if admin user already exists.
@REM     echo Continuing with startup...
@REM ) else (
@REM     echo Admin user setup completed successfully.
@REM )
@REM cd ..
@REM echo.

REM === BUILD FRONTEND ===
echo [3/5] Building frontend production bundle...
cd frontend
echo Running npm run build...

REM Run build and capture output
call npm run build > build_output.txt 2>&1
set BUILD_ERROR=%errorlevel%

REM Check if build was successful by looking for "Compiled successfully" in output
findstr /C:"Compiled successfully" build_output.txt >nul 2>&1
if %errorlevel% equ 0 (
    echo Frontend build completed successfully.
    REM Show file sizes if available
    findstr /C:"File sizes after gzip:" build_output.txt >nul 2>&1
    if %errorlevel% equ 0 (
        echo.
        echo Build output summary:
        for /f "tokens=*" %%i in ('findstr /C:"File sizes after gzip:" build_output.txt') do echo %%i
        for /f "tokens=*" %%i in ('findstr /C:"build\\static\\js\\main" build_output.txt') do echo   %%i
    )
) else (
    echo ERROR: Frontend build failed!
    echo.
    echo Build output:
    type build_output.txt
    echo.
    echo Error code: %BUILD_ERROR%
    REM Clean up build output file
    if exist build_output.txt del build_output.txt
    cd ..
    pause
    exit /b 1
)

REM Clean up build output file
if exist build_output.txt del build_output.txt
cd ..
echo.

REM === START BACKEND SERVER ===
echo [4/5] Starting backend server...
echo ========================================================
echo Backend will start in production mode on port 3001
echo Frontend is served from built files
echo ========================================================
echo.

cd backend
set NODE_ENV=production
echo Starting server with: npm start
call npm start

REM If we reach here, server has stopped
cd ..
echo.
echo ===================================================================
echo Backend server has stopped.
echo Check logs in backend/logs/ for more details.
echo ===================================================================
pause
