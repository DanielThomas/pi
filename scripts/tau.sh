#!/usr/bin/env bash
#
# tau — provision and connect to pi on a remote host via SSH.
#
# Usage:
#   tau [options] [ssh-options] user@host
#
# Options:
#   --use-pi-coding-agent-dir  Use the remote host's PI_CODING_AGENT_DIR as-is
#   -e, --ext <src>   Include an installed extension (can be repeated)
#   --mode <mode>     Output mode: text (default), json, or rpc
#   --verbose         Show detailed progress output
#   -h, --help        Show this help
#
set -euo pipefail

# ============================================================================
# Config
# ============================================================================

VERBOSE=false
SPINNER_PID=""

now() { printf '%.3f' "$(date +%s.%N)"; }
TAU_START="$(now)"
info() {
  if [[ "$VERBOSE" == "true" ]]; then
    local elapsed
    elapsed="$(printf '%.3f' "$(echo "$(now) - $TAU_START" | bc)")"
    printf '\033[2m+%ss %s\033[0m\n' "$elapsed" "$*" >&2
  fi
}

hide_cursor() { printf '\033[?25l' >&2; }
show_cursor() { printf '\033[?25h' >&2; }

progress() {
  progress_stop
  if [[ "$VERBOSE" == "true" ]]; then
    info "$1"
    return
  fi
  local msg="$1"
  (
    while true; do
      printf '\r\033[2m \033[0mτ\033[2m %s\033[0m\033[K' "$msg" >&2
      sleep 0.5
      printf '\r\033[2m τ %s\033[0m\033[K' "$msg" >&2
      sleep 0.5
    done
  ) &
  SPINNER_PID=$!
}

progress_stop() {
  if [[ -n "$SPINNER_PID" ]]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    printf '\r\033[2K' >&2
  fi
}

trap 'progress_stop; show_cursor' EXIT

NODE_VERSION="22.19.0"
PI_VERSION="0.75.3"
TAU_REMOTE_DIR='${XDG_DATA_HOME:-$HOME/.local/share}/tau'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TSX="${REPO_ROOT}/node_modules/.bin/tsx"
PI_CLI_SRC="${REPO_ROOT}/packages/coding-agent/src/cli.ts"
PI_CLI_DIST="${REPO_ROOT}/packages/coding-agent/dist/cli.js"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tau"
TAR_MAC_OPTS=""; [[ "$(uname -s)" == "Darwin" ]] && TAR_MAC_OPTS="--no-mac-metadata"

# Create a reproducible tarball from a staging directory.
# Compression is chosen by the archive extension: .tar.zst uses zstd -7,
# anything else uses gzip.  COPYFILE_DISABLE=1 prevents macOS from including
# AppleDouble (._*) resource fork files that make archives non-reproducible.
# Run a command silently, but print its output on failure.
run_quiet() {
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    rm -f "$log"
  else
    local rc=$?
    progress_stop
    echo "Error: $1 failed (exit $rc)" >&2
    cat "$log" >&2
    rm -f "$log"
    return $rc
  fi
}

create_tar() {
  local archive="$1" staging="$2"
  case "$archive" in
    *.tar.zst)
      COPYFILE_DISABLE=1 tar --no-xattrs ${TAR_MAC_OPTS:-} -cf - -C "$staging" . | zstd -7 -q -o "$archive"
      ;;
    *)
      COPYFILE_DISABLE=1 tar --no-xattrs ${TAR_MAC_OPTS:-} -czf "$archive" -C "$staging" .
      ;;
  esac
}

