#!/usr/bin/env bash
# Runs the codeviz MCP server (stdio) from this checkout, built first:
#   claude mcp add codeviz -- /path/to/codeviz/scripts/mcp.sh
# The caller's cwd stays the cwd (it picks the repo); stdout is the protocol, so the build writes to stderr.
set -e
dir="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -z "$CODEVIZ_ELECTRON" ]]; then
    exec nix develop "path:$dir" --command "$0" "$@"
fi
tsc -p "$dir" >&2
exec node "$dir/dist/main/mcp.js"
