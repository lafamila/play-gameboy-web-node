import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryDatabase } from '../lib/database.mjs';
import {
  LINK_CORE_VERSION,
  LINK_PROTOCOL_VERSION,
  LinkService,
  compatibilityForRom,
} from '../lib/link-service.mjs';

const hostRom = {
  id: 'a'.repeat(64), platform: 'gba', gameCode: 'BPRK', title: 'FireRed', filename: 'fire.gba',
};
const guestRom = {
  id: 'b'.repeat(64), platform: 'gba', gameCode: 'BPGK', title: 'LeafGreen', filename: 'leaf.gba',
};

async function setup(serviceOptions = {}) {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  await database.upsertRom(guestRom);
  await database.putSave('host', hostRom.id, 'battery', Buffer.alloc(131072, 1), 1);
  await database.putSave('guest', hostRom.id, 'battery', Buffer.alloc(131072, 2), 1);
  const service = new LinkService({ database, now: () => 1000, ...serviceOptions });
  const created = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  await service.joinRoom({
    roomId: created.room.id,
    accountId: 'guest',
    inviteCode: created.inviteCode,
    romId: hostRom.id,
  });
  return { database, service, roomId: created.room.id, inviteCode: created.inviteCode };
}

async function activate(service, roomId) {
  await service.setReady({ roomId, accountId: 'host', ready: true });
  await service.setReady({ roomId, accountId: 'guest', ready: true });
  await service.startRoom({ roomId, accountId: 'host' });
}

function sioEnvelope(overrides = {}) {
  return {
    sequence: 0,
    mode: 2,
    bits: 16,
    speed: 3,
    initiatorSlot: 0,
    data: 0x1234,
    ticks: 8520,
    ...overrides,
  };
}

function fakeTimers() {
  const pending = new Set();
  return {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
      pending.delete(timer);
    },
    active() {
      return [...pending];
    },
    async runAll() {
      const timers = [...pending];
      pending.clear();
      for (const timer of timers) {
        if (!timer.cleared) await timer.callback();
      }
    },
  };
}

test('GBA ROM compatibility uses one generic SIO v3 capability', () => {
  const compatibility = compatibilityForRom(hostRom);
  assert.equal(LINK_CORE_VERSION, 'vba-1.7.2-generic-sio-v3');
  assert.equal(LINK_PROTOCOL_VERSION, 'gba-sio-v3');
  assert.equal(compatibility.gameGroup, 'gba-sio');
  assert.deepEqual(compatibility, compatibilityForRom({ ...hostRom, gameCode: 'AX4E' }));
  assert.deepEqual(compatibility, compatibilityForRom({ ...hostRom, id: guestRom.id }));
});

test('room admission lets the ROMs negotiate compatibility over the generic cable', async () => {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  await database.upsertRom(guestRom);
  const service = new LinkService({ database, now: () => 1000 });
  const created = await service.createRoom({ accountId: 'host', romId: hostRom.id });

  const joined = await service.joinRoom({
    roomId: created.room.id,
    accountId: 'guest',
    inviteCode: created.inviteCode,
    romId: guestRom.id,
  });
  assert.equal(joined.participants[1].romId, guestRom.id);
});

test('Single-Pak guest joins without ROM/save lock and host finalizes independently', async () => {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  const hostBefore = Buffer.alloc(256, 0x11);
  const guestBefore = Buffer.alloc(256, 0x22);
  await database.putSave('host', hostRom.id, 'battery', hostBefore, 1);
  await database.putSave('guest', hostRom.id, 'battery', guestBefore, 1);
  const service = new LinkService({ database, now: () => 1000 });
  const created = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  const roomId = created.room.id;
  const joined = await service.joinRoom({
    roomId,
    accountId: 'guest',
    inviteCode: created.inviteCode,
    bootKind: 'multiboot-client',
  });
  assert.deepEqual(joined.participants.map((participant) => ({
    slot: participant.slot,
    bootKind: participant.bootKind,
    romId: participant.romId,
  })), [
    { slot: 0, bootKind: 'cartridge', romId: hostRom.id },
    { slot: 1, bootKind: 'multiboot-client', romId: null },
  ]);
  assert.equal(database.linkSaveLocks.size, 1);
  assert.equal(database.playAdmissionLocks.size, 2);

  await activate(service, roomId);
  const messages = [];
  service.on('message', (event) => messages.push(event));
  await service.handleMessage({
    roomId,
    accountId: 'guest',
    message: { type: 'sio-state', mode: 15, siocnt: 0x0008, rcnt: 0x0007, epoch: 1 },
  });
  assert.ok(messages.some((event) => event.targetAccountId === 'host' &&
    event.message.type === 'sio-state' && event.message.mode === 15));
  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'checkpoint', sequence: 0, state: Buffer.from('host-state').toString('base64') },
  });
  assert.ok(messages.some((event) => event.message.type === 'checkpoint-saved'));
  assert.equal((await database.getLatestLinkCheckpointPair(roomId)).checkpoints.length, 1);
  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'guest',
    message: { type: 'checkpoint', sequence: 1, state: Buffer.from('guest-state').toString('base64') },
  }), { code: 'CHECKPOINT_NOT_APPLICABLE' });
  await assert.rejects(service.submitBattery({
    roomId, accountId: 'guest', payload: Buffer.alloc(256, 0x33),
  }), { code: 'BATTERY_NOT_APPLICABLE' });

  const hostAfter = Buffer.alloc(256, 0x44);
  const completed = await service.submitBattery({
    roomId, accountId: 'host', payload: hostAfter,
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual((await database.getSave('host', hostRom.id, 'battery')).payload, hostAfter);
  assert.deepEqual((await database.getSave('guest', hostRom.id, 'battery')).payload, guestBefore);
  assert.equal(database.linkSaveLocks.size, 0);
  assert.equal(database.playAdmissionLocks.size, 0);
});

