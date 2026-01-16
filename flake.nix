{
  description = "OmniDev - Meta-CLI/MCP for AI agents";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        buildDeps = with pkgs; [
          bun
          nodejs_22  # For npx
        ];
        devDeps = with pkgs; buildDeps ++ [
          # TypeScript tooling
          typescript
          nodePackages.typescript-language-server
          biome

          # Git (for git safety layer)
          git

          # JSON processing
          jq
        ];
      in
      { devShell = pkgs.mkShell { buildInputs = devDeps; }; });
}
