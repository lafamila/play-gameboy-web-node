import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';

import { createDatabase } from '../lib/database.mjs';
import { smokeDatabaseName } from '../lib/smoke-database-name.mjs';

if (process.env.MARIADB_SMOKE !== '1') {
  console.log('MariaDB smoke skipped (set MARIADB_SMOKE=1)');
  process.exit(0);
}

const host = process.env.MARIADB_SMOKE_HOST ?? '127.0.0.1';
const port = Number(process.env.MARIADB_SMOKE_PORT ?? 43307);
const user = process.env.MARIADB_SMOKE_USER ?? 'root';
const password = process.env.MARIADB_SMOKE_PASSWORD ?? 'test';
const name = smokeDatabaseName(process.env.MARIADB_SMOKE_DATABASE);

const config = { driver: 'mariadb', host, port, user, password, name };
const admin = await mysql.createConnection({ host, port, user, password });
const ROM_A = 'a'.repeat(64);
const ROM_B = 'b'.repeat(64);

try {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`USE \`${name}\``);
  await admin.query(`CREATE TABLE roms (
    id CHAR(64) PRIMARY KEY, filename VARCHAR(255) NOT NULL, title VARCHAR(64) NOT NULL,
    game_code VARCHAR(8) NOT NULL, rom_identity VARCHAR(32) NOT NULL,
    revision SMALLINT UNSIGNED NOT NULL, size BIGINT UNSIGNED NOT NULL,
    storage_path TEXT NOT NULL, source ENUM('fixture','uploaded') NOT NULL,
    created_by VARCHAR(128) NULL, created_at BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`);
  await admin.query(`INSERT INTO roms
    (id,filename,title,game_code,rom_identity,revision,size,storage_path,source,created_at)
    VALUES (?, 'a.gba', 'A', 'BPRE', 'A', 0, 1024, '/tmp/a', 'fixture', 1),
           (?, 'b.gba', 'B', 'BPGE', 'B', 0, 1024, '/tmp/b', 'fixture', 1)`,
  [ROM_A, ROM_B]);
  await admin.query(`CREATE TABLE account_saves (
    account_id VARCHAR(128) NOT NULL, rom_id CHAR(64) NOT NULL,
    kind ENUM('state','battery') NOT NULL, payload MEDIUMBLOB NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL, revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY(account_id,rom_id,kind),
    CONSTRAINT account_saves_rom_fk FOREIGN KEY(rom_id) REFERENCES roms(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await admin.execute(
    `INSERT INTO account_saves VALUES ('legacy-account', ?, 'battery', ?, 123, 7)`,
    [ROM_A, Buffer.from('legacy-payload')],
  );
  await admin.query(`CREATE TABLE link_rooms (
    id VARCHAR(64) PRIMARY KEY, rom_id CHAR(64) NOT NULL, status VARCHAR(32) NOT NULL,
    created_by VARCHAR(128) NOT NULL, created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    CONSTRAINT link_rooms_rom_fk FOREIGN KEY(rom_id) REFERENCES roms(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await admin.query(`CREATE TABLE link_save_locks (
    account_id VARCHAR(128) NOT NULL, rom_id CHAR(64) NOT NULL,
    room_id VARCHAR(64) NOT NULL, save_revision BIGINT UNSIGNED NOT NULL,
    locked_at BIGINT UNSIGNED NOT NULL, PRIMARY KEY(account_id,rom_id),
    CONSTRAINT smoke_lock_room_fk FOREIGN KEY(room_id) REFERENCES link_rooms(id) ON DELETE CASCADE,
    CONSTRAINT smoke_lock_rom_fk FOREIGN KEY(rom_id) REFERENCES roms(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await admin.execute(`INSERT INTO link_rooms
    (id,rom_id,status,created_by,created_at,updated_at)
    VALUES ('legacy-room', ?, 'aborted', 'legacy-account', 1, 1)`, [ROM_A]);
  await admin.execute(`INSERT INTO link_save_locks VALUES
    ('legacy-account', ?, 'legacy-room', 7, 1)`, [ROM_A]);

  const migrations = await Promise.all([createDatabase(config), createDatabase(config)]);
  await Promise.all(migrations.map((database) => database.close()));
  const repeated = await createDatabase(config);

  const [legacy] = await repeated.pool.execute(
    `SELECT profile_key AS profileKey, payload, revision FROM account_saves
     WHERE account_id='legacy-account' AND rom_id=? AND kind='battery'`,
    [ROM_A],
  );
  assert.equal(legacy[0].profileKey, 'primary');
  assert.deepEqual(Buffer.from(legacy[0].payload), Buffer.from('legacy-payload'));
  assert.equal(legacy[0].revision, 7);
  const [savePk] = await repeated.pool.execute(
    `SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='account_saves' AND CONSTRAINT_NAME='PRIMARY'
     ORDER BY ORDINAL_POSITION`, [name],
  );
  assert.deepEqual(savePk.map((item) => item.name), ['account_id', 'profile_key', 'rom_id', 'kind']);
  const [lockPk] = await repeated.pool.execute(
    `SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='link_save_locks' AND CONSTRAINT_NAME='PRIMARY'
     ORDER BY ORDINAL_POSITION`, [name],
  );
  assert.deepEqual(lockPk.map((item) => item.name), ['account_id', 'profile_key', 'rom_id']);
  const [foreignKeys] = await repeated.pool.execute(
    `SELECT TABLE_NAME AS tableName, COUNT(*) AS count
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=? AND CONSTRAINT_TYPE='FOREIGN KEY'
       AND TABLE_NAME IN ('account_saves','link_save_locks','local_save_locks')
     GROUP BY TABLE_NAME`, [name],
  );
  assert.deepEqual(Object.fromEntries(foreignKeys.map((item) => [item.tableName, item.count])), {
    account_saves: 1,
    link_save_locks: 2,
    local_save_locks: 2,
  });
  await repeated.pool.execute(`DELETE FROM link_save_locks WHERE room_id='legacy-room'`);

  const now = Date.now();
  const makeLocal = (id, secondAccount, firstRom, secondRom) => repeated.createLocalLinkSession({
    id, ownerAccountId: 'race-owner', player2AccountId: secondAccount,
    player2Mode: 'account', leaseExpiresAt: now + 60_000, now,
    participants: [
      { slot: 0, accountId: 'race-owner', profileKey: 'primary', romId: firstRom },
      { slot: 1, accountId: secondAccount, profileKey: 'primary', romId: secondRom },
    ],
  });
  const race = await Promise.allSettled([
    makeLocal('race-local-a', 'race-p2-a', ROM_A, ROM_B),
    makeLocal('race-local-b', 'race-p2-b', ROM_B, ROM_A),
  ]);
  assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(race.find((item) => item.status === 'rejected').reason.code, 'PLAY_ADMISSION_LOCKED');
  const winner = race.find((item) => item.status === 'fulfilled').value;
  await repeated.updateLocalLinkSession(winner.id, {
    expectedStatuses: ['preparing'], status: 'finishing',
  }, now + 1);
  const first = winner.participants[0];
  await repeated.pool.execute(
    `INSERT INTO account_saves
      (account_id,profile_key,rom_id,kind,payload,updated_at,revision)
     VALUES (?,? ,?,'battery',?, ?, 1)
     ON DUPLICATE KEY UPDATE payload=VALUES(payload), revision=revision+1`,
    [winner.participants[1].accountId, 'primary', winner.participants[1].romId,
      Buffer.from('conflict'), now + 2],
  );
  await assert.rejects(() => repeated.commitLocalBatteryPair(winner.id, [
    { slot: 0, payload: Buffer.alloc(256, 1) },
    { slot: 1, payload: Buffer.alloc(256, 2) },
  ], now + 3), { code: 'SAVE_REVISION_CONFLICT' });
  assert.equal(await repeated.getSave(first.accountId, first.romId, 'battery', first.profileKey), null);
  await repeated.abortLocalLinkSession(winner.id, now + 4);

  const crossMode = await Promise.allSettled([
    repeated.createLinkRoom({ id: 'race-remote-cross', accountId: 'race-owner', romId: ROM_A,
      now: now + 5 }),
    makeLocal('race-local-cross', 'race-p2-cross', ROM_B, ROM_A),
  ]);
  assert.equal(crossMode.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(crossMode.find((item) => item.status === 'rejected').reason.code,
    'PLAY_ADMISSION_LOCKED');
  if (await repeated.getLinkRoom('race-remote-cross')) {
    await repeated.abortLinkRoom('race-remote-cross', now + 6);
  } else {
    await repeated.abortLocalLinkSession('race-local-cross', now + 6);
  }
  await repeated.createLinkRoom({
    id: 'remote-ready-race', accountId: 'ready-race-owner', romId: ROM_A, now: now + 7,
  });
  await Promise.allSettled([
    repeated.setLinkReadyState(
      'remote-ready-race', 'ready-race-owner', true, 'waiting', ['waiting', 'ready'], now + 8,
    ),
    repeated.abortLinkRoom('remote-ready-race', now + 8),
  ]);
  assert.equal((await repeated.getLinkRoom('remote-ready-race')).status, 'aborted');
  await assert.rejects(() => repeated.setLinkReadyState(
    'remote-ready-race', 'ready-race-owner', true, 'ready', ['waiting', 'ready'], now + 9,
  ), { code: 'LINK_ROOM_STATE_CONFLICT' });

  await repeated.createLinkRoom({
    id: 'remote-start-race', accountId: 'start-race-owner', romId: ROM_A, now: now + 10,
  });
  await repeated.joinLinkRoom('remote-start-race', {
    accountId: 'start-race-guest', romId: ROM_A,
  }, now + 11);
  await Promise.allSettled([
    repeated.updateLinkRoomStatus('remote-start-race', 'active', now + 12, ['ready']),
    repeated.abortLinkRoom('remote-start-race', now + 12),
  ]);
  assert.equal((await repeated.getLinkRoom('remote-start-race')).status, 'aborted');
  await assert.rejects(() => repeated.updateLinkRoomStatus(
    'remote-start-race', 'active', now + 13, ['ready'],
  ), { code: 'LINK_ROOM_STATE_CONFLICT' });
  const [admissions] = await repeated.pool.query('SELECT * FROM play_admission_locks');
  assert.equal(admissions.length, 0);
  await repeated.close();
  console.log(JSON.stringify({ migrationConcurrency: 'passed', legacyPreservation: 'passed',
    admissionRace: 'passed', pairedRollback: 'passed' }));
} finally {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
}
