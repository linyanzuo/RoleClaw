#!/usr/bin/env bash
# RoleClaw Installer - macOS / Linux
# Only installs global roleclaw command. IDE and role are selected per-project via roleclaw init.
# Windows: use scripts/install-roleclaw.ps1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLECLAW_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROLECLAW_ENTRY="${ROLECLAW_REPO}/scripts/roleclaw.mjs"

print_title() {
  echo "========================================="
  echo "      RoleClaw Installer"
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

install_global_command() {
  chmod +x "${ROLECLAW_ENTRY}"
  ln -sfn "${ROLECLAW_ENTRY}" "${GLOBAL_BIN_DIR}/roleclaw"

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
  echo "  roleclaw init          # interactive: select IDE & role"
  echo "  roleclaw pull          # install skills and rules"
  echo
  echo "If project has no registry-template, set Registry path:"
  echo "  ROLECLAW_REGISTRY=/path/to/registry roleclaw init"
  echo "  # or: roleclaw init --registry /path/to/registry"
}

main() {
  print_title
  select_global_bin_dir
  install_global_command
  print_next_steps
}

main "$@"
