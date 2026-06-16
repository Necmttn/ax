// electron-builder configuration for ax studio desktop.
//
// ---------------------------------------------------------------------------
// AUTO-UPDATE (electron-updater) RELEASE REQUIREMENTS
// ---------------------------------------------------------------------------
// The desktop app checks for updates at boot via `electron-updater`
// (src/updates/DesktopUpdates.ts), wired into the boot program only in
// production (dev has no feed). The update feed is the `generic` `publish`
// config below (a Cloudflare R2 bucket), baked into `app-update.yml` inside the
// packaged app at build time.
//
// Why NOT GitHub releases: the CLI already publishes to this repo under `v*`
// tags via release-please. electron-updater on a shared repo can't distinguish
// desktop releases from CLI releases, and the desktop version (0.12.x) collides
// with existing CLI `v0.12.x` tags. So the desktop ships its own generic feed.
//
// For the feed to actually serve updates, the CI workflow
// (.github/workflows/studio-desktop-release.yml) must:
//   1. Build SIGNED + NOTARIZED with `--publish never`, producing dist-release/
//      with the dmg, zip, *.blockmap, and `latest-mac.yml` feed manifest.
//   2. Upload all of those to the R2 bucket under /desktop/ (S3-compatible).
//      `latest-mac.yml` at the feed URL is what the updater polls; without it
//      `checkForUpdatesAndNotify()` no-ops.
//   3. Provide credentials:
//        - R2 (S3) keys to upload: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
//          R2_SECRET_ACCESS_KEY / R2_BUCKET.
//        - Apple signing + notarization (see below): CSC_LINK / CSC_KEY_PASSWORD
//          + APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. macOS
//          electron-updater REQUIRES the update be signed + notarized; an
//          unsigned/ad-hoc build refuses to apply a downloaded update.
//
// ONE-TIME Cloudflare setup (manual, in the CF dashboard):
//   - Create an R2 bucket (e.g. `ax-desktop-releases`).
//   - Expose it at a public custom domain matching the `publish.url` host
//     (default https://dl.ax.necmttn.com → bucket root; files land under
//     /desktop/). Or set AX_UPDATE_FEED to your r2.dev URL.
//   - Create an R2 API token (Object Read & Write) → the R2_* secrets above.
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
    { from: "build/icons", to: "icons" },
  ],
  mac: {
    // arm64-first. A split arm64/x64 build produces two clobbering
    // `latest-mac.yml` feed manifests; until a merge step exists, the update
    // feed ships Apple Silicon only. dmg = first download, zip = updater delta.
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true, // requires APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env
  },
  afterSign: "scripts/notarize-check.cjs",
  // Update feed = a Cloudflare R2 bucket served at this URL (decoupled from the
  // CLI's GitHub `v*` releases, which would collide + confuse the updater). CI
  // builds with `--publish never`, then uploads dist-release/* (dmg, zip,
  // blockmap, latest-mac.yml) to R2 under /desktop/. `latest-mac.yml` at this
  // URL is what `autoUpdater.checkForUpdatesAndNotify()` polls. Set AX_UPDATE_FEED
  // to override the host at build time (defaults to the production domain).
  publish: [
    {
      provider: "generic",
      url: process.env.AX_UPDATE_FEED || "https://dl.ax.necmttn.com/desktop/",
    },
  ],
};
