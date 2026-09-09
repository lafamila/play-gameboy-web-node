#pragma once

#include <cstdint>

#include "System.h"
#include "Port.h"

extern int linktime;
extern bool linkCpuActive;

void StartLink(u16 value);
void StartGPLink(u16 value);
void StartJOYLink(u16 value);
void WriteLinkData(u16 value);
void LinkUpdate();

void vbaLinkReset();
int vbaLinkSetPlayer(int playerId);
int vbaLinkSetSequence(int sequence);
int vbaLinkStartMultiboot(uint32_t parameterAddress, int transferMode);
int vbaLinkMultibootActive();
int vbaLinkRunMultiboot();
int vbaLinkPlayer();
int vbaLinkWaiting();
int vbaLinkTransferActive();
int vbaLinkRequestPending();
int vbaLinkRequestSequence();
int vbaLinkMode();
int vbaLinkStateEpoch();
int vbaLinkRequestMode();
int vbaLinkRequestBits();
int vbaLinkRequestInitiator();
int vbaLinkRequestSpeed();
uint32_t vbaLinkRequestData();
int vbaLinkRequestTicks();
int vbaLinkSetPeerState(int mode, int siocnt, int rcnt);
int vbaLinkPrepareRemote(int sequence, int mode, int bits, int speed,
                         int initiator, uint32_t data, int transferTicks);
uint32_t vbaLinkResponseData();
int vbaLinkApplyTransfer(int sequence, int mode, int bits, int speed,
                         int initiator, uint32_t player0Data,
                         uint32_t player1Data);
void vbaLinkCancelWait();
