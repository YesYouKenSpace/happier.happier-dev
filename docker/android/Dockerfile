# syntax=docker/dockerfile:1.7
# Reproducible LOCAL Android APK build for apps/ui (Expo SDK 54 / RN 0.81.5).
#
# Mirrors .github/workflows/build-android-debug.yml but runs entirely in a container so no
# JDK / Android SDK / NDK is installed on the host. Toolchain: Node 22 + Temurin JDK 17 +
# Android SDK 36 + NDK 27.1.12297006 + CMake 3.22.1, then `expo prebuild` + gradle.
#
# MUST run as linux/amd64: Google ships the Android NDK/build-tools as x86_64-Linux only, so on
# Apple Silicon this image runs under Docker Desktop's Rosetta/QEMU emulation. Device code is
# cross-compiled to the requested ABI (default arm64-v8a) regardless of build-host arch.
#
# Build (from repo root) — see `make apk.docker`:
#   DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -f docker/android/Dockerfile \
#     --build-arg BUILD_VARIANT=release --output type=local,dest=apps/ui/dist/apk .
#   -> release: apps/ui/dist/apk/release/app-release.apk   (minified, JS-bundled, debug-key signed → standalone)
#   -> debug:   apps/ui/dist/apk/debug/app-debug.apk       (needs a Metro dev server; requires ~12GB Docker RAM)

# Node >= 22.12 is required: expo config plugins (react-native-enriched-markdown) use
# require() of ES modules, which is only enabled by default from 22.12 onward (CI uses 22.x latest).
ARG NODE_VERSION=22.23.1
ARG JDK_IMAGE=eclipse-temurin:17-jdk-jammy
ARG APP_ENV=development
ARG BUILD_VARIANT=release
ARG GRADLE_HEAP=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8
ARG ANDROID_BUILD_ARCHS=arm64-v8a
# CPU affinity list for the gradle/native build. Caps how many clang jobs ninja runs in
# parallel so peak RAM fits a modest (~8GB) Docker VM under emulation. Widen on bigger hosts.
ARG GRADLE_CPUS=0-3

# ---------------------------------------------------------------------------
# Stage: toolchain — JDK + Node + Yarn + Android SDK/NDK/CMake (rarely changes)
# ---------------------------------------------------------------------------
FROM ${JDK_IMAGE} AS toolchain
ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip bzip2 git ca-certificates openssh-client xz-utils python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Corporate TLS-inspection trust (vendor-agnostic). `make apk.docker` collects the host's extra
# root CA(s) — any corporate proxy/MDM/self-signed CA, or dev-provided certs — into
# docker/android/local-ca-certs.pem (see collect-ca-certs.sh). The bundle may hold MANY certs, so
# split it one-per-file: update-ca-certificates and keytool each only ingest a single cert per
# file. Trust them in BOTH the system store and the JDK cacerts (Java/gradle use a separate
# truststore) so in-container HTTPS (nodejs.org, dl.google.com SDK/NDK, yarn, Maven) validates.
# Empty bundle on hosts without extra CAs -> no-op.
COPY docker/android/local-ca-certs.pem /tmp/local-ca-certs.pem
RUN set -eux; \
    cp /tmp/local-ca-certs.pem /usr/local/share/ca-certificates/local-extra-bundle.pem; \
    if [ -s /tmp/local-ca-certs.pem ]; then \
      csplit -z -s -f /usr/local/share/ca-certificates/local-extra- -b '%03d.crt' \
        /tmp/local-ca-certs.pem '/-----BEGIN CERTIFICATE-----/' '{*}'; \
      update-ca-certificates; \
      for c in /usr/local/share/ca-certificates/local-extra-*.crt; do \
        [ -f "$c" ] || continue; \
        keytool -importcert -noprompt -trustcacerts -alias "extra-$(basename "$c" .crt)" \
          -file "$c" -keystore "$JAVA_HOME/lib/security/cacerts" -storepass changeit 2>/dev/null || true; \
      done; \
    fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/local-extra-bundle.pem \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

ARG NODE_VERSION
RUN set -eux; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    corepack enable; \
    corepack prepare yarn@1.22.22 --activate; \
    node -v; yarn -v

