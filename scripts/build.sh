#!/bin/bash
# Build dsh-balance: compile src/ → lib/ with tsc, then bundle host+client with tsdown.
# Requires typescript + tsdown (devDependencies) — run `npm install` first.
#
# Dependency-source probing (node_modules mode prefers the RUNNING dsh version):
#   1. DSH_CHECKOUT (a dsh source checkout with packages/)
#   2. global dsh CLI bundle:      $HOME/.local/lib/node_modules/@deepseek-ai/dsh/node_modules
#      (or wherever `dsh` resolves — auto-derived from `command -v dsh`)
#   3. shared profile node_modules: $HOME/.dsh/profiles/node_modules
#   4. npm npx cache dirs (newest first) that contain @deepseek-ai/dsh-tools
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── locate dependency root ────────────────────────────────────────────────
MODE=""
DEP=""

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  MODE="checkout"
  DEP="$CHECKOUT"
else
  # Derive the running dsh bundle's node_modules from the `dsh` on PATH.
  RUNNING=""
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$DSH_BIN" ] && [ -x "$DSH_BIN" ]; then
    REAL="$(readlink -f "$DSH_BIN" 2>/dev/null || echo "$DSH_BIN")"
    # …/dsh/lib/bin.js  →  package root …/dsh  →  its node_modules
    PKG="$(dirname "$(dirname "$REAL")")"
    if [ -d "$PKG/node_modules/@deepseek-ai/dsh-tools" ]; then RUNNING="$PKG/node_modules"; fi
  fi
  for base in "$RUNNING" \
              "$HOME/.dsh/profiles/node_modules" \
              "$(ls -dt "$HOME"/.npm/_npx/*/node_modules 2>/dev/null | tr '\n' ' ')"; do
    if [ -z "$base" ]; then continue; fi
    if [ -d "$base/@deepseek-ai/dsh-tools" ]; then
      MODE="node_modules"
      DEP="$base"
      break
    fi
  done
fi

if [ -z "$MODE" ]; then
  echo "build: cannot locate dsh dependencies (set DSH_CHECKOUT to a dsh checkout)" >&2
  exit 1
fi
echo "=== Dependency source: $MODE @ $DEP ==="

# ── link one dependency to node_modules/<name> ─────────────────────────────
# Candidates are resolved in order; the first existing path wins.
link_pkg() {
  local name="$1"; shift
  local link="$ROOT/node_modules/$name"
  local target=""
  for c in "$@"; do
    if [ -e "$c" ]; then target="$c"; break; fi
  done
  if [ -z "$target" ]; then
    echo "build: dependency target missing for $name (tried: $*)" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$link" "$target"
}

# Optional link: 同 link_pkg 但缺目标不报错（仅用于可有可无的类型依赖）。
link_opt() {
  local name="$1"; shift
  local target=""
  for c in "$@"; do
    if [ -e "$c" ]; then target="$c"; break; fi
  done
  if [ -z "$target" ]; then return 0; fi
  link_pkg "$name" "$target"
}

echo "=== Linking build dependencies ==="
mkdir -p node_modules/@deepseek-ai node_modules/@types

if [ "$MODE" = "checkout" ]; then
  link_pkg cordis "$DEP/vendor/cordis"
  link_pkg @deepseek-ai/cordis "$DEP/vendor/cordis"
  link_pkg schemastery "$DEP/vendor/schemastery"
  link_pkg @deepseek-ai/schemastery "$DEP/vendor/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$DEP/packages/core/tools"
  link_pkg @deepseek-ai/dsh-llm "$DEP/packages/llm/llm"
  link_pkg @deepseek-ai/dsh-session "$DEP/packages/session/session" "$DEP/packages/session"
  link_pkg @deepseek-ai/dsh-credentials "$DEP/packages/credentials/credentials"
  link_pkg @deepseek-ai/dsh-host-webserver "$DEP/packages/host/webserver" "$DEP/packages/host/webserver/package.json"
  link_opt @types/node "$DEP/node_modules/@types/node"
else
  # node_modules 布局兼容两种形态：
  #   R/@deepseek-ai/<name>（标准 hoisted 根）
  #   R/<name>（dsh CLI 自带的 node_modules/@deepseek-ai 即 scope 目录本身）
  link_pkg @deepseek-ai/cordis "$DEP/@deepseek-ai/cordis" "$DEP/cordis"
  link_pkg cordis "$DEP/@deepseek-ai/cordis" "$DEP/cordis"
  link_pkg schemastery "$DEP/@deepseek-ai/schemastery" "$DEP/schemastery"
  link_pkg @deepseek-ai/schemastery "$DEP/@deepseek-ai/schemastery" "$DEP/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$DEP/@deepseek-ai/dsh-tools" "$DEP/dsh-tools"
  link_pkg @deepseek-ai/dsh-llm "$DEP/@deepseek-ai/dsh-llm" "$DEP/dsh-llm"
  link_pkg @deepseek-ai/dsh-session "$DEP/@deepseek-ai/dsh-session" "$DEP/dsh-session"
  link_pkg @deepseek-ai/dsh-credentials "$DEP/@deepseek-ai/dsh-credentials" "$DEP/dsh-credentials"
  link_pkg @deepseek-ai/dsh-host-webserver "$DEP/@deepseek-ai/dsh-host-webserver" "$DEP/dsh-host-webserver"
  link_opt @types/node "$DEP/@types/node" "$DEP/node_modules/@types/node"
fi

echo "=== Compiling src → lib (tsc) ==="
if [ -x node_modules/.bin/tsc ]; then
  TSC=node_modules/.bin/tsc
elif command -v tsc >/dev/null 2>&1; then
  TSC=tsc
else
  echo "build: tsc not found (run npm install first)" >&2
  exit 1
fi
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null || true
