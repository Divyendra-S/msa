#!/bin/sh
# Starts the Wind Tunnel MCP server: the installed `windtunnel` CLI, or the CLI next to the
# plugin (in the npm package, or in a checkout of the repository). Needs Node 22.18 or newer.
set -e
if command -v windtunnel >/dev/null 2>&1; then exec windtunnel mcp "$@"; fi

plugin="$(cd "$(dirname "$0")/.." && pwd)"
cli="$plugin/../dist/bin.js"
[ -f "$cli" ] || cli="$plugin/../../packages/cli/src/bin.ts"
if [ ! -f "$cli" ]; then
  echo "windtunnel: CLI not found. Install it and make sure \`windtunnel\` is on PATH." >&2
  exit 1
fi

new_enough() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; }
node_bin=""
if command -v node >/dev/null 2>&1 && new_enough node; then node_bin=node; fi
if [ -z "$node_bin" ]; then
  # An nvm install, newest first, when the default node is too old.
  for candidate in $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node 2>/dev/null | sort -rV); do
    if new_enough "$candidate"; then node_bin="$candidate"; break; fi
  done
fi
if [ -z "$node_bin" ]; then
  echo "windtunnel: needs Node 22.18 or newer" >&2
  exit 1
fi
exec "$node_bin" "$cli" mcp "$@"
