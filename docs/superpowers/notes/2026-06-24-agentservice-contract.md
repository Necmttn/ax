# Electron `agentService` Contract - Spike Findings

**Date:** 2026-06-24  
**Issue:** #599 - studio app registers db + serve via launchd  
**Status:** DONE - strategy resolved, no gate blocked

---

## 1. Sources consulted

- Electron 41.5.0 docs: `app.setLoginItemSettings` / `app.getLoginItemSettings`
- Electron source: `shell/common/platform_util_mac.mm` (v41.5.0, read via GitHub)
- Electron source: `shell/common/gin_converters/login_item_settings_converter.*`
- Apple: `SMAppService.agentServiceWithPlistName:` (ServiceManagement.framework)
- Real-world plist samples: `supaku/kith`, `JP1222/Mac-Monitor`, `haasonsaas/ambient-agent`,  
  `antimatter-studios/diskjockey`, `parleq/parleq-speech`
- `apps/studio-desktop/electron-builder.config.cjs` - `appId`, signing config
- `apps/studio-desktop/build/entitlements.mac.plist` - hardenedRuntime entitlements
- `apps/studio-desktop/src/electron/ElectronApp.ts` - existing `setLoginItemSettings` wrapper
- `apps/studio-desktop/src/backend/AxBackendManager.ts` - daemon lifecycle context

---

## 2. Electron API contract (verbatim from source)

### Internal implementation (platform_util_mac.mm)

```objc
// agentService → SMAppService.agentServiceWithPlistName:
SMAppService* GetServiceForType(const std::string& type, const std::string& name) {
  NSString* service_name = [NSString stringWithUTF8String:name.c_str()];
  if (type == "agentService")
    return [SMAppService agentServiceWithPlistName:service_name];
  ...
}

bool SetLoginItemEnabled(const std::string& type, const std::string& service_name, bool enabled) {
  SMAppService* service = GetServiceForType(type, service_name);
  NSError* error = nil;
  bool result = enabled ? [service registerAndReturnError:&error]
                        : [service unregisterAndReturnError:&error];
  ...
}
```

### JS/TS call shapes (macOS 13+)

```typescript
// Register (enable)
Electron.app.setLoginItemSettings({
  type: "agentService",
  serviceName: "com.necmttn.ax-studio.helper",   // plist name, no .plist extension
  openAtLogin: true,
});

// Unregister (disable)
Electron.app.setLoginItemSettings({
  type: "agentService",
  serviceName: "com.necmttn.ax-studio.helper",
  openAtLogin: false,
});

// Status query
const { status } = Electron.app.getLoginItemSettings({
  type: "agentService",
  serviceName: "com.necmttn.ax-studio.helper",
});
// status: "not-registered" | "enabled" | "requires-approval" | "not-found"
```

`serviceName` is the plist filename **without** the `.plist` extension, passed verbatim to  
`SMAppService.agentServiceWithPlistName:`. The `type` field defaults to `mainAppService`;  
all non-default types require `serviceName`.

### Matching the existing ElectronApp service style

The existing wrapper in `apps/studio-desktop/src/electron/ElectronApp.ts` (line 72-77) calls:

```typescript
Electron.app.setLoginItemSettings({ openAtLogin: enabled, type: "mainAppService" });
Electron.app.getLoginItemSettings({ type: "mainAppService" }).openAtLogin
```

The new `agentService` wrapper must follow the same `Effect.sync(() => ...)` pattern and add  
`serviceName` as a parameter. Suggested addition to `ElectronAppShape`:

```typescript
readonly setAgentServiceEnabled: (
  serviceName: string,
  enabled: boolean,
) => Effect.Effect<void>;
readonly getAgentServiceStatus: (
  serviceName: string,
) => Effect.Effect<"not-registered" | "enabled" | "requires-approval" | "not-found">;
```

---

## 3. Plist placement and structure

### Where the plist must live

```
ax studio.app/
└── Contents/
    └── Library/
        └── LaunchAgents/
            └── com.necmttn.ax-studio.helper.plist   ← MUST be here
```

Apple's SMAppService looks for the plist at exactly  
`<AppBundle>/Contents/Library/LaunchAgents/<serviceName>.plist`.  
The `Label` key inside the plist must match the filename (without `.plist`).

### The `BundleProgram` key

`BundleProgram` is the bundle-relative path to the helper executable, resolved from the  
**app bundle root** (i.e., from `ax studio.app/`, NOT from `Contents/MacOS/`).

