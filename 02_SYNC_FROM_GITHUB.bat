@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp002_SYNC_FROM_GITHUB.ps1"
