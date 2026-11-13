@echo off
setlocal
title Agent Workbench Launcher
cd /d "%~dp0"

echo ==========================================================
echo   Browser AI Agent Workbench - one-click launcher
echo ==========================================================
echo.

REM ---------- 1. Check Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node,10)"') do set "NODEMAJ=%%v"
if not defined NODEMAJ set "NODEMAJ=0"
if %NODEMAJ% LSS 20 goto OLD_NODE
echo [OK] Node.js v%NODEMAJ% detected.
echo.

REM ---------- 2. Mode: dev (default) / lan / single ----------
set "MODE=%~1"
if /i "%MODE%"=="" set "MODE=dev"
if /i "%MODE%"=="single" goto SINGLE
set "DEVFLAGS="
if /i "%MODE%"=="lan" set "DEVFLAGS=-- --host 0.0.0.0"
set "PORT=5173"

REM ---------- 3. Already running? ----------
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 goto ALREADY_RUNNING

REM ---------- 4. Dependencies (first run only) ----------
if exist "node_modules\.bin\vite.cmd" goto DEPS_OK
echo [..] First run - installing dependencies, please wait...
call npm install
if errorlevel 1 goto NPM_FAIL
:DEPS_OK

REM ---------- 5. Start Vite in its own window ----------
echo [..] Starting Vite dev server at http://localhost:%PORT% ...
start "Agent Workbench Server" cmd /k "npm run dev %DEVFLAGS%"

REM ---------- 6. Wait until the port is listening ----------
set "TRIES=0"
:WAIT_DEV
set /a TRIES+=1
if %TRIES% GEQ 45 goto TIMEOUT
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 goto READY
ping -n 2 127.0.0.1 >nul
goto WAIT_DEV

REM ---------- Single-file mode ----------
:SINGLE
set "PORT=5174"
if exist "dist-single\index.html" goto SINGLE_OK
echo [..] No dist-single build found - running npm run build:single ...
call npm run build:single
if errorlevel 1 goto NPM_FAIL
:SINGLE_OK
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 goto ALREADY_RUNNING
echo [..] Serving dist-single at http://localhost:%PORT% ...
start "Agent Workbench Server" cmd /k "npx vite preview --outDir dist-single --port %PORT% --strictPort"
set "TRIES=0"
:WAIT_SINGLE
set /a TRIES+=1
if %TRIES% GEQ 45 goto TIMEOUT
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 goto READY
ping -n 2 127.0.0.1 >nul
goto WAIT_SINGLE

REM ---------- Shared success ----------
:READY
echo [OK] Server is up. Opening your default browser...
start "" "http://localhost:%PORT%"
echo.
echo   URL   : http://localhost:%PORT%
echo   STOP  : close the "Agent Workbench Server" window
echo   SETUP : fill Base URL / API Key / Model in the app Settings page
if /i "%MODE%"=="lan" echo   LAN   : http://YOUR-LAN-IP:%PORT% (allow it through the firewall)
echo.
pause
exit /b 0

:ALREADY_RUNNING
echo [!!] Port %PORT% is already in use - a server seems to be running.
echo      Opening the existing page instead of starting a second server.
start "" "http://localhost:%PORT%"
echo.
echo   URL   : http://localhost:%PORT%
echo   If this is NOT the Agent Workbench, close the program that owns
echo   port %PORT% (check with: netstat -ano) and run this script again.
echo.
pause
exit /b 0

:NO_NODE
echo [ERROR] Node.js was not found in PATH.
echo         This project needs Node.js 20 or newer.
echo         Install it from https://nodejs.org/ and run this script again.
echo.
pause
exit /b 1

:OLD_NODE
echo [ERROR] Node.js 20 or newer is required. Detected:
node -v
echo.
pause
exit /b 1

:NPM_FAIL
echo [ERROR] An npm command failed. See the messages above.
echo.
pause
exit /b 1

:TIMEOUT
echo [ERROR] Port %PORT% did not open within about 45 seconds.
echo         Check the "Agent Workbench Server" window for the real error.
echo.
pause
exit /b 1
