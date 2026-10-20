# Completed Fork Work

## Committed Feature and Default Inventory

Documented on 2026-09-21. This records documentation of existing code, not new implementation or a release certification.

- Added the [README inventory](README.md#committed-features-and-defaults) for ten patch-unique fork commits through `432d3af9ea`, compared with cached upstream `dev` at `6809131923`.
- Recorded [pairing and encryption defaults](security-defaults.md), their explicit configuration, existing enforcement, and source-derived compatibility limits.
- Recorded [browser local notifications](web-notifications.md), inherited settings, permission and privacy behavior, focus suppression, and page-lifetime limits.
- Recorded [development tools](development.md), including CLI rebuild/linking, Android builds, remote publication requests, Nix/direnv, and scoped CA propagation. Superseded rebuild behavior is distinguished from the current recipe.
- Linked current source owners, originating commits, and existing coverage. Whitespace, local links, heading anchors, source-line ranges, and all ten commit references passed documentation checks. Reviewed `make --dry-run` and dry runs of the three documented Makefile targets without executing their recipes.
- Product tests and live builds, services, browser flows, and publication were not run. Documentation checks and command dry runs do not certify runtime behavior.

Existing pairing producer/receiver and test-expectation mismatches are documented in [security evidence caveats](security-defaults.md#evidence-caveats), not fixed by this documentation task. No new security implementation or follow-up work is authorized by this completion entry.

## OpenCode Review Mode Configuration

Updated on 2026-09-21. OpenCode ACP and managed-server launches now enable `experimental.auto_approve` unless explicitly disabled, restoring the attached TUI's classifier-gated `review` mode. Focused tests passed; live OpenCode TUI validation and release certification were not run.

## OpenCode Default Permission Mode

Updated on 2026-09-21. Plain `happier opencode` now supplies `yolo` as the default permission mode, while explicit modes remain unchanged. Focused CLI tests passed; live provider execution and release certification were not run.

## Documentation Completion Policy

Updated on 2026-09-21. The [root instruction entry point](../../AGENTS.md#fork-policy) now requires implementation and upstream-integration tasks to satisfy the [fork documentation completion requirements](README.md#documentation-completion) before handoff.

- Made same-change documentation updates mandatory for changed fork behavior, defaults, security/compatibility contracts, and development workflows, with narrow, explained exceptions for unchanged behavior.
- Made README-as-PRD/quickstart, approved Roadmap/TODO execution, completion records, official integration references, and evidence-backed handoff expectations explicit.
- Whitespace and local link/fragment checks passed. This changes documentation and agent instructions only; runtime tests and fresh-agent adherence checks were not run. Instructions establish the requirement, not a technical guarantee that every agent will comply.
