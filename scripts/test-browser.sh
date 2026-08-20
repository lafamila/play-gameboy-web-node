#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_DIR="${ROOT_DIR}/.build/core-probe"
cleanup() { rm -rf "${PROBE_DIR}"; }
trap cleanup EXIT
cleanup
VBA_LINK_TEST_PROBE=1 VBA_CORE_OUTPUT_DIR="${PROBE_DIR}" bash "${ROOT_DIR}/scripts/build-core.sh"
export CORE_STORAGE_DIR="${PROBE_DIR}"
node "${ROOT_DIR}/scripts/test-browser.mjs"
