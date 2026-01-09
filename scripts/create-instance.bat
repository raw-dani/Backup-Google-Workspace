@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo GWS Email Backup - Create New Instance
echo ============================================

REM Get instance name
set /p INSTANCE_NAME="Enter instance name (e.g., atonergi): "
if "%INSTANCE_NAME%"=="" (
    echo ERROR: Instance name is required
    exit /b 1
)

REM Get port number (auto-increment)
set /p BACKEND_PORT="Enter backend port (default: 3001): "
if "%BACKEND_PORT%"=="" set BACKEND_PORT=3001

set /p FRONTEND_PORT="Enter frontend port (default: 8080): "
if "%FRONTEND_PORT%"=="" set FRONTEND_PORT=8080

REM Get database info
set /p DB_NAME="Enter database name (default: gws_backup_%INSTANCE_NAME%): "
if "%DB_NAME%"=="" set DB_NAME=gws_backup_%INSTANCE_NAME%

set /p DB_USER="Enter MySQL user (default: root): "
if "%DB_USER%"=="" set DB_USER=root

set /p DB_PASS="Enter MySQL password: "

REM Base directory
set BASE_DIR=%~dp0..\
set INSTANCES_DIR=%BASE_DIR%instances

REM Create instance directory
set INSTANCE_DIR=%INSTANCES_DIR%\%INSTANCE_NAME%
echo.
echo Creating instance directory: %INSTANCE_DIR%
mkdir "%INSTANCE_DIR%" 2>nul
if exist "%INSTANCE_DIR%" (
    echo ERROR: Instance "%INSTANCE_NAME%" already exists
    exit /b 1
)

REM Copy project files
echo Copying project files...
xcopy /E /I /Q "%BASE_DIR%backend" "%INSTANCE_DIR%\backend" >nul 2>&1
xcopy /E /I /Q "%BASE_DIR%frontend" "%INSTANCE_DIR%\frontend" >nul 2>&1
xcopy "%BASE_DIR%*.bat" "%INSTANCE_DIR%\" >nul 2>&1
xcopy "%BASE_DIR%*.md" "%INSTANCE_DIR%\" >nul 2>&1
xcopy "%BASE_DIR%.env*" "%INSTANCE_DIR%\" >nul 2>&1
xcopy "%BASE_DIR%package.json" "%INSTANCE_DIR%\" >nul 2>&1

REM Update backend .env
echo Updating backend configuration...
set BACKEND_ENV=%INSTANCE_DIR%\backend\.env
if exist "%BACKEND_ENV%" (
    if defined DB_PASS (
        powershell -Command "(Get-Content '%BACKEND_ENV%') -replace 'DB_PASSWORD=.*', 'DB_PASSWORD=%DB_PASS%' | Set-Content '%BACKEND_ENV%'"
    )
    powershell -Command "(Get-Content '%BACKEND_ENV%') -replace 'PORT=.*', 'PORT=%BACKEND_PORT%' | Set-Content '%BACKEND_ENV%'"
    powershell -Command "(Get-Content '%BACKEND_ENV%') -replace 'DB_NAME=.*', 'DB_NAME=%DB_NAME%' | Set-Content '%BACKEND_ENV%'"
    powershell -Command "(Get-Content '%BACKEND_ENV%') -replace 'DB_USER=.*', 'DB_USER=%DB_USER%' | Set-Content '%BACKEND_ENV%'"
)

REM Update backend package.json for port
echo Updating backend package.json...
set BACKEND_PKG=%INSTANCE_DIR%\backend\package.json
if exist "%BACKEND_PKG%" (
    powershell -Command "(Get-Content '%BACKEND_PKG%') -replace '\"start\": \"node src/index.js\"', '\"start\": \"node --port=%BACKEND_PORT% src/index.js\"' | Set-Content '%BACKEND_PKG%'"
)

REM Update frontend .env
echo Updating frontend configuration...
set FRONTEND_ENV=%INSTANCE_DIR%\frontend\.env
if exist "%FRONTEND_ENV%" (
    powershell -Command "(Get-Content '%FRONTEND_ENV%') -replace 'REACT_APP_API_URL=.*', 'REACT_APP_API_URL=http://localhost:%BACKEND_PORT%' | Set-Content '%FRONTEND_ENV%'"
)

REM Create start script
echo Creating start script...
(
echo @echo off
echo echo ============================================
echo echo GWS Backup - %INSTANCE_NAME% (Port: %BACKEND_PORT%)
echo echo ============================================
echo cd /d "%%~dp0backend"
echo start /B node src/index.js ^> logs\app.log 2^>^&1
echo cd ..\frontend
echo npx serve -s build -l %FRONTEND_PORT%
) > "%INSTANCE_DIR%\start.bat"

REM Create database
echo.
echo Creating database %DB_NAME% in MySQL...
if defined DB_PASS (
    mysql -u %DB_USER% -p%DB_PASS% -e "CREATE DATABASE IF NOT EXISTS %DB_NAME% CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>nul
) else (
    mysql -u %DB_USER% -e "CREATE DATABASE IF NOT EXISTS %DB_NAME% CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>nul
)

if %errorlevel% equ 0 (
    echo ✅ Database %DB_NAME% created successfully
) else (
    echo ⚠️  Database creation skipped (MySQL might not be running)
)

REM Build frontend
echo.
echo Building frontend...
cd "%INSTANCE_DIR%\frontend"
npm run build >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Frontend built successfully
) else (
    echo ⚠️  Frontend build failed, please run manually: cd frontend ^&^& npm run build
)

echo.
echo ============================================
echo ✅ Instance "%INSTANCE_NAME%" created successfully!
echo ============================================
echo.
echo Instance location: %INSTANCE_DIR%
echo Backend port: %BACKEND_PORT%
echo Frontend port: %FRONTEND_PORT%
echo Database: %DB_NAME%
echo.
echo To start this instance:
echo 1. cd %INSTANCE_DIR%
echo 2. start.bat
echo.
echo Or run as Windows Service (recommended for production):
echo nssm install GWSBackup_%INSTANCE_NAME% "%%~dp0backend\node.exe" "src\index.js"
echo nssm set GWSBackup_%INSTANCE_NAME% AppDirectory "%%~dp0backend"
echo nssm set GWSBackup_%INSTANCE_NAME% DisplayName "GWS Backup - %INSTANCE_NAME%"
echo nssm set GWSBackup_%INSTANCE_NAME% Start SERVICE_AUTO_START
echo.
pause
