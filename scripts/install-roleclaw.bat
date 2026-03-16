@echo off
REM RoleClaw Installer for Windows - bypasses PowerShell execution policy
REM Run: scripts\install-roleclaw.bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-roleclaw.ps1"
pause
