#pragma once

#include "System.h"
#include "Port.h"

extern int linktime;

void StartLink(u16 value);
void StartGPLink(u16 value);
void StartJOYLink(u16 value);
void LinkUpdate();

void vbaLinkReset();
int vbaLinkSetPlayer(int playerId);
int vbaLinkPlayer();
int vbaLinkWaiting();
int vbaLinkTransferActive();
int vbaLinkRequestPending();
int vbaLinkRequestSequence();
int vbaLinkRequestSpeed();
int vbaLinkRequestData();
int vbaLinkPrepareRemote(int sequence, int speed, int masterData);
int vbaLinkApplyPair(int sequence, int speed, int masterData, int slaveData);
void vbaLinkCancelWait();
