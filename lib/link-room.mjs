import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const ACTIVE = 'active';
const TERMINAL_STATUSES = new Set(['completed', 'aborted']);

export class LinkRoomCoordinator {
  constructor({ createRoomId = randomUUID } = {}) {
    if (typeof createRoomId !== 'function') {
      throw new LinkRoomError('INVALID_INPUT', 'createRoomId must be a function');
    }
    this.createRoomId = createRoomId;
    this.rooms = new Map();
  }

  createRoom(input) {
    const accountId = requireString(input?.accountId, 'accountId');
    rejectRawInviteSecret(input);
    const inviteSecretHash = requireString(input?.inviteSecretHash, 'inviteSecretHash');
    const compatibility = readCompatibility(input);
    const roomId = input?.roomId === undefined
      ? requireString(this.createRoomId(), 'generated roomId')
      : requireString(input.roomId, 'roomId');
    if (this.rooms.has(roomId)) throw new LinkRoomError('ROOM_EXISTS', 'Room already exists');

    const room = {
      id: roomId,
      status: 'waiting',
      paused: false,
      inviteSecretHash,
      compatibility,
      participants: [participant(0, accountId, input.romHash, 'cartridge'), null],
      nextTransferSequence: 0,
      transferRound: null,
      completedTransfers: new Map(),
      nextCheckpointSequence: 0,
      checkpointRound: null,
      completedCheckpoints: new Map(),
      lastCheckpoint: null,
      finishRound: null,
      commitPackage: null,
      abortReason: null,
    };
    this.rooms.set(roomId, room);
    return roomSnapshot(room);
  }

  joinRoom(input) {
    const room = this.#room(input?.roomId);
    const accountId = requireString(input?.accountId, 'accountId');
    rejectRawInviteSecret(input);
    const inviteSecretHash = requireString(input?.inviteSecretHash, 'inviteSecretHash');
    const compatibility = readCompatibility(input);
    const bootKind = readBootKind(input?.bootKind);
    this.#assertNotTerminal(room);
    this.#assertNotPaused(room);
    if (!hashesEqual(room.inviteSecretHash, inviteSecretHash)) {
      throw new LinkRoomError('INVITE_MISMATCH', 'Invite secret hash does not match');
    }
    assertCompatible(room.compatibility, compatibility);
    if (room.participants[0].accountId === accountId) {
      throw new LinkRoomError('DISTINCT_ACCOUNTS_REQUIRED', 'Host and guest accounts must be distinct');
    }
    if (room.participants[1]) {
      if (room.participants[1].accountId !== accountId) {
        throw new LinkRoomError('ROOM_FULL', 'Room already has two participants');
      }
      if (room.participants[1].bootKind !== bootKind ||
          room.participants[1].romHash !== readRomHash(input?.romHash, bootKind)) {
        throw new LinkRoomError('DUPLICATE_CONFLICT', 'Guest boot configuration does not match');
      }
      return roomSnapshot(room);
    }
    if (room.status !== 'waiting') throw invalidState(room, 'waiting');

    room.participants[1] = participant(1, accountId, input.romHash, bootKind);
    return roomSnapshot(room);
  }

  setReady(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertNotTerminal(room);
    this.#assertNotPaused(room);
    if (!['waiting', 'ready'].includes(room.status)) throw invalidState(room, 'waiting or ready');
    actor.ready = input?.ready !== false;
    room.status = room.participants.length === 2 &&
      room.participants.every((item) => item?.ready) ? 'ready' : 'waiting';
    return roomSnapshot(room);
  }

  startRoom(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertNotTerminal(room);
    this.#assertNotPaused(room);
    if (actor.slot !== 0) throw new LinkRoomError('FORBIDDEN', 'Only the host can start the room');
    if (room.status === ACTIVE) return roomSnapshot(room);
    if (room.status !== 'ready') throw invalidState(room, 'ready');
    if (!room.participants[1]) throw new LinkRoomError('INVALID_STATE', 'Guest slot is empty');
    room.status = ACTIVE;
    return roomSnapshot(room);
  }

