import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryDatabase } from '../lib/database.mjs';
import { LocalLinkService } from '../lib/local-link-service.mjs';

const HOST_ROM = 'a'.repeat(64);
const GUEST_ROM = 'b'.repeat(64);
const host = { accountId: 'host', subject: 'host', permission: 'user' };
const guest = { accountId: 'guest', subject: 'guest', permission: 'user' };

async function setup(now = 1_000) {
  const database = new MemoryDatabase();
  for (const [id, gameCode] of [[HOST_ROM, 'BPRE'], [GUEST_ROM, 'BPGE']]) {
    await database.upsertRom({
      id, platform: 'gba', gameCode, title: gameCode, filename: `${gameCode}.gba`,
      romIdentity: gameCode, revision: 0, size: 1024, path: `/tmp/${id}.gba`, source: 'fixture',
    });
  }
  const service = new LocalLinkService({
    database, now: () => now, leaseMs: 5_000,
    timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
  });
  return { database, service };
}

test('account and guest local players use server-owned isolated save profiles', async () => {
  const { database, service } = await setup();
  const accountSession = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  assert.deepEqual(accountSession.participants.map((item) => [item.accountId, item.profileKey]), [
    ['host', 'primary'], ['guest', 'primary'],
  ]);
  await service.abort({ id: accountSession.id, player1: host, player2: guest });

  const guestSession = await service.create({
    player1: host, player2Mode: 'guest', player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  assert.deepEqual(guestSession.participants.map((item) => [item.accountId, item.profileKey]), [
    ['host', 'primary'], ['host', 'guest-p2'],
  ]);
  assert.equal(database.localSaveLocks.size, 2);
});

test('same-account P2 and incompatible ROM pairs are rejected before start', async () => {
  const { database, service } = await setup();
  await assert.rejects(() => service.create({
    player1: host, player2: { ...host }, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  }), { code: 'LOCAL_SAME_ACCOUNT' });
  await database.upsertRom({
    id: 'c'.repeat(64), platform: 'gba', gameCode: 'BPGK', title: 'Other region',
    filename: 'other.gba', romIdentity: 'other', revision: 0, size: 1024,
    path: '/tmp/other.gba', source: 'fixture',
  });
  await assert.rejects(() => service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: 'c'.repeat(64),
  }), { code: 'LOCAL_ROM_INCOMPATIBLE' });
});

test('ready/start/checkpoint/final battery operations remain paired and atomic', async () => {
  const { database, service } = await setup();
  const session = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  await assert.rejects(() => service.start({ id: session.id, player1: host, player2: guest }), {
    code: 'LOCAL_NOT_READY',
  });
  await service.setReady({ id: session.id, slot: 0, player1: host, player2: guest });
  await service.setReady({ id: session.id, slot: 1, player1: host, player2: guest });
  await assert.rejects(() => service.start({ id: session.id, player1: host, player2: guest }), {
    code: 'LOCAL_CHECKPOINT_REQUIRED',
  });
  const checkpoint = await service.checkpoint({
    id: session.id, sequence: 0, player1: host, player2: guest,
    states: [{ slot: 0, data: Buffer.from('state-a').toString('base64') },
      { slot: 1, data: Buffer.from('state-b').toString('base64') }],
  });
  assert.equal(checkpoint.checkpoints.length, 2);
  await service.start({ id: session.id, player1: host, player2: guest });
  const batteryA = Buffer.alloc(131072, 0x11);
  const batteryB = Buffer.alloc(131072, 0x22);
  await service.finish({
    id: session.id, player1: host, player2: guest,
    batteries: [{ slot: 0, data: batteryA.toString('base64') },
      { slot: 1, data: batteryB.toString('base64') }],
  });
  assert.deepEqual((await database.getSave('host', HOST_ROM, 'battery')).payload, batteryA);
  assert.deepEqual((await database.getSave('guest', GUEST_ROM, 'battery')).payload, batteryB);
  assert.equal(database.localSaveLocks.size, 0);
});

