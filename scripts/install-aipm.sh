#!/usr/bin/env bash
# AIPM Installer - macOS / Linux
# Only installs global aipm command. IDE and role are selected per-project via aipm init.
# Windows: use scripts/install-aipm.ps1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIPM_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
AIPM_ENTRY="${AIPM_REPO}/scripts/aipm.mjs"

print_title() {
  echo "========================================="
  echo "      AIPM Installer"
  echo "========================================="
}

select_global_bin_dir() {
  if [[ -w "/usr/local/bin" ]]; then
    GLOBAL_BIN_DIR="/usr/local/bin"
  else
    GLOBAL_BIN_DIR="${HOME}/bin"
    mkdir -p "${GLOBAL_BIN_DIR}"
  fi
}

remove_legacy_roleclaw() {
  local roleclaw_path="${GLOBAL_BIN_DIR}/roleclaw"
  if [[ -e "${roleclaw_path}" ]]; then
    rm -f "${roleclaw_path}"
    echo "Removed legacy 'roleclaw' command."
  fi
}

install_global_command() {
  remove_legacy_roleclaw
  chmod +x "${AIPM_ENTRY}"
  ln -sfn "${AIPM_ENTRY}" "${GLOBAL_BIN_DIR}/aipm"

  if [[ ":${PATH}:" != *":${GLOBAL_BIN_DIR}:"* ]]; then
    echo
    echo "[WARN] ${GLOBAL_BIN_DIR} is not in PATH."
    echo "       Add it to your shell profile, then reopen terminal."
  fi
}

print_next_steps() {
  echo
  echo "Installation complete."
  echo
  echo "Next steps (per project):"
  echo "  cd /path/to/your/project"
  echo "  aipm init          # interactive: select IDE & profile"
  echo "  aipm pull          # install skills and rules"
  echo
  echo "If project has no registry-template, set Registry path:"
  echo "  AIPM_REGISTRY=/path/to/registry aipm init"
  echo "  # or: aipm init --registry /path/to/registry"
}

main() {
  print_title
  select_global_bin_dir
  install_global_command
  print_next_steps
}

main "$@"
