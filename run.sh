#!/usr/bin/env bash
# Call Bots on an Ubuntu server: one command sets everything up and sends the
# bots in. Run it again and it starts immediately — each step checks first and
# does nothing when it is already done.
#
#   ./run.sh --link "https://…/join/<token>" --bots 10 --camera off --mic off
#   ./run.sh --link "https://…/join/<token>" --ui     # dashboard on :4610
#   ./run.sh --check                                  # set up, send no bots
#   ./run.sh --clean                                  # remove everything it made
#
# Everything it installs — its own Node, its own Chromium, its own npm cache and
# run data — lives in ./.server, and --clean removes the lot. The exception is
# Chromium's shared libraries, which only apt can provide: those are installed
# system-wide, announced when it happens, and skipped with --no-deps.
set -Eeuo pipefail

NODE_VERSION=22.12.0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="$ROOT/.server"

LINK=""; BOTS=2; CAMERA=on; MIC=on; MODE=join
PORT=4610; SYSTEM_DEPS=1; CHECK_ONLY=0; DO_CLEAN=0

die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
say()  { printf '\033[36m·\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --link)     LINK="${2:-}"; shift 2 ;;
    --bots)     BOTS="${2:-}"; shift 2 ;;
    --camera)   CAMERA="${2:-}"; shift 2 ;;
    --mic)      MIC="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --ui)       MODE=ui; shift ;;
    --check)    CHECK_ONLY=1; shift ;;
    --clean)    DO_CLEAN=1; shift ;;
    --no-deps)  SYSTEM_DEPS=0; shift ;;
    -h|--help)  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown option: $1 (try --help)" ;;
  esac
done

if [ "$DO_CLEAN" = 1 ]; then
  rm -rf "$PREFIX"
  ok "removed $PREFIX — nothing of this install remains outside it"
  exit 0
fi

# Everything below writes only inside $PREFIX.
export CALL_BOTS_HOME="$PREFIX/home"
export PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers"
export npm_config_cache="$PREFIX/npm-cache"
export npm_config_prefix="$PREFIX/npm"
export npm_config_update_notifier=false
export XDG_CACHE_HOME="$PREFIX/cache"
export DEBIAN_FRONTEND=noninteractive
mkdir -p "$PREFIX" "$CALL_BOTS_HOME" "$PLAYWRIGHT_BROWSERS_PATH"

# apt is allowed to remove packages to resolve a conflict, which on a server
# running other things is how an install breaks something unrelated. This config
# makes it abort instead, so the worst case is that we install nothing. It is
# passed through APT_CONFIG rather than written into /etc, so it applies only to
# the apt calls this script makes.
APT_GUARD="$PREFIX/apt.conf"
printf 'APT::Get::Remove "false";\nAPT::Get::Upgrade "false";\n' > "$APT_GUARD"
export APT_CONFIG="$APT_GUARD"

# Runs a command with root, however this machine gets there.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null; then sudo -E env "PATH=$PATH" "$@"
  else return 1
  fi
}

# --- 1. the handful of tools this script itself needs -------------------------
ensure_tools() {
  local missing=()
  for tool in curl tar xz; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  [ "$SYSTEM_DEPS" = 1 ] || die "missing ${missing[*]} — install them, or drop --no-deps"
  command -v apt-get >/dev/null || die "missing ${missing[*]} and this is not a Debian/Ubuntu machine"
  say "installing ${missing[*]} (apt)"
  as_root apt-get update -qq || die "apt-get update failed — run this as root, or install ${missing[*]} yourself"
  as_root apt-get install -y -qq curl tar xz-utils ca-certificates \
    || die "could not install ${missing[*]}"
  ok "tools installed"
}

# --- 2. a private Node --------------------------------------------------------
ensure_node() {
  case "$(uname -m)" in
    x86_64)        NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *)             die "unsupported architecture: $(uname -m)" ;;
  esac
  NODE_DIR="$PREFIX/node-v$NODE_VERSION-linux-$NODE_ARCH"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    say "downloading Node v$NODE_VERSION ($NODE_ARCH)"
    curl -fsSL -o "$PREFIX/node.tar.xz" \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
      || die "could not download Node — is this machine online?"
    tar -xJf "$PREFIX/node.tar.xz" -C "$PREFIX"
    rm -f "$PREFIX/node.tar.xz"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
  ok "node $(node --version)"
}