test('remote join validates bootKind and rejects ROM-backed multiboot clients', async () => {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  const service = new LinkService({ database, now: () => 1000 });
  const created = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  const input = {
    roomId: created.room.id,
    accountId: 'guest',
    inviteCode: created.inviteCode,
  };
  await assert.rejects(service.joinRoom({ ...input, bootKind: 'bios' }), {
    code: 'BOOT_KIND_INVALID',
  });
  await assert.rejects(service.joinRoom({
    ...input, bootKind: 'multiboot-client', romId: hostRom.id,
  }), { code: 'MULTIBOOT_ROM_INVALID' });
  await assert.rejects(service.joinRoom({ ...input, bootKind: 'cartridge' }), {
    code: 'ROM_NOT_FOUND',
  });

  const joined = await service.joinRoom({ ...input, bootKind: 'multiboot-client' });
  assert.equal(joined.participants[1].bootKind, 'multiboot-client');
});

test('aborting a Single-Pak room releases host save and both admission locks', async () => {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  const service = new LinkService({ database, now: () => 1000 });
  const created = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  await service.joinRoom({
    roomId: created.room.id,
    accountId: 'guest',
    inviteCode: created.inviteCode,
    bootKind: 'multiboot-client',
  });
  await service.abortRoom({ roomId: created.room.id, accountId: 'guest', reason: 'cancelled' });
  assert.equal(database.linkSaveLocks.size, 0);
  assert.equal(database.playAdmissionLocks.size, 0);
  await database.putSave('host', hostRom.id, 'battery', Buffer.alloc(256, 1));
});

test('two accounts ready and exchange one generic Multiplayer SIO transfer', async () => {
  const { database, service, roomId } = await setup();
  await activate(service, roomId);

  const messages = [];
  service.on('message', (event) => messages.push(event));
  let persistedRoomReads = 0;
  const getLinkRoom = database.getLinkRoom.bind(database);
  database.getLinkRoom = async (...args) => {
    ++persistedRoomReads;
    return getLinkRoom(...args);
  };
  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'sio-offer', ...sioEnvelope() },
  });
  await service.handleMessage({
    roomId,
    accountId: 'guest',
    message: { type: 'sio-response', ...sioEnvelope({ data: 0xabcd }) },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistedRoomReads, 0, 'word transfers must not query persistent room state');
  assert.ok(messages.some((event) => event.targetAccountId === 'guest' && event.message.type === 'sio-offer'));
  assert.deepEqual(messages.find((event) => event.message.type === 'sio-pair').message, {
    type: 'sio-pair',
    sequence: 0,
    mode: 2,
    bits: 16,
    speed: 3,
    initiatorSlot: 0,
    ticks: 8520,
    dataBySlot: [0x1234, 0xabcd],
  });
  messages.length = 0;
  await service.handleMessage({
    roomId, accountId: 'guest', message: { type: 'sync', sequence: 0 },
  });
  assert.deepEqual(messages[0], {
    roomId,
    targetAccountId: 'guest',
    message: {
      type: 'sio-pair',
      sequence: 0,
      mode: 2,
      bits: 16,
      speed: 3,
      initiatorSlot: 0,
      ticks: 8520,
      dataBySlot: [0x1234, 0xabcd],
    },
  });
});

