#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[zerollama-setup] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

print_check() {
  local label="$1"
  local status="$2"
  local detail="$3"
  echo "[check] ${label}: ${status}${detail:+ (${detail})}"
}

node_major() {
  if ! require_cmd node; then
    echo "0"
    return
  fi
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

is_node_ready() {
  local major
  major="$(node_major)"
  [ "$major" -ge 18 ]
}

print_requirement_checks() {
  local node_status="missing"
  local node_detail=""
  local yarn_status="missing"
  local yarn_detail=""
  local ollama_status="missing"
  local ollama_detail=""

  if require_cmd node; then
    node_detail="$(node -v 2>/dev/null || true)"
    if is_node_ready; then
      node_status="ok"
    else
      node_status="too old"
    fi
  fi

  if require_cmd yarn; then
    yarn_status="ok"
    yarn_detail="$(yarn -v 2>/dev/null || true)"
  fi

  if require_cmd ollama; then
    ollama_status="ok"
    ollama_detail="$(command -v ollama)"
  fi

  print_check "node>=18" "$node_status" "$node_detail"
  print_check "yarn" "$yarn_status" "$yarn_detail"
  print_check "ollama" "$ollama_status" "$ollama_detail"
}

collect_missing_requirements() {
  local missing=()
  if ! is_node_ready; then
    missing+=("node>=18")
  fi
  if ! require_cmd yarn; then
    missing+=("yarn")
  fi
  if ! require_cmd ollama; then
    missing+=("ollama")
  fi
  printf '%s\n' "${missing[@]-}"
}

ensure_corepack_yarn() {
  if require_cmd yarn; then
    return
  fi

  if require_cmd corepack; then
    log "Enabling Yarn via Corepack"
    corepack enable || true
    corepack prepare yarn@stable --activate || true
  fi

  if ! require_cmd yarn && require_cmd npm; then
    log "Installing Yarn with npm"
    sudo npm install -g yarn
  fi
}

install_with_brew() {
  if ! require_cmd brew; then
    log "Homebrew is required on macOS. Install from https://brew.sh"
    exit 1
  fi

  local missing=()
  if ! is_node_ready; then
    missing+=("node")
  fi
  if ! require_cmd yarn; then
    missing+=("yarn")
  fi
  if ! require_cmd ollama; then
    missing+=("ollama")
  fi

  if [ ${#missing[@]} -eq 0 ]; then
    return
  fi

  log "Installing missing packages with Homebrew: ${missing[*]}"
  brew update
  brew install "${missing[@]}"
}

install_with_apt() {
  log "Installing missing requirements with apt"
  sudo apt-get update
  sudo apt-get install -y curl ca-certificates gnupg

  if ! is_node_ready || ! require_cmd npm; then
    sudo apt-get install -y nodejs npm
  fi

  ensure_corepack_yarn

  if ! require_cmd ollama; then
    log "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
}

install_with_dnf() {
  log "Installing missing requirements with dnf"
  if ! is_node_ready || ! require_cmd npm || ! require_cmd curl; then
    sudo dnf install -y nodejs npm curl
  fi

  ensure_corepack_yarn

  if ! require_cmd ollama; then
    log "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
}

install_with_pacman() {
  log "Installing missing requirements with pacman"
  local pkgs=()
  if ! is_node_ready; then
    pkgs+=("nodejs" "npm")
  fi
  if ! require_cmd yarn; then
    pkgs+=("yarn")
  fi
  if ! require_cmd curl; then
    pkgs+=("curl")
  fi
  if [ ${#pkgs[@]} -gt 0 ]; then
    sudo pacman -Sy --noconfirm "${pkgs[@]}"
  fi

  if ! require_cmd ollama; then
    log "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
}

install_on_linux() {
  if require_cmd apt-get; then
    install_with_apt
  elif require_cmd dnf; then
    install_with_dnf
  elif require_cmd pacman; then
    install_with_pacman
  else
    log "Unsupported Linux package manager. Install Node.js >=18, Yarn, and Ollama manually."
    exit 1
  fi
}

install_on_windows_shell() {
  if ! require_cmd powershell.exe; then
    log "powershell.exe is required when running from Git Bash/MSYS/Cygwin."
    exit 1
  fi

  log "Installing missing requirements with winget via PowerShell"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Write-Error 'winget is required. Install App Installer from Microsoft Store.'
      exit 1
    }

    function Install-IfMissing($CommandName, $WingetId) {
      if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        winget install --id $WingetId -e --accept-package-agreements --accept-source-agreements
      }
    }

    Install-IfMissing 'node' 'OpenJS.NodeJS.LTS'
    Install-IfMissing 'yarn' 'Yarn.Yarn'
    Install-IfMissing 'ollama' 'Ollama.Ollama'
  "
}

main() {
  echo "[zerollama-setup] Checking requirements..."
  print_requirement_checks

  local missing
  missing="$(collect_missing_requirements)"

  if [ -z "$missing" ]; then
    echo "ready"
    exit 0
  fi

  log "Missing requirements detected:"
  while IFS= read -r req; do
    [ -n "$req" ] && log "  - $req"
  done <<< "$missing"

  case "$(uname -s)" in
    Darwin)
      install_with_brew
      ;;
    Linux)
      install_on_linux
      ;;
    CYGWIN*|MINGW*|MSYS*)
      install_on_windows_shell
      ;;
    *)
      log "Unsupported OS. Install Node.js >=18, Yarn, and Ollama manually."
      exit 1
      ;;
  esac

  if [ -z "$(collect_missing_requirements)" ]; then
    echo "[zerollama-setup] Re-checking requirements after install..."
    print_requirement_checks
    log "Done. Installed missing requirements for Zerollama."
    log "Next steps:"
    log "  yarn install"
    log "  yarn dev"
    exit 0
  fi

  log "Some requirements are still missing after install attempt."
  log "Please install Node.js >=18, Yarn, and Ollama manually, then rerun this script."
  exit 1
}

main "$@"
