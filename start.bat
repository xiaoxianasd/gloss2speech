@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found in PATH. Please install Python 3.10+ first.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found in PATH. Please install Node.js first.
    pause
    exit /b 1
)

if not exist "%ROOT%\.env" (
    echo [INFO] .env not found, starting in Mock mode (copy .env.example to .env for Huawei Cloud^).
)

if not exist "%ROOT%\frontend\node_modules" (
    echo [INFO] First run: installing frontend dependencies...
    pushd "%ROOT%\frontend"
    call npm install
    if errorlevel 1 (
        popd
        echo [ERROR] npm install failed. Please check Node.js and network access.
        pause
        exit /b 1
    )
    popd
)

echo [START] Launching Backend (http://127.0.0.1:8000)...
start "SignBridge Backend (8000)" /D "%ROOT%" cmd /k "chcp 65001 >nul && python -X utf8 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload"

echo [START] Launching Frontend (http://127.0.0.1:5173)...
start "SignBridge Frontend (5173)" /D "%ROOT%\frontend" cmd /k "chcp 65001 >nul && npm run dev"

timeout /t 3 /nobreak >nul 2>nul || ping -n 4 127.0.0.1 >nul
start "" "http://127.0.0.1:5173"

echo.
echo ============================================================
echo   SignBridge started!
echo   - Frontend : http://127.0.0.1:5173
echo   - API Docs : http://127.0.0.1:8000/docs
echo   - Health   : http://127.0.0.1:8000/api/health
echo   - Stop     : Close the two popup console windows to stop.
echo ============================================================
echo.
pause
