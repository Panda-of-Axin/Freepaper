@echo off
cd /d "%~dp0"
where wt >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" wt -d "%~dp0"
) else (
  start "Freepaper Terminal" cmd /k cd /d "%~dp0"
)
