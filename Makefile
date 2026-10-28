.PHONY: apk.docker cli.rebuild cli.install test-public-sharing

HAPPIER_BIN := $(HOME)/.happier-stack/bin/happier

gh.ci.mobile.build:
	gh workflow run build-ui-mobile-local.yml \
		-f environment=preview \
		-f platform=android \
		-f profile=preview-apk \
		-f action=build_only \
		-f publish_apk_release=true \
		-f source_ref=dev

# Build an installable Android APK locally in Docker (no host JDK/SDK/NDK).
# Runs as linux/amd64 (Rosetta/QEMU) because the Android NDK is x86_64-Linux only.
#   Vars: APP_ENV=development|preview|production  BUILD_VARIANT=release|debug
#         GRADLE_HEAP=...  ANDROID_BUILD_ARCHS=arm64-v8a[,armeabi-v7a,...]
#   release (default): minified + JS-bundled + debug-key signed -> standalone, fits ~8GB Docker VM
#     -> apps/ui/dist/apk/release/app-release.apk
#   debug: needs a Metro dev server to run; use BUILD_VARIANT=debug + raise Docker RAM to ~12GB
#     -> apps/ui/dist/apk/debug/app-debug.apk
APP_ENV ?= development
BUILD_VARIANT ?= release
GRADLE_HEAP ?= -Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8
ANDROID_BUILD_ARCHS ?= arm64-v8a
GRADLE_CPUS ?= 0-3
apk.docker:
	@echo ">> collecting host corporate root CA(s) for the container (vendor-agnostic) ..."
	@bash docker/android/collect-ca-certs.sh docker/android/local-ca-certs.pem || touch docker/android/local-ca-certs.pem
	DOCKER_BUILDKIT=1 docker build \
		--platform linux/amd64 \
		-f docker/android/Dockerfile \
		--build-arg APP_ENV=$(APP_ENV) \
		--build-arg BUILD_VARIANT=$(BUILD_VARIANT) \
		--build-arg GRADLE_HEAP="$(GRADLE_HEAP)" \
		--build-arg ANDROID_BUILD_ARCHS=$(ANDROID_BUILD_ARCHS) \
		--build-arg GRADLE_CPUS=$(GRADLE_CPUS) \
		--output type=local,dest=apps/ui/dist/apk \
		.

# Rebuild the local CLI and refresh both runtime outputs, then restart the daemon.
# WHY: `yarn cli:build` rebuilds only dist/ (used by the interactive `happier`
# wrapper) plus shared deps like @happier-dev/protocol. The launchd daemon runs a
# SEPARATE bundle, apps/cli/package-dist/, which build.mjs never syncs. So a bare
# rebuild leaves the daemon on a stale bundle; once a shared dep's exports change,
# the daemon crash-loops at ESM load and `happier service start` hangs forever.
# This target runs the missing syncPackageDist step and restarts the daemon, so the
# interactive CLI and daemon always run the same fresh code. This also ensures the
# local shim exists, but does not edit shell startup files.
cli.rebuild:
	@echo ">> building CLI (dist/ + shared deps) ..."
	yarn cli:build
	@echo ">> syncing package-dist/ (daemon bundle) — the step 'yarn cli:build' skips ..."
	node apps/cli/scripts/syncPackageDist.mjs
	@echo ">> ensuring local happier CLI shim ..."
	yarn cli:activate:path
	@echo ">> restarting daemon service ..."
	$(HAPPIER_BIN) service restart
	$(HAPPIER_BIN) service status

.PHONY: test-protocol test-cli test-ui test-server test-server-integration typecheck test-all

TEST_FILES ?=
WORKSPACE ?= @happier-dev/protocol

test-protocol:
	yarn workspace @happier-dev/protocol test $(TEST_FILES) --maxWorkers=2

test-cli:
	yarn --cwd apps/cli vitest run --config vitest.config.ts $(TEST_FILES) --maxWorkers=2

test-ui:
	yarn --cwd apps/ui vitest run --config vitest.config.ts $(TEST_FILES) --maxWorkers=2

test-server:
	yarn --cwd apps/server test:unit $(TEST_FILES) --maxWorkers=2

test-server-integration:
	yarn --cwd apps/server test:integration $(TEST_FILES) --maxWorkers=2

typecheck:
	yarn workspace $(WORKSPACE) typecheck

test-all:
	yarn test

test-public-sharing:
	yarn --cwd apps/ui vitest run sources/sync/domains/features sources/hooks/server/useFeature sources/sync/domains/social sources/sync/api/social sources/sync/encryption/publicShareEncryption.test.ts sources/components/sessions/sharing sources/__tests__/app/share "sources/__tests__/routes/(app)/session/[id]/sharing.permission.test.tsx" "sources/__tests__/routes/(app)/session/[id]/sharing.publicFeature.test.tsx"
	yarn --cwd apps/ui typecheck

# Malicious-relay regression gate for authenticated owner-session DEKs.
# Every suite below must stay green: each covers a relay-substitution, transplant,
# replay, wrong-account, or downgrade attack that the strict cutover must reject.
# UI typecheck is intentionally excluded: it fails on pre-existing third-party
# drift (markdown/legendList components) unrelated to this corridor; the UI suites
# below are the enforced contract instead.
test-security:
	yarn workspace @happier-dev/protocol vitest run src/crypto/ownerSessionDataKeyEnvelope.test.ts
	yarn workspace @happier-dev/protocol typecheck
	yarn workspace @happier-dev/cli vitest run src/api/api.sessionDataEncryptionKey.test.ts src/api/client/encryptionKey.test.ts src/api/client/openSessionDataEncryptionKey.test.ts src/session/services/resolveSessionTransportContext.test.ts src/cli/output/session/sessionSummary.test.ts src/cli/commands/attach.test.ts src/cli/commands/resume.test.ts src/api/api.test.ts src/api/session/snapshotSync.test.ts src/daemon/automation/automationPendingQueueClient.test.ts src/session/transport/encryption/sessionEncryptionContext.plaintext.test.ts
	yarn workspace @happier-dev/cli typecheck
	PRISMA_QUERY_ENGINE_LIBRARY=$$(pwd)/apps/server/generated/sqlite-client/libquery_engine.so.node PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 yarn workspace @happier-dev/server vitest run --isolate -c vitest.integration.config.ts sources/app/api/routes/session/sessionRoutes.createRegister.sqlite.integration.spec.ts
	yarn --cwd apps/ui vitest run sources/sync/runtime/orchestration/serverScopedRpc/scopedDataKeySingleFlight.test.ts sources/sync/sync.clientEncryptionRequirement.test.ts sources/sync/engine/pending/pendingQueueV2.errorHandling.test.ts sources/sync/encryption/sessionDataKeyHydration.test.ts sources/sync/engine/sessions/sessionSnapshot.replacementCoverage.test.ts sources/sync/engine/socket/socket.updateSession.plaintext.test.ts
