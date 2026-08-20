// VisualBoyAdvance 1.7.2 browser bridge.
// The linked emulator core is GPL-2.0-or-later; see THIRD_PARTY_NOTICES.md.

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "GBA.h"
#include "Globals.h"
#include "Sound.h"
#include "gb/GB.h"
#include "gb/gbGlobals.h"
#include "vba172_link.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define VBA_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define VBA_EXPORT
#endif

namespace {

constexpr int kGbaScreenWidth = 240;
constexpr int kGbaScreenHeight = 160;
constexpr int kGbaFrameStride = 241;
constexpr int kGbScreenWidth = 160;
constexpr int kGbScreenHeight = 144;
constexpr int kAudioCapacity = 1 << 18;
#ifdef __EMSCRIPTEN__
constexpr const char* kGbaRomPath = "/game.gba";
constexpr const char* kGbRomPath = "/game.gb";
constexpr const char* kStatePath = "/state.sg1";
constexpr const char* kBatteryPath = "/battery.sa1";
#else
constexpr const char* kGbaRomPath = "/private/tmp/vba172-game.gba";
constexpr const char* kGbRomPath = "/private/tmp/vba172-game.gb";
constexpr const char* kStatePath = "/private/tmp/vba172-state.sg1";
constexpr const char* kBatteryPath = "/private/tmp/vba172-battery.sa1";
#endif

uint32_t g_joypad = 0;
uint64_t g_frame_counter = 0;
uint64_t g_emulation_steps = 0;
std::string g_last_error;
std::vector<uint8_t> g_export_buffer;
int16_t g_audio_ring[kAudioCapacity];
int g_audio_read = 0;
int g_audio_write = 0;
int g_audio_count = 0;
uint64_t g_audio_total = 0;
int g_state_audio_quality = 1;
bool g_loaded = false;
int g_system = -1;
EmulatedSystem* g_emulator = nullptr;

bool WriteFile(const char* path, const uint8_t* data, int size) {
  FILE* file = fopen(path, "wb");
  if (!file) {
    g_last_error = std::string("Cannot open ") + path + " for writing";
    return false;
  }
  const bool ok = size >= 0 &&
                  fwrite(data, 1, static_cast<size_t>(size), file) ==
                      static_cast<size_t>(size);
  fclose(file);
  if (!ok) {
    g_last_error = std::string("Cannot write ") + path;
  }
  return ok;
}

bool ReadFile(const char* path) {
  FILE* file = fopen(path, "rb");
  if (!file) {
    g_last_error = std::string("Cannot open ") + path + " for reading";
    return false;
  }
  fseek(file, 0, SEEK_END);
  const long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  if (size < 0) {
    fclose(file);
    g_last_error = std::string("Cannot size ") + path;
    return false;
  }
  g_export_buffer.resize(static_cast<size_t>(size));
  const bool ok = fread(g_export_buffer.data(), 1, g_export_buffer.size(), file) ==
                  g_export_buffer.size();
  fclose(file);
  if (!ok) {
    g_last_error = std::string("Cannot read ") + path;
  }
  return ok;
}

void ResetAudio() {
  g_audio_read = 0;
  g_audio_write = 0;
  g_audio_count = 0;
  std::fill(std::begin(g_audio_ring), std::end(g_audio_ring), 0);
}

void PushAudio(const int16_t* samples, int count) {
  g_audio_total += static_cast<uint64_t>(count);
  for (int i = 0; i < count; ++i) {
    if (g_audio_count == kAudioCapacity) {
      g_audio_read = (g_audio_read + 1) % kAudioCapacity;
      --g_audio_count;
    }
    g_audio_ring[g_audio_write] = samples[i];
    g_audio_write = (g_audio_write + 1) % kAudioCapacity;
    ++g_audio_count;
  }
}

void ConfigureColorMap() {
  systemColorDepth = 32;
  systemRedShift = 0;
  systemGreenShift = 8;
  systemBlueShift = 16;
  for (int color = 0; color < 0x10000; ++color) {
    const uint8_t red5 = color & 0x1f;
    const uint8_t green5 = (color >> 5) & 0x1f;
    const uint8_t blue5 = (color >> 10) & 0x1f;
    const uint8_t red = (red5 << 3) | (red5 >> 2);
    const uint8_t green = (green5 << 3) | (green5 >> 2);
    const uint8_t blue = (blue5 << 3) | (blue5 >> 2);
    systemColorMap32[color] = 0xff000000u | (static_cast<uint32_t>(blue) << 16) |
                              (static_cast<uint32_t>(green) << 8) | red;
    systemColorMap16[color] = static_cast<uint16_t>(
        ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3));
  }
}

