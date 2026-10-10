#!/usr/bin/env bash
# Builds and starts codeviz inside the flake. Arguments go to the app:
#   scripts/run.sh
#   scripts/run.sh --port 47600
#   scripts/run.sh --shot .cache/shots/x.png --cluster ecs_typedb_t --layout relation
set -e

cd "$(dirname "$0")/.."

# Already in the flake's shell: run directly.
if [[ -n "$CODEVIZ_ELECTRON" ]]; then
    tsc -p .
    exec "$CODEVIZ_ELECTRON" . "$@"
fi

exec nix develop path:. --command "$0" "$@"
