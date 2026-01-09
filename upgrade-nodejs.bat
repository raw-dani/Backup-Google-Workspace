@echo off
echo ===================================================================
echo Node.js Upgrade Script - v18 to v22 LTS
echo ===================================================================
echo.

REM Check current Node.js version
echo [1/6] Checking current Node.js version...
node --version
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js first from: https://nodejs.org/
    pause
    exit /b 1
)
echo.

REM Check current npm version
echo [2/6] Checking current npm version...
npm --version
echo.

REM Create backup of package-lock.json files
echo [3/6] Creating backup of package files...
if exist frontend\package-lock.json (
    copy frontend\package-lock.json frontend\package-lock.json.backup
    echo Created: frontend\package-lock.json.backup
)
if exist backend\package-lock.json (
    copy backend\package-lock.json backend\package-lock.json.backup
    echo Created: backend\package-lock.json.backup
)
if exist package-lock.json (
    copy package-lock.json package-lock.json.backup
    echo Created: package-lock.json.backup
)
echo.

REM Clear npm cache
echo [4/6] Clearing npm cache...
npm cache clean --force
echo.

REM Instructions for manual Node.js installation
echo ===================================================================
echo MANUAL STEP REQUIRED: Install Node.js 22 LTS
echo ===================================================================
echo.
echo Please download and install Node.js 22 LTS manually:
echo.
echo 1. Open browser and go to: https://nodejs.org/
echo 2. Download: "Windows Installer (.msi)" - 22.x.x LTS
echo 3. Run the installer as Administrator
echo 4. Follow the installation wizard (use default settings)
echo 5. Restart your command prompt/terminal
echo.
echo After installation, press any key to continue verification...
pause >nul
echo.

REM Verify new Node.js version
echo [5/6] Verifying Node.js upgrade...
node --version
if %errorlevel% neq 0 (
    echo ERROR: Node.js verification failed
    pause
    exit /b 1
)

REM Check if version is 22.x.x
for /f "tokens=1,2 delims=." %%a in ('node --version') do (
    if %%a==v22 (
        echo SUCCESS: Node.js 22.x.x detected!
    ) else (
        echo WARNING: Node.js version might not be 22.x.x
        echo Current version: %%a.%%b
    )
)
echo.

REM Verify npm version
echo [6/6] Checking npm version...
npm --version
echo.

REM Clean and reinstall dependencies
echo ===================================================================
echo CLEANING AND REINSTALLING DEPENDENCIES
echo ===================================================================
echo.

echo Reinstalling root dependencies...
if exist package.json (
    npm install
    if %errorlevel% neq 0 (
        echo WARNING: Root npm install failed, but continuing...
    )
)
echo.

echo Reinstalling backend dependencies...
cd backend
npm install
if %errorlevel% neq 0 (
    echo ERROR: Backend npm install failed
    cd ..
    pause
    exit /b 1
)
cd ..
echo.

echo Reinstalling frontend dependencies...
cd frontend
npm install
if %errorlevel% neq 0 (
    echo ERROR: Frontend npm install failed
    cd ..
    pause
    exit /b 1
)
cd ..
echo.

REM Final verification
echo ===================================================================
echo UPGRADE COMPLETE!
echo ===================================================================
echo.
echo Node.js has been upgraded to version 22 LTS
echo All dependencies have been reinstalled
echo.
echo You can now run your application with:
echo - npm run dev (development)
echo - start-prod.bat (production)
echo.
echo If you encounter any issues:
echo 1. Check that all .env files are still valid
echo 2. Restart your IDE/text editor
echo 3. Run 'npm run dev' to test the application
echo.
echo Backup files created:
echo - frontend\package-lock.json.backup
echo - backend\package-lock.json.backup
echo - package-lock.json.backup
echo.
pause
