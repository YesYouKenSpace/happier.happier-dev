#!/usr/bin/env bash
# Collect the host's extra / corporate root CA(s) into one PEM bundle for the Docker Android
# build, so in-container HTTPS (nodejs.org, dl.google.com, yarn registry, Maven) works behind a
# TLS-inspecting proxy — vendor-agnostic (Zscaler / Netskope / Palo Alto / self-signed / MDM /
# mkcert / none). Writes an empty file when there's nothing to add (no-op on plain networks/CI).
#
# Sources merged (whichever exist), deduped:
#   1. macOS admin/corporate roots: the System keychain (where MDM/IT install corp CAs).
#   2. Any *.pem / *.crt a developer drops in docker/android/ca-certs/  (works on any OS).
#   3. $EXTRA_CA_CERTS — a file or directory of PEM/CRT certs.
#
# Usage: collect-ca-certs.sh <output.pem>
set -euo pipefail

OUT="${1:?usage: collect-ca-certs.sh <output.pem>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
: > "$TMP"

emit() { [ -s "$1" ] && cat "$1" >> "$TMP" || true; }

# 1) macOS admin/corporate root store (all vendors; no name filter = agnostic)
if command -v security >/dev/null 2>&1; then
  security find-certificate -a -p /Library/Keychains/System.keychain 2>/dev/null >> "$TMP" || true
fi

# 2) developer-provided certs (any OS)
if [ -d "${SCRIPT_DIR}/ca-certs" ]; then
  for f in "${SCRIPT_DIR}"/ca-certs/*.pem "${SCRIPT_DIR}"/ca-certs/*.crt; do emit "$f"; done
fi

# 3) EXTRA_CA_CERTS: a file or a directory
if [ -n "${EXTRA_CA_CERTS:-}" ]; then
  if [ -d "$EXTRA_CA_CERTS" ]; then
    for f in "$EXTRA_CA_CERTS"/*.pem "$EXTRA_CA_CERTS"/*.crt; do emit "$f"; done
  else
    emit "$EXTRA_CA_CERTS"
  fi
fi

# Keep only certificate blocks (drop any stray labels `security` prints), and write output.
if command -v awk >/dev/null 2>&1; then
  awk '/-----BEGIN CERTIFICATE-----/{c=1} c{print} /-----END CERTIFICATE-----/{c=0}' "$TMP" > "$OUT"
else
  cp "$TMP" "$OUT"
fi

count="$(grep -c -- '-----BEGIN CERTIFICATE-----' "$OUT" 2>/dev/null || true)"
echo "[collect-ca-certs] wrote ${count:-0} certificate(s) -> ${OUT}"