  getRoom(input) {
    const room = this.#room(input?.roomId);
    this.#participant(room, input?.accountId);
    return roomSnapshot(room);
  }

  disconnect(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertNotTerminal(room);
    actor.connected = false;
    room.paused = true;
    return roomSnapshot(room);
  }

  reconnect(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertNotTerminal(room);
    assertCompatible(room.compatibility, readCompatibility(input));
    actor.connected = true;
    room.paused = room.participants.some((item) => item && !item.connected);
    return roomSnapshot(room);
  }

  submitTransfer(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertOperational(room, ACTIVE);
    const sequence = requireSequence(input?.sequence);
    const phase = requireTransferPhase(input?.phase);
    const payload = readTransferPayload(input?.payload);

    const completed = room.completedTransfers.get(sequence);
    if (completed) {
      assertTransferPhase(completed.initiatorSlot, actor.slot, phase);
      assertIdempotent(completed.submissions[actor.slot], payload, 'transfer');
      return { accepted: false, promise: Promise.resolve(completed.result) };
    }
    if (sequence !== room.nextTransferSequence) {
      throw new LinkRoomError(
        'INVALID_SEQUENCE',
        `Expected transfer sequence ${room.nextTransferSequence}, received ${sequence}`,
      );
    }

    let round = room.transferRound;
    if (!round) {
      if (phase !== 'offer') {
        throw new LinkRoomError('INVALID_TRANSFER_ROLE', 'A response requires a pending SIO offer');
      }
      if (payload.initiatorSlot !== actor.slot) {
        throw new LinkRoomError('INVALID_TRANSFER_ROLE', 'SIO offer initiatorSlot must match the sender slot');
      }
      if (payload.mode === 2 && actor.slot !== 0) {
        throw new LinkRoomError('INVALID_TRANSFER_ROLE', 'Only slot 0 can initiate Multiplayer transfers');
      }
      round = {
        sequence,
        initiatorSlot: actor.slot,
        submissions: [undefined, undefined],
        ...deferred(),
      };
      room.transferRound = round;
    }
    if (round.sequence !== sequence) throw new LinkRoomError('INVALID_SEQUENCE', 'Another transfer is pending');
    assertTransferPhase(round.initiatorSlot, actor.slot, phase);
    if (round.submissions[actor.slot] !== undefined) {
      assertIdempotent(round.submissions[actor.slot], payload, 'transfer');
      return { accepted: false, promise: round.promise };
    }
    assertTransferContext(round.submissions[round.initiatorSlot], payload);

    round.submissions[actor.slot] = payload;
    if (round.submissions.every((submission) => submission !== undefined)) {
      const offer = round.submissions[round.initiatorSlot];
      const result = deepFreeze({
        sequence,
        mode: offer.mode,
        bits: offer.bits,
        speed: offer.speed,
        initiatorSlot: round.initiatorSlot,
        ticks: offer.ticks,
        dataBySlot: round.submissions.map((submission) => submission.data),
      });
      room.completedTransfers.set(sequence, {
        initiatorSlot: round.initiatorSlot,
        submissions: round.submissions,
        result,
      });
      room.transferRound = null;
      room.nextTransferSequence += 1;
      round.resolve(result);
    }
    return { accepted: true, promise: round.promise };
  }

  syncTransfer(input) {
    const room = this.#room(input?.roomId);
    this.#participant(room, input?.accountId);
    this.#assertNotTerminal(room);
    const sequence = requireSequence(input?.sequence);
    const completed = room.completedTransfers.get(sequence);
    if (completed) return { status: 'completed', result: completed.result };
    if (room.transferRound?.sequence === sequence) {
      const initiatorSlot = room.transferRound.initiatorSlot;
      return {
        status: 'waiting-for-response',
        initiatorSlot,
        offer: cloneValue(room.transferRound.submissions[initiatorSlot]),
      };
    }
    return { status: sequence === room.nextTransferSequence ? 'current' : 'unknown' };
  }

