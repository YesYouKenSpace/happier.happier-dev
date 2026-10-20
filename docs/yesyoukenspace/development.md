# Fork development tools

Use these fork conveniences to prepare a development shell, rebuild the local CLI, or build Android APKs. Keep build, service, and publication side effects distinct; none is a read-only validation command.

**Basis:** committed source at [432d3af9ea](https://github.com/yesyoukenspace/happier.happier-dev/commit/432d3af9ea9937050f28679bbbefa8d5e6e05988), compared with cached upstream `dev` at [6809131923](https://github.com/happier-dev/happier/commit/6809131923b2fa434690dd4223762f40f7fab97a). This page covers seven development-tooling commits, not all fork differences. Source inspection does not establish that an installed CLI, built APK, or published release contains them.

## Project commands

Run explicit targets from the repository root, following [fork policy](README.md#quickstart). The [Makefile](../../Makefile) owns these entry points; lower-level script names below explain implementation, not alternative project commands.

| Target | Effect | Required care |
| --- | --- | --- |
| `make cli.rebuild` | Builds CLI outputs, activates checkout-backed shims, requests daemon service restart, then reports status. | Requires workspace dependencies and host Node/Yarn. Writes build outputs and stack configuration; can edit shell startup files and interrupt the running daemon. |
| `make apk.docker` | Collects host extra CAs, builds Android inside Docker, exports APK files. | Requires Make, Bash, a trusted Docker/BuildKit builder, network access, and sufficient build resources. Downloads dependencies/toolchains and writes local CA/output files and Docker caches. |
| `make gh.ci.mobile.build` | Dispatches remote mobile CI with APK release publication requested. | Requires separately authorized GitHub Actions/release access. This is an external write, not a local build. |

**Do not use bare `make` as a harmless default.** Its first ordinary target is `gh.ci.mobile.build`. `cli.install` appears only in `.PHONY`; it has no installation recipe ([Makefile:1-12](../../Makefile#L1-L12)).

Development validation also has explicit targets: `make test-protocol`, `make test-cli`,
`make test-ui`, `make test-server`, and `make test-server-integration`. Set `TEST_FILES` to select
the relevant package-relative test paths. `make typecheck WORKSPACE=@happier-dev/cli` selects a
workspace's native TypeScript lane (the default workspace is protocol). `make test-all` invokes the
repository-wide test script; it needs the optional runtimes and reference checkouts required by
those suites. These targets do not activate CLI shims, restart services, or publish builds.

## Local CLI rebuild and linking

Current [rebuild recipe](../../Makefile#L41-L59) performs these steps in order:

1. Calls root `cli:build`, whose CLI package prebuild builds shared dependencies and whose [build owner](../../apps/cli/scripts/build.mjs#L152-L234) publishes `apps/cli/dist/` through [finalizeDist](../../apps/cli/scripts/finalizeDist.mjs#L20-L45).
2. Calls [syncPackageDist](../../apps/cli/scripts/syncPackageDist.mjs#L43-L97) to refresh `apps/cli/package-dist/` from the build output. This remains a separate step; compiling `dist/` alone is not package-dist synchronization. The helper honors `HAPPIER_CLI_SKIP_PACKAGE_DIST_SYNC=1`, so an inherited skip setting defeats that refresh.
3. Calls root `cli:activate:path`, which invokes [repo_cli_activate.mjs](../../apps/stack/scripts/repo_cli_activate.mjs#L21-L37) with `--install-path`. Activation configures stack shims for this checkout through stack init, with runtime installation and bootstrap disabled.
4. Uses `HAPPIER_BIN`, defaulting to `$(HOME)/.happier-stack/bin/happier`, for service restart and status. It does not select an arbitrary `happier` from `PATH`.

The Makefile comment claiming shell startup files are untouched is stale: [root script wiring](../../package.json#L18) supplies `--install-path`, and [ensurePathInstalled](../../apps/stack/scripts/init.mjs#L76-L121) can update Bash, Zsh, or Fish configuration. [Stack init](../../apps/stack/scripts/init.mjs#L413-L438) writes shims and applies that option unless sandbox policy prevents global side effects. These shell shims assume Bash/Unix-style paths; this Makefile workflow is not evidence of native Windows support.

The target now uses host Node/Yarn directly; the earlier `NODE24`/mise prefix was removed. Ensure the intended toolchain is active before rebuilding. It requests restart of an existing service, not first-time service installation: [service lifecycle handling](../../apps/cli/src/daemon/service/cli.ts#L1713-L1786) checks installation and may refresh a drifted definition. Build success alone does not prove the selected daemon loaded this checkout.

### Retained standalone shortcut

Root [`cli:link`](../../package.json#L156) still delegates to CLI [`link:local`](../../apps/cli/package.json#L134-L137), backed by [link-happier-local.sh](../../apps/cli/scripts/link-happier-local.sh). **Current `cli.rebuild` does not call this script.** It uses stack activation instead.

- Default destination is `~/.local/bin/happier`; `--name` and `--dir` select another destination. Installation removes the old destination before writing a fresh executable wrapper; uninstall removes the selected destination without checking its provenance.
- Wrapper points directly at this checkout's `apps/cli/bin/happier.mjs`. If mise exists, it requests Node 24; otherwise it uses `node` from `PATH`, without enforcing version 24. Missing `dist/index.mjs` produces a warning, not a build or an installation failure.
- It warns when the destination directory is absent from `PATH` but does not edit shell configuration. The wrapper does not force a data home: [`resolveCliHappyHomeDir`](../../apps/cli/src/configuration.ts#L100-L111) defaults to `~/.happier` and honors `HAPPIER_HOME_DIR`. Thus this shortcut is not automatically an isolated development identity.

Related tests: [package-dist replacement](../../apps/cli/scripts/syncPackageDist.test.ts) and [checkout activation](../../apps/stack/scripts/repo_cli_activate.test.mjs). Neither demonstrates an end-to-end rebuild/service restart or tests the standalone link script.

## Android builds

### Local Docker build

Default invocation is `make apk.docker`. [Makefile defaults](../../Makefile#L22-L39) select `APP_ENV=development`, `BUILD_VARIANT=release`, `ANDROID_BUILD_ARCHS=arm64-v8a`, `GRADLE_CPUS=0-3`, and `GRADLE_HEAP=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8`. For example, `make apk.docker APP_ENV=preview BUILD_VARIANT=debug` changes app environment and Gradle variant independently. `release` does not mean production app identity or production signing.

[Dockerfile toolchain declarations](../../docker/android/Dockerfile#L20-L95) specify Node `22.23.1`, Yarn `1.22.22`, image `eclipse-temurin:17-jdk-jammy`, Android command-line tools `11076708`, platform `android-36`, build tools `36.0.0`, NDK `27.1.12297006`, and CMake `3.22.1`. These are configured versions, not proof downloads currently succeed or a byte-reproducibility guarantee; the image uses a tag and installation includes live package repositories. Docker's Node 22 toolchain is separate from the host Nix shell's Node 24.

The target forces `linux/amd64` regardless of APK ABI. An ARM host therefore needs an amd64-capable builder or [Docker emulation](https://docs.docker.com/build/building/multi-platform/#qemu). No host JDK/Android SDK is required by this recipe. CPU affinity and heap settings constrain the build; historical RAM estimates in comments are not measured capacity guarantees.

[Build stages](../../docker/android/Dockerfile#L100-L156) install workspace dependencies inside the container, build UI workspace dependencies, regenerate native projects, and assemble the APK. [Dedicated Docker ignore rules](../../docker/android/Dockerfile.dockerignore) exclude host `node_modules`, generated app native projects, and build outputs, while retaining native-module source. The generated native project is not the host's existing Android project.

- Release enables minification/resource shrinking and assembles bundled JS; expected export is `apps/ui/dist/apk/release/app-release.apk`. The recipe supplies no production signing setup. Default development-key signing follows the [Expo SDK 54 template's `buildTypes.release`](https://github.com/expo/expo/blob/sdk-54/templates/expo-template-bare-minimum/android/app/build.gradle), not a verified artifact signature. Do not treat this APK as a store-signed release.
- Debug assembles the development variant, which needs a Metro development server; expected export is `apps/ui/dist/apk/debug/app-debug.apk`. Only the literal `BUILD_VARIANT=release` takes the release branch; other values fall through to debug.
- Sentry auto-upload is disabled and upload failure is allowed; release assembly skips the two named vital-lint tasks. APK assembly is not the full test/lint lane.

Consumed settings live in [app.config.js](../../apps/ui/app.config.js#L92-L137), [withAndroidReleaseShrinker](../../apps/ui/plugins/withAndroidReleaseShrinker.js), and [withAndroidReactNativeArchitectures](../../apps/ui/plugins/withAndroidReactNativeArchitectures.js); plugin registration is [here](../../apps/ui/app.config.js#L363-L368). App identity comes from [appVariantConfig.cjs](../../apps/ui/appVariantConfig.cjs), not the Gradle variant. Related [shrinker](../../apps/ui/tools/plugins/withAndroidReleaseShrinker.test.ts) and [ABI](../../apps/ui/tools/plugins/withAndroidReactNativeArchitectures.test.ts) tests cover configuration transformations, not Docker execution, device launch, or APK signing.

### Build-time CA collection

[collect-ca-certs.sh](../../docker/android/collect-ca-certs.sh#L21-L47) gathers certificates from the macOS System keychain when `security` is available, local `docker/android/ca-certs/*.pem` and `*.crt`, and `EXTRA_CA_CERTS` pointing to a file or directory. It does not discover Linux or Windows system trust stores. Collection concatenates inputs and, when awk exists, keeps PEM certificate blocks; despite the comment, it does not deduplicate or validate trust/root status.

The target writes `docker/android/local-ca-certs.pem`; the bundle and local CA directory are [Git-ignored](../../.gitignore#L28-L30). Make continues after collector failure by touching the output path, which does not clear an existing bundle. Review collection diagnostics rather than assuming failed collection means no extra trust.

[Docker trust setup](../../docker/android/Dockerfile#L51-L65) copies that bundle, splits certificates for system trust, attempts imports into Java's trust store, and sets container `NODE_EXTRA_CA_CERTS` plus `GIT_SSL_CAINFO`. Java import errors are suppressed. Use only approved CAs and a trusted builder: certificates enter build layers, and the repository build context is not a secret-safe archive. Review the dedicated ignore rules before building. `EXTRA_CA_CERTS` is this collector's input; it is not the runtime setting described below.

### Remote mobile CI

`make gh.ci.mobile.build` dispatches [build-ui-mobile-local.yml](../../.github/workflows/build-ui-mobile-local.yml) with `environment=preview`, `platform=android`, `profile=preview-apk`, `action=build_only`, `publish_apk_release=true`, and `source_ref=dev` ([recipe](../../Makefile#L5-L12)). It builds the remote `dev` ref, not uncommitted local changes. No repository or workflow-control ref is explicitly selected by the recipe; verify the GitHub CLI target before authorizing dispatch.

Here, `build_only` excludes store submission, **not GitHub release publication**. The workflow defaults `native_build_mode` to `local`, meaning the CI runner rather than this machine. It locates a built APK and has a separate [sign/publish job](../../.github/workflows/build-ui-mobile-local.yml#L358-L438), with [trusted-ref, release-actor, and Expo-token prerequisites](../../.github/workflows/build-ui-mobile-local.yml#L189-L247). A successful dispatch is not proof of a completed build or publication. Related [workflow contract tests](../../scripts/release/build_ui_mobile_local_uses_ui_mobile_release.workflow.contract.test.mjs) cover delegation and publication separation.

## Nix and direnv

[flake.nix](../../flake.nix) supplies a default development shell for `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`; it defines no native Windows shell. Its explicit packages are `nodejs_24`, Yarn overridden to use that Node, `python3`, `gnumake`, `gcc`, `pkg-config`, `git`, `watchman`, and `ffmpeg`. The repository [package-manager declaration](../../package.json#L223) requests Yarn `1.22.22`; the Nix derivations resolve through the [locked nixpkgs revision](../../flake.lock#L3-L17), not that manifest alone.

The shell hook sets `COREPACK_ENABLE_STRICT=0` and prints Node/Yarn versions. It does not install workspace dependencies or run a Happier build. Docker, Android tools, and GitHub CLI are not explicit packages in this shell; entering it is not proof that every Makefile prerequisite exists.

[.envrc](../../.envrc) contains `use flake`, and [.gitignore](../../.gitignore#L121) excludes `.direnv/`. Host setup still needs Nix with flake support and direnv shell integration plus explicit approval of this checkout's environment. See official [Nix development-shell behavior](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-develop.html), [direnv flake loading](https://direnv.net/man/direnv-stdlib.1.html#use-flake-installable), and [direnv setup/approval](https://direnv.net/man/direnv.1.html). Environment loading may realize/download Nix dependencies; approval is an execution/trust decision, not a documentation check.

## Runtime extra CA propagation

The fork's `NODE_EXTRA_CA_CERTS` change reaches two specific owners:

- [`planDaemonServiceInstall`](../../apps/cli/src/daemon/service/plan.ts#L240-L443) chooses explicit `nodeExtraCaCerts`, otherwise the invoking process's `NODE_EXTRA_CA_CERTS`, trims it, and includes only a nonempty value in service environment. That shared environment is rendered for macOS launchd, Linux systemd, and Windows Scheduled Task wrappers. This passes a file path, not certificate contents, and does not validate or copy the file.
- [`buildClaudeSubprocessEnv`](../../apps/cli/src/backends/claude/spawn/buildClaudeSubprocessEnv.ts#L16-L90) allows that key from the base environment through its Claude-specific filter. Current consumers include [Claude unified-terminal spawning](../../apps/cli/src/backends/claude/unifiedTerminal/buildClaudeUnifiedTerminalSpawn.ts#L309-L323) and [Claude remote Agent SDK environment](../../apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.ts#L737-L776).

The [service installer](../../apps/cli/src/daemon/service/installer.ts#L195-L224) and [start/restart definition refresh](../../apps/cli/src/daemon/service/cli.ts#L1753-L1791) consume the same planner. Keep the intended CA environment present during later service refreshes: definitions are regenerated from the caller's environment, not preserved automatically from an earlier installation. Use a stable path readable by the service/Agent account. [Node's documented contract](https://nodejs.org/api/cli.html#node_extra_ca_certsfile) reads the setting at process launch; changing it inside an already-running Node process does not reload trust, and an explicit TLS `ca` option bypasses these extra certificates.

This is not a blanket guarantee for every Agent, subprocess, or subagent. Other launch paths and non-Node runtimes need their own consumer evidence. It does not change relay authentication or end-to-end encryption policy.

Nearby tests are [service environment planning](../../apps/cli/src/daemon/service/plan.releaseRingEnv.test.ts) and [Claude environment filtering](../../apps/cli/src/backends/claude/spawn/buildClaudeSubprocessEnv.test.ts). Neither asserts this CA key. No explicit `NODE_EXTRA_CA_CERTS`/`nodeExtraCaCerts` assertion was found in the inspected CLI tests; runtime TLS behavior remains unverified here.

## Commit coverage

| Commit | Current disposition |
| --- | --- |
| [b7423dbc01](https://github.com/yesyoukenspace/happier.happier-dev/commit/b7423dbc010a17ce95587dcd0ea0e9c1d0f52f6c) | Retained mobile CI target; remote preview Android build with APK publication requested. |
| [71ba29bcc5](https://github.com/yesyoukenspace/happier.happier-dev/commit/71ba29bcc5f1a3708c657bb36bf47d573ab29009) | Retained standalone local wrapper; separate from current rebuild activation. |
| [9353f3afe5](https://github.com/yesyoukenspace/happier.happier-dev/commit/9353f3afe5710abc387c11424f0fe05549a92f2d) | Retained Docker Android target, toolchain, context exclusions, and CA collector; comments are not build/trust guarantees. |
| [452c3222c6](https://github.com/yesyoukenspace/happier.happier-dev/commit/452c3222c6c51e83d0255ffe877b25cdc09da8c5) | Retained Nix shell, lock, direnv hook, and ignore rule. |
| [ff31ac60f6](https://github.com/yesyoukenspace/happier.happier-dev/commit/ff31ac60f6322bed867393792b2c860596a8f3f5) | Retained `cli:link`/`link:local`; original rebuild recipe superseded by e984228ef6. |
| [6fda385bac](https://github.com/yesyoukenspace/happier.happier-dev/commit/6fda385bacdcb02d683deef05692c55fcf8ef4a6) | Retained service-plan and Claude environment allowance; not an all-Agent propagation contract. |
| [e984228ef6](https://github.com/yesyoukenspace/happier.happier-dev/commit/e984228ef60efc5c0204b58d02a9709ec74041aa) | Current host-tool rebuild, checkout activation, explicit shim restart/status. Flake change corrects a comment; it adds no packages. |

## Related

- [Fork policy and documentation index](README.md)
- [CLI architecture](../cli-architecture.md) and [binary runtime](../binary-runtime.md)
- [Agent catalog ownership](../agents-catalog.md)

Validation boundary: this is a source-backed inventory. Builds, shell realization, service actions, TLS probes, device installation, and CI/release publication were not performed for this documentation. Linked tests are pointers to existing coverage, not claims that those tests ran or that these workflows passed.
