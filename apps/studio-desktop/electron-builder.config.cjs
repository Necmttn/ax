// electron-builder configuration for ax studio desktop.
//
// IMPORTANT - macOS code-signing / SIGKILL failure mode (see memory:
// dogfood-compiled-binary-codesign):
//   The bundled `surreal` + `bun` Mach-O binaries placed under
//   Contents/Resources/bin MUST be codesigned. An unsigned or ad-hoc-copied
//   Mach-O is SIGKILL'd by macOS Gatekeeper on first spawn (no error, the
//   child just dies), which breaks the supervised surreal/ax-serve boot.
//
//   electron-builder WILL sign every Mach-O it finds under Contents/Resources
//   automatically - but only when `hardenedRuntime` is on AND a real
//   "Developer ID Application" identity is available (CSC_LINK / keychain).
//   In that path no manual step is needed.
//
//   For LOCAL UNSIGNED dev builds (no Apple cert, CSC_IDENTITY_AUTO_DISCOVERY
//   =false), electron-builder does NOT sign the vendored binaries, so you must
//   ad-hoc sign them yourself before launching the app, e.g.:
//
//     codesign --force --sign - \
//       "dist-release/mac-arm64/ax studio.app/Contents/Resources/bin/arm64/"{surreal,bun}
//
//   (Adjust mac-arm64 / arch dir for x64 builds.) Without this the app launches
//   but the surreal/bun children are killed on spawn.

module.exports = {
  appId: "com.necmttn.ax-studio",
  productName: "ax studio",
  directories: { output: "dist-release", buildResources: "build" },
  files: ["dist-electron/**", "package.json"],
  extraResources: [
    { from: "resources/bin", to: "bin" },
    { from: "resources/ax-src", to: "ax-src" },
    { from: "resources/studio", to: "studio" },
  ],
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true, // requires APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env
  },
  afterSign: "scripts/notarize-check.cjs",
  publish: [{ provider: "github", owner: "Necmttn", repo: "ax" }],
};