# Remove files from a node_modules tree that are unnecessary at runtime on the
# target. This runs after npm install and before the bundle is tarred up.
strip_for_target() {
  local nm="$1" os="$2" arch="$3"

  # --- platform-specific binaries ---

  # koffi bundles all 18 platform binaries in a single package instead of
  # using per-platform npm packages with os/cpu fields
  local koffi_dir="${nm}/koffi/build/koffi"
  if [[ -d "$koffi_dir" ]]; then
    local keep="${os}_${arch}"
    local platform_dir
    for platform_dir in "$koffi_dir"/*/; do
      [[ "$(basename "$platform_dir")" == "$keep" ]] || rm -rf "$platform_dir"
    done
  fi

  # --- development-only artifacts ---

  # TypeScript type definitions (pulled in by protobufjs) are never needed at runtime
  rm -rf "${nm}/@types"

  # Source maps are never needed on the remote host
  find "$nm" -name '*.map' -type f -delete

  # TypeScript declarations are build-time only
  find "$nm" \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -type f -delete

  # TypeScript source shipped alongside compiled dist/ (SDKs like mistralai,
  # openai, anthropic, google genai)
  local pkg
  for pkg in \
    "@mistralai/mistralai" \
    "@google/genai" \
    "openai" \
    "@anthropic-ai/sdk" \
    "gaxios"; do
    rm -rf "${nm}/${pkg}/src"
  done

  # Test and example directories inside packages
  find "$nm" -maxdepth 4 \( -name tests -o -name test -o -name examples \) \
    -type d -exec rm -rf {} + 2>/dev/null || true

  # Documentation directories in specific packages (not blanket — some packages
  # like yaml use doc/ for runtime code)
  rm -rf "${nm}/@earendil-works/pi-coding-agent/docs"
  rm -rf "${nm}/@earendil-works/pi-coding-agent/examples"
  rm -rf "${nm}/undici/docs"
  rm -rf "${nm}/koffi/doc"
  rm -rf "${nm}/bignumber.js/doc"

  # READMEs, CHANGELOGs, and LICENSE files (not needed at runtime)
  find "$nm" \( -name 'README*' -o -name 'CHANGELOG*' -o -name 'CONTRIBUTING*' \) \
    -type f -delete

  # TypeScript build info files
  find "$nm" -name 'tsconfig.tsbuildinfo' -type f -delete
  find "$nm" -name 'tsconfig*.json' -type f -delete
}

# ============================================================================
# Argument parsing
# ============================================================================

USE_PI_CODING_AGENT_DIR=false
MODE=""
SSH_ARGS=()
HOST=""
EXT_SOURCES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      cat <<'EOF'
Usage: tau [options] [ssh-options] user@host

Provision and connect to pi on a remote host via SSH.

On first run, downloads Node.js and pi for the remote platform,
bundles them, and copies to the remote host. Subsequent runs
connect directly.

Options:
  --use-pi-coding-agent-dir
                       Use the remote host's PI_CODING_AGENT_DIR (~/.pi/agent/)
                       instead of tau-managed config. Skips settings sync and
                       extension deployment
  --mode <mode>        Output mode: text (default), json, or rpc
                       Passed through to pi on the remote host
  -e, --ext, --extension <source>
                       Include an installed extension in the bundle
                       Supports git:host/org/repo, npm:package, or local paths
                       Can be specified multiple times
  --verbose            Show detailed progress output
  -h, --help           Show this help

Examples:
  tau user@host
  tau -e git:github.com/org/my-extension user@host
  tau --ext npm:pi-ext-foo --ext npm:pi-ext-bar user@host
  tau --use-pi-coding-agent-dir user@host
  tau -p 2222 user@host
EOF
      exit 0
      ;;
    --use-pi-coding-agent-dir)
      USE_PI_CODING_AGENT_DIR=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    -e|--ext|--extension)
      EXT_SOURCES+=("$2")
      shift 2
      ;;
    -[bcDEFIiJLlmOopQRSWw])
      SSH_ARGS+=("$1" "$2")
      shift 2
      ;;
    -*)
      SSH_ARGS+=("$1")
      shift
      ;;
    *)
      HOST="$1"
      shift
      ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "Error: missing host argument." >&2
  echo "Usage: tau [options] [ssh-options] user@host" >&2
  exit 1
fi

mkdir -p "$CACHE_DIR"

# Multiplex all SSH calls over a single TCP connection
SSH_ARGS+=(-o "ControlMaster=auto" -o "ControlPath=${CACHE_DIR}/ssh-%C" -o "ControlPersist=30")

node_tarball_url() {
  local os="$1" arch="$2"
  echo "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${os}-${arch}.tar.xz"
}

ensure_node_tarball() {
  local os="$1" arch="$2"
  local cache_path="${CACHE_DIR}/node-v${NODE_VERSION}-${os}-${arch}.tar.xz"
  if [[ -f "$cache_path" ]]; then
    _RESULT="$cache_path"
    return
  fi
  progress "Downloading Node.js ${NODE_VERSION} for ${os}-${arch}"
  curl -fsSL "$(node_tarball_url "$os" "$arch")" -o "$cache_path"
  _RESULT="$cache_path"
}

# Base bundle: node + pi, cached per version+arch
ensure_base_bundle() {
  local os="$1" arch="$2"
  local base_path="${CACHE_DIR}/tau-base-${PI_VERSION}-${os}-${arch}.${TAR_EXT}"
  if [[ -f "$base_path" ]]; then
    _RESULT="$base_path"
    return
  fi

  ensure_node_tarball "$os" "$arch"
  local node_tarball="$_RESULT"

  progress "Building base bundle for ${os}-${arch}"
  local staging="${CACHE_DIR}/staging-base-${PI_VERSION}-${os}-${arch}"
  rm -rf "$staging"
  mkdir -p "$staging"

  tar xf "$node_tarball" -C "$staging" --strip-components=2 \
    "node-v${NODE_VERSION}-${os}-${arch}/bin/node"

  progress "Building pi"
  run_quiet npm run build --prefix "$REPO_ROOT"

  # Pack all workspace packages so npm install uses the local builds
  # instead of fetching published versions from npm.
  progress "Installing dependencies"
  local pkg tgz_files=()
  for pkg in agent ai tui coding-agent; do
    local tgz
    tgz="$(cd "${REPO_ROOT}/packages/${pkg}" && npm pack --pack-destination "$staging" 2>/dev/null | tail -1)"
    tgz_files+=("${staging}/${tgz}")
  done
  run_quiet npm install --prefix "$staging" "${tgz_files[@]}" \
    --omit=dev --no-audit --no-fund \
    --os="$os" --cpu="$arch"
  rm -f "${staging}"/*.tgz

  progress "Stripping development files"
  strip_for_target "${staging}/node_modules" "$os" "$arch"

  create_tar "$base_path" "$staging"
  rm -rf "$staging"

  _RESULT="$base_path"
}

# Extensions: install missing, then update all to latest
ensure_extensions() {
  local ext_dir="${CACHE_DIR}/extensions"
  mkdir -p "$ext_dir"

  for source in "${EXT_SOURCES[@]}"; do
    if ! PI_CODING_AGENT_DIR="$ext_dir" "$TSX" "$PI_CLI_SRC" list 2>/dev/null | grep -q "$source"; then
      progress "Installing extension: ${source}"
      PI_CODING_AGENT_DIR="$ext_dir" run_quiet "$TSX" "$PI_CLI_SRC" install "$source"
    fi
  done

  progress "Updating extensions"
  PI_CODING_AGENT_DIR="$ext_dir" run_quiet "$TSX" "$PI_CLI_SRC" update --extensions

  # Pi's package manager runs `npm install` in git extension dirs, which
  # auto-installs peer dependencies (npm 7+). Extensions declare pi packages
  # as peers, so the entire pi dependency tree gets duplicated. The extension
  # loader resolves those imports back to the host pi installation via jiti
  # aliases, so the duplicates are never used. Re-run npm install with
  # --legacy-peer-deps to strip them. A marker file tracks whether pruning
  # has already been done for the current extension content.
  local prune_marker="${ext_dir}/.pruned"
  local content_hash
  content_hash="$(cd "$ext_dir" && find . -name .pruned -prune -o -type f -print 2>/dev/null | sort | xargs shasum 2>/dev/null | shasum | cut -c1-8)"
  if [[ -f "$prune_marker" && "$(cat "$prune_marker")" == "$content_hash" ]]; then
    return
  fi
  local dir
  for dir in "$ext_dir"/git/*/*/*; do
    [[ -f "$dir/package.json" ]] || continue
    progress "Pruning peer dependencies: ${dir##*/}"
    run_quiet npm install --omit=dev --legacy-peer-deps --prefix "$dir"
  done
  # Recompute after pruning and write marker
  content_hash="$(cd "$ext_dir" && find . -name .pruned -prune -o -type f -print 2>/dev/null | sort | xargs shasum 2>/dev/null | shasum | cut -c1-8)"
  echo "$content_hash" > "$prune_marker"
}

