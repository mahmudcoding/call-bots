#!/usr/bin/env bash
# Call Bots on an Ubuntu server: set everything up, then send the bots in.
#
# Everything this installs lives in ./.server — its own Node, its own npm cache,
# its own Chromium, its own run data. Nothing is written outside this directory
# and nothing is installed globally, so removing the directory removes the lot
# (./run.sh --clean does it for you).
#
# The one exception is unavoidable: Chromium needs shared libraries from the
# distribution, and only apt can provide those. This script never installs them
# behind your back. It checks, and if any are missing it prints the exact
# command; --install-deps runs that command for you, with sudo, and nothing else.
#
#   ./run.sh --link "https://…/join/<token>" --bots 10 --camera off --mic off
#   ./run.sh --link "https://…/join/<token>" --ui        # dashboard on :4610
#   ./run.sh --check                                     # verify setup only
#   ./run.sh --clean                                     # remove ./.server
set -Eeuo pipefail

NODE_VERSION=22.12.0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="$ROOT/.server"

LINK=""; BOTS=2; CAMERA=on; MIC=on; MODE=join
INSTALL_DEPS=0; DO_CLEAN=0; CHECK_ONLY=0; PORT=4610

die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '\033[36m·\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --link)         LINK="${2:-}"; shift 2 ;;
    --bots)         BOTS="${2:-}"; shift 2 ;;
    --camera)       CAMERA="${2:-}"; shift 2 ;;
    --mic)          MIC="${2:-}"; shift 2 ;;
    --port)         PORT="${2:-}"; shift 2 ;;
    --ui)           MODE=ui; shift ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --check)        CHECK_ONLY=1; shift ;;
    --clean)        DO_CLEAN=1; shift ;;
    -h|--help)      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
done

if [ "$DO_CLEAN" = 1 ]; then
  rm -rf "$PREFIX"
  ok "removed $PREFIX — nothing of this install remains outside it"
  exit 0
fi

# --- 0. tools this script itself needs ----------------------------------------
# A minimal server image can lack these, and failing here with the apt line is
# far better than failing halfway through a download.
NEED=()
for tool in curl tar xz; do command -v "$tool" >/dev/null || NEED+=("$tool"); done
if [ ${#NEED[@]} -gt 0 ]; then
  printf '\n\033[31mmissing:\033[0m %s\n\n' "${NEED[*]}"
  printf 'install them first:\n  sudo apt-get update && sudo apt-get install -y curl tar xz-utils ca-certificates\n\n'
  exit 1
fi

# --- everything below writes only inside $PREFIX ------------------------------
export CALL_BOTS_HOME="$PREFIX/home"
export PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers"
export npm_config_cache="$PREFIX/npm-cache"
export npm_config_prefix="$PREFIX/npm"
export npm_config_update_notifier=false
export XDG_CACHE_HOME="$PREFIX/cache"
mkdir -p "$PREFIX" "$CALL_BOTS_HOME" "$PLAYWRIGHT_BROWSERS_PATH"

# --- 1. a private Node --------------------------------------------------------
case "$(uname -m)" in
  x86_64)          NODE_ARCH=x64 ;;
  aarch64|arm64)   NODE_ARCH=arm64 ;;
  *)               die "unsupported architecture: $(uname -m)" ;;
esac
NODE_DIR="$PREFIX/node-v$NODE_VERSION-linux-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "downloading Node v$NODE_VERSION ($NODE_ARCH) into .server"
  TARBALL="$PREFIX/node.tar.xz"
  curl -fsSL -o "$TARBALL" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
    || die "could not download Node — is this machine online?"
  tar -xJf "$TARBALL" -C "$PREFIX"
  rm -f "$TARBALL"
fi
export PATH="$NODE_DIR/bin:$PATH"
ok "node $("$NODE_DIR/bin/node" --version) (private to .server)"

# --- 2. dependencies ----------------------------------------------------------
cd "$ROOT"
if [ ! -d node_modules/playwright ]; then
  say "installing dependencies"
  npm install --omit=dev --no-audit --no-fund --loglevel=error
fi
ok "dependencies installed"

# --- 3. Chromium's system libraries -------------------------------------------
# Playwright knows what its browser needs on this distribution; ask it rather
# than carrying a package list that goes stale between Ubuntu releases.
if [ "$INSTALL_DEPS" = 1 ]; then
  say "installing Chromium's system libraries (this is the only global change)"
  if [ "$(id -u)" = 0 ]; then
    npx playwright install-deps chromium
  else
    command -v sudo >/dev/null || die "not root and no sudo — run as root, or install the libraries yourself"
    sudo -E env "PATH=$PATH" npx playwright install-deps chromium
  fi
  ok "system libraries installed"
fi

# --- 4. Chromium itself, inside .server ---------------------------------------
if ! compgen -G "$PLAYWRIGHT_BROWSERS_PATH/chromium-*" >/dev/null; then
  say "downloading Chromium into .server/browsers"
  npx playwright install chromium
fi
ok "chromium ready"

# --- 5. prove it can actually start -------------------------------------------
say "checking the browser starts"
if ! node -e "
  const { chromium } = require('playwright')
  chromium.launch({ channel: 'chromium', headless: true })
    .then(b => b.close())
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message.split('\n')[0]); process.exit(1) })
" 2>"$PREFIX/browser-check.log"; then
  printf '\n\033[31mChromium could not start.\033[0m Almost always a missing system library.\n'
  sed -n '1,12p' "$PREFIX/browser-check.log" | sed 's/^/  /'
  printf '\n'
  printf 'Install the libraries it needs (the only change outside this directory):\n'
  printf '  ./run.sh --install-deps --check\n\n'
  exit 1
fi
ok "browser starts"

node src/cli.mjs doctor || true

if [ "$CHECK_ONLY" = 1 ]; then
  ok "setup complete — rerun with --link to send bots in"
  exit 0
fi

# --- 6. send the bots in ------------------------------------------------------
[ -n "$LINK" ] || die "--link is required (the call's invite link)"

if [ "$MODE" = ui ]; then
  say "dashboard on http://127.0.0.1:$PORT (it binds to localhost only)"
  say "reach it with:  ssh -L $PORT:127.0.0.1:$PORT <user>@<this-server>"
  exec node src/cli.mjs ui --port "$PORT" --no-open
fi

printf '\n'
say "sending $BOTS bot(s) — camera $CAMERA, mic $MIC"
say "the call must use entry mode Open: nobody is here to admit them"
printf '\n'
exec node src/cli.mjs join "$LINK" \
  --guests "$BOTS" --camera "$CAMERA" --mic "$MIC"