  getPeer(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertOperational(room, ACTIVE);
    const peer = room.participants[1 - actor.slot];
    if (!peer) throw new LinkRoomError('INVALID_STATE', 'Peer slot is empty');
    return { slot: peer.slot, accountId: peer.accountId };
  }

  submitCheckpoint(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertOperational(room, ACTIVE);
    if (actor.bootKind !== 'cartridge') {
      throw new LinkRoomError('CHECKPOINT_NOT_APPLICABLE', 'Multiboot clients do not persist checkpoints');
    }
    const sequence = requireSequence(input?.sequence);
    const state = cloneSubmission(input?.state, 'state');

    const completed = room.completedCheckpoints.get(sequence);
    if (completed) {
      assertIdempotent(completed.submissions[actor.slot], state, 'checkpoint');
      return { accepted: true, checkpoint: completed.checkpoint };
    }
    if (sequence !== room.nextCheckpointSequence) {
      throw new LinkRoomError(
        'INVALID_SEQUENCE',
        `Expected checkpoint sequence ${room.nextCheckpointSequence}, received ${sequence}`,
      );
    }

    let round = room.checkpointRound;
    if (!round) {
      round = { sequence, submissions: [undefined, undefined] };
      room.checkpointRound = round;
    }
    if (round.submissions[actor.slot] !== undefined) {
      assertIdempotent(round.submissions[actor.slot], state, 'checkpoint');
      return { accepted: false, sequence };
    }

    round.submissions[actor.slot] = state;
    const cartridgeSlots = room.participants
      .filter((participant) => participant?.bootKind === 'cartridge')
      .map((participant) => participant.slot);
    if (cartridgeSlots.some((slot) => round.submissions[slot] === undefined)) {
      return { accepted: false, sequence };
    }

    const checkpoint = deepFreeze({
      sequence,
      states: cartridgeSlots.map((slot) => ({
        slot,
        accountId: room.participants[slot].accountId,
        state: cloneValue(round.submissions[slot]),
      })),
    });
    room.completedCheckpoints.set(sequence, { submissions: round.submissions, checkpoint });
    room.checkpointRound = null;
    room.lastCheckpoint = checkpoint;
    room.nextCheckpointSequence += 1;
    return { accepted: true, checkpoint };
  }

  finish(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertNotPaused(room);
    if (actor.bootKind !== 'cartridge') {
      throw new LinkRoomError('BATTERY_NOT_APPLICABLE', 'Multiboot clients do not persist battery saves');
    }
    const metadata = cloneMetadata(input?.batteryMetadata);

    if (room.status === 'completed') {
      assertIdempotent(room.finishRound.submissions[actor.slot], metadata, 'finish');
      return Promise.resolve(room.commitPackage);
    }
    this.#assertNotTerminal(room);
    if (room.status !== ACTIVE && room.status !== 'finishing') {
      throw invalidState(room, `${ACTIVE} or finishing`);
    }
    if (room.status === ACTIVE) {
      if (room.transferRound || room.checkpointRound) {
        throw new LinkRoomError('INVALID_STATE', 'Cannot finish while a transfer or checkpoint pair is pending');
      }
      room.status = 'finishing';
      room.finishRound = { submissions: [null, null], ...deferred() };
    }

    const round = room.finishRound;
    if (round.submissions[actor.slot] !== null) {
      assertIdempotent(round.submissions[actor.slot], metadata, 'finish');
      return round.promise;
    }
    round.submissions[actor.slot] = metadata;
    const cartridgeSlots = room.participants
      .filter((participant) => participant?.bootKind === 'cartridge')
      .map((participant) => participant.slot);
    if (cartridgeSlots.every((slot) => round.submissions[slot] !== null)) {
      const commitPackage = deepFreeze({
        roomId: room.id,
        compatibility: room.compatibility,
        participants: room.participants.map(({ slot, accountId, bootKind }) => ({
          slot, accountId, bootKind,
        })),
        lastTransferSequence: room.nextTransferSequence - 1,
        checkpoint: room.lastCheckpoint,
        batteryMetadata: cartridgeSlots.map((slot) => ({
          slot,
          accountId: room.participants[slot].accountId,
          metadata: cloneValue(round.submissions[slot]),
        })),
      });
      room.commitPackage = commitPackage;
      room.status = 'completed';
      round.resolve(commitPackage);
    }
    return round.promise;
  }

