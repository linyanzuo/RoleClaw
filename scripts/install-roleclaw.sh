#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLECLAW_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROLECLAW_ENTRY="${ROLECLAW_REPO}/scripts/roleclaw.mjs"
ROLE_DIR="${ROLECLAW_REPO}/registry-template/roles"
DEFAULT_REGISTRY="${ROLECLAW_REPO}/registry-template"

print_title() {
  echo "========================================="
  echo "      RoleClaw Interactive Installer"
  echo "========================================="
}

print_ide_matrix() {
  cat <<'EOF'

Supported IDE Tools (Step 3):

  1) Cursor                  [SUPPORTED]
  2) Claude Code             [PLANNED]
  3) VS Code (AgentSkills)   [PLANNED]
  4) GitHub Copilot Chat     [PLANNED]

EOF
}

select_supported_ide() {
  local ides=("Cursor")

  echo "Choose IDE (currently installable options):"
  select _ide in "${ides[@]}"; do
    case "${REPLY}" in
      1)
        SELECTED_IDE="cursor"
        echo "Selected IDE: Cursor"
        break
        ;;
      *)
        echo "Please choose a valid number."
        ;;
    esac
  done
}

load_roles() {
  if [[ ! -d "${ROLE_DIR}" ]]; then
    echo "Role directory not found: ${ROLE_DIR}" >&2
    exit 1
  fi

  ROLE_OPTIONS=()
  ROLE_IDS=()
  local role_file role_id role_name
  shopt -s nullglob
  for role_file in "${ROLE_DIR}"/*.json; do
    role_id="$(basename "${role_file}" .json)"
    role_name="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(j.name||'');" "${role_file}")"
    ROLE_IDS+=("${role_id}")
    if [[ -n "${role_name}" ]]; then
      ROLE_OPTIONS+=("${role_id} (${role_name})")
    else
      ROLE_OPTIONS+=("${role_id}")
    fi
  done
  shopt -u nullglob

  if [[ ${#ROLE_IDS[@]} -eq 0 ]]; then
    echo "No roles found in ${ROLE_DIR}" >&2
    exit 1
  fi
}

select_role() {
  echo
  echo "Choose role:"
  select role in "${ROLE_OPTIONS[@]}"; do
    if [[ -n "${role:-}" ]]; then
      SELECTED_ROLE="${ROLE_IDS[$((REPLY - 1))]}"
      echo "Selected role: ${SELECTED_ROLE}"
      break
    fi
    echo "Please choose a valid number."
  done
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

configure_project() {
  local project_dir registry_ref

  echo
  read -r -p "Project directory to configure (default: current directory): " project_dir
  project_dir="${project_dir:-$(pwd)}"

  if [[ ! -d "${project_dir}" ]]; then
    echo "Project directory does not exist: ${project_dir}" >&2
    exit 1
  fi

  read -r -p "Registry path/URL (default: ${DEFAULT_REGISTRY}): " registry_ref
  registry_ref="${registry_ref:-${DEFAULT_REGISTRY}}"

  (
    cd "${project_dir}"
    roleclaw init
    node -e "const fs=require('fs');const p='.roleclaw/config.json';const data=JSON.parse(fs.readFileSync(p,'utf8'));data.registry=process.argv[1];fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n');" "${registry_ref}"
    roleclaw use-role "${SELECTED_ROLE}"
    roleclaw sync
    roleclaw doctor
  )

  echo
  echo "Installation complete."
  echo "IDE: ${SELECTED_IDE}"
  echo "Role: ${SELECTED_ROLE}"
  echo "Project: ${project_dir}"
  echo "Registry: ${registry_ref}"
  echo
  echo "Try:"
  echo "  roleclaw list"
}

main() {
  print_title
  print_ide_matrix
  select_supported_ide
  load_roles
  select_role
  select_global_bin_dir
  install_global_command
  configure_project
}

main "$@"
