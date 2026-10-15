{
  description = "codeviz: C/C++ code search and visualization over clangd";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/5a88de74db0e948139be4b46f9a94d64aa11391c";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_22 pkgs.electron pkgs.clang-tools pkgs.clang pkgs.typescript pkgs.python3 ];
        shellHook = ''
          export ELECTRON_SKIP_BINARY_DOWNLOAD=1
          export CODEVIZ_ELECTRON=${pkgs.electron}/bin/electron
        '';
      };

      # The app: compiled main process, the UI, runtime node_modules, a
      # `codeviz` launcher that runs nixpkgs' electron with clangd on PATH, and
      # a desktop entry with an icon. `nix profile install path:.` puts it in the
      # profile; the profile's share/ is on $XDG_DATA_DIRS, so launchers find
      # share/applications/codeviz.desktop.
      packages.${system}.default = pkgs.buildNpmPackage {
        pname = "codeviz";
        version = (lib.importJSON ./package.json).version;
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [ ./package.json ./package-lock.json ./tsconfig.json ./src ./assets ];
        };
        npmDepsHash = "sha256-JKOsBEBkCY4jqqV9VTwUfeyyozoGspfbQ5NbqveAfOw=";
        nodejs = pkgs.nodejs_22;
        # The electron npm package is there for types only.
        env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        nativeBuildInputs = [ pkgs.typescript pkgs.makeWrapper ];
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --offline --no-save
          mkdir -p $out/lib/codeviz/src
          cp -r package.json dist node_modules $out/lib/codeviz/
          cp -r src/ui $out/lib/codeviz/src/
          makeWrapper ${pkgs.electron}/bin/electron $out/bin/codeviz \
            --add-flags $out/lib/codeviz \
            --prefix PATH : ${lib.makeBinPath [ pkgs.clang-tools ]}
          # The MCP server for Claude Code (stdio): node running dist/main/mcp.js. It finds
          # bin/codeviz next to it to start the app (src/main/mcp.ts, launcher()).
          makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/codeviz-mcp \
            --add-flags $out/lib/codeviz/dist/main/mcp.js
          install -Dm644 assets/codeviz.svg $out/share/icons/hicolor/scalable/apps/codeviz.svg
          # StartupWMClass matches the class main.ts sets, so the launcher ties the window to this entry.
          mkdir -p $out/share/applications
          cat > $out/share/applications/codeviz.desktop <<EOF
          [Desktop Entry]
          Type=Application
          Name=codeviz
          GenericName=Code visualizer
          Comment=C/C++ code search, clusters and commit views over clangd
          Exec=$out/bin/codeviz
          Icon=codeviz
          Terminal=false
          StartupNotify=true
          StartupWMClass=codeviz
          SingleMainWindow=true
          Categories=Development;
          Keywords=clangd;c;cpp;git;diff;
          EOF
          runHook postInstall
        '';
        meta.mainProgram = "codeviz";
      };
    };
}