void ConfigureGbPalette() {
  for (int index = 0; index < 24;) {
    systemGbPalette[index++] = (0x1f) | (0x1f << 5) | (0x1f << 10);
    systemGbPalette[index++] = (0x15) | (0x15 << 5) | (0x15 << 10);
    systemGbPalette[index++] = (0x0c) | (0x0c << 5) | (0x0c << 10);
    systemGbPalette[index++] = 0;
  }
}

void ShutdownLoaded() {
  if (!g_loaded || !g_emulator) return;
  soundShutdown();
  g_emulator->emuCleanUp();
  g_loaded = false;
  g_emulator = nullptr;
  g_system = -1;
  emulating = 0;
  vbaLinkReset();
}

}  // namespace

int emulating = 0;
bool systemSoundOn = true;
uint16_t systemColorMap16[0x10000];
uint32_t systemColorMap32[0x10000];
uint16_t systemGbPalette[24];
int systemRedShift = 0;
int systemGreenShift = 8;
int systemBlueShift = 16;
int systemColorDepth = 32;
int systemDebug = 0;
int systemVerbose = 0;
int systemFrameSkip = 0;
int systemSaveUpdateCounter = SYSTEM_SAVE_NOT_UPDATED;
void (*dbgOutput)(char*, uint32_t) = nullptr;

void winlog(const char*, ...) {}
void log(const char*, ...) {}
bool systemPauseOnFrame() { return false; }
void systemGbPrint(uint8_t*, int, int, int, int) {}
void systemScreenCapture(int) {}
void systemDrawScreen() { ++g_frame_counter; }
bool systemReadJoypads() { return true; }
uint32_t systemReadJoypad(int) { return g_joypad; }
uint32_t systemGetClock() { return 0; }

void systemMessage(int, const char* message, ...) {
  char buffer[1024];
  va_list args;
  va_start(args, message);
  vsnprintf(buffer, sizeof(buffer), message, args);
  va_end(args);
  g_last_error = buffer;
}

void systemSetTitle(const char*) {}

void systemWriteDataToSoundBuffer() {
  PushAudio(reinterpret_cast<const int16_t*>(soundFinalWave), soundBufferLen / 2);
}

void systemSoundShutdown() { systemSoundOn = false; }
void systemSoundPause() {}
void systemSoundResume() {}
void systemSoundReset() { ResetAudio(); }
bool systemSoundInit() {
  systemSoundOn = true;
  ResetAudio();
  return true;
}
void systemScreenMessage(const char*) {}
void systemUpdateMotionSensor() {}
int systemGetSensorX() { return 2047; }
int systemGetSensorY() { return 2047; }
bool systemCanChangeSoundQuality() { return true; }
void systemShowSpeed(int) {}
void system10Frames(int) {}
void systemFrame() {}
void systemGbBorderOn() {}

// The POC accepts raw .gba files only, so ELF debug data is intentionally absent.
bool elfRead(const char*, int&, FILE*) { return false; }
void elfCleanUp() {}

