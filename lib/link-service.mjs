import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { LinkRoomCoordinator, LinkRoomError } from './link-room.mjs';

export const LINK_CORE_VERSION = 'vba-1.7.2-generic-sio-v3';
export const LINK_PROTOCOL_VERSION = 'gba-sio-v3';

const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

export class LinkService extends EventEmitter {
  constructor({
    database,
    coordinator = new LinkRoomCoordinator(),
    now = Date.now,
    disconnectGraceMs = DEFAULT_DISCONNECT_GRACE_MS,
    timers = globalThis,
  } = {}) {
    super();
    if (!database) throw new Error('database is required');
    if (!Number.isFinite(disconnectGraceMs) || disconnectGraceMs < 0) {
      throw new Error('disconnectGraceMs must be a non-negative finite number');
    }
    if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
      throw new Error('timers must provide setTimeout and clearTimeout');
    }
    this.database = database;
    this.coordinator = coordinator;
    this.now = now;
    this.disconnectGraceMs = disconnectGraceMs;
    this.timers = timers;
    this.disconnectTimers = new Map();
    this.pendingBatteries = new Map();
    this.transferBroadcasts = new Set();
  }

  async initialize() {
    return this.database.abortOpenLinkRooms?.(this.now()) ?? [];
  }

  async createRoom({ accountId, romId }) {
    const rom = await this.#gbaRom(romId);
    await this.#recoverConflictingRooms(accountId, rom.id);
    const roomId = randomUUID();
    const inviteCode = randomBytes(24).toString('base64url');
    const inviteHash = hashInvite(inviteCode);
    const compatibility = compatibilityForRom(rom);
    const expiresAt = this.now() + 2 * 60 * 60 * 1000;

    const snapshot = this.coordinator.createRoom({
      roomId,
      accountId,
      inviteSecretHash: inviteHash,
      romHash: rom.id,
      ...compatibility,
    });
    try {
      await this.database.createLinkRoom({
        id: roomId,
        accountId,
        romId: rom.id,
        bootKind: 'cartridge',
        inviteHash,
        expiresAt,
        ...compatibility,
      });
    } catch (error) {
      this.coordinator.abort({ roomId, accountId, reason: 'database create failed' });
      throw error;
    }
    return { room: await this.getRoom({ roomId, accountId }), inviteCode, snapshot };
  }

  async joinRoom({ roomId, accountId, inviteCode, romId, bootKind: bootKindValue }) {
    const persisted = await this.database.getLinkRoom(roomId);
    if (!persisted) throw serviceError(404, 'LINK_ROOM_NOT_FOUND', 'Link room not found');
    if (persisted.expiresAt && persisted.expiresAt <= this.now()) {
      try {
        this.coordinator.abort({ roomId, accountId: persisted.createdBy, reason: 'expired' });
      } catch (error) {
        if (!(error instanceof LinkRoomError) || error.code !== 'ROOM_NOT_FOUND') throw error;
      }
      this.#clearRoomDisconnectTimers(roomId);
      this.pendingBatteries.delete(roomId);
      await this.database.abortLinkRoom(roomId, this.now());
      throw serviceError(410, 'LINK_ROOM_EXPIRED', 'Link room expired');
    }
    const bootKind = readBootKind(bootKindValue);
    if (bootKind === 'multiboot-client' && romId !== undefined && romId !== null) {
      throw serviceError(400, 'MULTIBOOT_ROM_INVALID', 'Multiboot clients must not provide a ROM');
    }
    const rom = bootKind === 'cartridge' ? await this.#gbaRom(romId) : null;
    const compatibility = genericLinkCompatibility();
    this.coordinator.joinRoom({
      roomId,
      accountId,
      inviteSecretHash: hashInvite(inviteCode),
      bootKind,
      romHash: rom?.id ?? null,
      ...compatibility,
    });
    try {
      await this.database.joinLinkRoom(roomId, { accountId, bootKind, romId: rom?.id ?? null });
    } catch (error) {
      this.coordinator.abort({ roomId, accountId, reason: 'database join failed' });
      this.#clearRoomDisconnectTimers(roomId);
      this.pendingBatteries.delete(roomId);
      await this.database.abortLinkRoom(roomId, this.now()).catch(() => {});
      throw error;
    }
    this.#emitRoom(roomId, null, { type: 'room', room: await this.getRoom({ roomId, accountId }) });
    return this.getRoom({ roomId, accountId });
  }

  async getRoom({ roomId, accountId }) {
    const runtime = this.coordinator.getRoom({ roomId, accountId });
    const persisted = await this.database.getLinkRoom(roomId);
    if (!persisted || !persisted.participants.some((item) => item.accountId === accountId)) {
      throw serviceError(403, 'LINK_ROOM_FORBIDDEN', 'Account is not a room participant');
    }
    return {
      ...runtime,
      createdBy: persisted.createdBy,
      expiresAt: persisted.expiresAt,
      participants: runtime.participants.map((participant) => {
        if (!participant) return null;
        const saved = persisted.participants.find((item) => item.accountId === participant.accountId);
        return {
          ...participant,
          bootKind: saved?.bootKind ?? participant.bootKind,
          romId: saved ? saved.romId : participant.romHash,
        };
      }),
    };
  }

  async setReady({ roomId, accountId, ready }) {
    const snapshot = this.coordinator.setReady({ roomId, accountId, ready });
    await this.database.setLinkReadyState(
      roomId,
      accountId,
      ready !== false,
      snapshot.status,
      ['waiting', 'ready'],
      this.now(),
    );
    const room = await this.getRoom({ roomId, accountId });
    this.#emitRoom(roomId, null, { type: 'room', room });
    return room;
  }

  async startRoom({ roomId, accountId }) {
    this.coordinator.startRoom({ roomId, accountId });
    await this.database.updateLinkRoomStatus(roomId, 'active', this.now(), ['ready']);
    const room = await this.getRoom({ roomId, accountId });
    this.#emitRoom(roomId, null, { type: 'room', room });
    return room;
  }

  async abortRoom({ roomId, accountId, reason }) {
    const snapshot = this.coordinator.abort({ roomId, accountId, reason });
    this.#clearRoomDisconnectTimers(roomId);
    this.pendingBatteries.delete(roomId);
    await this.database.abortLinkRoom(roomId, this.now());
    this.#emitRoom(roomId, null, { type: 'aborted', reason: snapshot.abortReason });
    return snapshot;
  }

  async submitBattery({ roomId, accountId, payload }) {
    const room = await this.getRoom({ roomId, accountId });
    if (!['active', 'finishing', 'completed'].includes(room.status)) {
      throw serviceError(409, 'LINK_ROOM_NOT_ACTIVE', 'Link room is not active');
    }
    const participant = room.participants.find((item) => item?.accountId === accountId);
    if (participant?.bootKind !== 'cartridge') {
      throw serviceError(409, 'BATTERY_NOT_APPLICABLE', 'Multiboot clients do not persist battery saves');
    }
    validateBattery(payload);
    const requiredBatteries = room.participants.filter(
      (item) => item?.bootKind === 'cartridge',
    ).length;
    let batteries = this.pendingBatteries.get(roomId);
    if (!batteries) {
      batteries = new Map();
      this.pendingBatteries.set(roomId, batteries);
    }
    const existing = batteries.get(accountId);
    if (existing && !existing.equals(payload)) {
      throw serviceError(409, 'BATTERY_CONFLICT', 'A different battery payload was already submitted');
    }
    batteries.set(accountId, Buffer.from(payload));
    const metadata = {
      sha256: createHash('sha256').update(payload).digest('hex'),
      byteLength: payload.length,
    };
    const finishPromise = this.coordinator.finish({ roomId, accountId, batteryMetadata: metadata });
    if (batteries.size < requiredBatteries) {
      finishPromise.catch(() => {});
      this.#emitRoom(roomId, null, { type: 'finishing', submitted: batteries.size });
      return { status: 'finishing', submitted: batteries.size };
    }

    await finishPromise;
    this.#clearRoomDisconnectTimers(roomId);
    const result = await this.database.commitPairedBatterySaves(roomId, batteries);
    this.pendingBatteries.delete(roomId);
    this.#emitRoom(roomId, null, { type: 'completed', result });
    return { status: 'completed', result };
  }

  async connect({ roomId, accountId }) {
    this.#clearDisconnectTimer(roomId, accountId);
    const room = await this.getRoom({ roomId, accountId });
    if (room.paused) {
      this.coordinator.reconnect({ roomId, accountId, ...room.compatibility });
    }
    await this.database.setLinkParticipantState(roomId, accountId, { connected: true });
    return this.getRoom({ roomId, accountId });
  }

  async disconnect({ roomId, accountId }) {
    let snapshot;
    try {
      snapshot = this.coordinator.disconnect({ roomId, accountId });
    } catch (error) {
      if (error instanceof LinkRoomError && error.code === 'INVALID_STATE') {
        this.#clearRoomDisconnectTimers(roomId);
        return null;
      }
      throw error;
    }
    await this.database.setLinkParticipantState(roomId, accountId, { connected: false });
    this.#scheduleDisconnectAbort(roomId, accountId);
    this.#emitRoom(roomId, null, { type: 'paused', accountId });
    return snapshot;
  }

  async #recoverConflictingRooms(accountId, romId) {
    const rooms = await this.database.getRecoverableLinkRooms(accountId, romId);
    for (const room of rooms) {
      this.#clearRoomDisconnectTimers(room.id);
      this.pendingBatteries.delete(room.id);
      try {
        this.coordinator.abort({
          roomId: room.id,
          accountId: room.createdBy,
          reason: 'replaced by a new room',
        });
      } catch (error) {
        if (!(error instanceof LinkRoomError)
          || !['ROOM_NOT_FOUND', 'INVALID_STATE'].includes(error.code)) {
          throw error;
        }
      }
      await this.database.abortLinkRoom(room.id, this.now());
    }
  }

  #scheduleDisconnectAbort(roomId, accountId) {
    this.#clearDisconnectTimer(roomId, accountId);
    const key = disconnectTimerKey(roomId, accountId);
    const token = { handle: null };
    this.disconnectTimers.set(key, token);
    token.handle = this.timers.setTimeout(() => {
      if (this.disconnectTimers.get(key) !== token) return undefined;
      this.disconnectTimers.delete(key);
      return this.#abortAfterDisconnectGrace(roomId, accountId).catch((error) => {
        this.#emitRoom(roomId, null, {
          type: 'error', code: error.code || 'LINK_ERROR', message: error.message,
        });
      });
    }, this.disconnectGraceMs);
    token.handle?.unref?.();
  }

  async #abortAfterDisconnectGrace(roomId, accountId) {
    const reason = 'disconnect grace expired';
    let snapshot = null;
    try {
      snapshot = this.coordinator.abort({ roomId, accountId, reason });
    } catch (error) {
      if (!(error instanceof LinkRoomError)
        || !['ROOM_NOT_FOUND', 'INVALID_STATE'].includes(error.code)) {
        throw error;
      }
    }
    this.#clearRoomDisconnectTimers(roomId);
    this.pendingBatteries.delete(roomId);
    const room = await this.database.abortLinkRoom(roomId, this.now());
    if (room.status === 'aborted') {
      this.#emitRoom(roomId, null, {
        type: 'aborted', reason: snapshot?.abortReason ?? reason,
      });
    }
  }

  #clearDisconnectTimer(roomId, accountId) {
    const key = disconnectTimerKey(roomId, accountId);
    const token = this.disconnectTimers.get(key);
    if (!token) return;
    this.timers.clearTimeout(token.handle);
    this.disconnectTimers.delete(key);
  }

  #clearRoomDisconnectTimers(roomId) {
    const prefix = `${roomId}\0`;
    for (const [key, token] of this.disconnectTimers) {
      if (!key.startsWith(prefix)) continue;
      this.timers.clearTimeout(token.handle);
      this.disconnectTimers.delete(key);
    }
  }

  async handleMessage({ roomId, accountId, message }) {
    const room = this.coordinator.getRoom({ roomId, accountId });
    const participant = room.participants.find((item) => item?.accountId === accountId);
    if (!participant) throw serviceError(403, 'LINK_ROOM_FORBIDDEN', 'Account is not a participant');
    if (message?.type === 'sync') {
      const sync = this.coordinator.syncTransfer({ roomId, accountId, sequence: message.sequence });
      if (sync.status === 'completed') {
        this.#emitRoom(roomId, accountId, {
          type: 'sio-pair',
          ...sync.result,
        });
      } else if (sync.status === 'waiting-for-response') {
        this.#emitRoom(roomId, room.participants[1 - sync.initiatorSlot]?.accountId, {
          type: 'sio-offer', sequence: message.sequence, ...sync.offer,
        });
      }
      return;
    }
    if (message?.type === 'sio-offer') {
      const payload = transferPayload(message);
      const submission = this.coordinator.submitTransfer({
        roomId, accountId, sequence: message.sequence, phase: 'offer', payload,
      });
      if (submission.accepted) {
        this.#watchTransfer(roomId, message.sequence, submission.promise);
        this.#emitRoom(roomId, room.participants[1 - participant.slot]?.accountId, {
          type: 'sio-offer', sequence: message.sequence, ...payload,
        });
      }
      return;
    }
    if (message?.type === 'sio-response') {
      const submission = this.coordinator.submitTransfer({
        roomId,
        accountId,
        sequence: message.sequence,
        phase: 'response',
        payload: transferPayload(message),
      });
      if (submission.accepted) this.#watchTransfer(roomId, message.sequence, submission.promise);
      return;
    }
    if (message?.type === 'sio-state') {
      const state = sioState(message, participant.bootKind);
      const peer = this.coordinator.getPeer({ roomId, accountId });
      this.#emitRoom(roomId, peer.accountId, {
        type: 'sio-state',
        ...state,
      });
      return;
    }
    if (message?.type === 'checkpoint') {
      const payload = decodeCheckpoint(message.state);
      const result = this.coordinator.submitCheckpoint({
        roomId, accountId, sequence: message.sequence, state: payload,
      });
      if (result.accepted) {
        await this.database.putLinkCheckpointPair(
          roomId,
          message.sequence,
          result.checkpoint.states.map((item) => ({ accountId: item.accountId, payload: item.state })),
        );
        this.#emitRoom(roomId, null, { type: 'checkpoint-saved', sequence: message.sequence });
      }
      return;
    }
    throw serviceError(400, 'LINK_MESSAGE_INVALID', 'Unsupported link message');
  }

  #watchTransfer(roomId, sequence, promise) {
    const key = `${roomId}:${sequence}`;
    if (this.transferBroadcasts.has(key)) return;
    this.transferBroadcasts.add(key);
    promise.then((result) => {
      this.#emitRoom(roomId, null, {
        type: 'sio-pair',
        ...result,
      });
    }).catch((error) => {
      this.#emitRoom(roomId, null, { type: 'error', code: error.code, message: error.message });
    }).finally(() => this.transferBroadcasts.delete(key));
  }

  #emitRoom(roomId, targetAccountId, message) {
    this.emit('message', { roomId, targetAccountId, message });
  }

  async #gbaRom(romId) {
    const rom = await this.database.getRom(romId);
    if (!rom) throw serviceError(404, 'ROM_NOT_FOUND', 'ROM not found');
    if (rom.platform !== 'gba') throw serviceError(400, 'GBA_REQUIRED', 'Link cable requires a GBA ROM');
    return rom;
  }
}

