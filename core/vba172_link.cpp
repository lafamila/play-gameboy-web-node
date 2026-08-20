// Browser transport for the GBA multiplayer cable protocol used by VBA Link 1.72.
// The register behavior and transfer timings are derived from denopqrihg's GPL
// VBA Link implementation. Network transport is intentionally handled by JS.

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

constexpr int kTransferFirst[4] = {34080, 8520, 5680, 2840};
constexpr int kTransferSecond[4] = {65536, 16384, 10923, 5461};
constexpr int kTransferEnd[4] = {72527, 18132, 12088, 6044};

int g_player = -1;
int g_sequence = 0;
int g_speed = 3;
int g_transferPhase = 0;
int g_masterData = 0xffff;
int g_slaveData = 0xffff;
int g_requestTicks = 0;
int g_remoteSequence = -1;
int g_remoteMasterData = 0xffff;
int g_remoteTicks = 0;
bool g_waiting = false;
bool g_requestPending = false;
bool g_guestHeld = false;
bool g_guestHoldPending = false;

bool PrepareScheduledGuestResponse(bool interruptCpu) {
  if (g_player != 1 || g_remoteSequence != g_sequence || g_waiting ||
      g_transferPhase || linktime < g_remoteTicks) {
    return false;
  }
  if (g_sequence == 0) linktime = 0;
  else linktime -= g_remoteTicks;
  g_slaveData = READ16LE(&ioMem[0x12a]);
  g_waiting = true;
  if (interruptCpu && linkCpuActive && extTicks) *extTicks = 0;
  return true;
}

void WriteRoleBits(u16 value) {
  value &= 0xffbb;
  value |= g_player == 0 ? 8 : 0x0c;
  value |= (std::max(g_player, 0) << 4);
  UPDATE_REG(0x128, value);
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
}

void StartPairedTransfer(int sequence, int speed, int masterData, int slaveData) {
  g_sequence = sequence;
  g_speed = speed & 3;
  g_masterData = masterData & 0xffff;
  g_slaveData = slaveData & 0xffff;
  g_transferPhase = 1;
  g_waiting = false;
  g_requestPending = false;
  g_guestHeld = false;
  g_guestHoldPending = false;
  g_remoteSequence = -1;
  g_remoteTicks = 0;
  WRITE32LE(&ioMem[0x120], 0xffffffff);
  WRITE32LE(&ioMem[0x124], 0xffffffff);
  UPDATE_REG(0x128, READ16LE(&ioMem[0x128]) | 0x80);
}

}  // namespace

void StartLink(u16 value) {
  if (!ioMem) return;
  if (g_player < 0) {
    WriteDisconnectedSio(value);
    return;
  }

  if (!(READ16LE(&ioMem[0x134]) & 0x8000) && (value & 0x3000) == 0x2000) {
    if ((value & 0x80) && g_player == 0 && !g_waiting && !g_transferPhase) {
      g_masterData = READ16LE(&ioMem[0x12a]);
      g_speed = value & 3;
      g_requestTicks = g_sequence == 0 ? 0 : std::max(linktime, 0);
      linktime = 0;
      g_requestPending = true;
      g_waiting = true;
      if (linkCpuActive && extTicks) *extTicks = 0;
    } else if (g_player != 0 && (value & 0x80)) {
      value &= 0xff7f;
      value |= (g_waiting || g_transferPhase) ? 0x80 : 0;
    }
    WriteRoleBits(value);
    return;
  }

  UPDATE_REG(0x128, value);
}

void StartGPLink(u16 value) {
  if (!ioMem) return;
  if (!value) {
    UPDATE_REG(0x134, 0);
    return;
  }
  if (g_player >= 0 && !(value & 0x8000) &&
      (READ16LE(&ioMem[0x128]) & 0x3000) == 0x2000) {
    WriteRoleBits(READ16LE(&ioMem[0x128]));
    return;
  }
  UPDATE_REG(0x134, value);
}

void StartJOYLink(u16 value) {
  if (!ioMem) return;
  UPDATE_REG(0x140, value);
}

void WriteLinkData(u16 value) {
  if (!ioMem) return;
  UPDATE_REG(0x12a, value);
  if (g_player == 1 && g_guestHoldPending) {
    g_guestHoldPending = false;
    g_guestHeld = true;
    if (linkCpuActive && extTicks) *extTicks = 0;
  }
}