test('slot 1 can initiate Normal32 and sync relays its pending offer to slot 0', async () => {
  const { service, roomId } = await setup();
  await activate(service, roomId);
  const messages = [];
  service.on('message', (event) => messages.push(event));
  const offer = {
    type: 'sio-offer',
    ...sioEnvelope({
      mode: 1,
      bits: 32,
      speed: 1,
      initiatorSlot: 1,
      data: 0xfedcba98,
      ticks: 2048,
    }),
  };

  await service.handleMessage({ roomId, accountId: 'guest', message: offer });
  assert.deepEqual(messages[0], {
    roomId,
    targetAccountId: 'host',
    message: offer,
  });
  messages.length = 0;
  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'sync', sequence: 0 },
  });
  assert.deepEqual(messages[0], {
    roomId,
    targetAccountId: 'host',
    message: offer,
  });

  messages.length = 0;
  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { ...offer, type: 'sio-response', data: 0x89abcdef },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.find((event) => event.message.type === 'sio-pair').message, {
    type: 'sio-pair',
    sequence: 0,
    mode: 1,
    bits: 32,
    speed: 1,
    initiatorSlot: 1,
    ticks: 2048,
    dataBySlot: [0x89abcdef, 0xfedcba98],
  });
});

test('slot 1 cannot initiate Multiplayer transfers', async () => {
  const { service, roomId } = await setup();
  await activate(service, roomId);

  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'guest',
    message: {
      type: 'sio-offer',
      ...sioEnvelope({ initiatorSlot: 1 }),
    },
  }), { code: 'INVALID_TRANSFER_ROLE' });
});

test('malformed SIO transfer and state envelopes are rejected', async () => {
  const { service, roomId } = await setup();
  await activate(service, roomId);
  const malformedTransfers = [
    sioEnvelope({ mode: 3 }),
    sioEnvelope({ mode: 0, bits: 16 }),
    sioEnvelope({ speed: 4 }),
    sioEnvelope({ mode: 0, bits: 8, speed: 2 }),
    sioEnvelope({ initiatorSlot: 2 }),
    sioEnvelope({ data: -1 }),
    sioEnvelope({ data: 0x1_0000_0000 }),
    sioEnvelope({ mode: 0, bits: 8, speed: 1, data: 0x100 }),
    sioEnvelope({ ticks: -1 }),
    sioEnvelope({ ticks: 0x8000_0000 }),
    sioEnvelope({ sequence: 0.5 }),
  ];
  for (const envelope of malformedTransfers) {
    await assert.rejects(service.handleMessage({
      roomId,
      accountId: 'host',
      message: { type: 'sio-offer', ...envelope },
    }), { code: 'SIO_TRANSFER_INVALID' });
  }

  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'guest',
    message: { type: 'sio-response', ...sioEnvelope() },
  }), { code: 'INVALID_TRANSFER_ROLE' });
  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'sio-state', mode: 2, siocnt: 0x1_0000, rcnt: 0, epoch: 0 },
  }), { code: 'SIO_STATE_INVALID' });
  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'sio-state', mode: 15, siocnt: 0x0008, rcnt: 0x0007, epoch: 0 },
  }), { code: 'SIO_STATE_INVALID' });
  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'sio-state', mode: 8, siocnt: 0, rcnt: 0x80a0, epoch: 1 },
  });

  await service.handleMessage({
    roomId,
    accountId: 'host',
    message: { type: 'sio-offer', ...sioEnvelope() },
  });
  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'guest',
    message: { type: 'sio-response', ...sioEnvelope({ speed: 2, data: 0xabcd }) },
  }), { code: 'TRANSFER_MISMATCH' });
  await service.abortRoom({ roomId, accountId: 'host', reason: 'test cleanup' });
});

test('SIO state is validated and relayed only to the peer without persistence', async () => {
  const { database, service, roomId } = await setup();
  await activate(service, roomId);
  const messages = [];
  service.on('message', (event) => messages.push(event));
  let persistedCalls = 0;
  const originalCheckpoint = database.putLinkCheckpointPair.bind(database);
  database.putLinkCheckpointPair = async (...args) => {
    persistedCalls += 1;
    return originalCheckpoint(...args);
  };

  await service.handleMessage({
    roomId,
    accountId: 'guest',
    message: {
      type: 'sio-state', mode: 0, siocnt: 0x4081, rcnt: 0x8000, epoch: 7, ignored: true,
    },
  });
  assert.deepEqual(messages, [{
    roomId,
    targetAccountId: 'host',
    message: { type: 'sio-state', mode: 0, siocnt: 0x4081, rcnt: 0x8000, epoch: 7 },
  }]);
  assert.equal(persistedCalls, 0);
});

