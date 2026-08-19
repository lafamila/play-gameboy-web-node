#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/.build"
SOURCE_ARCHIVE="${BUILD_DIR}/VisualBoyAdvance-src-1.7.2.zip"
SOURCE_DIR="${BUILD_DIR}/VisualBoyAdvance-1.7.2"
OUTPUT_DIR="${ROOT_DIR}/core/dist"
EMSDK_DIR="${EMSDK_DIR:-${BUILD_DIR}/emsdk}"
SOURCE_URL="https://downloads.sourceforge.net/project/vba/VisualBoyAdvance/1.7.2/VisualBoyAdvance-src-1.7.2.zip"
SOURCE_SHA256="83e1b72433cb14e3a468575a13d5165a271dd24599ac30755fb5bc6d5727129a"
EMSDK_VERSION="4.0.15"

mkdir -p "${BUILD_DIR}" "${OUTPUT_DIR}"

if [[ ! -f "${SOURCE_ARCHIVE}" ]]; then
  curl -L "${SOURCE_URL}" -o "${SOURCE_ARCHIVE}"
fi

ACTUAL_SHA256="$(shasum -a 256 "${SOURCE_ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${SOURCE_SHA256}" ]]; then
  echo "Unexpected VisualBoyAdvance source checksum: ${ACTUAL_SHA256}" >&2
  exit 1
fi

if [[ ! -d "${SOURCE_DIR}" ]]; then
  unzip -q "${SOURCE_ARCHIVE}" -d "${BUILD_DIR}"
fi

# Modern Clang treats const-returning strrchr assignments from the 2004 source as errors.
perl -pi -e 's/^(\s*)char \* p = strrchr\(file,/$1const char * p = strrchr(file,/' "${SOURCE_DIR}/src/GBA.cpp"
node "${ROOT_DIR}/scripts/patch-vba172-source.mjs" "${SOURCE_DIR}"

if [[ ! -x "${EMSDK_DIR}/upstream/emscripten/em++" ]]; then
  if [[ ! -d "${EMSDK_DIR}/.git" ]]; then
    git clone --depth 1 https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
  fi
  "${EMSDK_DIR}/emsdk" install "${EMSDK_VERSION}"
  "${EMSDK_DIR}/emsdk" activate "${EMSDK_VERSION}"
fi

# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null

SOURCES=(
  "${ROOT_DIR}/core/vba172_web.cpp"
  "${ROOT_DIR}/core/vba172_util.cpp"
  "${SOURCE_DIR}/src/GBA.cpp"
  "${SOURCE_DIR}/src/Globals.cpp"
  "${SOURCE_DIR}/src/Gfx.cpp"
  "${SOURCE_DIR}/src/Mode0.cpp"
  "${SOURCE_DIR}/src/Mode1.cpp"
  "${SOURCE_DIR}/src/Mode2.cpp"
  "${SOURCE_DIR}/src/Mode3.cpp"
  "${SOURCE_DIR}/src/Mode4.cpp"
  "${SOURCE_DIR}/src/Mode5.cpp"
  "${SOURCE_DIR}/src/EEprom.cpp"
  "${SOURCE_DIR}/src/Flash.cpp"
  "${SOURCE_DIR}/src/RTC.cpp"
  "${SOURCE_DIR}/src/Sound.cpp"
  "${SOURCE_DIR}/src/Sram.cpp"
  "${SOURCE_DIR}/src/Cheats.cpp"
  "${SOURCE_DIR}/src/agbprint.cpp"
  "${SOURCE_DIR}/src/bios.cpp"
  "${SOURCE_DIR}/src/gb/GB.cpp"
  "${SOURCE_DIR}/src/gb/gbCheats.cpp"
  "${SOURCE_DIR}/src/gb/gbGfx.cpp"
  "${SOURCE_DIR}/src/gb/gbGlobals.cpp"
  "${SOURCE_DIR}/src/gb/gbMemory.cpp"
  "${SOURCE_DIR}/src/gb/gbPrinter.cpp"
  "${SOURCE_DIR}/src/gb/gbSGB.cpp"
  "${SOURCE_DIR}/src/gb/gbSound.cpp"
)

EXPORTS='["_malloc","_free","_vba_load_rom","_vba_run_frame","_vba_set_joypad","_vba_framebuffer","_vba_frame_stride","_vba_frame_width","_vba_frame_height","_vba_frame_counter","_vba_emulation_steps","_vba_load_state","_vba_export_state","_vba_load_battery","_vba_export_battery","_vba_export_data","_vba_export_size","_vba_audio_available","_vba_audio_total_samples","_vba_audio_read","_vba_last_error","_vba_state_version","_vba_shutdown"]'

em++ \
  -std=gnu++14 \
  -O3 \
  -fno-exceptions \
  -Wno-write-strings \
  -Wno-c++11-narrowing \
  -Wno-deprecated-declarations \
  -DFINAL_VERSION \
  -DC_CORE \
  -I"${SOURCE_DIR}/src" \
  "${SOURCES[@]}" \
  --no-entry \
  -sUSE_ZLIB=1 \
  -sFILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=5242880 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createVbaModule \
  -sENVIRONMENT=web \
  -sNO_EXIT_RUNTIME=1 \
  -sEXPORTED_FUNCTIONS="${EXPORTS}" \
  -sEXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPU8","HEAP16"]' \
  -o "${OUTPUT_DIR}/vba172.js"

cp -f "${SOURCE_ARCHIVE}" "${OUTPUT_DIR}/VisualBoyAdvance-src-1.7.2.zip"

echo "Built ${OUTPUT_DIR}/vba172.js and ${OUTPUT_DIR}/vba172.wasm"
