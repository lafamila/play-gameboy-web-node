// Hardware-oriented browser transport for the GBA serial port. Network and
// in-page coordination are intentionally handled outside the emulator core.

#include "vba172_link.h"

#include <algorithm>
#include <cstdint>

#include "GBA.h"
#include "Globals.h"

#define UPDATE_REG(address, value) WRITE16LE(((u16 *)&ioMem[address]), value)

int linktime = 0;
bool linkCpuActive = false;
extern int* extTicks;

namespace {

constexpr int kNormal8Cycles[2] = {512, 64};
constexpr int kNormal32Cycles[2] = {2048, 256};
constexpr int kMultiCycles[4] = {63427, 16241, 10998, 5755};

enum SioMode {
  kNormal8 = 0,
  kNormal32 = 1,
  kMultiplayer = 2,
  kUart = 3,
  kGpio = 8,
  kJoyBus = 12,
};

int g_player = -1;
int g_peerMode = -1;
u16 g_peerSioCnt = 0;
u16 g_peerRcnt = 0;
int g_mode = kNormal8;
int g_sequence = 0;
int g_stateEpoch = 0;

bool g_waiting = false;
bool g_requestPending = false;
bool g_transferActive = false;
bool g_transferPaired = false;
bool g_responseReady = false;
int g_transferFinishCycles = 0;

int g_requestMode = -1;
int g_requestBits = 0;
int g_requestSpeed = 0;
int g_requestInitiator = -1;
uint32_t g_requestData = 0xffffffff;
int g_requestTicks = 0;

int g_remoteSequence = -1;
int g_remoteMode = -1;
int g_remoteBits = 0;
int g_remoteSpeed = 0;
int g_remoteInitiator = -1;
uint32_t g_remoteData = 0xffffffff;
int g_remoteTicks = 0;
uint32_t g_responseData = 0xffffffff;

int g_transferMode = -1;
int g_transferBits = 0;
int g_transferSpeed = 0;
int g_transferInitiator = -1;
uint32_t g_transferData[2] = {0xffffffff, 0xffffffff};

enum MultibootHostStage {
  kMultibootIdle,
  kMultibootLength,
  kMultibootData,
  kMultibootDataEnd,
  kMultibootReady,
  kMultibootSignalCrc,
  kMultibootCrc,
};

struct MultibootHostState {
  MultibootHostStage stage = kMultibootIdle;
  int transferMode = 0;
  int sioMode = kNormal32;
  int speed = 0;
  uint32_t start = 0;
  uint32_t source = 0;
  uint32_t end = 0;
  uint32_t key = 0;
  uint32_t keyXor = 0;
  uint32_t finalWord = 0;
  uint32_t encryptedWord = 0;
  uint16_t crc = 0;
  uint16_t polynomial = 0;
  bool highHalfPending = false;
};

MultibootHostState g_multiboot;

bool IsSupportedMode(int mode) {
  return mode == kNormal8 || mode == kNormal32 || mode == kMultiplayer;
}

bool PeerModeMatches(int mode) {
  return g_peerMode == mode || g_peerMode == 15;
}

int DetectMode(u16 siocnt, u16 rcnt) {
  const unsigned value = ((rcnt & 0xc000) | (siocnt & 0x3000)) >> 12;
  return value < 8 ? static_cast<int>(value & 3) : static_cast<int>(value & 0x0c);
}

int ModeBits(int mode) {
  if (mode == kNormal8) return 8;
  if (mode == kNormal32) return 32;
  if (mode == kMultiplayer) return 16;
  return 0;
}

int TransferCycles(int mode, int speed) {
  if (mode == kNormal8) return kNormal8Cycles[speed & 1];
  if (mode == kNormal32) return kNormal32Cycles[speed & 1];
  if (mode == kMultiplayer) return kMultiCycles[speed & 3];
  return 0;
}

uint32_t OutgoingData(int mode) {
  if (!ioMem) return 0xffffffff;
  if (mode == kNormal8) return READ16LE(&ioMem[0x12a]) & 0xff;
  if (mode == kNormal32) return READ32LE(&ioMem[0x120]);
  if (mode == kMultiplayer) return READ16LE(&ioMem[0x12a]);
  return 0xffffffff;
}

uint8_t ReadCpuByte(uint32_t address) {
  switch (address >> 24) {
    case 0x02:
      return workRAM ? workRAM[address & 0x3ffff] : 0;
    case 0x03:
      return internalRAM ? internalRAM[address & 0x7fff] : 0;
    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
      return rom ? rom[address & 0x1ffffff] : 0;
    default:
      return 0;
  }
}

uint32_t ReadCpuWord(uint32_t address) {
  return static_cast<uint32_t>(ReadCpuByte(address)) |
         (static_cast<uint32_t>(ReadCpuByte(address + 1)) << 8) |
         (static_cast<uint32_t>(ReadCpuByte(address + 2)) << 16) |
         (static_cast<uint32_t>(ReadCpuByte(address + 3)) << 24);
}

uint16_t MultibootCrcWord(uint16_t crc, uint32_t data, uint16_t polynomial) {
  for (int bit = 0; bit < 32; ++bit) {
    const bool carry = ((crc ^ data) & 1) != 0;
    crc >>= 1;
    if (carry) crc ^= polynomial;
    data >>= 1;
  }
  return crc;
}

void MarkStateChanged() {
  if (++g_stateEpoch < 0) g_stateEpoch = 1;
}

void ApplyCableRegisters() {
  if (!ioMem) return;
  u16 siocnt = READ16LE(&ioMem[0x128]);
  if (g_player >= 0 && g_mode == kMultiplayer) {
    siocnt &= 0xff83;
    siocnt |= g_player == 0 ? 0 : 0x04;
    if (PeerModeMatches(kMultiplayer)) siocnt |= 0x08;
    siocnt |= (std::max(g_player, 0) & 3) << 4;
    if (g_transferActive || g_requestPending) siocnt |= 0x80;
    else siocnt &= 0xff7f;
  } else if (g_player >= 0 && (g_mode == kNormal8 || g_mode == kNormal32)) {
    const bool peerConnected = PeerModeMatches(g_mode);
    const bool siHigh = !peerConnected || (g_peerSioCnt & 0x08);
    siocnt = static_cast<u16>((siocnt & ~0x04) | (siHigh ? 0x04 : 0));
  }
  UPDATE_REG(0x128, siocnt);

  u16 rcnt = READ16LE(&ioMem[0x134]);
  if (rcnt & 0x8000) return;
  rcnt &= 0xfff0;
  if (g_player >= 0 && g_mode == kMultiplayer) {
    if (!g_transferActive) rcnt |= 0x01;
    if (PeerModeMatches(kMultiplayer)) rcnt |= 0x02;
    if (g_player != 0) rcnt |= 0x04;
  } else if (g_player >= 0 && (g_mode == kNormal8 || g_mode == kNormal32)) {
    const bool internalClock = (siocnt & 0x01) != 0;
    if (!g_transferActive && internalClock) rcnt |= 0x01;
    else if (!internalClock && (g_peerRcnt & 0x01)) rcnt |= 0x01;
    if (!PeerModeMatches(g_mode) || (g_peerSioCnt & 0x08)) rcnt |= 0x04;
    if (siocnt & 0x08) rcnt |= 0x08;
  }
  UPDATE_REG(0x134, rcnt);
}

void ResetRemoteRequest() {
  g_remoteSequence = -1;
  g_remoteMode = -1;
  g_remoteBits = 0;
  g_remoteSpeed = 0;
  g_remoteInitiator = -1;
  g_remoteData = 0xffffffff;
  g_remoteTicks = 0;
  g_responseReady = false;
  g_responseData = 0xffffffff;
}

void ResetPendingTransfer() {
  g_waiting = false;
  g_requestPending = false;
  g_requestMode = -1;
  g_requestBits = 0;
  g_requestSpeed = 0;
  g_requestInitiator = -1;
  g_requestData = 0xffffffff;
  g_requestTicks = 0;
  ResetRemoteRequest();
}

void RefreshMode() {
  if (!ioMem) return;
  const int mode = DetectMode(READ16LE(&ioMem[0x128]), READ16LE(&ioMem[0x134]));
  if (mode != g_mode) {
    if (!g_transferActive) ResetPendingTransfer();
    g_mode = mode;
    MarkStateChanged();
  }
  ApplyCableRegisters();
}

void InterruptCpu() {
  if (linkCpuActive && extTicks) *extTicks = 0;
}

void BeginRequest(int mode, int speed) {
  if (!ioMem || g_player < 0 || g_transferActive || g_requestPending) return;
  g_requestMode = mode;
  g_requestBits = ModeBits(mode);
  g_requestSpeed = speed;
  g_requestInitiator = g_player;
  g_requestData = OutgoingData(mode);
  g_requestTicks = g_sequence == 0 ? 0 : std::max(linktime, 0);
  linktime = 0;
  g_requestPending = true;
  g_waiting = true;
  ApplyCableRegisters();
  InterruptCpu();
}

void BeginUnpairedTransfer(int mode, int speed) {
  if (!ioMem || g_transferActive || g_requestPending) return;
  g_transferMode = mode;
  g_transferBits = ModeBits(mode);
  g_transferSpeed = speed;
  g_transferInitiator = g_player;
  g_transferData[0] = g_player == 0 ? OutgoingData(mode) : 0xffffffff;
  g_transferData[1] = g_player == 1 ? OutgoingData(mode) : 0xffffffff;
  g_transferFinishCycles = TransferCycles(mode, speed);
  g_transferPaired = false;
  g_transferActive = true;
  linktime = 0;
  UPDATE_REG(0x128, READ16LE(&ioMem[0x128]) | 0x80);
  ApplyCableRegisters();
}

uint16_t MultibootResponse16(uint32_t value) {
  return g_multiboot.sioMode == kNormal32
      ? static_cast<uint16_t>(value >> 16)
      : static_cast<uint16_t>(value);
}

void FinishMultibootHost(bool success) {
  g_multiboot = MultibootHostState{};
  ResetPendingTransfer();
  reg[0].I = success ? 0 : 1;
  ApplyCableRegisters();
}

bool QueueMultibootTransfer(uint32_t data) {
  if (!ioMem || g_player != 0 || g_transferActive || g_requestPending) return false;
  StartGPLink(0);
  if (g_multiboot.sioMode == kNormal32) {
    const u16 control = static_cast<u16>(0x1009 | (g_multiboot.speed << 1));
    WRITE32LE(&ioMem[0x120], data);
    StartLink(control);
    StartLink(static_cast<u16>(control | 0x80));
  } else {
    const u16 control = static_cast<u16>(0x2000 | (g_multiboot.speed & 3));
    WriteLinkData(static_cast<u16>(data));
    StartLink(control);
    StartLink(static_cast<u16>(control | 0x80));
  }
  return g_requestPending;
}

bool QueueNextMultibootData() {
  if (g_multiboot.sioMode == kMultiplayer && g_multiboot.highHalfPending) {
    g_multiboot.highHalfPending = false;
    const bool queued = QueueMultibootTransfer(g_multiboot.encryptedWord >> 16);
    g_multiboot.source += 4;
    return queued;
  }
  if (g_multiboot.source >= g_multiboot.end) {
    g_multiboot.crc = MultibootCrcWord(
        g_multiboot.crc, g_multiboot.finalWord, g_multiboot.polynomial);
    g_multiboot.stage = kMultibootDataEnd;
    return QueueMultibootTransfer(0x0065);
  }
  const uint32_t plain = ReadCpuWord(g_multiboot.source);
  g_multiboot.key = g_multiboot.key * 0x6f646573 + 1;
  const uint32_t target = 0x020000c0 +
      (g_multiboot.source - g_multiboot.start);
  g_multiboot.encryptedWord = plain ^ static_cast<uint32_t>(-target) ^
      g_multiboot.key ^ g_multiboot.keyXor;
  g_multiboot.crc = MultibootCrcWord(
      g_multiboot.crc, plain, g_multiboot.polynomial);
  if (g_multiboot.sioMode == kMultiplayer) {
    g_multiboot.highHalfPending = true;
    return QueueMultibootTransfer(g_multiboot.encryptedWord & 0xffff);
  }
  g_multiboot.source += 4;
  return QueueMultibootTransfer(g_multiboot.encryptedWord);
}

void AdvanceMultibootHost(uint32_t response) {
  const uint16_t reply = MultibootResponse16(response);
  bool queued = true;
  switch (g_multiboot.stage) {
    case kMultibootLength: {
      if ((reply & 0xff00) != 0x7300) {
        FinishMultibootHost(false);
        return;
      }
      const uint8_t random = reply & 0xff;
      g_multiboot.finalWord = (g_multiboot.finalWord & 0xff) |
          (static_cast<uint32_t>(random) << 8) | 0xffff0000;
      g_multiboot.stage = kMultibootData;
      queued = QueueNextMultibootData();
      break;
    }
    case kMultibootData:
      queued = QueueNextMultibootData();
      break;
    case kMultibootDataEnd:
      g_multiboot.stage = kMultibootReady;
      queued = QueueMultibootTransfer(0x0065);
      break;
    case kMultibootReady:
      if (reply == 0x0075) {
        g_multiboot.stage = kMultibootSignalCrc;
        queued = QueueMultibootTransfer(0x0066);
      } else if (reply == 0x0074) {
        queued = QueueMultibootTransfer(0x0065);
      } else {
        FinishMultibootHost(false);
        return;
      }
      break;
    case kMultibootSignalCrc:
      if (reply != 0x0075) {
        FinishMultibootHost(false);
        return;
      }
      g_multiboot.stage = kMultibootCrc;
      queued = QueueMultibootTransfer(g_multiboot.crc);
      break;
    case kMultibootCrc:
      FinishMultibootHost(reply == g_multiboot.crc);
      return;
    default:
      FinishMultibootHost(false);
      return;
  }
  if (!queued) FinishMultibootHost(false);
}

bool RemoteSideReady() {
  if (!ioMem || g_remoteSequence != g_sequence || g_transferActive ||
      g_player < 0 || g_player == g_remoteInitiator || g_mode != g_remoteMode) {
    return false;
  }
  if (g_mode == kMultiplayer) {
    return g_remoteInitiator == 0 && g_player == 1;
  }
  if (g_mode == kNormal8 || g_mode == kNormal32) {
    const u16 siocnt = READ16LE(&ioMem[0x128]);
    return !(siocnt & 0x01) && (siocnt & 0x80);
  }
  return false;
}

bool PrepareRemoteResponse(bool interruptCpu) {
  if (g_responseReady) return true;
  if (!RemoteSideReady()) return false;
  if (g_mode == kMultiplayer && linktime < g_remoteTicks) return false;
  if (g_sequence == 0 || g_mode != kMultiplayer) linktime = 0;
  else linktime -= g_remoteTicks;
  g_responseData = OutgoingData(g_mode);
  g_responseReady = true;
  g_waiting = true;
  if (interruptCpu) InterruptCpu();
  return true;
}

void StartPairedTransfer(int sequence, int mode, int bits, int speed,
                         int initiator, uint32_t player0Data,
                         uint32_t player1Data) {
  g_sequence = sequence;
  g_transferMode = mode;
  g_transferBits = bits;
  g_transferSpeed = speed;
  g_transferInitiator = initiator;
  g_transferData[0] = player0Data;
  g_transferData[1] = player1Data;
  g_transferFinishCycles = TransferCycles(mode, speed);
  g_transferPaired = true;
  g_transferActive = true;
  g_waiting = false;
  g_requestPending = false;
  ResetRemoteRequest();
  linktime = 0;
  if (mode == kMultiplayer) {
    WRITE32LE(&ioMem[0x120], 0xffffffff);
    WRITE32LE(&ioMem[0x124], 0xffffffff);
  }
  UPDATE_REG(0x128, READ16LE(&ioMem[0x128]) | 0x80);
  ApplyCableRegisters();
}

void CompleteTransfer() {
  if (!ioMem || !g_transferActive) return;
  const uint32_t peerResponse = g_transferData[g_player == 0 ? 1 : 0];
  if (g_transferMode == kMultiplayer) {
    UPDATE_REG(0x120, static_cast<u16>(g_transferData[0]));
    UPDATE_REG(0x122, static_cast<u16>(g_transferData[1]));
    UPDATE_REG(0x124, 0xffff);
    UPDATE_REG(0x126, 0xffff);
  } else {
    const uint32_t received = g_transferData[g_player == 0 ? 1 : 0];
    if (g_transferMode == kNormal8) {
      UPDATE_REG(0x12a, static_cast<u16>(received & 0xff));
    } else if (g_transferMode == kNormal32) {
      WRITE32LE(&ioMem[0x120], received);
    }
  }
  u16 siocnt = READ16LE(&ioMem[0x128]) & 0xff7f;
  if (g_transferMode == kMultiplayer) {
    siocnt = static_cast<u16>((siocnt & 0xff0f) | ((std::max(g_player, 0) & 3) << 4));
  }
  UPDATE_REG(0x128, siocnt);
  if (siocnt & 0x4000) {
    IF |= 0x80;
    UPDATE_REG(0x202, IF);
  }
  g_transferActive = false;
  linktime -= g_transferFinishCycles;
  if (linktime < 0) linktime = 0;
  if (g_transferPaired) ++g_sequence;
  ApplyCableRegisters();
  if (g_transferPaired && g_player == 0 && g_multiboot.stage != kMultibootIdle) {
    AdvanceMultibootHost(peerResponse);
  }
  g_transferPaired = false;
}

void WriteDisconnectedSio(u16 value) {
  if (value & 0x80) {
    value &= 0xff7f;
    if ((value & 1) && (value & 0x4000)) {
      UPDATE_REG(0x12a, 0xff);
      IF |= 0x80;
      UPDATE_REG(0x202, IF);
    }
    value &= 0x7f7f;
  }
  UPDATE_REG(0x128, value);
  g_mode = DetectMode(value, READ16LE(&ioMem[0x134]));
}

}  // namespace