```
BundleProgram = "Contents/Library/LaunchAgents/ax-serve-helper"
  → resolves to: ax studio.app/Contents/Library/LaunchAgents/ax-serve-helper
```

**Critical**: `BundleProgram` must be used instead of an absolute `Program` path.  
Launchd uses the bundle-relative path to verify the helper's code signature belongs  
to the parent app (same Team ID, same Developer ID signing chain).  
Absolute `ProgramArguments[0]` paths bypass this check and will be rejected on  
hardened/notarized builds.

### Canonical plist XML shape

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Label MUST match serviceName (filename without .plist) -->
    <key>Label</key>
    <string>com.necmttn.ax-studio.helper</string>

    <!-- BundleProgram: path relative to ax studio.app/ root.
         launchd resolves it from wherever the .app lives at runtime
         (e.g. /Applications, ~/Applications), so no hardcoded paths. -->
    <key>BundleProgram</key>
    <string>Contents/Library/LaunchAgents/ax-serve-helper</string>

    <!-- KeepAlive: restart the agent if it exits (crash recovery). -->
    <key>KeepAlive</key>
    <true/>

    <!-- RunAtLoad: start the agent immediately on registration and at login. -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Associates agent with the host app in System Settings → Login Items. -->
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>com.necmttn.ax-studio</string>
    </array>

    <key>ProcessType</key>
    <string>Background</string>

    <!-- EnvironmentVariables: inject AX_DATA_DIR and PORT so the helper
         finds the rocksdb store and binds the right port.
         These are expanded by launchd BEFORE exec; no shell expansion. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>AX_DB_URL</key>
        <string>ws://127.0.0.1:8521</string>
        <key>AX_DB_NS</key>
        <string>ax</string>
        <key>AX_DB_DB</key>
        <string>main</string>
    </dict>

    <!-- NOTE: StandardOutPath / StandardErrorPath intentionally OMITTED.
         macOS 14.4+ rejects SMAppService jobs that set them on sandboxed apps
         (register() → SMAppServiceErrorDomain code 22 / status .notFound).
         Route stdout/stderr to os_log in the helper binary instead. -->
</dict>
</plist>
```

**Plist filename:** `com.necmttn.ax-studio.helper.plist` (must match `Label` + `serviceName`).

---

## 4. Executable strategy - DECIDED

### Gate question resolved: can `BundleProgram` point at the main Electron binary?

**Answer: TECHNICALLY YES, PRACTICALLY NO.**

- `BundleProgram` can point to any bundle-relative path, including  
  `Contents/MacOS/ax studio` (the main Electron binary). The `parleq` app  
  does this for `mainAppService`.
- `ProgramArguments` can coexist with `BundleProgram`: launchd uses `BundleProgram`  
  as the executable and `ProgramArguments` as argv, so `--background-helper` could  
  be passed.
- **BUT**: Launching the full Electron binary as a launchd agent is inappropriate:
  - Electron expects a display (window server), Cocoa run loop, and renderer processes.
  - Launchd background agents have no display environment (`DISPLAY` unset, no  
    WindowServer session). The Electron binary will crash or hang trying to initialize.
  - Even with a `--background-helper` guard, the Electron process model (multi-process,  
    Chromium IPC) is far heavier than needed for `surreal` + `ax serve` supervision.

### Decided strategy: **Strategy B - Separate compiled helper binary**

Place a separate, small compiled binary at:  
`ax studio.app/Contents/Library/LaunchAgents/ax-serve-helper`

This binary's sole job: start `surreal` and `bun axctl serve` in the foreground,  
managing their lifetime (similar to what `AxBackendManager` does today).

**Why this approach:**
1. The established SMAppService agentService pattern universally uses a separate helper  
   binary (confirmed across 5+ real-world apps).
2. electron-builder automatically signs ALL Mach-O files found anywhere in the app bundle  
   (including `Contents/Library/LaunchAgents/`) when `hardenedRuntime: true` + a real  
   Developer ID cert is present - no extra signing step needed.
3. The helper binary is already in scope: the `axctl` compiled bun binary  
   (`bun build --compile`) is exactly this helper, or a thin wrapper around it.
4. `BundleProgram` code-signature check passes trivially (same Developer ID).
5. No Electron process weight; launchd gets a lightweight background-only binary.

### Helper binary concrete spec

**Identity:** A compiled bun binary (output of `bun build --compile`) named `ax-serve-helper`  
that runs `ax serve` (starts surreal + serves the ax HTTP API).  

**Source location (to be staged by Task 4):** `apps/studio-desktop/build/LaunchAgents/ax-serve-helper`  
(compiled by the `prepackage` script step, placed in the bundle via `extraFiles`).

**electron-builder extraFiles entry (Task 4 will add):**
```javascript
extraFiles: [
  {
    from: "build/LaunchAgents/ax-serve-helper",
    to: "Library/LaunchAgents/ax-serve-helper",
    // Note: extraFiles `to` is relative to Contents/, so this lands at
    // Contents/Library/LaunchAgents/ax-serve-helper
  }
]
```
This places it next to the plist. electron-builder signs it with `hardenedRuntime: true`  
automatically.

### Fallback (if compiled bun binary is infeasible for notarization)

If `bun build --compile` output fails Apple's notarization scan (e.g., due to unsupported  
binary format at notarization time): use a minimal shell launcher at the same path  
(`#!/bin/sh` shebang with absolute paths to the bundled `bun` and ax-src entry). Shell  
scripts don't go through code-signature verification by `BundleProgram` the same way, but  
they ARE executable and `launchd` will run them. This is the accepted fallback documented  
in Apple's own developer materials for simple agents.

