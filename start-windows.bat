@echo off
echo ===========================================
echo Google Workspace Email Backup - Windows Setup
echo ===========================================

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

REM Check Node.js version
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo Node.js version: %NODE_VERSION%

REM Setup backend
echo.
echo Setting up backend...
cd backend

REM Install dependencies
echo Installing backend dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install backend dependencies
    pause
    exit /b 1
)

REM Setup database
echo Setting up database...
call npm run setup:db
if %errorlevel% neq 0 (
    echo ERROR: Failed to setup database
    pause
    exit /b 1
)

REM Setup admin user
echo Setting up admin user...
call npm run setup:admin
if %errorlevel% neq 0 (
    echo ERROR: Failed to setup admin user
    pause
    exit /b 1
)

REM Setup frontend
echo.
echo Setting up frontend...
cd ../frontend

REM Install dependencies
echo Installing frontend dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install frontend dependencies
    pause
    exit /b 1
)

cd ..

echo.
echo ===========================================
echo Setup completed successfully!
echo ===========================================
echo.
echo To start the application:
echo 1. Run start-dev.bat for development mode
echo 2. Or run start-prod.bat for production mode
echo.
echo Default admin login:
echo Username: admin
echo Password: admin123
echo Role: super_admin (can manage other admins)
echo.
echo IMPORTANT: Change the default password in production!
echo.
pause