export function compatibilityForRom(rom) {
  if (!rom || rom.platform !== 'gba') throw serviceError(400, 'GBA_REQUIRED', 'Link cable requires a GBA ROM');
  return genericLinkCompatibility();
}

function genericLinkCompatibility() {
  return {
    coreVersion: LINK_CORE_VERSION,
    protocolVersion: LINK_PROTOCOL_VERSION,
    gameGroup: 'gba-sio',
  };
}

function readBootKind(value = 'cartridge') {
  if (value !== 'cartridge' && value !== 'multiboot-client') {
    throw serviceError(400, 'BOOT_KIND_INVALID', 'bootKind must be cartridge or multiboot-client');
  }
  return value;
}

function transferPayload(message) {
  if (!Number.isSafeInteger(message?.sequence) || message.sequence < 0 ||
      !Number.isInteger(message?.mode) || message.mode < 0 || message.mode > 2 ||
      message.bits !== [8, 32, 16][message.mode] ||
      !Number.isInteger(message?.speed) || message.speed < 0 || message.speed > 3 ||
      (message.mode !== 2 && message.speed > 1) ||
      (message.initiatorSlot !== 0 && message.initiatorSlot !== 1) ||
      !Number.isInteger(message?.data) || message.data < 0 || message.data > 0xffffffff ||
      (message.bits === 8 && message.data > 0xff) ||
      (message.bits === 16 && message.data > 0xffff) ||
      !Number.isSafeInteger(message?.ticks) || message.ticks < 0 ||
      message.ticks > 0x7fffffff) {
    throw serviceError(400, 'SIO_TRANSFER_INVALID', 'Invalid SIO transfer envelope');
  }
  return {
    mode: message.mode,
    bits: message.bits,
    speed: message.speed,
    initiatorSlot: message.initiatorSlot,
    data: message.data,
    ticks: message.ticks,
  };
}

