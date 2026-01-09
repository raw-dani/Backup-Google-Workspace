@echo off
echo Fixing Frontend Build Issues...
echo ================================

REM Navigate to frontend directory
cd frontend

echo [1/4] Removing corrupted node_modules and package-lock.json...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del package-lock.json

echo [2/4] Installing fresh dependencies...
call npm install

echo [3/4] Testing build process...
call npm run build

if %errorlevel% equ 0 (
    echo.
    echo ✅ SUCCESS: Frontend build completed successfully!
    echo.
    echo The production build is ready in frontend/build/
    echo You can now run the production startup script.
) else (
    echo.
    echo ❌ FAILED: Frontend build failed!
    echo.
    echo Please check the error messages above.
    pause
    exit /b 1
)

echo [4/4] Build verification complete.
cd ..
pause
