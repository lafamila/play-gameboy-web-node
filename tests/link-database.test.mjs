import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryDatabase } from '../lib/database.mjs';

const FIRE_RED_ROM_ID = 'a'.repeat(64);
const LEAF_GREEN_ROM_ID = 'b'.repeat(64);
const ROM_ID = FIRE_RED_ROM_ID;

async function databaseWithRom() {
  const database = new MemoryDatabase();
  for (const [id, filename, title, gameCode] of [
    [FIRE_RED_ROM_ID, 'fire-red.gba', 'FIRE RED', 'BPRE'],
    [LEAF_GREEN_ROM_ID, 'leaf-green.gba', 'LEAF GREEN', 'BPGE'],
  ]) {
    await database.upsertRom({
      id,
      platform: 'gba',
      filename,
      title,
      gameCode,
      romIdentity: title,
      revision: 0,
      size: 1,
      path: `/tmp/${filename}`,
      source: 'uploaded',
    });
  }
  return database;
}

test('two-player link rooms track participant state and lock battery saves', async () => {
  const database = await databaseWithRom();
  await database.putSave('host', FIRE_RED_ROM_ID, 'battery', Buffer.from('host-before'), 10);
  await database.putSave('guest', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('guest-before'), 11);

  const created = await database.createLinkRoom({
    id: 'room-1',
    romId: FIRE_RED_ROM_ID,
    accountId: 'host',
    inviteHash: 'sha256:invite',
    coreVersion: 'vba-link-1.7.2',
    protocolVersion: 'cable-v1',
    gameGroup: 'pokemon-gen3-kanto',
    expiresAt: 1_000,
    now: 20,
  });
  assert.equal(created.status, 'waiting');
  assert.deepEqual({
    romId: created.romId,
    inviteHash: created.inviteHash,
    coreVersion: created.coreVersion,
    protocolVersion: created.protocolVersion,
    gameGroup: created.gameGroup,
    expiresAt: created.expiresAt,
  }, {
    romId: FIRE_RED_ROM_ID,
    inviteHash: 'sha256:invite',
    coreVersion: 'vba-link-1.7.2',
    protocolVersion: 'cable-v1',
    gameGroup: 'pokemon-gen3-kanto',
    expiresAt: 1_000,
  });
  assert.deepEqual(created.participants.map(({ accountId, romId, slot, saveRevision }) => ({
    accountId, romId, slot, saveRevision,
  })), [{ accountId: 'host', romId: FIRE_RED_ROM_ID, slot: 0, saveRevision: 1 }]);

  const joined = await database.joinLinkRoom('room-1', {
    accountId: 'guest',
    romId: LEAF_GREEN_ROM_ID,
  }, 21);
  assert.equal(joined.status, 'ready');
  assert.deepEqual(joined.participants.map(({ accountId, romId, slot }) => ({ accountId, romId, slot })), [
    { accountId: 'host', romId: FIRE_RED_ROM_ID, slot: 0 },
    { accountId: 'guest', romId: LEAF_GREEN_ROM_ID, slot: 1 },
  ]);
  await assert.rejects(
    database.putSave('host', FIRE_RED_ROM_ID, 'battery', Buffer.from('blocked')),
    { code: 'SAVE_LOCKED' },
  );
  await assert.rejects(
    database.putSave('guest', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('blocked')),
    { code: 'SAVE_LOCKED' },
  );
  await database.putSave('host', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('host-other-rom'), 22);
  await database.putSave('guest', FIRE_RED_ROM_ID, 'battery', Buffer.from('guest-other-rom'), 22);
  await database.putSave('host', FIRE_RED_ROM_ID, 'state', Buffer.from('quick-state'), 22);

  await database.setLinkParticipantState('room-1', 'host', { ready: true, connected: true }, 23);
  const active = await database.updateLinkRoomStatus('room-1', 'active', 24);
  assert.equal(active.status, 'active');
  assert.deepEqual(active.participants[0], {
    accountId: 'host',
    romId: FIRE_RED_ROM_ID,
    slot: 0,
    ready: true,
    connected: true,
    saveRevision: 1,
    joinedAt: 20,
    updatedAt: 23,
  });
});