# Extension bundle: extension files only, platform-independent
ensure_ext_bundle() {
  if [[ ${#EXT_SOURCES[@]} -eq 0 ]]; then
    return
  fi

  local ext_dir="${CACHE_DIR}/extensions"
  local prune_marker="${ext_dir}/.pruned"

  # Fast path: if all requested extensions are installed, pruned, and the
  # bundle is cached, skip the expensive tsx/npm invocations entirely.
  if [[ -f "$prune_marker" && -f "${ext_dir}/settings.json" ]]; then
    local all_installed=true
    for source in "${EXT_SOURCES[@]}"; do
      if ! grep -q "$source" "${ext_dir}/settings.json"; then
        all_installed=false
        break
      fi
    done
    if [[ "$all_installed" == "true" ]]; then
      local cached_hash
      cached_hash="$(cat "$prune_marker")"
      local bundle_path="${CACHE_DIR}/tau-ext-${cached_hash}.${TAR_EXT}"
      if [[ -f "$bundle_path" ]]; then
        _RESULT="$bundle_path"
        return
      fi
    fi
  fi

  # Slow path: install/update extensions, prune, and build bundle
  ensure_extensions

  local ext_hash
  ext_hash="$(cd "$ext_dir" && find . -name .pruned -prune -o -type f -print 2>/dev/null | sort | xargs shasum 2>/dev/null | shasum | cut -c1-8)"
  local bundle_path="${CACHE_DIR}/tau-ext-${ext_hash}.${TAR_EXT}"
  if [[ -f "$bundle_path" ]]; then
    _RESULT="$bundle_path"
    return
  fi

  info "Assembling extension bundle"
  local staging="${CACHE_DIR}/staging-ext-${ext_hash}"
  rm -rf "$staging"
  mkdir -p "$staging"

  for subdir in npm git; do
    if [[ -d "${ext_dir}/${subdir}" ]]; then
      cp -R "${ext_dir}/${subdir}" "${staging}/${subdir}"
    fi
  done

  find "$staging" -name .git -type d -exec rm -rf {} + 2>/dev/null || true

  create_tar "$bundle_path" "$staging"
  rm -rf "$staging"

  _RESULT="$bundle_path"
}

# Build merged settings: user preferences + tau extension packages.
# Strips the user's own package list (extensions are managed by tau)
# and lastChangelogVersion (not relevant on the remote).
build_settings() {
  local user_settings="$HOME/.pi/agent/settings.json"
  # Only include extension packages when extensions are being deployed
  local ext_settings=""
  if [[ ${#EXT_SOURCES[@]} -gt 0 ]]; then
    ext_settings="${CACHE_DIR}/extensions/settings.json"
  fi
  node -e "
    const fs = require('fs');
    let user = {};
    try { user = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); } catch {}
    let ext = {};
    if (process.argv[2]) try { ext = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8')); } catch {}
    delete user.packages;
    delete user.lastChangelogVersion;
    if (ext.packages) user.packages = ext.packages;
    process.stdout.write(JSON.stringify(user, null, 2));
  " "$user_settings" "$ext_settings"
}

# ============================================================================
# Provisioning
# ============================================================================

provision() {


  # Phase 1: detect remote OS, arch, and available tools
  local probe_script
  probe_script="$(cat <<'PROBE'
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  x86_64)  ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "UNSUPPORTED $(uname -s) $(uname -m)"; exit 0 ;;
esac
CAPS=""
command -v zstd >/dev/null 2>&1 && CAPS="zstd"
echo "$OS $ARCH $(whoami)@$(hostname) $CAPS"
PROBE
)"

  # Cache probe results per host to skip the SSH round trip on repeat connections
  local probe_cache="${CACHE_DIR}/probe-$(echo "$HOST" | shasum | cut -c1-16)"
  local result
  if [[ -f "$probe_cache" ]]; then
    result="$(cat "$probe_cache")"

  else
    result="$(ssh "${SSH_ARGS[@]}" "$HOST" "$probe_script")"
    echo "$result" > "$probe_cache"
  fi

  if [[ "$result" == UNSUPPORTED* ]]; then
    progress_stop
    echo "Unsupported platform: ${result#UNSUPPORTED }" >&2
    exit 1
  fi

  local os arch remote_id caps
  read -r os arch remote_id caps <<< "$result"
  local platform="${os}-${arch}"

  # Pick compression: zstd if available on both ends, else gzip
  if [[ "$caps" == *zstd* ]] && command -v zstd >/dev/null 2>&1; then
    TAR_EXT="tar.zst"
  else
    TAR_EXT="tar.gz"
  fi

  local ident="${remote_id} ${platform}"

  # Phase 2: build bundles locally
  ensure_base_bundle "$os" "$arch"
  BASE_PATH="$_RESULT"
  BASE_HASH="$(shasum -a 256 "$BASE_PATH" | cut -c1-16)"
  PLATFORM="${platform}"
  ident+=" base@${BASE_HASH}"

  if [[ ${#EXT_SOURCES[@]} -gt 0 ]]; then
    ensure_ext_bundle
    EXT_PATH="$_RESULT"
    EXT_HASH="$(shasum -a 256 "$EXT_PATH" | cut -c1-16)"
    ident+=" ext@${EXT_HASH}"
  fi
  info "$ident"

  progress_stop
}

# Check what's deployed and upload anything missing. The check call
# establishes the SSH ControlMaster; subsequent uploads are multiplexed.
check_and_upload() {
  # Cache deployment status per host+hashes to skip the check SSH call
  local deploy_key="base@${BASE_HASH}"
  if [[ -n "$EXT_HASH" ]]; then
    deploy_key+=" ext@${EXT_HASH}"
  fi
  local deploy_cache="${CACHE_DIR}/deployed-$(echo "$HOST" | shasum | cut -c1-16)"
  if [[ -f "$deploy_cache" && "$(cat "$deploy_cache")" == "$deploy_key" ]]; then
    info "Deployment cached"
    return
  fi

  local check_script
  check_script="TAU=\"\${XDG_DATA_HOME:-\$HOME/.local/share}/tau\"
\"\$TAU/dist/${BASE_HASH}/node\" --version >/dev/null 2>&1 && echo have:base"
  if [[ -n "$EXT_HASH" ]]; then
    check_script+=$'\n'"[ -d \"\$TAU/ext/${EXT_HASH}\" ] && echo have:ext"
  fi
  check_script+=$'\n'"true"

  progress "Checking deployment"
  local deployed
  deployed="$(ssh "${SSH_ARGS[@]}" "$HOST" "$check_script")"

  local tau_remote="\${XDG_DATA_HOME:-\$HOME/.local/share}/tau"
  local untar_cmd
  if [[ "$TAR_EXT" == "tar.zst" ]]; then
    untar_cmd="zstd -d | tar xf -"
  else
    untar_cmd="tar xzf -"
  fi
  if [[ "$deployed" != *"have:base"* ]]; then
    progress "Uploading base ($(du -h "$BASE_PATH" | cut -f1 | xargs))"
    ssh "${SSH_ARGS[@]}" "$HOST" "mkdir -p \"${tau_remote}/dist/${BASE_HASH}\" && cd \"${tau_remote}/dist/${BASE_HASH}\" && ${untar_cmd}" < "$BASE_PATH"
  fi
  if [[ -n "$EXT_HASH" && "$deployed" != *"have:ext"* ]]; then
    progress "Uploading extensions ($(du -h "$EXT_PATH" | cut -f1 | xargs))"
    ssh "${SSH_ARGS[@]}" "$HOST" "mkdir -p \"${tau_remote}/ext/${EXT_HASH}\" && cd \"${tau_remote}/ext/${EXT_HASH}\" && ${untar_cmd}" < "$EXT_PATH"
  fi

  echo "$deploy_key" > "$deploy_cache"
}

# ============================================================================
# Connect
# ============================================================================

build_remote_command() {
  local tau_dir="${TAU_REMOTE_DIR}"
  local dist_dir="${tau_dir}/dist/${BASE_HASH}"
  local cmd=""

  # Preamble: set up per-user config directory before starting pi.
  # This runs as part of the connect SSH call, avoiding a separate round trip.
  if [[ "$USE_PI_CODING_AGENT_DIR" != "true" ]]; then
    local settings_b64
    settings_b64="$(build_settings | base64 | tr -d '\n')"
    local user_dir="${tau_dir}/users/${USER_IDENTITY}"
    cmd+="USER_DIR=\"${user_dir}\"; "
    cmd+="mkdir -p \"\$USER_DIR\" \"${tau_dir}/sessions\"; "
    if [[ -n "$EXT_HASH" ]]; then
      cmd+="ln -sfn \"../../ext/${EXT_HASH}/npm\" \"\$USER_DIR/npm\"; "
      cmd+="ln -sfn \"../../ext/${EXT_HASH}/git\" \"\$USER_DIR/git\"; "
    fi
    cmd+="printf %s ${settings_b64} | base64 -d > \"\$USER_DIR/settings.json\"; "
    cmd+="export PI_CODING_AGENT_DIR=\"\$USER_DIR\" PI_CODING_AGENT_SESSION_DIR=\"${tau_dir}/sessions\"; "
  fi

  local remote_mode="${MODE:-rpc}"
  local log=\"${tau_dir}/logs/rpc-\$\$.log\"
  cmd+="mkdir -p \"${tau_dir}/logs\"; \"${dist_dir}/node\" \"${dist_dir}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js\" --mode ${remote_mode} 2> >(tee \"${log}\" >&2)"
  echo "$cmd"
}

# ============================================================================
# Main
# ============================================================================

BASE_HASH=""
EXT_HASH=""
BASE_PATH=""
EXT_PATH=""
PLATFORM=""
TAR_EXT="tar.gz"
USER_IDENTITY="$(whoami)@$(hostname -s 2>/dev/null || hostname)"

hide_cursor
provision
check_and_upload

remote_cmd="$(build_remote_command)"
info "ssh ${SSH_ARGS[*]} $HOST \$SHELL -lc '${remote_cmd}'"
progress_stop
show_cursor
if [[ -z "$MODE" ]]; then
  node "$PI_CLI_DIST" connect --exec ssh "${SSH_ARGS[@]}" "$HOST" "\$SHELL -lc '${remote_cmd}'"
else
  ssh "${SSH_ARGS[@]}" "$HOST" "\$SHELL -lc '${remote_cmd}'"  
fi
