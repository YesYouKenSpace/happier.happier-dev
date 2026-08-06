{
  description = "Happier monorepo dev shell (Node 24 + Yarn 1 classic)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # Systems we support for `nix develop`.
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSystem = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forEachSystem (pkgs:
        let
          # Repo pins node 24 in mise.toml; packageManager pins yarn@1.22.22.
          nodejs = pkgs.nodejs_24;
          # Align yarn's bundled node with the shell's node so versions match.
          yarn = pkgs.yarn.override { inherit nodejs; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              yarn

              # node-gyp / native module build toolchain (see Dockerfile deps stages).
              pkgs.python3
              pkgs.gnumake
              pkgs.gcc
              pkgs.pkg-config

              # Runtime/tooling used across the monorepo.
              pkgs.git
              pkgs.watchman
              pkgs.ffmpeg
            ];

            shellHook = ''
              export COREPACK_ENABLE_STRICT=0
              echo "happier dev shell: node $(node --version), yarn $(yarn --version)"
            '';
          };
        });
    };
}