void LinkUpdate() {
  if (!ioMem || g_player < 0) {
    linktime = 0;
    return;
  }
  if (!g_transferPhase) {
    PrepareScheduledGuestResponse(true);
    return;
  }

  if (g_transferPhase == 1 && linktime >= kTransferFirst[g_speed]) {
    UPDATE_REG(0x120, g_masterData);
    g_transferPhase = 2;
  }
  if (g_transferPhase == 2 && linktime >= kTransferSecond[g_speed]) {
    UPDATE_REG(0x122, g_slaveData);
    g_transferPhase = 3;
  }
  if (g_transferPhase == 3 && linktime >= kTransferEnd[g_speed]) {
    g_transferPhase = 0;
    linktime -= kTransferEnd[g_speed];
    if (READ16LE(&ioMem[0x128]) & 0x4000) {
      IF |= 0x80;
      UPDATE_REG(0x202, IF);
    }
    UPDATE_REG(0x128,
               (READ16LE(&ioMem[0x128]) & 0xff0f) |
                   (std::max(g_player, 0) << 4));
    ++g_sequence;
    if (g_player == 1) {
      g_guestHoldPending = true;
    }
  }
}

void vbaLinkReset() {
  g_player = -1;
  g_sequence = 0;
  g_speed = 3;
  g_transferPhase = 0;
  g_masterData = 0xffff;
  g_slaveData = 0xffff;
  g_requestTicks = 0;
  g_remoteSequence = -1;
  g_remoteMasterData = 0xffff;
  g_remoteTicks = 0;
  g_waiting = false;
  g_requestPending = false;
  g_guestHeld = false;
  g_guestHoldPending = false;
  linktime = 0;
}

int vbaLinkSetPlayer(int playerId) {
  if (playerId < -1 || playerId > 1 || g_transferPhase || g_waiting) return 0;
  g_player = playerId;
  g_sequence = 0;
  g_requestTicks = 0;
  linktime = 0;
  g_guestHeld = false;
  g_guestHoldPending = false;
  if (ioMem && playerId >= 0) WriteRoleBits(READ16LE(&ioMem[0x128]));
  return 1;
}

int vbaLinkPlayer() { return g_player; }
int vbaLinkWaiting() { return g_waiting ? 1 : 0; }
int vbaLinkTransferActive() { return g_transferPhase ? 1 : 0; }
int vbaLinkRequestPending() { return g_requestPending ? 1 : 0; }
int vbaLinkRequestSequence() { return g_sequence; }
int vbaLinkRequestSpeed() { return g_speed; }
int vbaLinkRequestData() { return g_masterData; }
int vbaLinkRequestTicks() { return g_requestTicks; }
int vbaLinkGuestHeld() { return g_guestHeld ? 1 : 0; }

int vbaLinkPrepareRemote(int sequence, int speed, int masterData, int transferTicks) {
  if (!ioMem || g_player != 1 || sequence != g_sequence || g_transferPhase ||
      g_guestHoldPending || transferTicks < 0) {
    return -1;
  }
  if (g_waiting && g_remoteSequence == sequence) return g_slaveData;
  if (g_waiting || (g_remoteSequence >= 0 && g_remoteSequence != sequence)) return -1;
  if (g_remoteSequence < 0) {
    g_guestHeld = false;
    g_guestHoldPending = false;
    g_remoteSequence = sequence;
    g_remoteMasterData = masterData & 0xffff;
    g_remoteTicks = transferTicks;
    g_speed = speed & 3;
  }
  PrepareScheduledGuestResponse(false);
  return g_waiting ? g_slaveData : -2;
}

int vbaLinkApplyPair(int sequence, int speed, int masterData, int slaveData) {
  if (!ioMem || g_player < 0 || sequence != g_sequence || g_transferPhase) return 0;
  if (g_player == 0 && !g_requestPending) return 0;
  if (g_player == 1 && (!g_waiting || g_remoteSequence != sequence ||
                        g_remoteMasterData != (masterData & 0xffff))) {
    return 0;
  }
  StartPairedTransfer(sequence, speed, masterData, slaveData);
  return 1;
}

void vbaLinkCancelWait() {
  if (g_transferPhase) return;
  g_waiting = false;
  g_requestPending = false;
  g_guestHeld = false;
  g_guestHoldPending = false;
  g_remoteSequence = -1;
  g_remoteTicks = 0;
}