# --- 3. app dependencies ------------------------------------------------------
ensure_packages() {
  if [ ! -d "$ROOT/node_modules/playwright" ]; then
    say "installing dependencies"
    (cd "$ROOT" && npm install --no-audit --no-fund --loglevel=error)
  fi
  ok "dependencies installed"
}

# --- 4. Chromium, inside .server ----------------------------------------------
ensure_chromium() {
  if ! compgen -G "$PLAYWRIGHT_BROWSERS_PATH/chromium-*" >/dev/null; then
    say "downloading Chromium"
    (cd "$ROOT" && npx playwright install chromium >/dev/null 2>&1) || true
  fi
  compgen -G "$PLAYWRIGHT_BROWSERS_PATH/chromium-*" >/dev/null \
    || die "Chromium failed to download"
  ok "chromium downloaded"
}

# Only a real launch proves the shared libraries are there.
browser_starts() {
  (cd "$ROOT" && node -e "
    const { chromium } = require('playwright')
    chromium.launch({ channel: 'chromium', headless: true })
      .then(b => b.close()).then(() => process.exit(0))
      .catch(e => { console.error(e.message); process.exit(1) })
  ") >"$PREFIX/browser-check.log" 2>&1
}

# --- 5. Chromium's system libraries, only if it will not start ----------------
ensure_browser_runs() {
  if browser_starts; then ok "browser starts"; return 0; fi
  if [ "$SYSTEM_DEPS" = 0 ]; then
    sed -n '1,10p' "$PREFIX/browser-check.log" | sed 's/^/  /'
    die "Chromium will not start and --no-deps was given"
  fi
  command -v apt-get >/dev/null || {
    sed -n '1,10p' "$PREFIX/browser-check.log" | sed 's/^/  /'
    die "Chromium will not start and this is not a Debian/Ubuntu machine"
  }
  say "Chromium needs shared libraries — installing them (this is system-wide)"
  as_root apt-get update -qq \
    || die "apt-get update failed — run this as root, or install the libraries yourself"
  if ! (cd "$ROOT" && as_root "$NODE_DIR/bin/npx" playwright install-deps chromium); then
    printf '\n'
    printf 'Nothing was changed: the install was refused rather than allowed to\n'
    printf 'remove or downgrade anything already on this machine.\n\n'
    printf 'Options:\n'
    printf '  · install the libraries yourself, resolving the conflict as you want it\n'
    printf '  · run this in a container instead, where nothing is shared with the host\n'
    printf '  · ./run.sh --no-deps  if they are in fact already present\n'
    die "could not install Chromium's libraries without touching existing packages"
  fi
  ok "system libraries installed"
  browser_starts || {
    sed -n '1,10p' "$PREFIX/browser-check.log" | sed 's/^/  /'
    printf '\nThe libraries installed but Chromium still will not run. That usually\n'
    printf 'means this distribution is older than the browser expects, which apt\n'
    printf 'cannot fix — run it in a container instead.\n'
    die "Chromium still will not start"
  }
  ok "browser starts"
}

ensure_tools
ensure_node
ensure_packages
ensure_chromium
ensure_browser_runs
(cd "$ROOT" && node src/cli.mjs doctor) || true

if [ "$CHECK_ONLY" = 1 ]; then
  ok "ready — rerun with --link to send bots in"
  exit 0
fi
[ -n "$LINK" ] || die "--link is required (the call's invite link)"

cd "$ROOT"
if [ "$MODE" = ui ]; then
  printf '\n'
  say "dashboard on http://127.0.0.1:$PORT — it binds to localhost only"
  say "reach it with:  ssh -L $PORT:127.0.0.1:$PORT <user>@<this-server>"
  printf '\n'
  exec node src/cli.mjs ui --port "$PORT" --no-open
fi

printf '\n'
say "sending $BOTS bot(s) — camera $CAMERA, mic $MIC"
say "the call needs entry mode Open: nobody is here to admit them"
printf '\n'
exec node src/cli.mjs join "$LINK" --guests "$BOTS" --camera "$CAMERA" --mic "$MIC"
