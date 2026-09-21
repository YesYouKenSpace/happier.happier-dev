# yesyoukenspace Happier Fork

## Development Changes

Public sharing is disabled by default in the current development source. Explicit bundle-time opt-in, retained link deletion, and security limits are documented under [Public sharing](public-sharing.md). `make test-public-sharing` runs the affected tests and UI typecheck. The 137 public-sharing tests and final UI typecheck pass. Live browser validation and the required 0.3 forward-port remain blocked, so this is not a released or fully verified change.

## Documentation Index

- [Development changes](#development-changes)
- [Public sharing](public-sharing.md)

## Roadmap

- [ ] Disable public sharing by default in trusted clients, with explicit build-local opt-in and existing-link deletion preserved. Implementation, regression tests, and UI typecheck passed; live QA needs Playwright Chromium, and the 0.3 port needs a destination checkout. See [Public sharing](public-sharing.md).
