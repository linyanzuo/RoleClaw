@echo off
REM AIPM Installer for Windows - bypasses PowerShell execution policy
REM Run: scripts\install-aipm.bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-aipm.ps1"
set "PATH=%USERPROFILE%\bin;%PATH%"
echo.
echo Verifying...
aipm
echo.
echo ----------------------------------------
echo If aipm is not found in your terminal:
echo   1. Close and reopen the terminal (recommended)
echo   2. Or run this in PowerShell:
echo      $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
echo   3. Or run this in CMD:
echo      set "PATH=%USERPROFILE%\bin;%PATH%"
echo ----------------------------------------
pause