  getCommitPackage(input) {
    const room = this.#room(input?.roomId);
    this.#participant(room, input?.accountId);
    return room.status === 'completed' ? cloneValue(room.commitPackage) : null;
  }

  abort(input) {
    const room = this.#room(input?.roomId);
    this.#participant(room, input?.accountId);
    if (room.status === 'aborted') return roomSnapshot(room);
    if (room.status === 'completed') throw new LinkRoomError('INVALID_STATE', 'Completed room cannot be aborted');

    room.status = 'aborted';
    room.paused = false;
    room.abortReason = input?.reason === undefined ? null : requireString(input.reason, 'reason');
    room.commitPackage = null;
    const error = new LinkRoomError('ROOM_ABORTED', 'Room was aborted');
    room.transferRound?.reject(error);
    room.finishRound?.reject(error);
    room.transferRound = null;
    return roomSnapshot(room);
  }

  #room(roomId) {
    const id = requireString(roomId, 'roomId');
    const room = this.rooms.get(id);
    if (!room) throw new LinkRoomError('ROOM_NOT_FOUND', 'Room not found');
    return room;
  }

  #participant(room, accountId) {
    const id = requireString(accountId, 'accountId');
    const actor = room.participants.find((item) => item?.accountId === id);
    if (!actor) throw new LinkRoomError('FORBIDDEN', 'Account is not a room participant');
    return actor;
  }

  #assertOperational(room, expectedStatus) {
    this.#assertNotTerminal(room);
    this.#assertNotPaused(room);
    if (room.status !== expectedStatus) throw invalidState(room, expectedStatus);
  }

  #assertNotPaused(room) {
    if (room.paused) throw new LinkRoomError('ROOM_PAUSED', 'Room is paused until both participants reconnect');
  }

  #assertNotTerminal(room) {
    if (TERMINAL_STATUSES.has(room.status)) {
      throw new LinkRoomError('INVALID_STATE', `Room is ${room.status}`);
    }
  }
}

export class LinkRoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LinkRoomError';
    this.code = code;
  }
}

function participant(slot, accountId, romHash, bootKind) {
  if (slot === 0 && bootKind !== 'cartridge') {
    throw new LinkRoomError('INVALID_INPUT', 'Slot 0 must boot from a cartridge');
  }
  return {
    slot,
    accountId,
    connected: true,
    ready: false,
    bootKind,
    romHash: readRomHash(romHash, bootKind),
  };
}

function readBootKind(value = 'cartridge') {
  if (value !== 'cartridge' && value !== 'multiboot-client') {
    throw new LinkRoomError('INVALID_INPUT', 'bootKind must be cartridge or multiboot-client');
  }
  return value;
}

function readRomHash(value, bootKind) {
  if (bootKind === 'multiboot-client') {
    if (value !== undefined && value !== null) {
      throw new LinkRoomError('INVALID_INPUT', 'Multiboot clients must not provide a ROM hash');
    }
    return null;
  }
  return requireString(value, 'romHash');
}

function readCompatibility(input) {
  return deepFreeze({
    coreVersion: requireString(input?.coreVersion, 'coreVersion'),
    protocolVersion: requireString(input?.protocolVersion, 'protocolVersion'),
    gameGroup: requireString(input?.gameGroup, 'gameGroup'),
  });
}

function assertCompatible(expected, received) {
  if (!isDeepStrictEqual(expected, received)) {
    throw new LinkRoomError('INCOMPATIBLE_CLIENT', 'Core and protocol capabilities must match the host');
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LinkRoomError('INVALID_INPUT', `${name} must be a non-empty string`);
  }
  return value;
}

function requireSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LinkRoomError('INVALID_INPUT', 'sequence must be a non-negative safe integer');
  }
  return value;
}

