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
      participants: [participant(0, accountId, input.romHash), null],
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
      return roomSnapshot(room);
    }
    if (room.status !== 'waiting') throw invalidState(room, 'waiting');

    room.participants[1] = participant(1, accountId, input.romHash);
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
    const payload = cloneSubmission(input?.payload, 'payload');

    const completed = room.completedTransfers.get(sequence);
    if (completed) {
      assertIdempotent(completed.submissions[actor.slot], payload, 'transfer');
      return Promise.resolve(completed.result);
    }
    if (sequence !== room.nextTransferSequence) {
      throw new LinkRoomError(
        'INVALID_SEQUENCE',
        `Expected transfer sequence ${room.nextTransferSequence}, received ${sequence}`,
      );
    }

    let round = room.transferRound;
    if (!round) {
      round = { sequence, submissions: [undefined, undefined], ...deferred() };
      room.transferRound = round;
    }
    if (round.sequence !== sequence) throw new LinkRoomError('INVALID_SEQUENCE', 'Another transfer is pending');
    if (round.submissions[actor.slot] !== undefined) {
      assertIdempotent(round.submissions[actor.slot], payload, 'transfer');
      return round.promise;
    }

    round.submissions[actor.slot] = payload;
    if (round.submissions.every((submission) => submission !== undefined)) {
      const result = deepFreeze({
        sequence,
        payloads: room.participants.map((item, slot) => ({
          slot,
          accountId: item.accountId,
          payload: cloneValue(round.submissions[slot]),
        })),
      });
      room.completedTransfers.set(sequence, { submissions: round.submissions, result });
      room.transferRound = null;
      room.nextTransferSequence += 1;
      round.resolve(result);
    }
    return round.promise;
  }

  syncTransfer(input) {
    const room = this.#room(input?.roomId);
    this.#participant(room, input?.accountId);
    this.#assertNotTerminal(room);
    const sequence = requireSequence(input?.sequence);
    const completed = room.completedTransfers.get(sequence);
    if (completed) return { status: 'completed', result: completed.result };
    if (room.transferRound?.sequence === sequence && room.transferRound.submissions[0] !== undefined) {
      return {
        status: 'waiting-for-guest',
        hostPayload: cloneValue(room.transferRound.submissions[0]),
      };
    }
    return { status: sequence === room.nextTransferSequence ? 'current' : 'unknown' };
  }

  submitCheckpoint(input) {
    const room = this.#room(input?.roomId);
    const actor = this.#participant(room, input?.accountId);
    this.#assertOperational(room, ACTIVE);
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
    if (round.submissions.some((submission) => submission === undefined)) {
      return { accepted: false, sequence };
    }

    const checkpoint = deepFreeze({
      sequence,
      states: room.participants.map((item, slot) => ({
        slot,
        accountId: item.accountId,
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
    if (round.submissions.every((submission) => submission !== null)) {
      const commitPackage = deepFreeze({
        roomId: room.id,
        compatibility: room.compatibility,
        participants: room.participants.map(({ slot, accountId }) => ({ slot, accountId })),
        lastTransferSequence: room.nextTransferSequence - 1,
        checkpoint: room.lastCheckpoint,
        batteryMetadata: room.participants.map((item, slot) => ({
          slot,
          accountId: item.accountId,
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

function participant(slot, accountId, romHash) {
  return { slot, accountId, connected: true, ready: false, romHash: requireString(romHash, 'romHash') };
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
    throw new LinkRoomError('INCOMPATIBLE_CLIENT', 'Core version and ROM hash must match the host');
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