void StartLink(u16 value) {
  if (!ioMem) return;
  const u16 previous = READ16LE(&ioMem[0x128]);
  if (g_player < 0) {
    WriteDisconnectedSio(value);
    MarkStateChanged();
    return;
  }

  UPDATE_REG(0x128, value);
  RefreshMode();
  const bool startRequested = (value & 0x80) && !(previous & 0x80);
  if (g_mode == kMultiplayer) {
    if (startRequested && g_player == 0) {
      if (PeerModeMatches(kMultiplayer)) BeginRequest(g_mode, value & 3);
      else BeginUnpairedTransfer(g_mode, value & 3);
    }
  } else if ((g_mode == kNormal8 || g_mode == kNormal32) && startRequested) {
    if (value & 0x01) {
      if (PeerModeMatches(g_mode)) BeginRequest(g_mode, (value >> 1) & 1);
      else BeginUnpairedTransfer(g_mode, (value >> 1) & 1);
    }
    else {
      g_waiting = true;
      ApplyCableRegisters();
      InterruptCpu();
    }
  }
  ApplyCableRegisters();
  MarkStateChanged();
}

void StartGPLink(u16 value) {
  if (!ioMem) return;
  UPDATE_REG(0x134, value & 0xc1ff);
  RefreshMode();
  MarkStateChanged();
}