function sioState(message, bootKind) {
  const allowedModes = bootKind === 'multiboot-client'
    ? [0, 1, 2, 3, 8, 12, 15]
    : [0, 1, 2, 3, 8, 12];
  if (!allowedModes.includes(message?.mode) ||
      !Number.isInteger(message?.siocnt) || message.siocnt < 0 || message.siocnt > 0xffff ||
      !Number.isInteger(message?.rcnt) || message.rcnt < 0 || message.rcnt > 0xffff ||
      !Number.isSafeInteger(message?.epoch) || message.epoch < 0) {
    throw serviceError(400, 'SIO_STATE_INVALID', 'Invalid SIO state envelope');
  }
  return {
    mode: message.mode,
    siocnt: message.siocnt,
    rcnt: message.rcnt,
    epoch: message.epoch,
  };
}

function decodeCheckpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 3_000_000) {
    throw serviceError(400, 'CHECKPOINT_INVALID', 'Invalid checkpoint payload');
  }
  const payload = Buffer.from(value, 'base64');
  if (payload.length === 0 || payload.length > 2_000_000) {
    throw serviceError(400, 'CHECKPOINT_INVALID', 'Invalid checkpoint payload');
  }
  return payload;
}

function hashInvite(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) {
    throw serviceError(400, 'INVITE_INVALID', 'Invite code is invalid');
  }
  return createHash('sha256').update(value).digest('hex');
}

function validateBattery(payload) {
  if (!Buffer.isBuffer(payload) || ![256, 512, 2048, 8192, 32768, 32812, 65536, 131072].includes(payload.length)) {
    throw serviceError(400, 'BATTERY_INVALID', 'Battery save size is invalid');
  }
}

function serviceError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function disconnectTimerKey(roomId, accountId) {
  return `${roomId}\0${accountId}`;
}