test('revision conflicts and lease cleanup never commit a partial pair or leave locks', async () => {
  const { database, service } = await setup();
  const session = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  const guestKey = database.saveKey('guest', GUEST_ROM, 'battery');
  database.saves.set(guestKey, { payload: Buffer.alloc(256, 9), updatedAt: 2_000, revision: 1 });
  await database.updateLocalLinkSession(session.id, {
    expectedStatuses: ['preparing'], status: 'finishing',
  }, 2_001);
  await assert.rejects(() => database.commitLocalBatteryPair(session.id, [
    { slot: 0, payload: Buffer.alloc(256, 1) },
    { slot: 1, payload: Buffer.alloc(256, 2) },
  ], 2_002), { code: 'SAVE_REVISION_CONFLICT' });
  assert.equal(await database.getSave('host', HOST_ROM, 'battery'), null);
  assert.equal(database.localSaveLocks.size, 2);
  await database.abortExpiredLocalLinkSessions(10_000);
  assert.equal(database.localSaveLocks.size, 0);
  assert.equal((await database.getLocalLinkSession(session.id)).status, 'aborted');
});

test('failed final commit aborts finishing state and releases both local locks', async () => {
  const { database, service } = await setup();
  const session = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  await service.setReady({ id: session.id, slot: 0, player1: host, player2: guest });
  await service.setReady({ id: session.id, slot: 1, player1: host, player2: guest });
  await service.checkpoint({
    id: session.id, sequence: 0, player1: host, player2: guest,
    states: [{ slot: 0, data: Buffer.from('start-a').toString('base64') },
      { slot: 1, data: Buffer.from('start-b').toString('base64') }],
  });
  await service.start({ id: session.id, player1: host, player2: guest });
  database.commitLocalBatteryPair = async () => {
    const error = new Error('simulated commit failure');
    error.code = 'SIMULATED_COMMIT_FAILURE';
    throw error;
  };
  await assert.rejects(() => service.finish({
    id: session.id, player1: host, player2: guest,
    batteries: [{ slot: 0, data: Buffer.alloc(256, 1).toString('base64') },
      { slot: 1, data: Buffer.alloc(256, 2).toString('base64') }],
  }), { code: 'SIMULATED_COMMIT_FAILURE' });
  assert.equal((await database.getLocalLinkSession(session.id)).status, 'aborted');
  assert.equal(database.localSaveLocks.size, 0);
});

test('remote rooms and local sessions are mutually exclusive in both directions', async () => {
  const { database, service } = await setup();
  await database.createLinkRoom({ id: 'remote-room', accountId: host.accountId, romId: HOST_ROM });
  await assert.rejects(() => service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  }), { code: 'PLAY_ADMISSION_LOCKED' });
  await database.abortLinkRoom('remote-room');
  await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  await assert.rejects(() => database.createLinkRoom({
    id: 'blocked-room', accountId: host.accountId, romId: HOST_ROM,
  }), { code: 'PLAY_ADMISSION_LOCKED' });
});

