# Public Sharing

Public sharing defaults to disabled in this fork's shared native, web, and desktop UI code. This is a trusted-client restriction, not a relay setting or synced Account preference.

**Status:** development source checkpoint, not released. Automated checks passed; live verification and the required 0.3 forward-port remain blocked.

## Configuration

No configuration is needed to stay disabled. The explicit build-time opt-in is:

```dotenv
EXPO_PUBLIC_HAPPIER_FEATURE_SHARING_PUBLIC__ENABLED=true
```

Unset, blank, false, and malformed values remain disabled. Set the flag in the environment used to bundle the UI, then rebuild/reload that client bundle. See the [Expo environment example](../../apps/ui/.env.local.example). Changing a relay or CLI/daemon process environment does not change an installed client. There is no in-app settings toggle.

The [client build-policy owner](../../apps/ui/sources/sync/domains/features/featureBuildPolicy.ts) adds a deny for the existing `sharing.public` feature. Relay responses, Account preferences, and the generic build allowlist cannot enable it without this opt-in. An explicit build deny still wins even with opt-in. Opted-in UI flows also require the relay's existing public-sharing enabled bit; missing support stays closed.

## Behavior

The [creation owner](../../apps/ui/sources/sync/domains/social/createPublicShareWithClientToken.ts) rejects disabled builds before token generation, session-key lookup, wrapping, or upload. The [API adapter](../../apps/ui/sources/sync/api/social/apiSharing.ts) enforces the same canonical build policy for direct creation and public-token access calls, outside retries. The [sharing screen](../../apps/ui/sources/app/%28app%29/session/%5Bid%5D/sharing.tsx), [public-link dialog](../../apps/ui/sources/components/sessions/sharing/components/PublicLinkDialog.tsx), and [public viewer](../../apps/ui/sources/app/%28app%29/share/%5Btoken%5D.tsx) consume canonical feature decisions rather than trusting relay state alone.

While disabled, Create/Regenerate, link display/copy/open, QR/token display, and public-link viewing are unavailable. Existing-share metadata and deletion remain available through **Session Info > Manage sharing > active public link > Delete public link**. This flag leaves direct-sharing policy unchanged. It does not delete server records or rotate keys, and older clients remain unaffected; it introduces no new wire format or persistence migration.

## Security Limits

This is containment of the existing public-share protocol, not a cryptographic repair. That protocol sends a token together with the session DEK encrypted under a token-derived key: [`createPublicShareWithClientToken`](../../apps/ui/sources/sync/domains/social/createPublicShareWithClientToken.ts) and [`publicShareEncryption`](../../apps/ui/sources/sync/encryption/publicShareEncryption.ts). Opting in retains this exposure. Deleting a link cannot retract a previously obtained DEK. A relay-controlled web bundle remains outside the trusted-client assumption.

## Validation

Checks on 2026-09-21:

- RED observed before enforcement: default-off policy, key-export preflight, and direct API calls failed their rejection contracts. UI tests separately observed visible disabled controls and token HTTP requests before their guards.
- `make test-public-sharing` passed 137 tests across 28 files. Tests cover explicit opt-in, build deny, hostile server/Account opt-in, disabled creation before key access, no token requests, cached-link suppression, and retained deletion. Owners include [feature decisions](../../apps/ui/sources/sync/domains/features/featureDecisionRuntime.test.ts), [creation preflight](../../apps/ui/sources/sync/domains/social/createPublicShareWithClientToken.test.ts), [API calls](../../apps/ui/sources/sync/api/social/apiSharing.serverScope.test.ts), [dialog controls](../../apps/ui/sources/components/sessions/sharing/components/PublicLinkDialog.copy.test.tsx), and [viewer gating](../../apps/ui/sources/__tests__/app/share/publicShareViewer.featureGate.test.tsx).
- UI TypeScript validation passed. An intermediate run failed during a concurrent session-key API migration; the final check no longer reported those errors. Validation used the moving shared checkout, not a separate staged-only checkout.
- Independent review found no security bypass in the changed paths. Production Expo/Babel transformation checks passed for web, Android, and iOS, including resistance to runtime environment overrides of bundled values. These are not full app builds or device tests.
- Documentation content checks, all 39 documentation tests, and documentation typecheck passed. Full-repository validation was attempted separately and failed in other shared-package checks: Bun was missing, the Unix OpenCode launcher test exited 127, and website tests lacked released/unreleased comparison checkouts. No full-repository pass is claimed.

Live browser QA could not launch because the installed Playwright package lacks its Chromium executable. Native/desktop live QA and the full plaintext public-share Playwright flow were not run. The live acceptance recipe remains: load this checkout's development bundle with flag unset and isolated synthetic relay responses, open a public token on desktop/mobile viewports, confirm disabled UI and no token-bearing API requests, then verify existing-link deletion from management. No real credentials or shares are needed.

A 0.3 forward-port remains blocked until its destination checkout is provided.