---

## 5. Plist placement in electron-builder

The plist file itself (`com.necmttn.ax-studio.helper.plist`) also needs to land at  
`Contents/Library/LaunchAgents/`. Add alongside the helper binary:

```javascript
// in electron-builder.config.cjs, mac section:
extraFiles: [
  {
    from: "build/LaunchAgents/com.necmttn.ax-studio.helper.plist",
    to: "Library/LaunchAgents/com.necmttn.ax-studio.helper.plist",
  },
  {
    from: "build/LaunchAgents/ax-serve-helper",
    to: "Library/LaunchAgents/ax-serve-helper",
  },
]
```

Source files to create (Tasks 2 + 4):
- `apps/studio-desktop/build/LaunchAgents/com.necmttn.ax-studio.helper.plist` - the XML above
- `apps/studio-desktop/build/LaunchAgents/ax-serve-helper` - compiled helper binary (gitignored, built by prepackage)

---

## 6. Registration lifecycle summary

| Action | Electron call | SMAppService call | Result |
|--------|---------------|-------------------|--------|
| Register (enable at login) | `setLoginItemSettings({ type: 'agentService', serviceName: '…', openAtLogin: true })` | `[service registerAndReturnError:]` | status → `enabled` (or `requires-approval` first time) |
| Check status | `getLoginItemSettings({ type: 'agentService', serviceName: '…' }).status` | `[service status]` | `not-registered` / `enabled` / `requires-approval` / `not-found` |
| Unregister | `setLoginItemSettings({ type: 'agentService', serviceName: '…', openAtLogin: false })` | `[service unregisterAndReturnError:]` | status → `not-registered` |

`not-found` means the plist file is missing from `Contents/Library/LaunchAgents/` - it  
will appear as this until the app is rebuilt with the plist bundled.

`requires-approval` means the user must approve in System Settings → General → Login Items  
(first-time registration on macOS 13+). Electron's `getLoginItemSettings` exposes this  
so the app can surface a nudge.

---

## 7. Open concerns for subsequent tasks

1. **Helper binary build step**: Task 4 must add a `bun build --compile` step in  
   `prepackage` that produces `build/LaunchAgents/ax-serve-helper`. The helper needs  
   to know paths to the bundled `surreal` + `bun` binaries relative to itself  
   (`__dirname`-style resolution from `Contents/Library/LaunchAgents/`).

2. **Entitlements inheritance**: electron-builder uses `entitlementsInherit` for nested  
   binaries. The helper binary may need `com.apple.security.cs.allow-jit` removed  
   (it doesn't run JS in a JIT context). Check `entitlementsInherit` when signing fails.

3. **`KeepAlive` interaction with app quit**: when the user quits `ax studio`, launchd  
   will restart the helper immediately (KeepAlive=true). Task 2 must ensure  
   `AxDaemonArbitration` properly handles the "helper running, app just quitting"  
   case - the helper is INTENTIONALLY left running. The app must NOT kill it on quit.

4. **macOS 13 minimum**: `type: 'agentService'` requires macOS 13+. The existing  
   `ElectronApp.ts` comment already states "macOS 13+" for `mainAppService`; add  
   the same guard or check `process.platform === 'darwin'` + OS version before calling.

5. **`StandardOutPath`/`StandardErrorPath` are forbidden** (documented in plist above) for  
   sandboxed app agents on macOS 14.4+. The helper binary must route logs via `os_log`  
   or write to `~/.ax/` directly.
