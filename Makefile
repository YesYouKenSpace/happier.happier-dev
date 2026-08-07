.PHONY: apk.docker cli.rebuild

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

# Rebuild the local CLI and refresh BOTH runtime outputs, then restart the daemon.
# WHY: `yarn cli:build` rebuilds only dist/ (used by the interactive `happier`
# wrapper) plus shared deps like @happier-dev/protocol. The launchd daemon runs a
# SEPARATE bundle, apps/cli/package-dist/, which build.mjs never syncs. So a bare
# rebuild leaves the daemon on a stale bundle; once a shared dep's exports change,
# the daemon crash-loops at ESM load and `happier service start` hangs forever.
# This target runs the missing syncPackageDist step and restarts the daemon, so the
# interactive CLI and the daemon always run the same fresh code.
#   Override the node pin (e.g. no mise): make cli.rebuild NODE24=
NODE24 ?= mise exec node@24 --
cli.rebuild:
	@echo ">> building CLI (dist/ + shared deps) ..."
	$(NODE24) yarn cli:build
	@echo ">> syncing package-dist/ (daemon bundle) — the step 'yarn cli:build' skips ..."
	$(NODE24) node apps/cli/scripts/syncPackageDist.mjs
	@echo ">> restarting daemon service ..."
	happier service restart
	@happier service status