void StartJOYLink(u16 value) {
  if (!ioMem) return;
  UPDATE_REG(0x140, value);
}

void WriteLinkData(u16 value) {
  if (!ioMem) return;
  UPDATE_REG(0x12a, value);
  MarkStateChanged();
}

void LinkUpdate() {
  if (!ioMem) return;
  if (g_player < 0) {
    linktime = 0;
    return;
  }
  if (!g_transferActive) {
    PrepareRemoteResponse(true);
    if (!g_requestPending && g_remoteSequence < 0 && linktime > 0x3fffffff) linktime = 0;
    return;
  }
  if (linktime >= g_transferFinishCycles) CompleteTransfer();
}

void vbaLinkReset() {
  g_player = -1;
  g_peerMode = -1;
  g_peerSioCnt = 0;
  g_peerRcnt = 0;
  g_mode = kNormal8;
  g_sequence = 0;
  g_stateEpoch = 0;
  g_transferActive = false;
  g_transferPaired = false;
  g_transferFinishCycles = 0;
  g_transferMode = -1;
  g_transferBits = 0;
  g_transferSpeed = 0;
  g_transferInitiator = -1;
  g_transferData[0] = 0xffffffff;
  g_transferData[1] = 0xffffffff;
  g_multiboot = MultibootHostState{};
  ResetPendingTransfer();
  linktime = 0;
}

