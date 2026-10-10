#!/usr/bin/env bash
# Builds the codeviz nix package (packages.default in flake.nix) and links it
# at ./result. Run it with result/bin/codeviz, or install it for the user with
#   nix profile install path:/path/to/codeviz
#
# When package-lock.json changes, npmDepsHash in flake.nix must change too:
# set it to "" (or any wrong hash), run this, and copy the "got:" hash.
set -e

cd "$(dirname "$0")/.."
nix build path:.#default -o result "$@"
echo "built $(readlink result)"
echo "run: $(pwd)/result/bin/codeviz [flags]"
