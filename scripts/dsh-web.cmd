@echo off
setlocal EnableExtensions
title DeepSeek Harness  -  dsh web

rem ============================================================
rem  DeepSeek Harness (dsh) desktop launcher  --  Windows
rem
rem  Why this exists:
rem    dsh ships as an npx-only package - there is no global
rem    "dsh" command on PATH. A .lnk cannot point at it, so this
rem    script resolves node.exe and the dsh entry point at run
rem    time, then boots the "web" profile.
rem
rem  Keep this file ASCII-only. cmd.exe reads .cmd bytes in the
rem  console code page, so non-ASCII here corrupts the parser.
rem ============================================================

rem ---------------- CONFIG ----------------
rem Workspace that dsh registers and opens in the web UI.
set "DSH_CWD=%USERPROFILE%\dsh-workspace"

rem Web UI port. If it is taken, dsh exits with EADDRINUSE.
set "DSH_PORT=3080"

rem Optional: pin the dsh entry point and skip auto-discovery.
rem set "DSH_BIN=C:\path\to\@deepseek-ai\dsh\lib\bin.js"

rem Optional: dsh profile name (default: web when running "dsh web").
rem set "DSH_PROFILE=web"
rem ---------------- END CONFIG ----------------

set "DSH_URL=http://127.0.0.1:%DSH_PORT%/"

rem ---------- 1) Locate node.exe ----------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>NUL') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto dsh_no_node

rem ---------- 2) Locate the dsh entry point ----------
rem The npx cache lives under a HASH directory that changes whenever
rem the package version or the npm cache layout changes - so it must
rem never be hard-coded. Probe in order of reliability:
rem   a) ~\.dsh\profiles\node_modules\@deepseek-ai\dsh  (a symlink that
rem      dsh itself maintains - this is dsh's own resolved copy)
rem   b) the global npm prefix
rem   c) the npx cache, newest directory first
if not defined DSH_BIN if exist "%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" set "DSH_BIN=%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not defined DSH_BIN if exist "%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" set "DSH_BIN=%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not defined DSH_BIN if exist "%LOCALAPPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" set "DSH_BIN=%LOCALAPPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not defined DSH_BIN for /f "delims=" %%i in ('dir /b /ad /o-d "%LOCALAPPDATA%\npm-cache\_npx" 2^>NUL') do call :dsh_probe_npx "%%i"
if not defined DSH_BIN goto dsh_no_entry
goto dsh_have_entry

rem Probe one npx cache hash directory. "call" is used instead of a
rem parenthesised for-body so that percent-expansion cannot be frozen
rem at parse time. The /o-d above means the first hit is the newest.
:dsh_probe_npx
if defined DSH_BIN goto :eof
set "_NPXDIR=%LOCALAPPDATA%\npm-cache\_npx\%~1\node_modules\@deepseek-ai\dsh\lib\bin.js"
if exist "%_NPXDIR%" set "DSH_BIN=%_NPXDIR%"
goto :eof

:dsh_have_entry

rem ---------- 3) Enter the workspace ----------
rem dsh registers the current directory as a workspace, so start from
rem a stable place instead of inheriting wherever the shortcut ran.
if not exist "%DSH_CWD%\" mkdir "%DSH_CWD%" >NUL 2>&1
cd /d "%DSH_CWD%"
if errorlevel 1 goto dsh_no_cwd

echo ============================================================
echo   DeepSeek Harness   --   dsh web
echo ------------------------------------------------------------
echo   node      : %NODE_EXE%
echo   entry     : %DSH_BIN%
echo   workspace : %CD%
echo   web ui    : %DSH_URL%
echo ------------------------------------------------------------
echo   The browser opens automatically with a one-time access
echo   token. The bare URL above answers 401 without it, so use
echo   the link dsh prints - do not retype the host and port.
echo.
echo   Keep this window open while you use the UI.
echo   Press Ctrl+C here - or just close this window - to stop it.
echo ============================================================
echo.

if defined DSH_PROFILE goto dsh_run_profile
"%NODE_EXE%" "%DSH_BIN%" web --port %DSH_PORT%
goto dsh_after

:dsh_run_profile
"%NODE_EXE%" "%DSH_BIN%" --profile "%DSH_PROFILE%" web --port %DSH_PORT%

:dsh_after
set "RC=%ERRORLEVEL%"

rem A parenthesised IF block is deliberately avoided here. A literal
rem bracket inside an "if ( ... )" block derails cmd.exe's block
rem parser: the branch mis-fires and whole lines vanish. Compare with
rem goto instead. See docs/pitfalls.md.
if not "%RC%"=="0" goto dsh_failed
goto dsh_exit

rem ---------- error branches ----------
:dsh_no_node
echo [dsh] ERROR: node.exe was not found on this machine.
echo [dsh] Please install Node.js 20 or newer, then try again.
echo.
pause
exit /b 1

:dsh_no_entry
echo [dsh] ERROR: the @deepseek-ai/dsh entry point was not found.
echo [dsh] Looked in the .dsh profile links, the global npm prefix
echo [dsh] and the npx cache.
echo [dsh] Tip: run   npx @deepseek-ai/dsh --help   once in a
echo [dsh] terminal to populate the cache, then try again.
echo [dsh] Or pin it manually with:  set "DSH_BIN=..."
echo.
pause
exit /b 1

:dsh_no_cwd
echo [dsh] ERROR: cannot enter the workspace "%DSH_CWD%"
echo.
pause
exit /b 1

:dsh_failed
echo.
echo ------------------------------------------------------------
echo [dsh] startup failed - exit code %RC%
echo.
echo [dsh] If the log above mentions EADDRINUSE or port %DSH_PORT%,
echo [dsh] then DeepSeek Harness is probably ALREADY RUNNING in
echo [dsh] another window. Switch to that window and use the URL
echo [dsh] it printed, or close it first and start again.
echo ------------------------------------------------------------

:dsh_exit
echo.
echo [dsh] exited with code %RC%
echo.
pause
exit /b %RC%