int vbaLinkSetPlayer(int playerId) {
  if (playerId < -1 || playerId > 1 || g_transferActive) return 0;
  ResetPendingTransfer();
  g_player = playerId;
  if (playerId < 0) g_multiboot = MultibootHostState{};
  g_peerMode = -1;
  g_peerSioCnt = 0;
  g_peerRcnt = 0;
  g_sequence = 0;
  linktime = 0;
  RefreshMode();
  if (ioMem && playerId < 0) {
    UPDATE_REG(0x134, READ16LE(&ioMem[0x134]) & 0xfff0);
  }
  MarkStateChanged();
  return 1;
}

int vbaLinkSetSequence(int sequence) {
  if (sequence < 0 || g_transferActive || g_requestPending || g_waiting) return 0;
  g_sequence = sequence;
  return 1;
}

int vbaLinkStartMultiboot(uint32_t parameterAddress, int transferMode) {
  if (!ioMem || g_player != 0 || g_transferActive || g_requestPending ||
      transferMode < 0 || transferMode > 2 || g_multiboot.stage != kMultibootIdle) {
    return 0;
  }
  const uint32_t source = ReadCpuWord(parameterAddress + 0x20);
  const uint32_t end = ReadCpuWord(parameterAddress + 0x24);
  const uint32_t length = end - source;
  if (end <= source || length < 0x100 || length > 0x3ff40 || (length & 0x0f)) {
    return 0;
  }

  g_multiboot = MultibootHostState{};
  g_multiboot.stage = kMultibootLength;
  g_multiboot.transferMode = transferMode;
  g_multiboot.sioMode = transferMode == 1 ? kMultiplayer : kNormal32;
  g_multiboot.speed = transferMode == 1 ? 3 : (transferMode == 2 ? 1 : 0);
  g_multiboot.start = source;
  g_multiboot.source = source;
  g_multiboot.end = end;
  g_multiboot.key = static_cast<uint32_t>(ReadCpuByte(parameterAddress + 0x1c)) |
      (static_cast<uint32_t>(ReadCpuByte(parameterAddress + 0x19)) << 8) |
      (static_cast<uint32_t>(ReadCpuByte(parameterAddress + 0x1a)) << 16) |
      (static_cast<uint32_t>(ReadCpuByte(parameterAddress + 0x1b)) << 24);
  g_multiboot.finalWord = ReadCpuByte(parameterAddress + 0x14);
  g_multiboot.crc = transferMode == 1 ? 0xfff8 : 0xc387;
  g_multiboot.polynomial = transferMode == 1 ? 0xa517 : 0xc37b;
  g_multiboot.keyXor = transferMode == 1 ? 0x6465646f : 0x43202f2f;
  if (!QueueMultibootTransfer(length / 4 - 0x34)) {
    g_multiboot = MultibootHostState{};
    return 0;
  }
  return 1;
}

