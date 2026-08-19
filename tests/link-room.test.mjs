import assert from 'node:assert/strict';
import test from 'node:test';

import { LinkRoomCoordinator } from '../lib/link-room.mjs';

const compatibility = {
  coreVersion: 'vba-link-web-1.7.2+wasm.4',
  protocolVersion: 'gba-cable-v1',
  gameGroup: 'pokemon-gen3:k',
};

function hasCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

function createActiveRoom(roomId = 'room-1') {
  const coordinator = new LinkRoomCoordinator();
  coordinator.createRoom({
    roomId,
    accountId: 'host-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'host-rom',
    ...compatibility,
  });
  coordinator.joinRoom({
    roomId,
    accountId: 'guest-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'guest-rom',
    ...compatibility,
  });
  coordinator.setReady({ roomId, accountId: 'host-account' });
  coordinator.setReady({ roomId, accountId: 'guest-account' });
  coordinator.startRoom({ roomId, accountId: 'host-account' });
  return coordinator;
}

test('room admission assigns two distinct authenticated accounts and validates the compatibility handshake', () => {
  const coordinator = new LinkRoomCoordinator({ createRoomId: () => 'generated-room' });
  const waiting = coordinator.createRoom({
    accountId: 'host-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'host-rom',
    ...compatibility,
  });
  assert.equal(waiting.id, 'generated-room');
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(waiting.participants, [
    { slot: 0, accountId: 'host-account', connected: true, ready: false, romHash: 'host-rom' },
    null,
  ]);
  assert.equal(JSON.stringify(waiting).includes('sha256:invite-hash'), false);

  assert.throws(() => coordinator.createRoom({
    roomId: 'raw-secret-room',
    accountId: 'other-host',
    inviteSecret: 'raw-secret',
    inviteSecretHash: 'sha256:raw-secret',
    ...compatibility,
  }), hasCode('INVALID_INPUT'));
  assert.throws(() => coordinator.joinRoom({
    roomId: waiting.id,
    accountId: 'host-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'host-rom',
    ...compatibility,
  }), hasCode('DISTINCT_ACCOUNTS_REQUIRED'));
  assert.throws(() => coordinator.joinRoom({
    roomId: waiting.id,
    accountId: 'guest-account',
    inviteSecretHash: 'sha256:wrong',
    romHash: 'guest-rom',
    ...compatibility,
  }), hasCode('INVITE_MISMATCH'));
  assert.throws(() => coordinator.joinRoom({
    roomId: waiting.id,
    accountId: 'guest-account',
    inviteSecretHash: 'sha256:invite-hash',
    ...compatibility,
    gameGroup: 'different-game',
    romHash: 'guest-rom',
  }), hasCode('INCOMPATIBLE_CLIENT'));

  const ready = coordinator.joinRoom({
    roomId: waiting.id,
    accountId: 'guest-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'guest-rom',
    ...compatibility,
  });
  assert.equal(ready.status, 'waiting');
  assert.deepEqual(ready.participants.map((item) => item.accountId), ['host-account', 'guest-account']);
  assert.equal(coordinator.joinRoom({
    roomId: waiting.id,
    accountId: 'guest-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'guest-rom',
    ...compatibility,
  }).status, 'waiting');
  assert.throws(() => coordinator.joinRoom({
    roomId: waiting.id,
    accountId: 'third-account',
    inviteSecretHash: 'sha256:invite-hash',
    romHash: 'third-rom',
    ...compatibility,
  }), hasCode('ROOM_FULL'));
  assert.throws(
    () => coordinator.startRoom({ roomId: waiting.id, accountId: 'guest-account' }),
    hasCode('FORBIDDEN'),
  );
  coordinator.setReady({ roomId: waiting.id, accountId: 'host-account' });
  assert.equal(coordinator.setReady({
    roomId: waiting.id, accountId: 'guest-account',
  }).status, 'ready');
  assert.equal(coordinator.startRoom({ roomId: waiting.id, accountId: 'host-account' }).status, 'active');
  assert.throws(
    () => coordinator.getRoom({ roomId: waiting.id, accountId: 'third-account' }),
    hasCode('FORBIDDEN'),
  );
});