test('concurrent local and remote admissions serialize by account across different ROMs', async () => {
  const { database, service } = await setup();
  const localRace = await Promise.allSettled([
    service.create({
      player1: host, player2: guest, player2Mode: 'account',
      player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
    }),
    service.create({
      player1: host, player2: { ...guest, accountId: 'guest-2', subject: 'guest-2' },
      player2Mode: 'account', player1RomId: GUEST_ROM, player2RomId: HOST_ROM,
    }),
  ]);
  assert.equal(localRace.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(localRace.find((item) => item.status === 'rejected').reason.code,
    'PLAY_ADMISSION_LOCKED');
  const local = localRace.find((item) => item.status === 'fulfilled').value;
  await service.abort({ id: local.id, player1: host });

  const crossMode = await Promise.allSettled([
    database.createLinkRoom({ id: 'remote-race', accountId: host.accountId, romId: HOST_ROM }),
    service.create({
      player1: host, player2: guest, player2Mode: 'account',
      player1RomId: GUEST_ROM, player2RomId: HOST_ROM,
    }),
  ]);
  assert.equal(crossMode.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(crossMode.find((item) => item.status === 'rejected').reason.code,
    'PLAY_ADMISSION_LOCKED');
});

test('expired and terminal local sessions reject mutation and renewed leases survive stale cleanup', async () => {
  const { database, service } = await setup();
  const session = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  await database.updateLocalLinkSession(session.id, {
    expectedStatuses: ['preparing'], leaseExpiresAt: 20_000,
  }, 2_000);
  assert.equal(await database.abortLocalLinkSession(
    session.id, 10_000, { onlyIfExpired: true },
  ), null);
  assert.equal((await database.getLocalLinkSession(session.id)).status, 'preparing');
  await assert.rejects(() => database.updateLocalLinkSession(session.id, {
    expectedStatuses: ['preparing'], status: 'ready',
  }, 21_000), { code: 'LOCAL_SESSION_EXPIRED' });
  await database.abortLocalLinkSession(session.id, 21_000);
  await assert.rejects(() => database.updateLocalLinkSession(session.id, {
    expectedStatuses: ['preparing'], status: 'ready',
  }, 21_001), { code: 'LOCAL_STATE_INVALID' });
  assert.equal(database.playAdmissionLocks.size, 0);
});

test('stale get cleanup refetches a session renewed before conditional expiry abort', async () => {
  const { database, service } = await setup();
  const session = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  const racingService = new LocalLinkService({
    database, now: () => 7_000, leaseMs: 5_000,
    timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
  });
  const originalAbort = database.abortLocalLinkSession.bind(database);
  database.abortLocalLinkSession = async (id, now, options) => {
    database.localLinkSessions.get(id).leaseExpiresAt = 12_000;
    return originalAbort(id, now, options);
  };
  const renewed = await racingService.get({ id: session.id, player1: host, player2: guest });
  assert.equal(renewed.leaseExpiresAt, 12_000);
  assert.equal(renewed.status, 'preparing');
});

test('local checkpoints are strictly monotonic, bounded to one pair, and restore cable metadata', async () => {
  const { database, service } = await setup();
  const session = await service.create({
    player1: host, player2: guest, player2Mode: 'account',
    player1RomId: HOST_ROM, player2RomId: GUEST_ROM,
  });
  await service.setReady({ id: session.id, slot: 0, player1: host, player2: guest });
  await service.setReady({ id: session.id, slot: 1, player1: host, player2: guest });
  const states = [
    { slot: 0, data: Buffer.from('state-a').toString('base64') },
    { slot: 1, data: Buffer.from('state-b').toString('base64') },
  ];
  await assert.rejects(() => service.checkpoint({
    id: session.id, sequence: 0, states: states.slice(0, 1), player1: host, player2: guest,
  }), { code: 'LOCAL_PAIR_INVALID' });
  const firstMetadata = {
    guestHandshakePending: true, lastPairSequence: 4, lastReleaseSequence: 3,
  };
  await service.checkpoint({
    id: session.id, sequence: 0, states, player1: host, player2: guest,
    metadata: firstMetadata,
  });
  const retry = await service.checkpoint({
    id: session.id, sequence: 0, states, player1: host, player2: guest,
    metadata: firstMetadata,
  });
  assert.equal(retry.sequence, 0);
  await assert.rejects(() => service.checkpoint({
    id: session.id, sequence: 0, states, player1: host, player2: guest,
  }), { code: 'LOCAL_CHECKPOINT_REPLAY_CONFLICT' });
  await assert.rejects(() => service.checkpoint({
    id: session.id, sequence: 2, states, player1: host, player2: guest,
  }), { code: 'LOCAL_CHECKPOINT_SEQUENCE' });
  await service.checkpoint({
    id: session.id, sequence: 1, states, player1: host, player2: guest,
    metadata: { guestHandshakePending: false, lastPairSequence: 5, lastReleaseSequence: 5 },
  });
  assert.equal(database.localLinkCheckpoints.size, 2);
  const updated = await database.getLocalLinkSession(session.id);
  assert.equal(updated.lastCheckpointSequence, 1);
  assert.equal(updated.guestHandshakePending, false);
  assert.equal(updated.lastPairSequence, 5);
  assert.equal(updated.lastReleaseSequence, 5);
  await service.abort({ id: session.id, player1: host });
  assert.equal(database.localLinkCheckpoints.size, 0);
});
