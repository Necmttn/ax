{
  description = "ax - the retro loop for AI coding agents";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
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
          };

          pkgMeta = lib.importJSON ./package.json;

          # SurrealDB launcher. Wrapping with writeShellApplication gives us
          # shellcheck + `set -euo pipefail` + a closure of runtime deps for free.
          # All knobs honour the env vars the rest of the project already uses
          # (AX_DATA_DIR, AX_DB_HOST, AX_DB_PORT, AX_DB_USER, AX_DB_PASS).
          ax-surreal = pkgs.writeShellApplication {
            name = "ax-surreal";
            runtimeInputs = [ pkgs.surrealdb pkgs.coreutils ];
            text = ''
              data_dir="''${AX_DATA_DIR:-$HOME/.local/share/ax}/db"
              mkdir -p "$data_dir"
              exec surreal start \
                --user "''${AX_DB_USER:-root}" \
                --pass "''${AX_DB_PASS:-root}" \
                --bind "''${AX_DB_HOST:-127.0.0.1}:''${AX_DB_PORT:-8521}" \
                --log "''${AX_DB_LOG:-info}" \
                "rocksdb://$data_dir"
            '';
          };

          ax = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "ax";
            version = pkgMeta.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./bun.lock
                ./tsconfig.json
                ./bin
                ./src
                ./schema
                ./scripts
              ];
            };

            nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

            deps = pkgs.stdenv.mkDerivation {
              pname = "ax-node-modules";

              inherit (finalAttrs) version src;

              nativeBuildInputs = [ pkgs.bun ];

              dontConfigure = true;
              dontFixup = true;

              buildPhase = ''
                runHook preBuild
                export HOME="$(mktemp -d)"
                bun install \
                  --frozen-lockfile \
                  --ignore-scripts \
                  --no-progress
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                mkdir -p "$out"
                cp -R node_modules "$out/node_modules"
                runHook postInstall
              '';

              outputHashAlgo = "sha256";
              outputHashMode = "recursive";
              # Auto-refreshed by .github/workflows/release-please.yml
              # (refresh-flake-hash job) on PRs that touch bun.lock / package.json.
              outputHash = "sha256-zDarC1/7bCLdo9A5TSN3zMERw2aRrnt2QneitVPr7dY=";
            };

            dontConfigure = true;

            buildPhase = ''
              runHook preBuild
              cp -R ${finalAttrs.deps}/node_modules ./node_modules
              chmod -R u+w node_modules
              export HOME="$(mktemp -d)"
              # Invoke vite via bun so node shebangs aren't honored by the loader.
              bun ./node_modules/vite/bin/vite.js build \
                --config src/dashboard/web/vite.config.ts
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/share/ax" "$out/bin"
              cp -R src schema scripts package.json bun.lock tsconfig.json node_modules "$out/share/ax/"

              makeWrapper ${lib.getExe pkgs.bun} "$out/bin/axctl" \
                --add-flags "$out/share/ax/src/cli/index.ts" \
                --prefix PATH : ${lib.makeBinPath [ pkgs.bun pkgs.surrealdb ]}

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
          });
        in
        {
          # Override flake-parts' default `pkgs` arg so downstream modules
          # (process-compose-flake, etc.) also see allowUnfree = surrealdb.
          _module.args.pkgs = pkgs;

          packages = {
            default = ax;
            inherit ax ax-surreal;
          };

          devShells.default = pkgs.mkShell {
            name = "ax";

            packages = [
              pkgs.bun
              pkgs.nodejs_22
              pkgs.surrealdb
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