test('duplicate SIO submissions are idempotent and broadcast each event once', async () => {
  const { service, roomId } = await setup();
  await activate(service, roomId);
  const messages = [];
  service.on('message', (event) => messages.push(event));
  const offer = { type: 'sio-offer', ...sioEnvelope() };
  const response = { type: 'sio-response', ...sioEnvelope({ data: 0xabcd }) };

  await service.handleMessage({ roomId, accountId: 'host', message: offer });
  await service.handleMessage({ roomId, accountId: 'host', message: { ...offer } });
  await assert.rejects(service.handleMessage({
    roomId,
    accountId: 'host',
    message: { ...offer, data: 0x9999 },
  }), { code: 'DUPLICATE_CONFLICT' });
  assert.equal(messages.filter((event) => event.message.type === 'sio-offer').length, 1);

  await service.handleMessage({ roomId, accountId: 'guest', message: response });
  await new Promise((resolve) => setImmediate(resolve));
  await service.handleMessage({ roomId, accountId: 'guest', message: { ...response } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((event) => event.message.type === 'sio-pair').length, 1);
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
  assert.deepEqual((await database.getSave('guest', hostRom.id, 'battery')).payload, guestBattery);
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

test('creating a replacement room aborts the stale runtime room and releases both locks', async () => {
  const { database, service, roomId } = await setup();

  const replacement = await service.createRoom({ accountId: 'host', romId: hostRom.id });
  assert.notEqual(replacement.room.id, roomId);
  assert.equal(replacement.room.status, 'waiting');
  assert.equal((await database.getLinkRoom(roomId)).status, 'aborted');
  assert.equal(service.coordinator.getRoom({ roomId, accountId: 'host' }).status, 'aborted');

  await database.putSave('guest', hostRom.id, 'battery', Buffer.alloc(131072, 5));
  await assert.rejects(
    database.putSave('host', hostRom.id, 'battery', Buffer.alloc(131072, 6)),
    { code: 'SAVE_LOCKED' },
  );
});

test('creating after refresh recovers a stale database-only room lock', async () => {
  const database = new MemoryDatabase();
  await database.upsertRom(hostRom);
  await database.createLinkRoom({
    id: 'stale-database-room', accountId: 'host', romId: hostRom.id, now: 500,
  });
  const refreshedService = new LinkService({ database, now: () => 1_000 });

  const replacement = await refreshedService.createRoom({ accountId: 'host', romId: hostRom.id });
  assert.equal(replacement.room.status, 'waiting');
  assert.equal((await database.getLinkRoom('stale-database-room')).status, 'aborted');
  assert.equal(refreshedService.disconnectGraceMs, 60_000);
});

test('disconnect grace is cancelled on reconnect and later auto-aborts the room', async () => {
  const timers = fakeTimers();
  const { database, service, roomId } = await setup({
    disconnectGraceMs: 1_234,
    timers,
  });
  const messages = [];
  service.on('message', (event) => messages.push(event));

  await service.disconnect({ roomId, accountId: 'guest' });
  assert.equal((await database.getLinkRoom(roomId)).status, 'ready');
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 1_234);
  await assert.rejects(
    database.putSave('guest', hostRom.id, 'battery', Buffer.alloc(131072, 7)),
    { code: 'SAVE_LOCKED' },
  );

  await service.connect({ roomId, accountId: 'guest' });
  assert.equal(timers.active().length, 0);
  await timers.runAll();
  assert.equal((await database.getLinkRoom(roomId)).status, 'ready');

  await service.disconnect({ roomId, accountId: 'guest' });
  await timers.runAll();
  assert.equal((await database.getLinkRoom(roomId)).status, 'aborted');
  assert.equal(timers.active().length, 0);
  assert.ok(messages.some((event) => event.message.type === 'aborted'
    && event.message.reason === 'disconnect grace expired'));
  await database.putSave('host', hostRom.id, 'battery', Buffer.alloc(131072, 8));
  await database.putSave('guest', hostRom.id, 'battery', Buffer.alloc(131072, 9));
});

test('explicit abort clears disconnect timers and releases both locks immediately', async () => {
  const timers = fakeTimers();
  const { database, service, roomId } = await setup({ timers });

  await service.disconnect({ roomId, accountId: 'guest' });
  assert.equal(timers.active().length, 1);
  await service.abortRoom({ roomId, accountId: 'host', reason: 'left room' });
  assert.equal(timers.active().length, 0);
  await timers.runAll();
  assert.equal((await database.getLinkRoom(roomId)).status, 'aborted');
  await database.putSave('host', hostRom.id, 'battery', Buffer.alloc(131072, 10));
  await database.putSave('guest', hostRom.id, 'battery', Buffer.alloc(131072, 11));
});
