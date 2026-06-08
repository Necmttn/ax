// afterSign hook referenced by electron-builder.config.cjs.
//
// This is intentionally a NO-OP guard: electron-builder performs notarization
// itself when `mac.notarize: true` and the APPLE_* credentials are present in
// the environment. This hook only LOGS whether those credentials are set, so a
// build run makes it obvious why notarization was (or wasn't) attempted. It
// never fails the build - a missing-credential local/unsigned build proceeds.

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function notarizeCheck(context) {
  // Only meaningful on macOS.
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const hasAppleId = Boolean(process.env.APPLE_ID);
  const hasTeamId = Boolean(process.env.APPLE_TEAM_ID);
  const hasPassword = Boolean(process.env.APPLE_APP_SPECIFIC_PASSWORD);

  if (hasAppleId && hasTeamId && hasPassword) {
    console.log(
      "[notarize-check] APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD all set - electron-builder will notarize.",
    );
  } else {
    const missing = [
      hasAppleId ? null : "APPLE_ID",
      hasTeamId ? null : "APPLE_TEAM_ID",
      hasPassword ? null : "APPLE_APP_SPECIFIC_PASSWORD",
    ].filter(Boolean);
    console.warn(
      `[notarize-check] Notarization credentials missing: ${missing.join(", ")}. ` +
        "Build will NOT be notarized (fine for local/unsigned dev builds).",
    );
  }
};