test('link checkpoints are exposed only as complete participant pairs', async () => {
  const database = await databaseWithRom();
  await database.createLinkRoom({ id: 'room-1', romId: ROM_ID, accountId: 'host', now: 10 });
  await database.joinLinkRoom('room-1', 'guest', 11);
  assert.deepEqual(
    (await database.getLinkRoom('room-1')).participants.map(({ accountId, romId }) => ({ accountId, romId })),
    [
      { accountId: 'host', romId: ROM_ID },
      { accountId: 'guest', romId: ROM_ID },
    ],
  );

  assert.equal(
    await database.putLinkCheckpoint('room-1', 'host', 7, Buffer.from('host-checkpoint'), 20),
    null,
  );
  const pair = await database.putLinkCheckpoint(
    'room-1', 'guest', 7, Buffer.from('guest-checkpoint'), 21,
  );
  assert.equal(pair.sequence, 7);
  assert.deepEqual(
    pair.checkpoints.map(({ accountId, payload }) => [accountId, payload.toString()]),
    [['host', 'host-checkpoint'], ['guest', 'guest-checkpoint']],
  );

  await database.putLinkCheckpointPair('room-1', 8, {
    host: Buffer.from('host-next'),
    guest: Buffer.from('guest-next'),
  }, 22);
  const latest = await database.getLatestLinkCheckpointPair('room-1');
  assert.equal(latest.sequence, 8);
  assert.deepEqual(latest.checkpoints.map(({ payload }) => payload.toString()), ['host-next', 'guest-next']);
  assert.equal(await database.getLinkCheckpointPair('room-1', 7), null);
  await assert.rejects(
    database.putLinkCheckpointPair('room-1', 9, { host: Buffer.from('only-one') }),
    { code: 'LINK_PAIR_INVALID' },
  );
});

test('paired battery commit updates both accounts atomically and releases locks', async () => {
  const database = await databaseWithRom();
  await database.putSave('host', FIRE_RED_ROM_ID, 'battery', Buffer.from('host-before'), 10);
  await database.putSave('guest', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('guest-before'), 11);
  await database.createLinkRoom({
    id: 'room-1', romId: FIRE_RED_ROM_ID, accountId: 'host', now: 20,
  });
  await database.joinLinkRoom('room-1', {
    accountId: 'guest', romId: LEAF_GREEN_ROM_ID,
  }, 21);

  await assert.rejects(
    database.commitPairedBatterySaves('room-1', { host: Buffer.from('missing-guest') }),
    { code: 'LINK_PAIR_INVALID' },
  );
  assert.equal(
    (await database.getSave('host', FIRE_RED_ROM_ID, 'battery')).payload.toString(),
    'host-before',
  );
  await assert.rejects(
    database.putSave('guest', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('still-locked')),
    { code: 'SAVE_LOCKED' },
  );

  const committed = await database.commitPairedBatterySaves('room-1', [
    { accountId: 'host', payload: Buffer.from('host-after') },
    { accountId: 'guest', payload: Buffer.from('guest-after') },
  ], 30);
  assert.deepEqual(committed.saves, [
    { accountId: 'host', revision: 2 },
    { accountId: 'guest', revision: 2 },
  ]);
  assert.equal(
    (await database.getSave('host', FIRE_RED_ROM_ID, 'battery')).payload.toString(),
    'host-after',
  );
  assert.equal(
    (await database.getSave('guest', LEAF_GREEN_ROM_ID, 'battery')).payload.toString(),
    'guest-after',
  );
  assert.equal(await database.getSave('guest', FIRE_RED_ROM_ID, 'battery'), null);
  assert.equal((await database.getLinkRoom('room-1')).status, 'completed');

  await database.putSave('host', FIRE_RED_ROM_ID, 'battery', Buffer.from('host-unlocked'), 31);
  await database.putSave('guest', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('guest-unlocked'), 32);
  assert.equal(
    (await database.getSave('host', FIRE_RED_ROM_ID, 'battery')).payload.toString(),
    'host-unlocked',
  );
});

test('save revision conflicts leave both paired saves unchanged', async () => {
  const database = await databaseWithRom();
  await database.putSave('host', FIRE_RED_ROM_ID, 'battery', Buffer.from('host-before'));
  await database.putSave('guest', LEAF_GREEN_ROM_ID, 'battery', Buffer.from('guest-before'));
  await database.createLinkRoom({ id: 'room-1', romId: FIRE_RED_ROM_ID, accountId: 'host' });
  await database.joinLinkRoom('room-1', {
    accountId: 'guest', romId: LEAF_GREEN_ROM_ID,
  });

  database.saves.get(database.saveKey('guest', LEAF_GREEN_ROM_ID, 'battery')).revision += 1;
  await assert.rejects(database.commitPairedBatterySaves('room-1', {
    host: Buffer.from('host-after'),
    guest: Buffer.from('guest-after'),
  }), { code: 'SAVE_REVISION_CONFLICT' });
  assert.equal(
    (await database.getSave('host', FIRE_RED_ROM_ID, 'battery')).payload.toString(),
    'host-before',
  );
  assert.equal(
    (await database.getSave('guest', LEAF_GREEN_ROM_ID, 'battery')).payload.toString(),
    'guest-before',
  );
});

test('a terminal room releases locks for a later room', async () => {
  const database = await databaseWithRom();
  await database.createLinkRoom({ id: 'room-1', romId: ROM_ID, accountId: 'host' });
  await assert.rejects(
    database.createLinkRoom({ id: 'room-2', romId: ROM_ID, accountId: 'host' }),
    { code: 'SAVE_LOCKED' },
  );
  assert.equal(await database.getLinkRoom('room-2'), null);

  await database.updateLinkRoomStatus('room-1', 'aborted');
  const replacement = await database.createLinkRoom({
    id: 'room-2', romId: ROM_ID, accountId: 'host', now: 50,
  });
  assert.equal(replacement.createdBy, 'host');
});
