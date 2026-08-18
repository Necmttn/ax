{
  description = "ax - the retro loop for AI coding agents";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = inputs.nixpkgs.lib.systems.flakeExposed;

      perSystem = { system, ... }:
        let
          lib = inputs.nixpkgs.lib;

          pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ inputs.bun2nix.overlays.default ];
          };

          pkgMeta = lib.importJSON ./package.json;

          ax = pkgs.stdenv.mkDerivation {
            pname = "ax";
            version = pkgMeta.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./bun.lock
                ./bun.nix
                ./tsconfig.json
                ./tsconfig.base.json
                ./turbo.json
                ./apps/axctl
                ./packages
                ./scripts
              ];
            };

            nativeBuildInputs = [
              pkgs.bun
              pkgs.makeWrapper
              pkgs.bun2nix.hook
            ];

            # Deterministic per-package Bun cache generated from bun.lock.
            # Regenerate with `bunx bun2nix -o bun.nix` (also runs as a
            # postinstall hook). One file, works on mac + linux.
            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = ./bun.nix;
            };

            # `effect-language-service patch` runs in `prepare`; it pokes at
            # node_modules in ways that don't survive the Nix sandbox. We
            # ship a complete node_modules to $out so runtime is unaffected.
            dontRunLifecycleScripts = true;

            # We do the dashboard build ourselves below; bun2nix's default
            # build phase doesn't apply here.
            dontUseBunBuild = true;
            dontUseBunCheck = true;

            dontConfigure = true;

            buildPhase = ''
              runHook preBuild
              # Invoke vite via bun so node shebangs aren't honored by the loader.
              bun ./node_modules/vite/bin/vite.js build \
                --config apps/axctl/src/dashboard/web/vite.config.ts
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/share/ax" "$out/bin"
              cp -R apps packages scripts package.json bun.lock bun.nix tsconfig.json tsconfig.base.json turbo.json node_modules "$out/share/ax/"

              makeWrapper ${lib.getExe pkgs.bun} "$out/bin/axctl" \
                --add-flags "$out/share/ax/apps/axctl/src/cli/index.ts" \
                --prefix PATH : ${lib.makeBinPath [ pkgs.bun ]}

              ln -s axctl "$out/bin/ax"

              runHook postInstall
            '';

            meta = {
              description = "Local taste and telemetry graph for AI coding agents";
              homepage = "https://github.com/Necmttn/ax";
              license = lib.licenses.mit;
              mainProgram = "axctl";
              platforms = lib.platforms.unix;
            };
          };
        in
        {
          packages = {
            default = ax;
            inherit ax;
          };

          devShells.default = pkgs.mkShell {
            name = "ax";

            packages = [
              pkgs.bun
              pkgs.nodejs_22
              pkgs.jq
              pkgs.lsof
              pkgs.git
            ];
          };

          formatter = pkgs.nixpkgs-fmt;
        };
    };
}