int vbaLinkMultibootActive() {
  return g_multiboot.stage != kMultibootIdle ? 1 : 0;
}

int vbaLinkRunMultiboot() {
  if (g_multiboot.stage == kMultibootIdle) return 0;
  if (g_waiting || g_requestPending) return 2;
  if (g_transferActive) {
    linktime = g_transferFinishCycles;
    CompleteTransfer();
  }
  return g_multiboot.stage == kMultibootIdle ? 1 : 2;
}

int vbaLinkPlayer() { return g_player; }
int vbaLinkWaiting() { return g_waiting ? 1 : 0; }
int vbaLinkTransferActive() { return g_transferActive ? 1 : 0; }
int vbaLinkRequestPending() { return g_requestPending ? 1 : 0; }
int vbaLinkRequestSequence() { return g_sequence; }
int vbaLinkMode() { return g_mode; }
int vbaLinkStateEpoch() { return g_stateEpoch; }
int vbaLinkRequestMode() { return g_requestMode; }
int vbaLinkRequestBits() { return g_requestBits; }
int vbaLinkRequestInitiator() { return g_requestInitiator; }
int vbaLinkRequestSpeed() { return g_requestSpeed; }
uint32_t vbaLinkRequestData() { return g_requestData; }
int vbaLinkRequestTicks() { return g_requestTicks; }