test('serial transfers are a monotonic two-slot barrier with idempotent duplicates', async () => {
  const coordinator = createActiveRoom();
  const first = coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'host-account',
    sequence: 0,
    payload: { outgoing: 0x12, clock: 512 },
  });
  let settled = false;
  first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  const duplicate = coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'host-account',
    sequence: 0,
    payload: { outgoing: 0x12, clock: 512 },
  });
  assert.strictEqual(duplicate, first);
  assert.throws(() => coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'host-account',
    sequence: 0,
    payload: { outgoing: 0x13, clock: 512 },
  }), hasCode('DUPLICATE_CONFLICT'));
  assert.throws(() => coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'guest-account',
    sequence: 1,
    payload: { outgoing: 0x34, clock: 512 },
  }), hasCode('INVALID_SEQUENCE'));

  const second = coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'guest-account',
    sequence: 0,
    payload: { outgoing: 0x34, clock: 512 },
  });
  assert.strictEqual(second, first);
  const result = await first;
  assert.deepEqual(result, {
    sequence: 0,
    payloads: [
      { slot: 0, accountId: 'host-account', payload: { outgoing: 0x12, clock: 512 } },
      { slot: 1, accountId: 'guest-account', payload: { outgoing: 0x34, clock: 512 } },
    ],
  });
  assert.strictEqual(await second, result);
  assert.equal(coordinator.getRoom({ roomId: 'room-1', accountId: 'host-account' }).nextTransferSequence, 1);

  assert.deepEqual(await coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'host-account',
    sequence: 0,
    payload: { outgoing: 0x12, clock: 512 },
  }), result);
  assert.throws(() => coordinator.submitTransfer({
    roomId: 'room-1',
    accountId: 'host-account',
    sequence: 2,
    payload: 0x55,
  }), hasCode('INVALID_SEQUENCE'));
});

test('disconnect pauses barriers and a compatible reconnect resumes the active room', async () => {
  const coordinator = createActiveRoom();
  const pending = coordinator.submitTransfer({
    roomId: 'room-1', accountId: 'host-account', sequence: 0, payload: Uint8Array.of(0x11),
  });
  const paused = coordinator.disconnect({ roomId: 'room-1', accountId: 'guest-account' });
  assert.equal(paused.status, 'active');
  assert.equal(paused.paused, true);
  assert.equal(paused.participants[1].connected, false);
  assert.throws(() => coordinator.submitTransfer({
    roomId: 'room-1', accountId: 'guest-account', sequence: 0, payload: Uint8Array.of(0x22),
  }), hasCode('ROOM_PAUSED'));
  assert.throws(() => coordinator.reconnect({
    roomId: 'room-1', accountId: 'guest-account', ...compatibility, coreVersion: 'other-core',
  }), hasCode('INCOMPATIBLE_CLIENT'));

  const resumed = coordinator.reconnect({
    roomId: 'room-1', accountId: 'guest-account', ...compatibility,
  });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.participants[1].connected, true);
  coordinator.submitTransfer({
    roomId: 'room-1', accountId: 'guest-account', sequence: 0, payload: Uint8Array.of(0x22),
  });
  const result = await pending;
  assert.deepEqual([...result.payloads[0].payload], [0x11]);
  assert.deepEqual([...result.payloads[1].payload], [0x22]);
  assert.equal(coordinator.syncTransfer({
    roomId: 'room-1', accountId: 'host-account', sequence: 0,
  }).status, 'completed');
});

test('reconnect sync exposes a pending host offer without advancing the barrier', () => {
  const coordinator = createActiveRoom();
  coordinator.submitTransfer({
    roomId: 'room-1', accountId: 'host-account', sequence: 0,
    payload: { speed: 3, data: 0x1234 },
  });
  assert.deepEqual(coordinator.syncTransfer({
    roomId: 'room-1', accountId: 'guest-account', sequence: 0,
  }), { status: 'waiting-for-guest', hostPayload: { speed: 3, data: 0x1234 } });
  assert.equal(coordinator.getRoom({
    roomId: 'room-1', accountId: 'host-account',
  }).nextTransferSequence, 0);
});

test('checkpoint sequence advances only after both slot states are paired', () => {
  const coordinator = createActiveRoom();
  const host = coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'host-account', sequence: 0, state: { frame: 120, hash: 'host-state' },
  });
  assert.deepEqual(host, { accepted: false, sequence: 0 });
  assert.equal(coordinator.getRoom({ roomId: 'room-1', accountId: 'host-account' }).lastCheckpoint, null);
  assert.deepEqual(coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'host-account', sequence: 0, state: { frame: 120, hash: 'host-state' },
  }), { accepted: false, sequence: 0 });
  assert.throws(() => coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'host-account', sequence: 0, state: { frame: 121, hash: 'changed' },
  }), hasCode('DUPLICATE_CONFLICT'));

  const paired = coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'guest-account', sequence: 0, state: { frame: 120, hash: 'guest-state' },
  });
  assert.equal(paired.accepted, true);
  assert.deepEqual(paired.checkpoint.states.map(({ slot, accountId, state }) => ({ slot, accountId, state })), [
    { slot: 0, accountId: 'host-account', state: { frame: 120, hash: 'host-state' } },
    { slot: 1, accountId: 'guest-account', state: { frame: 120, hash: 'guest-state' } },
  ]);
  const snapshot = coordinator.getRoom({ roomId: 'room-1', accountId: 'guest-account' });
  assert.equal(snapshot.nextCheckpointSequence, 1);
  assert.equal(snapshot.lastCheckpoint.sequence, 0);
  assert.equal(coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'host-account', sequence: 0, state: { frame: 120, hash: 'host-state' },
  }).accepted, true);
  assert.throws(() => coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'host-account', sequence: 2, state: { frame: 240 },
  }), hasCode('INVALID_SEQUENCE'));
});

