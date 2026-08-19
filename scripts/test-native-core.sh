#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/.build"
SOURCE_DIR="${BUILD_DIR}/VisualBoyAdvance-1.7.2"
OUTPUT="${BUILD_DIR}/vba172-native-test"
ROUNDTRIP="${BUILD_DIR}/roundtrip.sg1"
ROUNDTRIP_RAW="${BUILD_DIR}/roundtrip.bin"

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Run npm run build:core once to fetch the pinned VBA source." >&2
  exit 1
fi

SOURCES=(
  "${ROOT_DIR}/core/vba172_web.cpp"
  "${ROOT_DIR}/core/vba172_link.cpp"
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

clang++ -std=gnu++14 -O2 -fno-exceptions \
  -Wno-write-strings -Wno-c++11-narrowing -Wno-deprecated-declarations \
  -DFINAL_VERSION -DC_CORE -DVBA_NATIVE_TEST -I"${SOURCE_DIR}/src" \
  "${SOURCES[@]}" -lz -o "${OUTPUT}"

ROM="$(find "${ROOT_DIR}/data" -maxdepth 1 -type f -name '*.gba' -print -quit)"
STATE="$(find "${ROOT_DIR}/data" -maxdepth 1 -type f -name '*1.sg1' -print -quit)"
"${OUTPUT}" "${ROM}" "${STATE}" "${ROUNDTRIP}"
gzip -t "${ROUNDTRIP}"
gzip -dc "${ROUNDTRIP}" > "${ROUNDTRIP_RAW}"

HEADER="$(xxd -p -l 24 "${ROUNDTRIP_RAW}")"
[[ "${HEADER}" == 08000000504f4b454d4f4e20464952454250524500000000 ]]
echo "Native state roundtrip passed"

GB_ROM="${ROOT_DIR}/Red_K.gb"
GB_ROUNDTRIP="${BUILD_DIR}/roundtrip-gb.sg1"
GB_ROUNDTRIP_RAW="${BUILD_DIR}/roundtrip-gb.bin"
"${OUTPUT}" "${GB_ROM}" - "${GB_ROUNDTRIP}"
gzip -t "${GB_ROUNDTRIP}"
gzip -dc "${GB_ROUNDTRIP}" > "${GB_ROUNDTRIP_RAW}"
[[ "$(xxd -p -l 4 "${GB_ROUNDTRIP_RAW}")" == 0a000000 ]]
[[ "$(dd if="${GB_ROUNDTRIP_RAW}" bs=1 skip=4 count=11 2>/dev/null)" == "POKEMON RED" ]]
echo "Native GB state roundtrip passed"