extern "C" {

VBA_EXPORT int vba_load_rom(const uint8_t* data, int size, int system) {
  g_last_error.clear();
  const char* romPath = system == 1 ? kGbRomPath : kGbaRomPath;
  std::remove(romPath);
  std::remove(kStatePath);
  std::remove(kBatteryPath);
  if (!data || size < 0x150 || (system != 0 && system != 1) ||
      !WriteFile(romPath, data, size)) {
    if (g_last_error.empty()) g_last_error = "Invalid ROM payload";
    return 0;
  }
  ShutdownLoaded();
  vbaLinkReset();
  ConfigureColorMap();
  if (system == 0) {
    if (!CPULoadRom(romPath)) {
      if (g_last_error.empty()) g_last_error = "VisualBoyAdvance rejected the GBA ROM";
      return 0;
    }
    CPUInit(nullptr, false);
    flashSetSize(0x20000);
    CPUReset();
    soundSetQuality(1);
    g_emulator = &GBASystem;
  } else {
    ConfigureGbPalette();
    gbEmulatorType = 1;
    gbBorderOn = 0;
    gbBorderAutomatic = 0;
    gbFrameSkip = 0;
    if (!gbLoadRom(romPath)) {
      if (g_last_error.empty()) g_last_error = "VisualBoyAdvance rejected the GB ROM";
      return 0;
    }
    gbSoundSetQuality(1);
    g_emulator = &GBSystem;
  }
  if (!soundInit()) {
    g_last_error = "Audio initialization failed";
    g_emulator->emuCleanUp();
    g_emulator = nullptr;
    return 0;
  }
  g_frame_counter = 0;
  g_emulation_steps = 0;
  g_audio_total = 0;
  g_state_audio_quality = 1;
  g_joypad = 0;
  g_loaded = true;
  g_system = system;
  emulating = 1;
  return 1;
}

VBA_EXPORT int vba_run_frame() {
  if (!g_loaded) return 0;
  if (vbaLinkWaiting() || vbaLinkGuestHeld()) return 2;
  const uint64_t target = g_frame_counter + 1;
  for (int attempt = 0; attempt < 4 && g_frame_counter < target; ++attempt) {
    g_emulator->emuMain(g_emulator->emuCount);
    ++g_emulation_steps;
    if (vbaLinkWaiting() || vbaLinkGuestHeld()) return 2;
  }
  return g_frame_counter >= target ? 1 : 0;
}

VBA_EXPORT void vba_set_joypad(uint32_t buttons) { g_joypad = buttons; }

VBA_EXPORT const uint8_t* vba_framebuffer() {
  if (!g_loaded || !pix) return nullptr;
  if (g_system == 1) {
    const int stride = gbBorderLineSkip + 1;
    return pix + sizeof(uint32_t) *
      (stride * (gbBorderRowSkip + 1) + gbBorderColumnSkip);
  }
  return pix + sizeof(uint32_t) * kGbaFrameStride;
}

VBA_EXPORT int vba_frame_stride() {
  return g_system == 1 ? gbBorderLineSkip + 1 : kGbaFrameStride;
}
VBA_EXPORT int vba_frame_width() { return g_system == 1 ? kGbScreenWidth : kGbaScreenWidth; }
VBA_EXPORT int vba_frame_height() { return g_system == 1 ? kGbScreenHeight : kGbaScreenHeight; }
VBA_EXPORT uint64_t vba_frame_counter() { return g_frame_counter; }
VBA_EXPORT uint64_t vba_emulation_steps() { return g_emulation_steps; }

VBA_EXPORT int vba_load_state(const uint8_t* data, int size) {
  g_last_error.clear();
  if (!g_loaded || !data || size <= 0 || !WriteFile(kStatePath, data, size)) {
    if (g_last_error.empty()) g_last_error = "No ROM loaded or invalid state";
    return 0;
  }
  const int result = g_emulator->emuReadState(kStatePath) ? 1 : 0;
  if (!result && g_last_error.empty()) g_last_error = "State load failed";
  if (result && g_system == 0) {
    g_state_audio_quality = soundQuality;
    soundSetQuality(1);
    soundTicks = SOUND_CLOCK_TICKS;
  }
  ResetAudio();
  return result;
}

VBA_EXPORT int vba_export_state() {
  g_last_error.clear();
  g_export_buffer.clear();
  std::remove(kStatePath);
  if (!g_loaded || !g_emulator->emuWriteState(kStatePath) || !ReadFile(kStatePath)) {
    if (g_last_error.empty()) g_last_error = "State export failed";
    return 0;
  }
  return 1;
}

VBA_EXPORT int vba_load_battery(const uint8_t* data, int size) {
  g_last_error.clear();
  if (!g_loaded || !data || size <= 0 || !WriteFile(kBatteryPath, data, size)) {
    if (g_last_error.empty()) g_last_error = "No ROM loaded or invalid battery save";
    return 0;
  }
  const int result = g_emulator->emuReadBattery(kBatteryPath) ? 1 : 0;
  if (!result && g_last_error.empty()) g_last_error = "Battery save load failed";
  return result;
}

VBA_EXPORT int vba_export_battery() {
  g_last_error.clear();
  g_export_buffer.clear();
  std::remove(kBatteryPath);
  if (!g_loaded || !g_emulator->emuWriteBattery(kBatteryPath) || !ReadFile(kBatteryPath)) {
    if (g_last_error.empty()) g_last_error = "Battery save export failed";
    return 0;
  }
  return 1;
}

VBA_EXPORT const uint8_t* vba_export_data() {
  return g_export_buffer.empty() ? nullptr : g_export_buffer.data();
}

VBA_EXPORT int vba_export_size() {
  return static_cast<int>(g_export_buffer.size());
}

VBA_EXPORT int vba_audio_available() { return g_audio_count; }
VBA_EXPORT uint64_t vba_audio_total_samples() { return g_audio_total; }
VBA_EXPORT int vba_audio_quality() { return g_system == 0 ? soundQuality : 1; }
VBA_EXPORT int vba_state_audio_quality() { return g_state_audio_quality; }

VBA_EXPORT int vba_audio_read(int16_t* output, int max_samples) {
  if (!output || max_samples <= 0) return 0;
  const int count = std::min(max_samples, g_audio_count);
  for (int i = 0; i < count; ++i) {
    output[i] = g_audio_ring[g_audio_read];
    g_audio_read = (g_audio_read + 1) % kAudioCapacity;
  }
  g_audio_count -= count;
  return count;
}

VBA_EXPORT const char* vba_last_error() { return g_last_error.c_str(); }

VBA_EXPORT int vba_state_version() { return g_system == 1 ? 10 : SAVE_GAME_VERSION; }

VBA_EXPORT int vba_link_set_player(int player_id) {
  if (!g_loaded || g_system != 0) return 0;
  return vbaLinkSetPlayer(player_id);
}
VBA_EXPORT int vba_link_player() { return vbaLinkPlayer(); }
VBA_EXPORT int vba_link_waiting() { return vbaLinkWaiting(); }
VBA_EXPORT int vba_link_transfer_active() { return vbaLinkTransferActive(); }
VBA_EXPORT int vba_link_request_pending() { return vbaLinkRequestPending(); }
VBA_EXPORT int vba_link_request_sequence() { return vbaLinkRequestSequence(); }
VBA_EXPORT int vba_link_request_speed() { return vbaLinkRequestSpeed(); }
VBA_EXPORT int vba_link_request_data() { return vbaLinkRequestData(); }
VBA_EXPORT int vba_link_request_ticks() { return vbaLinkRequestTicks(); }
VBA_EXPORT int vba_link_guest_held() { return vbaLinkGuestHeld(); }
VBA_EXPORT int vba_link_time() { return linktime; }
VBA_EXPORT int vba_link_siocnt() {
  return ioMem ? READ16LE(&ioMem[0x128]) : -1;
}
VBA_EXPORT int vba_link_siodata8() {
  return ioMem ? READ16LE(&ioMem[0x12a]) : -1;
}
VBA_EXPORT int vba_link_prepare_remote(int sequence, int speed, int master_data,
                                      int transfer_ticks) {
  return vbaLinkPrepareRemote(sequence, speed, master_data, transfer_ticks);
}
VBA_EXPORT int vba_link_apply_pair(int sequence, int speed, int master_data,
                                  int slave_data) {
  return vbaLinkApplyPair(sequence, speed, master_data, slave_data);
}
VBA_EXPORT void vba_link_cancel_wait() { vbaLinkCancelWait(); }

VBA_EXPORT void vba_shutdown() {
  ShutdownLoaded();
}

}  // extern "C"

