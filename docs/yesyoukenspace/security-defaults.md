# Security Defaults

Use this page to preserve the fork's stricter defaults: require authenticated v3 responses for fresh terminal pairing, reject plaintext Account/session storage at the CLI guards below, and disable public sharing in trusted UI clients unless explicitly enabled at bundle time. These are local requirements, not relay-selected preferences.

**Status:** the CLI sections describe committed source at fork [`432d3af9ea`](https://github.com/yesyoukenspace/happier.happier-dev/commit/432d3af9ea9937050f28679bbbefa8d5e6e05988), compared with cached upstream/dev [`6809131923`](https://github.com/happier-dev/happier/commit/6809131923b2fa434690dd4223762f40f7fab97a). [Client public sharing](public-sharing.md) has separate development-source validation evidence. This page does not certify a release, installed binary, or deployment.

## Fork Delta

| Process environment setting | Unset/blank in this fork | Unset/blank at cached upstream baseline | Fork commit |
| --- | --- | --- | --- |
| `HAPPIER_TERMINAL_PAIRING_REQUIRE` | `v3` | No minimum requirement (`null`); legacy responses accepted | [`8b533d3fff`](https://github.com/yesyoukenspace/happier.happier-dev/commit/8b533d3fffb4ed75c5570954e1a9dbf556486518) |
| `HAPPIER_ENCRYPTION_REQUIREMENT` | `require_e2ee` | `follow_account` | [`f323ab3d9c`](https://github.com/yesyoukenspace/happier.happier-dev/commit/f323ab3d9cac5e1debe1e4753fed2695e7a5fb8b) |

Current owners: [`readTerminalPairingRequirement`](../../apps/cli/src/auth/terminalProvisioningResponse.ts#L25-L34) and [`resolveClientEncryptionRequirementEnv`](../../apps/cli/src/configuration.ts#L65-L76). Both trim whitespace and normalize case; unrecognized non-empty values throw rather than silently weakening the requirement.

These commits change defaults in preexisting upstream machinery. They do not introduce v3 cryptography, Account/session encryption, strongest-wins requirement combination, or the enforcement guards. The shared [persisted requirement schema](../../packages/protocol/src/encryption/clientEncryptionRequirement.ts#L6-L17) still defaults missing values to `follow_account`; the fork changes the CLI's local floor, not that schema or a saved Account preference.

## Configuration

No environment setting is needed to select these fork defaults. For explicit configuration:

- `HAPPIER_TERMINAL_PAIRING_REQUIRE=v3` selects the same pairing requirement. There is **no environment opt-out** at this source revision: empty values still select v3, and values such as `compatible`, `v2`, or `off` throw. The decoder's internal `requirement: null` compatibility branch remains, but the [environment parser](../../apps/cli/src/auth/terminalProvisioningResponse.ts#L25-L34) no longer selects it.
- `HAPPIER_ENCRYPTION_REQUIREMENT=require_e2ee` explicitly retains the local encryption requirement. `HAPPIER_ENCRYPTION_REQUIREMENT=follow_account` opts out of that local floor, allowing the existing Account/server storage-mode selection to operate. It does **not** force plaintext or override a synced `clientEncryptionRequirementV1=require_e2ee`: [`resolveEffectiveClientEncryptionRequirement`](../../apps/cli/src/settings/accountSettings/resolveEffectiveClientEncryptionRequirement.ts#L13-L22) combines both inputs, and [`combineClientEncryptionRequirements`](../../packages/protocol/src/encryption/clientEncryptionRequirement.ts#L13-L30) lets the stronger requirement win.

Set the encryption requirement in the environment of the CLI/daemon process that must enforce it; [configuration reads it during initialization](../../apps/cli/src/configuration.ts#L367-L415). Do not assume setting a variable in another shell changes an already-running daemon. Use the existing [Makefile](../../Makefile) for build and service operations.

## Terminal Pairing

For fresh pairing, use the existing sign-in flow with a v3-capable app and the complete QR/deep link. [`doAuth`](../../apps/cli/src/ui/auth.ts#L195-L237) creates local pairing context and passes its requirement through mobile and web flows. The [current app approval path](../../apps/ui/sources/hooks/session/useConnectTerminal.ts#L134-L167) builds v3 when the link supplies pairing context; without it, that path builds v2.

The existing [v3 implementation](../../packages/protocol/src/crypto/terminalProvisioningV2.ts#L78-L164) authenticates the sealed content-key response with HMAC-SHA-256, binding the terminal public key and validity window. The CLI creates a [32-byte secret with a one-hour window](../../apps/cli/src/auth/terminalProvisioningResponse.ts#L23-L48). Its [auth request](../../apps/cli/src/cli/commands/auth/request.ts#L39-L56) sends the public key and claim-secret hash, not the pairing secret; [link generation](../../apps/cli/src/cli/commands/auth/request.ts#L87-L96) receives the pairing secret separately.

Receiver behavior and compatibility limits:

- [`openTerminalProvisioningResponse`](../../apps/cli/src/auth/terminalProvisioningResponse.ts#L51-L87) rejects non-v3 responses when v3 is required. Missing pairing context, invalid context, a bad MAC, an out-of-window response, or failure to open the sealed key also reject; see [`openTerminalProvisioningV3Payload`](../../packages/protocol/src/crypto/terminalProvisioningV2.ts#L134-L164). Legacy v1/v2 approval is not an automatic fallback.
- Split `auth request --json` / `auth wait` flows [persist the requirement and context](../../apps/cli/src/cli/commands/auth/request.ts#L58-L77). [`handleAuthWait`](../../apps/cli/src/cli/commands/auth/wait.ts#L109-L138) restores them, or reads the current requirement when absent. An unauthenticated wait with old pending state lacking pairing context fails and asks for a fresh request; [response rejection](../../apps/cli/src/cli/commands/auth/wait.ts#L170-L185) recommends updating the app and scanning a new QR code.
- **CLI-to-CLI approval limit, derived from source:** [`approveTerminalAuthRequest`](../../apps/cli/src/auth/terminalAuthApproval.ts#L30-L62), used by [`auth approve`](../../apps/cli/src/cli/commands/auth/approve.ts#L14-L25) and [`auth pair-remote`](../../apps/cli/src/cli/commands/auth/pairRemote.ts#L292-L319), still emits a v2 response without pairing-secret authentication. It cannot satisfy a fresh receiver using this fork's v3 default. No live pairing check was run for this page.
- Interactive auth's [legacy HTTP polling fallback](../../apps/cli/src/ui/auth.ts#L572-L635) still uses the same response decoder and requirement. HTTP compatibility does not imply permission to accept legacy provisioning payloads. The app's [approval transport](../../apps/ui/sources/auth/flows/approve.ts#L50-L65) also still depends on the relay's `supportsV2` response to select the v2/v3 payload slot; refusal or downgrade can prevent pairing, not lower the terminal's requirement.
- This default does not retroactively authenticate stored credentials. [`auth login`](../../apps/cli/src/cli/commands/auth/login.ts#L122-L133) can return for an already authenticated machine, and [`auth wait`](../../apps/cli/src/cli/commands/auth/wait.ts#L123-L134) can return existing credentials without processing a new response.

## Encryption Guards

With the local `require_e2ee` floor, weaker or missing Account requirements cannot select `follow_account` in the [effective requirement resolver](../../apps/cli/src/settings/accountSettings/resolveEffectiveClientEncryptionRequirement.ts#L13-L54). Reachable existing guards include:

- **Account settings:** [bootstrap/cache/network parsing](../../apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext.ts#L434-L475) and [live settings application](../../apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext.ts#L173-L192) reject plaintext envelopes before publishing their settings. [`updateAccountSettingsV2WithRetry`](../../apps/cli/src/settings/accountSettings/updateAccountSettingsV2WithRetry.ts#L204-L241) checks plaintext settings before mutation and writeback. The requirement error is `CLIENT_E2EE_REQUIRED`, with `retryable: false`; [bootstrap preserves that error](../../apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext.ts#L514-L544) rather than treating it as an ordinary cache-fallback failure.
- **Session creation:** [`resolveSessionCreateEncryptionMode`](../../apps/cli/src/api/session/resolveSessionCreateEncryptionMode.ts#L25-L75) rejects a `plaintext_only` server and an optional-policy Account selecting `plain`. Both [`ApiClient.getOrCreateSession`](../../apps/cli/src/api/api.ts#L409-L486) and [`getOrCreateSessionByTag`](../../apps/cli/src/session/transport/http/sessionsHttp.ts#L383-L446) use that decision and check the returned session mode, including create-or-load responses.
- **Existing-session attach lookup:** [`resolveExistingSessionAttachContext`](../../apps/cli/src/daemon/sessionEncryption/resolveExistingSessionAttachContext.ts#L74-L165) rejects a plain session before extracting its metadata or building its attach payload, returning `clientE2eeRequired`. The [daemon lookup caller](../../apps/cli/src/daemon/startDaemon.ts#L3173-L3186) maps it to an [attach refusal](../../apps/cli/src/daemon/startDaemon.ts#L1568-L1573).

These are refusal guards, not automatic encryption migrations. A plaintext Account or session does not become encrypted merely because this CLI starts with `require_e2ee`; the paths above reject incompatible content/modes. Explicit `follow_account` trades away the local floor for plaintext compatibility, subject to the remaining effective requirement and storage policy.

## Client Public Sharing

See [Public sharing](public-sharing.md) for the default-off client flag, explicit build-time opt-in, retained link deletion, and validation limits.

## Session Key Authentication

**Status: rebased onto upstream `dev` at `7e0bbd47f4` (commits `74b8cc7c09`, `fe0d37eb9a`, `5342b76ea0`);
post-rebase integration fixes live in the working tree, uncommitted; not released or fully live-validated.** The approved strict cutover keeps random
session DEKs but authenticates their owner envelopes with a purpose-derived account content key.
The envelope binds the creation tag; the session-ID binding lives inside the DEK-encrypted
metadata, so no relay change is needed. Clients must validate the requested identity before
accepting a key, including create-or-load responses, resume, and UI hydration.

Upstream's create→publish DEK-fetch retry composes with the fork's binding-pending signal:
a missing envelope is refetched a bounded number of times, then strictly rejected — never
downgraded. The scoped UI session-key memo cache is restored with a per-instance guard, so a
different account secret never adopts another account's cached resolution while machine-token
eviction still cannot invalidate session entries. Legacy-credential rows open owner envelopes
through the same strict path; only envelope-absent pre-cutover rows use the narrow fallback.

Updated clients reject missing, malformed, anonymous legacy, wrong-account, and wrong-context
session envelopes. Existing encrypted direct-share envelopes are also rejected until an authenticated
recipient-sharing protocol is implemented. Stored sessions and shares are not deleted or automatically
rewrapped; successful opening of a legacy envelope is not a trusted migration source. Older clients
cannot open the new owner format. Machine and artifact envelopes remain separate contracts.

The [canonical envelope owner](../../packages/protocol/src/crypto/ownerSessionDataKeyEnvelope.ts)
reuses purpose-derived authenticated Account encryption. The [wire contract](../encryption.md#authenticated-owner-session-keys)
seals the requested tag into the envelope and verifies the ID binding from metadata ciphertext.
The [CLI resolver](../../apps/cli/src/session/transport/encryption/sessionEncryptionContext.ts)
has no account-key fallback. The [UI owner reader](../../apps/ui/sources/sync/encryption/encryption.ts)
does not use the V1 native worker or accept direct-share envelopes based on relay flags.

Upgrade the CLI/daemon and UI together before creating sessions with this format; stock relays
need no change. Old clients cannot read new owner envelopes. There is no automatic recovery or
rewrap for legacy sessions. A trusted migration source must be established separately; a
decryptable server response is not one. Existing collection views retain inaccessible IDs without
trusting their metadata, so an old row does not block discovery of new sessions.

Pre-cutover rows that predate envelopes remain readable through a narrow account-key fallback:
their metadata is encrypted directly under the account key, which only an account-key holder
could have produced, so a relay can replay but never forge them. A present-but-unopenable
envelope never takes this path. Best-effort metadata readers degrade those rows to unavailable
rather than failing; selected-session execution still requires the strict path. These legacy
rows carry no ID binding, so same-account substitution among them is not detectable — a
documented residual confined to pre-cutover data.

Verification performed:

- [Envelope tests](../../packages/protocol/src/crypto/ownerSessionDataKeyEnvelope.test.ts) cover account,
  purpose, tag, tampering, credential modes, legacy rejection, and the metadata binding contract.
- [Composed HTTP tests](../../apps/server/sources/app/api/routes/session/sessionRoutes.createRegister.sqlite.integration.spec.ts)
  use real Fastify/authentication, disposable SQLite, and separate CLI source processes for creation,
  binding publication, cross-device load, resume-key recovery, coherent forged responses, identity
  transplants, wrong-account envelopes, stale pre-binding replay, and binding self-heal — all
  against the stock route surface with no relay change.
- [UI policy tests](../../apps/ui/sources/sync/sync.clientEncryptionRequirement.test.ts) verify no plaintext
  RPC, pending, direct-message, or metadata issuance under a locally enforced requirement, including
  policy changes during asynchronous work. Explicit `follow_account` controls remain allowed. The
  scoped guards combine the active device pin with the target account's own persisted requirement —
  strongest wins — and refuse plaintext with `CLIENT_ENCRYPTION_REQUIREMENT_UNAVAILABLE` when the
  target scope's floor cannot be established on this device. The
  [scoped resolver](../../apps/ui/sources/sync/domains/settings/scopedClientEncryptionRequirement.ts)
  owns that combination; a relay-selected storage mode on another server cannot borrow the active
  profile's opt-out.
- [Discovery tests](../../apps/cli/src/session/query/resolveSessionId.longPrefix.test.ts) and
  [strict transport tests](../../apps/cli/src/session/services/resolveSessionTransportContext.test.ts)
  distinguish inaccessible retained rows from the selected session, which still fails closed.
- Pre-cutover envelope-absent rows stay readable through the narrow account-key fallback, covered
  by the fork-chain legacy integration path and plaintext replay tests; present-but-unopenable
  envelopes never take that path.
- Focused/broader protocol, CLI, UI, and server tests and package typechecks passed. Independent
  review reproduced and then verified corrections for plaintext scoped-RPC downgrade and
  legacy-row collection poisoning.
- Post-rebase integration coverage: the CLI retry-then-reject composition
  ([transport test](../../apps/cli/src/session/services/resolveSessionTransportContext.test.ts),
  including stripped-envelope-on-bound-row rejection without account-key fallback),
  the restored scoped memo with per-account isolation
  ([scoped test](../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/scopedDataKeySingleFlight.test.ts)),
  legacy-envelope opening through the strict path and plaintext-summary projection under the
  fork default (pinned to `follow_account` in routing/projection tests, matching the
  established attach-test pattern), the daemon automation credential derivation, and the
  composed server proof extended with the stripped-bound case. CLI and
  protocol typechecks are clean in the fork's scope; UI typecheck is clean in `sync/` and the
  touched suites pass. The standing gate is `make test-security` (protocol envelope +
  CLI strict suites + composed server spec + UI scoped suites + CLI/protocol typechecks;
  green end-to-end: 16 + 201 + 8 + 155 tests).

Remaining gates: browser/native-device execution and running daemon/provider resume have not been
exercised. `make test-all` fails outside this corridor on missing Bun, an OpenCode launcher check,
and missing website release-reference checkouts. Pre-existing, unrelated failures reproduced on the
pristine base: missing `smol-toml`/`ws-node` installs (worked around locally with read-only
`apps/cli/node_modules` symlinks, no repo change), absent `tmux` (one attach test made hermetic;
the rest of that file passes), and upstream markdown/legendList/codex typecheck errors in files
this change does not touch. The required 0.3 port lacks a destination checkout.
The Roadmap remains open and no completion entry is recorded yet. Authenticated envelopes do not
establish freshness, prevent a relay withholding data, or protect a compromised paired endpoint.

## Security Limits

Pairing and storage requirements solve different problems. Neither setting proves replay resistance, correct authorization of every host action, or full malicious-relay resistance. V3's MAC and time-window checks are not evidence that every later RPC/message is bound to its intended action, target, and context. Apply the [fork threat model](README.md#malicious-relay-threat-model) when investigating those paths.

Keep the native app, host, keys, and software distribution trusted. Web pairing still trusts the JavaScript origin that receives the link secret; the [CLI explicitly warns about this distinction](../../apps/cli/src/ui/auth.ts#L463-L487). A relay can also withhold delivery. This page makes no availability guarantee or blanket mixed-version compatibility claim.

## Evidence Caveats

Available tests, **referenced but not run for this documentation change**:

- [CLI encryption default and explicit opt-out](../../apps/cli/src/configuration.clientEncryptionRequirement.test.ts#L26-L46), plus [strongest-wins combination](../../packages/protocol/src/encryption/clientEncryptionRequirement.test.ts#L10-L28).
- [V3 authentication, tampering, and expiry](../../packages/protocol/src/crypto/terminalProvisioningV2.test.ts#L89-L159), [receiver rejection](../../apps/cli/src/auth/terminalProvisioningResponse.test.ts#L67-L142), and [request-state persistence](../../apps/cli/src/cli/commands/auth.pairing.integration.test.ts#L60-L96).
- [Plaintext Account rejection](../../apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext.test.ts#L785-L829), [creation-policy rejection](../../apps/cli/src/api/session/resolveSessionCreateEncryptionMode.test.ts#L43-L82), and [attach rejection](../../apps/cli/src/daemon/sessionEncryption/resolveExistingSessionAttachContext.test.ts#L76-L97).

Known source/documentation divergence at this basis: the [pairing default test](../../apps/cli/src/auth/terminalProvisioningResponse.test.ts#L38-L44) still expects an unset value to return `null`, contradicting the fork parser. The [CLI approval integration test](../../apps/cli/src/cli/commands/auth.pairing.integration.test.ts#L201-L230) still expects legacy-authenticated success. These are observed assertion mismatches, not reported test-run results. The shared [terminal pairing rollout text](../encryption.md#terminal-pairing-authentication-rollout) describes upstream's opt-in expansion phase, not this fork's default. Read its architecture with the deltas here; do not cite it as proof of fork-default compatibility.

## Related

- [Fork policy and documentation index](README.md)
- [Encryption architecture and storage modes](../encryption.md#session-storage-modes)
- [Compatibility and version skew](../compatibility.md)
- [CLI architecture](../cli-architecture.md)
