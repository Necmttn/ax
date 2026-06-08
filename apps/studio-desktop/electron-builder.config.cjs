// electron-builder configuration for ax studio desktop.
//
// ---------------------------------------------------------------------------
// AUTO-UPDATE (electron-updater) RELEASE REQUIREMENTS
// ---------------------------------------------------------------------------
// The desktop app checks for updates at boot via `electron-updater`
// (src/updates/DesktopUpdates.ts), wired into the boot program only in
// production (dev has no feed). The update feed is the GitHub `publish` config
// below, baked into `app-update.yml` inside the packaged app at build time -
// there is no runtime feed URL.
//
// For the feed to actually serve updates, a release build must:
//   1. Be a tagged release. electron-updater compares the running app version
//      against the latest GitHub Release's assets, so bump package.json
//      `version` and create a matching GitHub Release/tag.
//   2. Publish the update artifacts to that GitHub Release. Run
//      `electron-builder --publish always` (NOT the plain `package` script,
//      which omits --publish). This uploads the installers PLUS the
//      electron-updater feed metadata: `latest-mac.yml` + the `*.blockmap`
//      files (and per-arch zips). Without `latest-mac.yml` on the release,
//      `autoUpdater.checkForUpdatesAndNotify()` finds no feed and no-ops.
//   3. Provide credentials:
//        - GH_TOKEN  - a GitHub token with `repo` scope (or `public_repo` for
//          this public repo) so electron-builder can upload release assets.
//        - Apple notarization creds (already required for signing, see below):
//          APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID, plus a real
//          "Developer ID Application" identity (CSC_LINK / keychain). macOS
//          electron-updater REQUIRES the update to be signed + notarized; an
//          unsigned/ad-hoc build will refuse to apply the downloaded update.
//   None of (1)-(3) can be exercised in this environment (no tag, no GH_TOKEN,
//   no Apple creds), so the live update path is verified only by compile +
//   bundle + dev-guard review, not by an actual update check.
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