ARG ANDROID_CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0
ARG ANDROID_NDK=27.1.12297006
ARG ANDROID_CMAKE=3.22.1
ENV PATH="/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}"
RUN set -eux; \
    mkdir -p ${ANDROID_HOME}/cmdline-tools; \
    curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" -o /tmp/ct.zip; \
    unzip -q /tmp/ct.zip -d ${ANDROID_HOME}/cmdline-tools; \
    rm /tmp/ct.zip; \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest; \
    yes | sdkmanager --licenses >/dev/null; \
    sdkmanager --install \
      "platform-tools" \
      "platforms;${ANDROID_PLATFORM}" \
      "build-tools;${ANDROID_BUILD_TOOLS}" \
      "ndk;${ANDROID_NDK}" \
      "cmake;${ANDROID_CMAKE}" >/dev/null; \
    sdkmanager --list_installed

# ---------------------------------------------------------------------------
# Stage: build — install workspace deps, prebuild native project, gradle APK
# ---------------------------------------------------------------------------
FROM toolchain AS build
WORKDIR /workspace
ARG APP_ENV
ARG BUILD_VARIANT
ARG GRADLE_HEAP
ARG ANDROID_BUILD_ARCHS
ENV YARN_CACHE_FOLDER=/root/.cache/yarn

COPY . .

# Clean install in-container (host node_modules are macOS-native and are dockerignored).
RUN --mount=type=cache,target=/root/.cache/yarn,sharing=locked \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    yarn install --frozen-lockfile --ignore-engines --network-timeout 600000 --non-interactive

# Build first-party @happier-dev/* workspace packages that apps/ui depends on.
RUN yarn --cwd apps/ui ensure:workspace:built

# Prebuild the native Android project, then assemble the APK.
# HAPPIER_ANDROID_GRADLE_JVMARGS is applied at prebuild (app.config.js -> withAndroidReleaseShrinker
# writes org.gradle.jvmargs) so D8 dex-merge does not OOM. Release enables minify+shrink (smaller
# dex, fits low-RAM Docker VMs) and bundles JS so the APK runs standalone.
# ARG declared here (not with the other build args) so it does not invalidate the cached install layers.
ARG GRADLE_CPUS
RUN --mount=type=cache,target=/root/.gradle,sharing=locked <<'BUILD'
set -eux
export EXPO_UNSTABLE_WEB_MODAL=1
export APP_ENV="${APP_ENV}"
export HAPPIER_ANDROID_BUILD_ARCHS="${ANDROID_BUILD_ARCHS}"
export HAPPIER_ANDROID_GRADLE_JVMARGS="${GRADLE_HEAP}"
# A local/CI build has no Sentry auth token and does not need source-map upload; skip it
# (otherwise the release SentryUpload task fails: "Auth token is required for this request").
export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_ALLOW_FAILURE=true
if [ "${BUILD_VARIANT}" = "release" ]; then
  export HAPPIER_ANDROID_ENABLE_MINIFY=1
  export HAPPIER_ANDROID_ENABLE_SHRINK_RESOURCES=1
fi
yarn --cwd apps/ui prebuild
cd apps/ui/android
# taskset caps CPU affinity so ninja/AGP run ~N parallel clang jobs (peak RAM) — keeps the
# native compile within a modest Docker VM instead of OOM-killing the gradle daemon.
if [ "${BUILD_VARIANT}" = "release" ]; then
  taskset -c "${GRADLE_CPUS}" ./gradlew :app:assembleRelease -x lintVitalRelease -x lintVitalAnalyzeRelease \
    --no-daemon --stacktrace -Dorg.gradle.workers.max=1
else
  taskset -c "${GRADLE_CPUS}" ./gradlew :app:assembleDebug \
    --no-daemon --stacktrace -Dorg.gradle.workers.max=1
fi
ls -la app/build/outputs/apk/*/
BUILD

# ---------------------------------------------------------------------------
# Stage: export — emit just the APK(s) to the host via --output type=local
# ---------------------------------------------------------------------------
FROM scratch AS export
COPY --from=build /workspace/apps/ui/android/app/build/outputs/apk/ /
