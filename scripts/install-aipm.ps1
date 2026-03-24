# AIPM Installer for Windows
# Only installs global aipm command. IDE and role are selected per-project via aipm init.
# Requires: Node.js, PowerShell 5.1+
# macOS/Linux: use scripts/install-aipm.sh
#
# If "script execution disabled" error, use:
#   scripts\install-aipm.bat
# or: powershell -ExecutionPolicy Bypass -File scripts\install-aipm.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AipmRepo = Resolve-Path (Join-Path $ScriptDir "..")
$AipmEntry = Join-Path $AipmRepo "scripts\aipm.mjs"

function Print-Title {
    Write-Host "========================================="
    Write-Host "      AIPM Installer"
    Write-Host "========================================="
}

function Install-GlobalCommand {
    $binDir = Join-Path $env:USERPROFILE "bin"
    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    # Remove legacy roleclaw command
    $roleclawBat = Join-Path $binDir "roleclaw.bat"
    if (Test-Path $roleclawBat) {
        Remove-Item $roleclawBat -Force
        Write-Host "Removed legacy 'roleclaw' command."
    }

    $batPath = Join-Path $binDir "aipm.bat"
    $batContent = "@echo off`nnode `"$AipmEntry`" %*"
    Set-Content -Path $batPath -Value $batContent -Encoding ASCII

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    }

    # Refresh current session PATH so aipm is available immediately (PowerShell does not auto-reload)
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "Installed aipm to $batPath"
}

function Print-NextSteps {
    Write-Host ""
    Write-Host "Installation complete."
    Write-Host ""
    Write-Host "NOTE: If you ran install-aipm.bat, the PATH was updated in the registry."
    Write-Host "      You may need to close and reopen the terminal for 'aipm' to be found."
    Write-Host ""
    Write-Host "Next steps (per project):"
    Write-Host "  cd C:\path\to\your\project"
    Write-Host "  aipm init          # interactive: select IDE & role"
    Write-Host "  aipm install       # install skills and rules"
    Write-Host ""
    Write-Host "Registry: default remote / global (~/.aipm) / project (aipm_profile.json)"
    Write-Host "  aipm init --registry <path-or-url>   # specify registry"
}

# Main
Print-Title
Install-GlobalCommand
Print-NextSteps