#ifdef VBA_NATIVE_TEST
bool RunNativeLinkProbe() {
  if (!vba_link_set_player(0)) {
    fprintf(stderr, "LINK probe configure failed\n");
    return false;
  }
  WRITE16LE(&ioMem[0x134], 0);
  WRITE16LE(&ioMem[0x12a], 0x1234);
  StartLink(0x6083);
  if (!vba_link_request_pending() || !vba_link_waiting() ||
      vba_link_request_sequence() != 0 || vba_link_request_speed() != 3 ||
      vba_link_request_data() != 0x1234 || vba_link_request_ticks() != 0) {
    fprintf(stderr, "LINK probe request=%d wait=%d seq=%d speed=%d data=%04x\n",
            vba_link_request_pending(), vba_link_waiting(),
            vba_link_request_sequence(), vba_link_request_speed(),
            vba_link_request_data());
    return false;
  }
  if (!vba_link_apply_pair(0, 3, 0x1234, 0xabcd)) {
    fprintf(stderr, "LINK probe pair failed\n");
    return false;
  }
  linktime = 100000;
  LinkUpdate();
  const bool passed = !vba_link_transfer_active() && !vba_link_waiting() &&
                      READ16LE(&ioMem[0x120]) == 0x1234 &&
                      READ16LE(&ioMem[0x122]) == 0xabcd;
  if (!passed) {
    fprintf(stderr, "LINK probe active=%d wait=%d data=%04x/%04x\n",
            vba_link_transfer_active(), vba_link_waiting(),
            READ16LE(&ioMem[0x120]), READ16LE(&ioMem[0x122]));
  }
  if (!passed || !vba_link_set_player(-1) || !vba_link_set_player(1)) return false;

  WRITE16LE(&ioMem[0x12a], 0xabcd);
  if (vba_link_prepare_remote(0, 3, 0x1234, 0) != 0xabcd) {
    fprintf(stderr, "LINK guest first transfer failed\n");
    return false;
  }
  StartLink(0x6083);
  if (!(READ16LE(&ioMem[0x128]) & 0x80) ||
      !vba_link_apply_pair(0, 3, 0x1234, 0xabcd)) {
    fprintf(stderr, "LINK guest transfer start bit was not preserved\n");
    return false;
  }
  linktime = 100000;
  LinkUpdate();
  if (vba_link_guest_held()) {
    fprintf(stderr, "LINK guest held before serial response write\n");
    return false;
  }
  WriteLinkData(0xabcd);
  if (!vba_link_guest_held()) {
    fprintf(stderr, "LINK guest was not held after serial response write\n");
    return false;
  }
  linktime = 1000;
  if (vba_link_prepare_remote(1, 3, 0x5678, 2000) != -2 || vba_link_waiting()) {
    fprintf(stderr, "LINK guest accepted transfer before scheduled tick\n");
    return false;
  }
  linktime = 2500;
  LinkUpdate();
  if (vba_link_prepare_remote(1, 3, 0x5678, 2000) != 0xabcd ||
      !vba_link_waiting() || linktime != 500) {
    fprintf(stderr, "LINK guest scheduled transfer failed wait=%d ticks=%d\n",
            vba_link_waiting(), linktime);
    return false;
  }
  StartLink(0x6003);
  if (READ16LE(&ioMem[0x128]) & 0x80) {
    fprintf(stderr, "LINK guest forced an unrequested transfer start bit\n");
    return false;
  }
  vba_link_cancel_wait();
  return vba_link_set_player(-1);
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: vba172-test ROM STATE|- [OUTPUT]\n");
    return 2;
  }
  FILE* rom_file = fopen(argv[1], "rb");
  fseek(rom_file, 0, SEEK_END);
  const long rom_size = ftell(rom_file);
  fseek(rom_file, 0, SEEK_SET);
  std::vector<uint8_t> rom_data(static_cast<size_t>(rom_size));
  fread(rom_data.data(), 1, rom_data.size(), rom_file);
  fclose(rom_file);
  const std::string romPath = argv[1];
  const bool isGb =
    (romPath.size() >= 3 && romPath.compare(romPath.size() - 3, 3, ".gb") == 0) ||
    (romPath.size() >= 4 && romPath.compare(romPath.size() - 4, 4, ".gbc") == 0);
  const int system = isGb ? 1 : 0;
  if (!vba_load_rom(rom_data.data(), static_cast<int>(rom_data.size()), system)) {
    fprintf(stderr, "ROM: %s\n", vba_last_error());
    return 1;
  }
  if (system == 0 && !RunNativeLinkProbe()) {
    fprintf(stderr, "LINK: browser cable transport probe failed\n");
    return 1;
  }
  if (std::string(argv[2]) != "-") {
    FILE* state_file = fopen(argv[2], "rb");
    fseek(state_file, 0, SEEK_END);
    const long state_size = ftell(state_file);
    fseek(state_file, 0, SEEK_SET);
    std::vector<uint8_t> state_data(static_cast<size_t>(state_size));
    fread(state_data.data(), 1, state_data.size(), state_file);
    fclose(state_file);
    if (!vba_load_state(state_data.data(), static_cast<int>(state_data.size()))) {
      fprintf(stderr, "STATE: %s\n", vba_last_error());
      return 1;
    }
    if (system == 0 && vba_audio_quality() != 1) {
      fprintf(stderr, "AUDIO: state quality was not normalized\n");
      return 1;
    }
  }
  for (int i = 0; i < 3; ++i) vba_run_frame();
  if (!vba_export_state()) {
    fprintf(stderr, "EXPORT: %s\n", vba_last_error());
    return 1;
  }
  if (argc > 3 && !WriteFile(argv[3], vba_export_data(), vba_export_size())) {
    fprintf(stderr, "WRITE: %s\n", vba_last_error());
    return 1;
  }
  printf("ok version=%d state=%d frames=%llu\n", vba_state_version(),
         vba_export_size(), static_cast<unsigned long long>(g_frame_counter));
  return 0;
}
#endif