int vbaLinkSetPeerState(int mode, int siocnt, int rcnt) {
  if (mode < -1 || mode > 15 || siocnt < 0 || siocnt > 0xffff ||
      rcnt < 0 || rcnt > 0xffff) {
    return 0;
  }
  g_peerMode = mode;
  g_peerSioCnt = static_cast<u16>(siocnt);
  g_peerRcnt = static_cast<u16>(rcnt);
  ApplyCableRegisters();
  return 1;
}

int vbaLinkPrepareRemote(int sequence, int mode, int bits, int speed,
                         int initiator, uint32_t data, int transferTicks) {
  if (!ioMem || g_player < 0 || initiator < 0 || initiator > 1 ||
      initiator == g_player || sequence != g_sequence || !IsSupportedMode(mode) ||
      bits != ModeBits(mode) || speed < 0 || speed > 3 || transferTicks < 0 ||
      g_transferActive || g_requestPending) {
    return -1;
  }
  if (g_responseReady && g_remoteSequence == sequence) return 1;
  if (g_remoteSequence >= 0 && g_remoteSequence != sequence) return -1;
  if (g_remoteSequence < 0) {
    g_remoteSequence = sequence;
    g_remoteMode = mode;
    g_remoteBits = bits;
    g_remoteSpeed = speed;
    g_remoteInitiator = initiator;
    g_remoteData = data;
    g_remoteTicks = transferTicks;
  }
  return PrepareRemoteResponse(false) ? 1 : 0;
}

uint32_t vbaLinkResponseData() { return g_responseData; }

int vbaLinkApplyTransfer(int sequence, int mode, int bits, int speed,
                         int initiator, uint32_t player0Data,
                         uint32_t player1Data) {
  if (!ioMem || g_player < 0 || sequence != g_sequence || !IsSupportedMode(mode) ||
      bits != ModeBits(mode) || speed < 0 || speed > 3 || initiator < 0 ||
      initiator > 1 || g_transferActive || g_mode != mode) {
    return 0;
  }
  if (g_player == initiator) {
    if (!g_requestPending || g_requestMode != mode || g_requestInitiator != initiator) return 0;
  } else if (!g_responseReady || g_remoteSequence != sequence ||
             g_remoteMode != mode || g_remoteInitiator != initiator) {
    return 0;
  }
  StartPairedTransfer(sequence, mode, bits, speed, initiator, player0Data, player1Data);
  return 1;
}

void vbaLinkCancelWait() {
  if (g_transferActive) return;
  ResetPendingTransfer();
  if (ioMem) UPDATE_REG(0x128, READ16LE(&ioMem[0x128]) & 0xff7f);
  ApplyCableRegisters();
}
