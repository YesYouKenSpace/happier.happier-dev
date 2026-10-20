# yesyoukenspace Happier Fork

Maintain [this fork](https://github.com/yesyoukenspace/happier.happier-dev) alongside [upstream Happier](https://github.com/happier-dev/happier), with a focus on protecting clients and agent hosts when the relay is malicious. New features and fixes remain in scope; security work is not the only reason to maintain the fork.

This page owns fork-specific agent policy, the documentation entry point, and the maintenance workflow. The security requirements below are review criteria, not a claim that every current path satisfies them. Establish protection from source and tests for the relevant build before relying on it.

## Agent Policy

- Apply this policy throughout the repository, not only inside this directory. Keep fork-specific policy here and keep the root instruction link small.
- Retain the [root constitution](../../AGENTS.md), relevant package instructions, and repository skills except where this page explicitly defines a fork-specific difference. Do not copy or replace the upstream instruction trees.
- Treat the malicious-relay threat model below as an explicit fork requirement. An upstream assumption that the relay is trusted does not override it. Resolve any material conflict before changing the affected behavior.
- This policy does not authorize inventing or expanding implementation beyond the current task or already-approved Roadmap/TODO work. Upstream integration, Git mutations, publication, and other approval-sensitive actions retain their existing authorization requirements.

## Quickstart

1. Read this page, then the relevant package instructions and existing canonical documentation for the task. Before changing an area listed below, read its feature page to preserve intentional fork differences.
2. For installation and usage, start with the [project README](../../README.md#installation). Upstream installation instructions do not establish that an installed artifact contains this fork's changes; verify the running build when testing fork behavior.
3. Use explicit targets from the existing [Makefile](../../Makefile) for fork project commands. Bare `make` selects remote mobile CI dispatch, not a harmless help/build default; read [command side effects](development.md#project-commands) first. Run the relevant validation for the changed owner; do not infer validation from a successful build or from an uninvoked command.
4. Before adding a feature or fix document, follow the documentation workflow below and update this page's index.

## Committed Features and Defaults

This inventory covers the ten patch-unique, non-merge fork commits through [432d3af9ea](https://github.com/yesyoukenspace/happier.happier-dev/commit/432d3af9ea9937050f28679bbbefa8d5e6e05988), compared with cached upstream `dev` at [6809131923](https://github.com/happier-dev/happier/commit/6809131923b2fa434690dd4223762f40f7fab97a). No upstream fetch or release/deployment verification was performed. The pages describe committed source, not a guarantee about an installed app or daemon, and link to the originating commits, current owners, and existing tests.

| Area | Behavior to preserve | Details |
| --- | --- | --- |
| CLI encryption | Unset/blank `HAPPIER_ENCRYPTION_REQUIREMENT` defaults to `require_e2ee`; explicit `follow_account` removes only the local floor. | [Security defaults](security-defaults.md#encryption-guards) |
| Terminal pairing | Fresh CLI pairing requires authenticated v3 responses by default; the environment parser has no legacy opt-out. Existing CLI-to-CLI approval still emits v2 and cannot satisfy that default. | [Pairing and compatibility limits](security-defaults.md#terminal-pairing) |
| Browser local notifications | Adds browser delivery and permission UI for existing activity events. Inherited device toggles and previews default on, but browser permission is still required; the page must remain running. | [Browser notifications](web-notifications.md) |
| Extra CA inheritance | `NODE_EXTRA_CA_CERTS` reaches daemon service definitions and the Claude subprocess environment filter; this is not an all-Agent guarantee. | [Runtime CA propagation](development.md#runtime-extra-ca-propagation) |
| CLI development workflow | `make cli.rebuild` refreshes both CLI outputs, activates checkout-backed shims, and restarts the service. The separate `cli:link` wrapper remains available but is not used by that target. | [Rebuild and linking](development.md#local-cli-rebuild-and-linking) |
| Local Android APKs | `make apk.docker` defaults to development app identity, release build variant, and arm64 APK code using a linux/amd64 builder; it includes optional build-time CA collection. | [Local Docker build](development.md#local-docker-build) |
| Remote mobile build | `make gh.ci.mobile.build` requests a preview Android build from remote `dev` with GitHub APK publication enabled. It is an external write requiring authorization. | [Remote mobile CI](development.md#remote-mobile-ci) |
| Development environment | Nix/direnv supplies Node 24 and associated development tools on the listed Linux/macOS architectures. Docker's Android toolchain separately declares Node 22. | [Nix and direnv](development.md#nix-and-direnv) |

The feature pages distinguish fork changes from inherited upstream behavior and flag stale comments/tests rather than documenting them as working guarantees. In particular, stricter pairing and encryption defaults are not proof of complete malicious-relay resistance.

## Development Changes

Owner-session keys now use authenticated, identity-bound envelopes in the current development source,
with the session-ID binding carried inside DEK-encrypted metadata so stock relays need no change.
The approved strict cutover rejects legacy owner and encrypted direct-share envelopes without deleting
stored data. Source tests and loopback HTTP composition pass; browser/native/daemon validation and
the 0.3 port remain pending. Read [session key authentication](security-defaults.md#session-key-authentication)
before upgrading components or attempting to resume old sessions.

Public sharing is disabled by default in the current development source. Explicit bundle-time opt-in, retained link deletion, and security limits are documented under [Public sharing](public-sharing.md). `make test-public-sharing` runs the affected tests and UI typecheck. The 137 public-sharing tests and final UI typecheck pass. Live browser validation and the required 0.3 forward-port remain blocked, so this is not a released or fully verified change.

OpenCode launches now enable anomalyco's `experimental.auto_approve` configuration by default, allowing the attached OpenCode TUI to expose classifier-gated `review` mode. An explicit `experimental.auto_approve: false` remains an opt-out. The config owner is `apps/cli/src/backends/opencode/shared/openCodeConfig.ts`, applied by the ACP and managed-server launch paths; focused CLI tests pass, but live TUI validation remains pending.

## Malicious-Relay Threat Model

Assume the relay can fabricate, modify, replay, reorder, suppress, or selectively deliver the messages and responses it controls. Treat its claimed identities, keys, capabilities, settings, session metadata, and authorization results as untrusted inputs, not independent proof of authority.

For changes touching that boundary:

- Enforce security decisions at the receiving client or agent host. Relay-side access checks alone do not establish protection against a compromised relay.
- Keep a locally enforced `require_e2ee` requirement fail-closed. A relay-selected storage mode or settings response must not weaken it.
- Trace key establishment and the authority for each host action, including shell commands, terminals, file access, and session lifecycle operations. Check whether authenticated data is bound to the intended action, target, and context; examine replay separately from ciphertext integrity.
- Add regression coverage at the real affected boundary for a reproduced attack or reachable failure. Do not prescribe new coordination, persistence, or protocol machinery before establishing the contract and the smallest owner-level correction.
- State assumptions about trusted clients, local operating systems, keys, and software distribution explicitly. A relay-controlled web client or a compromised endpoint is a separate trust boundary; protecting message transport alone does not establish protection there.
- Do not promise availability against a relay that can withhold delivery. Document observable failure and recovery behavior without presenting successful decryption as proof that data is fresh or complete.

The [encryption architecture](../encryption.md), [protocol](../protocol.md), and [CLI architecture](../cli-architecture.md) remain the starting points for implementation discovery. Re-derive security claims from their implementing code and tests; this policy is not evidence that those claims hold.

## Upstream Maintenance

- Keep intentional fork changes focused and reviewable. Fix the existing canonical owner rather than introducing a parallel fork runtime or duplicating upstream implementation.
- Use reviewed upstream integrations. Prefer merges over rebasing already-published fork history; preserve fork policy and inspect upstream changes to instructions, defaults, protocol behavior, and tests as well as merge conflicts.
- Do not use automatic "keep ours" conflict resolution to preserve security changes. Reconcile intent with the evolved upstream owner and rerun the relevant regression coverage.
- Record intentional differences in the affected fork topic page, with links to implementation and tests. Revisit that difference when upstream adopts or supersedes the fix; do not keep a second active implementation.
- Treat a changed wire, persistence, or mixed-version contract as a compatibility decision. Follow the existing [compatibility guidance](../compatibility.md) rather than silently weakening protection or assuming every client updates together.

## Documentation Workflow

Follow the repository's [documentation ownership rules](../../AGENTS.md#documentation-ownership) and [documentation skill](../../.agents/skills/happier-docs/SKILL.md). This namespace owns fork-specific intent and differences, not a second copy of all Happier documentation.

Documentation updates are required in the same change for fork features, behavioral fixes, defaults, security/compatibility contracts, development workflows, and upstream integrations that change fork behavior. An implementation is not complete while its documentation is stale.

- Start here: keep this README as the fork's PRD (product requirements document), quickstart for humans and agents, and documentation index. Add focused, descriptive topic pages such as `relay-rpc-security.md` when a feature or fix needs durable explanation. Do not create empty category folders or one report per commit.
- Search for the existing canonical page before creating a new one. Explain fork-only behavior under `docs/yesyoukenspace/`; link to upstream-owned concepts rather than copying them. Update affected canonical internal or published pages when their claims would otherwise become false.
- For a feature, document the user outcome, requirements, normal flow, meaningful limits, and acceptance criteria before implementation. Resolve product uncertainties first; create a separate implementation plan only when requested.
- For a fix, record the observed failure, root cause, changed behavior, and regression evidence in the relevant topic page when durable documentation is warranted. Small fixes do not require a new page if existing documentation and tests already explain the contract.
- Distinguish proposed, development-only, preview, and released behavior. Support factual claims with source paths and symbols or line references, actual validation results, and official external documentation where applicable. Do not turn goals or unrun checks into guarantees.
- Keep approved work as checkboxes in the Roadmap below. Tackle already-approved Roadmap items without asking for permission again; proceed with approved minor tasks in `TODO.md` when available. Stay within the agreed scope, respect concurrent work, and do not abandon an active task to take over another agent's work. Do not create empty tracking files or duplicate implementation-plan status.
- When work is validated, move the resulting behavior into this README's relevant sections and the canonical topic page, mark its task complete, and summarize the outcome under a linkable heading in [DONE.md](DONE.md). Include documentation links, checks actually run, skipped/failed validation, and remaining limitations; a completion record does not replace the maintained feature documentation.
- For external integrations, find the official API documentation or SDK and save its URL in this README alongside the relevant feature entry. Keep vendor references with the claims they support in topic pages as well.
- Update the index when adding a topic page. Use relative Markdown links, check their targets and fragments, and run documentation checks appropriate to the changed surface. Use Mermaid for diagrams when a diagram improves the explanation.

### Documentation Completion

Before reporting an implementation or upstream integration complete:

1. Update the affected existing fork topic pages and any canonical internal or published pages whose claims changed. Cover changed defaults, configuration/opt-outs, normal usage, failure/recovery behavior, security and compatibility limits, and source/test references as applicable. A small fix can update an existing page; it does not need a new document.
2. Keep this README's requirements, quickstart, feature/default inventory, and navigation accurate. Label uncommitted work as development-only or in progress; preserve historical commit origins and never present pending work as committed or released. Revise current-behavior claims when an upstream integration adopts or supersedes a fork difference.
3. Reconcile the applicable Roadmap/TODO item and [completion record](DONE.md) only after the required verification. Do not mark blocked or partially validated work complete; state the missing check or prerequisite instead.
4. Check changed links, fragments, commands, and evidence against the current source. In the final handoff, name the documentation paths updated, checks run, and validation gaps.

A documentation-only task updates the affected pages directly; read-only questions and investigations do not require documentation edits. A mechanical or internal-only change that leaves all documented behavior unchanged may leave topic pages untouched, but its handoff must identify the pages considered and explain why no update was needed. These exceptions must not be used to defer documentation for a feature, behavioral fix, default, or security-contract change.

## Documentation Index

- [Committed features and defaults](#committed-features-and-defaults)
- [Development changes](#development-changes)
- [Public sharing](public-sharing.md)
- [Security defaults](security-defaults.md)
- [Browser local notifications](web-notifications.md)
- [Development tools and build defaults](development.md)
- [Completed work](DONE.md)
- [Agent policy](#agent-policy)
- [Quickstart](#quickstart)
- [Malicious-relay threat model](#malicious-relay-threat-model)
- [Upstream maintenance](#upstream-maintenance)
- [Documentation workflow](#documentation-workflow)
- [Documentation completion requirements](#documentation-completion)
- [Shared internal documentation](../README.md)

## Roadmap

- [ ] Authenticate owner-session DEKs with the account content secret and session identity, with the ID binding inside DEK-encrypted metadata so stock relays need no change; reject legacy owner and direct-share envelopes without mutating stored data. Source implementation, scoped tests, independent review, and local HTTP composition passed; live browser/native/daemon gates and the unavailable 0.3 destination keep completion blocked. See [session key authentication](security-defaults.md#session-key-authentication).
- [x] Document existing committed fork features and defaults, including source owners, commit origins, and validation limits. [Completion](DONE.md#committed-feature-and-default-inventory)
- [x] Make fork documentation updates an explicit completion requirement for subsequent agents. [Completion](DONE.md#documentation-completion-policy)
- [ ] Disable public sharing by default in trusted clients, with explicit build-local opt-in and existing-link deletion preserved. Implementation, regression tests, and UI typecheck passed; live QA needs Playwright Chromium, and the 0.3 port needs a destination checkout. See [Public sharing](public-sharing.md).