function requireTransferPhase(value) {
  if (value !== 'offer' && value !== 'response') {
    throw new LinkRoomError('INVALID_INPUT', 'phase must be offer or response');
  }
  return value;
}

function readTransferPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinkRoomError('INVALID_INPUT', 'payload must be an SIO transfer object');
  }
  const mode = value.mode;
  const expectedBits = [8, 32, 16][mode];
  if (!Number.isInteger(mode) || expectedBits === undefined || value.bits !== expectedBits) {
    throw new LinkRoomError('INVALID_INPUT', 'mode and bits must describe Normal8, Normal32, or Multi');
  }
  if (!Number.isInteger(value.speed) || value.speed < 0 || value.speed > 3) {
    throw new LinkRoomError('INVALID_INPUT', 'speed must be an integer from 0 through 3');
  }
  if (value.initiatorSlot !== 0 && value.initiatorSlot !== 1) {
    throw new LinkRoomError('INVALID_INPUT', 'initiatorSlot must be 0 or 1');
  }
  if (!Number.isInteger(value.data) || value.data < 0 || value.data > 0xffffffff) {
    throw new LinkRoomError('INVALID_INPUT', 'data must be an unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(value.ticks) || value.ticks < 0) {
    throw new LinkRoomError('INVALID_INPUT', 'ticks must be a non-negative safe integer');
  }
  return deepFreeze({
    mode,
    bits: value.bits,
    speed: value.speed,
    initiatorSlot: value.initiatorSlot,
    data: value.data,
    ticks: value.ticks,
  });
}

function assertTransferPhase(initiatorSlot, actorSlot, phase) {
  const expected = actorSlot === initiatorSlot ? 'offer' : 'response';
  if (phase !== expected) {
    throw new LinkRoomError(
      'INVALID_TRANSFER_ROLE',
      `Slot ${actorSlot} must submit an SIO ${expected} for this transfer`,
    );
  }
}

function assertTransferContext(offer, received) {
  if (!offer) return;
  for (const key of ['mode', 'bits', 'speed', 'initiatorSlot', 'ticks']) {
    if (received[key] !== offer[key]) {
      throw new LinkRoomError('TRANSFER_MISMATCH', `SIO response ${key} does not match the offer`);
    }
  }
}

function rejectRawInviteSecret(input) {
  if (input && Object.hasOwn(input, 'inviteSecret')) {
    throw new LinkRoomError('INVALID_INPUT', 'Only inviteSecretHash may cross the coordinator boundary');
  }
}

function hashesEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cloneSubmission(value, name) {
  if (value === undefined) throw new LinkRoomError('INVALID_INPUT', `${name} is required`);
  return cloneValue(value);
}

function cloneMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinkRoomError('INVALID_INPUT', 'batteryMetadata must be an object');
  }
  return cloneValue(value);
}

function cloneValue(value) {
  try {
    return structuredClone(value);
  } catch {
    throw new LinkRoomError('INVALID_INPUT', 'Submission must be structured-cloneable');
  }
}

function assertIdempotent(existing, received, kind) {
  if (!isDeepStrictEqual(existing, received)) {
    throw new LinkRoomError('DUPLICATE_CONFLICT', `Conflicting duplicate ${kind} submission`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function roomSnapshot(room) {
  return {
    id: room.id,
    status: room.status,
    paused: room.paused,
    compatibility: cloneValue(room.compatibility),
    participants: room.participants.map((item) => item && {
      slot: item.slot,
      accountId: item.accountId,
      connected: item.connected,
      ready: item.ready,
      bootKind: item.bootKind,
      romHash: item.romHash,
    }),
    nextTransferSequence: room.nextTransferSequence,
    nextCheckpointSequence: room.nextCheckpointSequence,
    lastCheckpoint: room.lastCheckpoint ? { sequence: room.lastCheckpoint.sequence } : null,
    hasCommit: room.status === 'completed',
    abortReason: room.abortReason,
  };
}

function invalidState(room, expected) {
  return new LinkRoomError('INVALID_STATE', `Room must be ${expected}; current status is ${room.status}`);
}
