{
  description = "ax - the retro loop for AI coding agents";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = inputs.nixpkgs.lib.systems.flakeExposed;

      imports = [
        inputs.process-compose-flake.flakeModule
      ];

      perSystem = { system, ... }:
        let
          lib = inputs.nixpkgs.lib;

          pkgs = import inputs.nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg:
              builtins.elem (lib.getName pkg) [ "surrealdb" ];
            overlays = [ inputs.bun2nix.overlays.default ];
          };

          pkgMeta = lib.importJSON ./package.json;

          # Pin SurrealDB to 3.1.0. nixpkgs trails upstream and the on-disk
          # storage format moves between minor versions, so we fetch the
          # official prebuilt tarball directly. Bump `version` + all four
          # hashes together when upgrading.
          surrealdb = pkgs.stdenv.mkDerivation rec {
            pname = "surrealdb";
            version = "3.1.0";

            src =
              let
                sources = {
                  "aarch64-darwin" = {
                    suffix = "darwin-arm64";
                    hash = "sha256-Ss81eOPMHVeiO0QkG03Vswqr+K676bIRQw2jNVDxTT0=";
                  };
                  "x86_64-darwin" = {
                    suffix = "darwin-amd64";
                    hash = "sha256-akFoE+VPVnu2scpk4B8C3xv41b4dcrKPPV/CnUMHIX4=";
                  };
                  "x86_64-linux" = {
                    suffix = "linux-amd64";
                    hash = "sha256-qKffirEffeIq4UxkpGCepxRlx/if57Ai4Cn63cWHnkI=";
                  };
                  "aarch64-linux" = {
                    suffix = "linux-arm64";
                    hash = "sha256-0qbD1vsBoiK3J1ZqR6FZdA6nh95ml0gMd0ugTeYpqlk=";
                  };
                };
                sel = sources.${system} or (throw "surrealdb 3.1.0: unsupported system ${system}");
              in
              pkgs.fetchurl {
                url = "https://download.surrealdb.com/v${version}/surreal-v${version}.${sel.suffix}.tgz";
                inherit (sel) hash;
              };

            sourceRoot = ".";
            dontConfigure = true;
            dontBuild = true;

            nativeBuildInputs = lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];

            installPhase = ''
              runHook preInstall
              install -Dm755 surreal "$out/bin/surreal"
              runHook postInstall
            '';

            meta = {
              description = "SurrealDB - the multi-model database";
              homepage = "https://surrealdb.com";
              license = lib.licenses.unfreeRedistributable;
              mainProgram = "surreal";
              platforms = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            };
          };

          # SurrealDB launcher. Wrapping with writeShellApplication gives us
          # shellcheck + `set -euo pipefail` + a closure of runtime deps for free.
          # All knobs honour the env vars the rest of the project already uses
          # (AX_DATA_DIR, AX_DB_HOST, AX_DB_PORT, AX_DB_USER, AX_DB_PASS).
          ax-surreal = pkgs.writeShellApplication {
            name = "ax-surreal";
            runtimeInputs = [ surrealdb pkgs.coreutils ];
            text = ''
              base_dir="''${AX_DATA_DIR:-$HOME/.local/share/ax}"
              data_dir="$base_dir/db"
              buckets_dir="$base_dir/buckets"
              mkdir -p "$data_dir"
              mkdir -p "$buckets_dir/transcripts" "$buckets_dir/codex_artifacts"
              export SURREAL_BUCKET_FOLDER_ALLOWLIST="$buckets_dir"
              export SURREAL_ROCKSDB_BLOCK_CACHE_SIZE="''${AX_DB_ROCKSDB_BLOCK_CACHE_SIZE:-268435456}"
              export SURREAL_ROCKSDB_WRITE_BUFFER_SIZE="''${AX_DB_ROCKSDB_WRITE_BUFFER_SIZE:-33554432}"
              export SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER="''${AX_DB_ROCKSDB_MAX_WRITE_BUFFER_NUMBER:-4}"
              exec surreal start \
                --user "''${AX_DB_USER:-root}" \
                --pass "''${AX_DB_PASS:-root}" \
                --bind "''${AX_DB_HOST:-127.0.0.1}:''${AX_DB_PORT:-8521}" \
                --log "''${AX_DB_LOG:-info}" \
                --allow-experimental=files \
                "rocksdb://$data_dir"
            '';
          };

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
                --prefix PATH : ${lib.makeBinPath [ pkgs.bun surrealdb ]}

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
          # Override flake-parts' default `pkgs` arg so downstream modules
          # (process-compose-flake, etc.) also see allowUnfree = surrealdb.
          _module.args.pkgs = pkgs;

          packages = {
            default = ax;
            inherit ax ax-surreal surrealdb;
          };

          devShells.default = pkgs.mkShell {
            name = "ax";

            packages = [
              pkgs.bun
              pkgs.nodejs_22
              surrealdb
              pkgs.jq
              pkgs.lsof
              pkgs.git
            ];

            env = {
              AX_DB_URL = "ws://127.0.0.1:8521";
              AX_DB_NS = "ax";
              AX_DB_DB = "main";
            };
          };

          formatter = pkgs.nixpkgs-fmt;

          # `nix run .#serve` brings up SurrealDB + axctl serve as a bound
          # foreground pair. Both die together on Ctrl-C. axctl serve only
          # starts after surrealdb's /health probe succeeds.
          process-compose.serve = {
            settings.processes = {
              surrealdb = {
                command = lib.getExe ax-surreal;
                readiness_probe = {
                  exec.command = "${lib.getExe pkgs.curl} -fsS http://127.0.0.1:8521/health";
                  initial_delay_seconds = 1;
                  period_seconds = 1;
                  timeout_seconds = 2;
                  failure_threshold = 30;
                };
              };

              ax-serve = {
                command = "${ax}/bin/axctl serve";
                environment = [
                  "AX_DB_URL=ws://127.0.0.1:8521"
                  "AX_DB_NS=ax"
                  "AX_DB_DB=main"
                  "AX_DB_USER=root"
                  "AX_DB_PASS=root"
                ];
                depends_on.surrealdb.condition = "process_healthy";
              };
            };
          };
        };
    };
}