test('finish waits for both battery metadata submissions and yields one atomic commit package', async () => {
  const coordinator = createActiveRoom();
  const hostMetadata = { sha256: 'host-battery', byteLength: 131072, payloadKey: 'upload-host' };
  const guestMetadata = { sha256: 'guest-battery', byteLength: 131072, payloadKey: 'upload-guest' };
  coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'host-account', sequence: 0, state: { frame: 300 },
  });
  assert.throws(() => coordinator.finish({
    roomId: 'room-1', accountId: 'host-account', batteryMetadata: hostMetadata,
  }), hasCode('INVALID_STATE'));
  coordinator.submitCheckpoint({
    roomId: 'room-1', accountId: 'guest-account', sequence: 0, state: { frame: 300 },
  });
  const hostFinish = coordinator.finish({
    roomId: 'room-1', accountId: 'host-account', batteryMetadata: hostMetadata,
  });
  let settled = false;
  hostFinish.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(coordinator.getRoom({ roomId: 'room-1', accountId: 'host-account' }).status, 'finishing');
  assert.equal(coordinator.getCommitPackage({ roomId: 'room-1', accountId: 'host-account' }), null);
  assert.strictEqual(coordinator.finish({
    roomId: 'room-1', accountId: 'host-account', batteryMetadata: { ...hostMetadata },
  }), hostFinish);
  assert.throws(() => coordinator.finish({
    roomId: 'room-1', accountId: 'host-account', batteryMetadata: { ...hostMetadata, byteLength: 1 },
  }), hasCode('DUPLICATE_CONFLICT'));

  const guestFinish = coordinator.finish({
    roomId: 'room-1', accountId: 'guest-account', batteryMetadata: guestMetadata,
  });
  assert.strictEqual(guestFinish, hostFinish);
  const commit = await hostFinish;
  assert.equal(commit.roomId, 'room-1');
  assert.deepEqual(commit.compatibility, compatibility);
  assert.deepEqual(commit.participants, [
    { slot: 0, accountId: 'host-account' },
    { slot: 1, accountId: 'guest-account' },
  ]);
  assert.equal(commit.checkpoint.sequence, 0);
  assert.deepEqual(commit.batteryMetadata.map((entry) => entry.metadata), [hostMetadata, guestMetadata]);
  assert.strictEqual(await guestFinish, commit);
  assert.equal(coordinator.getRoom({ roomId: 'room-1', accountId: 'guest-account' }).status, 'completed');
  assert.deepEqual(
    coordinator.getCommitPackage({ roomId: 'room-1', accountId: 'guest-account' }),
    commit,
  );
  assert.throws(
    () => coordinator.abort({ roomId: 'room-1', accountId: 'host-account' }),
    hasCode('INVALID_STATE'),
  );
});

test('abort rejects pending barriers and never exposes a commit package', async () => {
  const transferRoom = createActiveRoom('transfer-room');
  const transfer = transferRoom.submitTransfer({
    roomId: 'transfer-room', accountId: 'host-account', sequence: 0, payload: 0x66,
  });
  const aborted = transferRoom.abort({
    roomId: 'transfer-room', accountId: 'guest-account', reason: 'guest cancelled',
  });
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.abortReason, 'guest cancelled');
  await assert.rejects(transfer, hasCode('ROOM_ABORTED'));
  assert.equal(transferRoom.getCommitPackage({ roomId: 'transfer-room', accountId: 'host-account' }), null);
  assert.equal(transferRoom.abort({
    roomId: 'transfer-room', accountId: 'host-account', reason: 'ignored duplicate',
  }).abortReason, 'guest cancelled');

  const finishRoom = createActiveRoom('finish-room');
  const finish = finishRoom.finish({
    roomId: 'finish-room',
    accountId: 'host-account',
    batteryMetadata: { sha256: 'host-only', byteLength: 131072 },
  });
  finishRoom.abort({ roomId: 'finish-room', accountId: 'guest-account' });
  await assert.rejects(finish, hasCode('ROOM_ABORTED'));
  assert.equal(finishRoom.getCommitPackage({ roomId: 'finish-room', accountId: 'guest-account' }), null);
  assert.throws(() => finishRoom.finish({
    roomId: 'finish-room',
    accountId: 'guest-account',
    batteryMetadata: { sha256: 'too-late', byteLength: 131072 },
  }), hasCode('INVALID_STATE'));
});
