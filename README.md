# codeviz

Code searching via symbols / types / functions / files for C/C++ repos using clangd.
Point it at a repo with a `compile_commands.json`.

## What's it for

I needed this tool so I could quickly search and try to get back up to speed with my very large game engine codebase that I've been working on with agents heavily for a year. VS Code and other text editors work fine, but at this point I spend far more time just searching and scanning for things on small searches, understanding how a system works after the agents reworked it all again.

This tool is my answer to that. You can click on a commit to see what changed in a simpler (to me) diff view: left is what it was, right is what it is now, no whitespace alignment logic.

The whole tool is a clustered canvas you can pan and zoom around. Zoom out to see names, zoom in to read a chunk of code where the diff was. Click on any indexed symbol/function/type to open it in a new tab showing its cluster. Shift-click to open it in the same tab.

There are several different ways of clustering in the top right of the canvas view; for normal symbols, `by relation` and `by affinity` are my current favorites.

Clicking on a function and seeing callees (functions it calls) to the left, and callers (who calls it) to the right is very handy.

Prototype by Claude Opus 5.5.

Currently NixOS only, but it's an Electron app, and I'll get it more general and working on Windows, plus an AppImage for other Linux distros, eventually.

## Run without installing

```sh
nix run github:josh4364/codeviz
```

## Install

```sh
nix profile add github:josh4364/codeviz
```

This puts `codeviz` on your PATH and a desktop entry in your launcher. Update with `nix profile upgrade codeviz`, remove with `nix profile remove codeviz`. (Older Nix calls it `nix profile install`.)

On NixOS you can instead add the flake as an input and put `inputs.codeviz.packages.x86_64-linux.default` in `environment.systemPackages` or `home.packages`.

## Build from source

```sh
git clone https://github.com/josh4364/codeviz
cd codeviz
scripts/run.sh                # builds and runs in the dev shell
nix build                     # or build the package into ./result
result/bin/codeviz
```

Every development command runs in the flake's shell: `nix develop path:. --command <cmd>` (for example `tsc -p .`).

## Usage

On the Workspace page, pick a repo and its compile db, tick the folders to index, then Save and index. Or from the command line:

```sh
codeviz --workspace ~/src/myrepo --roots src,lib
```

Indexes and caches live in `~/.local/share/codeviz`, settings in `~/.config/codeviz`. Nothing is written into the target repo.
