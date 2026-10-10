# codeviz

Code search, symbol clusters and commit views for C/C++ repos, built on clangd. An Electron app; point it at a repo with a `compile_commands.json`.

Prototype. Linux (x86_64) with Nix only.

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
