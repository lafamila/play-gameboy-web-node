import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryDatabase } from '../lib/database.mjs';
import { LinkService, compatibilityForRom } from '../lib/link-service.mjs';

const hostRom = {
  id: 'a'.repeat(64), platform: 'gba', gameCode: 'BPRK', title: 'FireRed', filename: 'fire.gba',
};
const guestRom = {
  id: 'b'.repeat(64), platform: 'gba', gameCode: 'BPGK', title: 'LeafGreen', filename: 'leaf.gba',
};

async function setup() {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  await database.upsertRom(guestRom);
  await database.putSave('host', hostRom.id, 'battery', Buffer.alloc(131072, 1), 1);
  await database.putSave('guest', guestRom.id, 'battery', Buffer.alloc(131072, 2), 1);
  const service = new LinkService({ database, now: () => 1000 });
  const created = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  await service.joinRoom({
    roomId: created.room.id,
    accountId: 'guest',
    inviteCode: created.inviteCode,
    romId: guestRom.id,
  });
  return { database, service, roomId: created.room.id, inviteCode: created.inviteCode };
}

test('Pokemon Gen 3 ROMs in the same region share a cable compatibility group', () => {
  assert.equal(compatibilityForRom(hostRom).gameGroup, 'pokemon-gen3:K');
  assert.deepEqual(compatibilityForRom(hostRom), compatibilityForRom(guestRom));
  assert.notEqual(
    compatibilityForRom(hostRom).gameGroup,
    compatibilityForRom({ ...guestRom, gameCode: 'BPGE' }).gameGroup,
  );
});

test('two accounts ready and exchange one virtual cable transfer', async () => {
  const { service, roomId } = await setup();
  assert.equal((await service.setReady({ roomId, accountId: 'host', ready: true })).status, 'waiting');
  assert.equal((await service.setReady({ roomId, accountId: 'guest', ready: true })).status, 'ready');
  assert.equal((await service.startRoom({ roomId, accountId: 'host' })).status, 'active');

  const messages = [];
  service.on('message', (event) => messages.push(event));
  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'link-offer', sequence: 0, speed: 3, data: 0x1234 },
  });
  await service.handleMessage({
    roomId,
    accountId: 'guest',
    message: { type: 'link-response', sequence: 0, speed: 3, data: 0xabcd },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(messages.some((event) => event.targetAccountId === 'guest' && event.message.type === 'link-offer'));
  assert.deepEqual(messages.find((event) => event.message.type === 'link-pair').message, {
    type: 'link-pair', sequence: 0, speed: 3, masterData: 0x1234, slaveData: 0xabcd,
  });
  messages.length = 0;
  await service.handleMessage({
    roomId, accountId: 'guest', message: { type: 'sync', sequence: 0 },
  });
  assert.deepEqual(messages[0], {
    roomId,
    targetAccountId: 'guest',
    message: { type: 'link-pair', sequence: 0, speed: 3, masterData: 0x1234, slaveData: 0xabcd },
  });
});

test('battery saves commit as one participant-specific ROM pair', async () => {
  const { database, service, roomId } = await setup();
  await service.setReady({ roomId, accountId: 'host', ready: true });
  await service.setReady({ roomId, accountId: 'guest', ready: true });
  await service.startRoom({ roomId, accountId: 'host' });

  const hostBattery = Buffer.alloc(131072, 3);
  const guestBattery = Buffer.alloc(131072, 4);
  assert.deepEqual(
    await service.submitBattery({ roomId, accountId: 'host', payload: hostBattery }),
    { status: 'finishing', submitted: 1 },
  );
  const completed = await service.submitBattery({ roomId, accountId: 'guest', payload: guestBattery });
  assert.equal(completed.status, 'completed');
  assert.deepEqual((await database.getSave('host', hostRom.id, 'battery')).payload, hostBattery);
  assert.deepEqual((await database.getSave('guest', guestRom.id, 'battery')).payload, guestBattery);
});

test('service startup aborts unrecoverable in-process rooms and releases save locks', async () => {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  await database.createLinkRoom({ id: 'old-room', accountId: 'host', romId: hostRom.id });
  const service = new LinkService({ database, now: () => 5000 });
  assert.deepEqual(await service.initialize(), ['old-room']);
  assert.equal((await database.getLinkRoom('old-room')).status, 'aborted');
  const next = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  assert.equal(next.room.status, 'waiting');
});
