# RoleClaw Installer for Windows
# Only installs global roleclaw command. IDE and role are selected per-project via roleclaw init.
# Requires: Node.js, PowerShell 5.1+
# macOS/Linux: use scripts/install-roleclaw.sh
#
# If "script execution disabled" error, use:
#   scripts\install-roleclaw.bat
# or: powershell -ExecutionPolicy Bypass -File scripts\install-roleclaw.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoleClawRepo = Resolve-Path (Join-Path $ScriptDir "..")
$RoleClawEntry = Join-Path $RoleClawRepo "scripts\roleclaw.mjs"

function Print-Title {
    Write-Host "========================================="
    Write-Host "      RoleClaw Installer"
    Write-Host "========================================="
}

function Install-GlobalCommand {
    $binDir = Join-Path $env:USERPROFILE "bin"
    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    $batPath = Join-Path $binDir "roleclaw.bat"
    $batContent = "@echo off`nnode `"$RoleClawEntry`" %*"
    Set-Content -Path $batPath -Value $batContent -Encoding ASCII

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    }

    # Refresh current session PATH so roleclaw is available immediately (PowerShell does not auto-reload)
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "Installed roleclaw to $batPath"
}

function Print-NextSteps {
    Write-Host ""
    Write-Host "Installation complete. PATH refreshed for current session."
    Write-Host ""
    Write-Host "Next steps (per project):"
    Write-Host "  cd C:\path\to\your\project"
    Write-Host "  roleclaw init          # interactive: select IDE & role"
    Write-Host "  roleclaw pull          # install skills and rules"
    Write-Host ""
    Write-Host "If project has no registry-template, set Registry path:"
    Write-Host '  $env:ROLECLAW_REGISTRY = "C:\path\to\registry"; roleclaw init'
    Write-Host "  # or: roleclaw init --registry C:\path\to\registry"
}

# Main
Print-Title
Install-GlobalCommand
Print-NextSteps
