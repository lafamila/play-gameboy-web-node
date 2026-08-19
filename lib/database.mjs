import mysql from 'mysql2/promise';

const TERMINAL_LINK_ROOM_STATUSES = new Set(['completed', 'aborted', 'cancelled', 'closed']);

function databaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePairedPayloads(payloads) {
  if (payloads instanceof Map) {
    return [...payloads].map(([accountId, payload]) => ({ accountId, payload }));
  }
  if (Array.isArray(payloads)) return payloads;
  if (payloads && typeof payloads === 'object') {
    return Object.entries(payloads).map(([accountId, payload]) => ({ accountId, payload }));
  }
  throw databaseError('LINK_PAIR_INVALID', 'Paired payloads must identify both accounts');
}

function validateCheckpointSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw databaseError('LINK_CHECKPOINT_INVALID', 'Checkpoint sequence must be a non-negative safe integer');
  }
}

function normalizeLinkParticipant(value, roomRomId) {
  if (typeof value === 'string') return { accountId: value, romId: roomRomId };
  return { accountId: value?.accountId, romId: value?.romId ?? roomRomId };
}

export async function createDatabase(config, options = {}) {
  if (config.driver === 'memory') {
    if (!options.allowMemory) throw new Error('The memory database is test-only');
    return new MemoryDatabase();
  }
  const database = new MariaDbDatabase(config);
  await database.migrate();
  return database;
}

export class MariaDbDatabase {
  constructor(config) {
    if (!/^[A-Za-z0-9_]+$/.test(config.name)) throw new Error('DB_NAME contains unsupported characters');
    this.config = config;
  }

  async migrate() {
    const adminPool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      connectionLimit: 1,
      enableKeepAlive: true,
    });
    await adminPool.query(
      `CREATE DATABASE IF NOT EXISTS \`${this.config.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await adminPool.end();
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.name,
      connectionLimit: 5,
      enableKeepAlive: true,
      timezone: 'Z',
      decimalNumbers: true,
    });
    const statements = [
      `CREATE TABLE IF NOT EXISTS oidc_transactions (
        state VARCHAR(128) PRIMARY KEY,
        verifier_cipher TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at BIGINT UNSIGNED NOT NULL,
        INDEX oidc_transactions_expiry_idx (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS app_sessions (
        session_hash CHAR(64) PRIMARY KEY,
        account_id VARCHAR(128) NOT NULL,
        subject VARCHAR(128) NOT NULL,
        display_name VARCHAR(255) NULL,
        email VARCHAR(320) NULL,
        permission ENUM('visitor', 'user', 'admin', 'superadmin') NOT NULL,
        access_token_cipher MEDIUMTEXT NOT NULL,
        refresh_token_cipher MEDIUMTEXT NOT NULL,
        access_expires_at BIGINT UNSIGNED NOT NULL,
        csrf_token VARCHAR(128) NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        last_seen_at BIGINT UNSIGNED NOT NULL,
        expires_at BIGINT UNSIGNED NOT NULL,
        INDEX app_sessions_account_idx (account_id),
        INDEX app_sessions_expiry_idx (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS roms (
        id CHAR(64) PRIMARY KEY,
        platform ENUM('gba', 'gb', 'gbc') NOT NULL DEFAULT 'gba',
        filename VARCHAR(255) NOT NULL,
        title VARCHAR(64) NOT NULL,
        game_code VARCHAR(8) NOT NULL,
        rom_identity VARCHAR(32) NOT NULL,
        revision SMALLINT UNSIGNED NOT NULL,
        size BIGINT UNSIGNED NOT NULL,
        storage_path TEXT NOT NULL,
        source ENUM('fixture', 'uploaded') NOT NULL,
        created_by VARCHAR(128) NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        INDEX roms_title_idx (title)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS account_saves (
        account_id VARCHAR(128) NOT NULL,
        rom_id CHAR(64) NOT NULL,
        kind ENUM('state', 'battery') NOT NULL,
        payload MEDIUMBLOB NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, rom_id, kind),
        CONSTRAINT account_saves_rom_fk FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS access_requests (
        account_id VARCHAR(128) PRIMARY KEY,
        requested_at BIGINT UNSIGNED NOT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS link_rooms (
        id VARCHAR(64) PRIMARY KEY,
        rom_id CHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'waiting',
        created_by VARCHAR(128) NOT NULL,
        invite_hash VARCHAR(128) NULL,
        core_version VARCHAR(128) NULL,
        protocol_version VARCHAR(64) NULL,
        game_group VARCHAR(64) NULL,
        expires_at BIGINT UNSIGNED NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        INDEX link_rooms_rom_idx (rom_id),
        INDEX link_rooms_status_idx (status),
        CONSTRAINT link_rooms_rom_fk FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS link_room_participants (
        room_id VARCHAR(64) NOT NULL,
        account_id VARCHAR(128) NOT NULL,
        rom_id CHAR(64) NOT NULL,
        slot TINYINT UNSIGNED NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        connected BOOLEAN NOT NULL DEFAULT FALSE,
        save_revision BIGINT UNSIGNED NOT NULL,
        joined_at BIGINT UNSIGNED NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (room_id, account_id),
        UNIQUE KEY link_room_slot_uniq (room_id, slot),
        INDEX link_room_participants_rom_idx (rom_id),
        CONSTRAINT link_room_participants_room_fk
          FOREIGN KEY (room_id) REFERENCES link_rooms(id) ON DELETE CASCADE,
        CONSTRAINT link_room_participants_rom_fk
          FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS link_checkpoints (
        room_id VARCHAR(64) NOT NULL,
        checkpoint_sequence BIGINT UNSIGNED NOT NULL,
        account_id VARCHAR(128) NOT NULL,
        payload MEDIUMBLOB NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (room_id, checkpoint_sequence, account_id),
        CONSTRAINT link_checkpoints_participant_fk
          FOREIGN KEY (room_id, account_id)
          REFERENCES link_room_participants(room_id, account_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS link_save_locks (
        account_id VARCHAR(128) NOT NULL,
        rom_id CHAR(64) NOT NULL,
        room_id VARCHAR(64) NOT NULL,
        save_revision BIGINT UNSIGNED NOT NULL,
        locked_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (account_id, rom_id),
        INDEX link_save_locks_room_idx (room_id),
        CONSTRAINT link_save_locks_room_fk
          FOREIGN KEY (room_id) REFERENCES link_rooms(id) ON DELETE CASCADE,
        CONSTRAINT link_save_locks_rom_fk
          FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
    for (const statement of statements) await this.pool.query(statement);
    await this.pool.query(
      `ALTER TABLE app_sessions
       MODIFY COLUMN permission ENUM('visitor', 'user', 'admin', 'superadmin') NOT NULL`,
    );

    // MySQL 8 does not support MariaDB's ADD COLUMN/INDEX IF NOT EXISTS syntax.
    // Probe information_schema so the same migration remains idempotent on both.
    await this.ensureColumn(
      'roms',
      'platform',
      "ENUM('gba', 'gb', 'gbc') NOT NULL DEFAULT 'gba' AFTER `id`",
    );
    await this.ensureColumn(
      'account_saves',
      'revision',
      'BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `updated_at`',
    );
    await this.ensureColumn('link_rooms', 'invite_hash', 'VARCHAR(128) NULL AFTER `created_by`');
    await this.ensureColumn('link_rooms', 'core_version', 'VARCHAR(128) NULL AFTER `invite_hash`');
    await this.ensureColumn('link_rooms', 'protocol_version', 'VARCHAR(64) NULL AFTER `core_version`');
    await this.ensureColumn('link_rooms', 'game_group', 'VARCHAR(64) NULL AFTER `protocol_version`');
    await this.ensureColumn('link_rooms', 'expires_at', 'BIGINT UNSIGNED NULL AFTER `game_group`');
    await this.ensureColumn('link_room_participants', 'rom_id', 'CHAR(64) NULL AFTER `account_id`');
    await this.pool.query(
      `UPDATE link_room_participants AS participants
       INNER JOIN link_rooms AS rooms ON rooms.id = participants.room_id
       SET participants.rom_id = rooms.rom_id
       WHERE participants.rom_id IS NULL`,
    );
    await this.pool.query(
      'ALTER TABLE link_room_participants MODIFY COLUMN rom_id CHAR(64) NOT NULL',
    );
    await this.ensureIndex(
      'link_room_participants',
      'link_room_participants_rom_idx',
      '(`rom_id`)',
    );
    await this.ensureForeignKey(
      'link_room_participants',
      'link_room_participants_rom_fk',
      'FOREIGN KEY (`rom_id`) REFERENCES `roms` (`id`) ON DELETE CASCADE',
    );
  }

  async ensureColumn(table, column, definition) {
    const [rows] = await this.pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [this.config.name, table, column],
    );
    if (rows.length === 0) {
      await this.pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  }

  async ensureIndex(table, index, definition) {
    const [rows] = await this.pool.execute(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [this.config.name, table, index],
    );
    if (rows.length === 0) {
      await this.pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` ${definition}`);
    }
  }

  async ensureForeignKey(table, constraint, definition) {
    const [rows] = await this.pool.execute(
      `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
         AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
      [this.config.name, table, constraint],
    );
    if (rows.length === 0) {
      await this.pool.query(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` ${definition}`,
      );
    }
  }

  async close() { await this.pool.end(); }

  async putTransaction(transaction) {
    await this.pool.execute(
      `INSERT INTO oidc_transactions (state, verifier_cipher, return_to, expires_at)
       VALUES (?, ?, ?, ?)`,
      [transaction.state, transaction.verifierCipher, transaction.returnTo, transaction.expiresAt],
    );
  }

  async consumeTransaction(state, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM oidc_transactions WHERE state = ? AND expires_at > ? FOR UPDATE',
        [state, now],
      );
      await connection.execute('DELETE FROM oidc_transactions WHERE state = ? OR expires_at <= ?', [state, now]);
      await connection.commit();
      return rows[0] ?? null;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async putSession(session) {
    await this.pool.execute(
      `INSERT INTO app_sessions (
        session_hash, account_id, subject, display_name, email, permission,
        access_token_cipher, refresh_token_cipher, access_expires_at, csrf_token,
        created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        account_id=VALUES(account_id), subject=VALUES(subject), display_name=VALUES(display_name),
        email=VALUES(email), permission=VALUES(permission), access_token_cipher=VALUES(access_token_cipher),
        refresh_token_cipher=VALUES(refresh_token_cipher), access_expires_at=VALUES(access_expires_at),
        csrf_token=VALUES(csrf_token), last_seen_at=VALUES(last_seen_at), expires_at=VALUES(expires_at)`,
      [
        session.sessionHash, session.accountId, session.subject, session.displayName,
        session.email, session.permission, session.accessTokenCipher,
        session.refreshTokenCipher, session.accessExpiresAt, session.csrfToken,
        session.createdAt, session.lastSeenAt, session.expiresAt,
      ],
    );
  }

  async getSession(hash) {
    const [rows] = await this.pool.execute('SELECT * FROM app_sessions WHERE session_hash = ?', [hash]);
    return rows[0] ?? null;
  }

  async touchSession(hash, now) {
    await this.pool.execute('UPDATE app_sessions SET last_seen_at = ? WHERE session_hash = ?', [now, hash]);
  }

  async deleteSession(hash) {
    await this.pool.execute('DELETE FROM app_sessions WHERE session_hash = ?', [hash]);
  }

  async upsertRom(rom) {
    await this.pool.execute(
      `INSERT INTO roms (
        id, platform, filename, title, game_code, rom_identity, revision, size,
        storage_path, source, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        platform=VALUES(platform), filename=VALUES(filename), title=VALUES(title), game_code=VALUES(game_code),
        rom_identity=VALUES(rom_identity), revision=VALUES(revision), size=VALUES(size),
        storage_path=IF(source='fixture', storage_path, VALUES(storage_path)),
        source=IF(source='fixture', source, VALUES(source))`,
      [
        rom.id, rom.platform, rom.filename, rom.title, rom.gameCode, rom.romIdentity, rom.revision,
        rom.size, rom.path, rom.source, rom.createdBy ?? null, rom.createdAt ?? Date.now(),
      ],
    );
  }

  async listRoms() {
    const [rows] = await this.pool.query(
      `SELECT id, platform, filename, title, game_code AS gameCode, revision, size, source
       FROM roms ORDER BY title, filename`,
    );
    return rows;
  }

  async getRom(id) {
    const [rows] = await this.pool.execute(
      `SELECT id, platform, filename, title, game_code AS gameCode, rom_identity AS romIdentity,
              revision, size, storage_path AS path, source, created_by AS createdBy,
              created_at AS createdAt
       FROM roms WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async putSave(accountId, romId, kind, payload, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (kind === 'battery') {
        const [locks] = await connection.execute(
          `SELECT room_id FROM link_save_locks
           WHERE account_id = ? AND rom_id = ? FOR UPDATE`,
          [accountId, romId],
        );
        if (locks.length > 0) throw databaseError('SAVE_LOCKED', 'Battery save is locked by a link room');
      }
      await connection.execute(
        `INSERT INTO account_saves (account_id, rom_id, kind, payload, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           payload=VALUES(payload), updated_at=VALUES(updated_at), revision=revision + 1`,
        [accountId, romId, kind, payload, now],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSave(accountId, romId, kind) {
    const [rows] = await this.pool.execute(
      `SELECT payload, updated_at AS updatedAt FROM account_saves
       WHERE account_id = ? AND rom_id = ? AND kind = ?`,
      [accountId, romId, kind],
    );
    return rows[0] ?? null;
  }

  async getSaveMetadata(accountId, romId) {
    const [rows] = await this.pool.execute(
      `SELECT kind, OCTET_LENGTH(payload) AS size, updated_at AS updatedAt
       FROM account_saves WHERE account_id = ? AND rom_id = ? ORDER BY kind`,
      [accountId, romId],
    );
    return rows;
  }

  async acquireLinkSaveLock(connection, roomId, accountId, romId, now) {
    try {
      await connection.execute(
        `INSERT INTO link_save_locks (account_id, rom_id, room_id, save_revision, locked_at)
         VALUES (?, ?, ?, 0, ?)`,
        [accountId, romId, roomId, now],
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw databaseError('SAVE_LOCKED', 'Battery save is already locked by a link room');
      }
      throw error;
    }
    const [saves] = await connection.execute(
      `SELECT revision FROM account_saves
       WHERE account_id = ? AND rom_id = ? AND kind = 'battery' FOR UPDATE`,
      [accountId, romId],
    );
    const revision = saves[0]?.revision ?? 0;
    await connection.execute(
      `UPDATE link_save_locks SET save_revision = ?
       WHERE account_id = ? AND rom_id = ? AND room_id = ?`,
      [revision, accountId, romId, roomId],
    );
    return revision;
  }

  async createLinkRoom(room) {
    const accountId = room.accountId ?? room.createdBy;
    const now = room.now ?? room.createdAt ?? Date.now();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO link_rooms (
           id, rom_id, status, created_by, invite_hash, core_version,
           protocol_version, game_group, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          room.id, room.romId, room.status ?? 'waiting', accountId,
          room.inviteHash ?? null, room.coreVersion ?? null, room.protocolVersion ?? null,
          room.gameGroup ?? null, room.expiresAt ?? null, now, now,
        ],
      );
      const saveRevision = await this.acquireLinkSaveLock(
        connection, room.id, accountId, room.romId, now,
      );
      await connection.execute(
        `INSERT INTO link_room_participants (
           room_id, account_id, rom_id, slot, ready, connected,
           save_revision, joined_at, updated_at
         ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        [
          room.id, accountId, room.romId, Boolean(room.ready),
          room.connected !== false, saveRevision, now, now,
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkRoom(room.id);
  }

  async joinLinkRoom(roomId, participantValue, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.execute(
        'SELECT rom_id AS romId, status FROM link_rooms WHERE id = ? FOR UPDATE',
        [roomId],
      );
      const room = rooms[0];
      if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
      const participant = normalizeLinkParticipant(participantValue, room.romId);
      const [participants] = await connection.execute(
        `SELECT account_id AS accountId FROM link_room_participants
         WHERE room_id = ? ORDER BY slot FOR UPDATE`,
        [roomId],
      );
      if (participants.some((item) => item.accountId === participant.accountId)) {
        await connection.commit();
        return this.getLinkRoom(roomId);
      }
      if (participants.length >= 2) throw databaseError('LINK_ROOM_FULL', 'Link room already has two participants');
      if (room.status !== 'waiting') {
        throw databaseError('LINK_ROOM_NOT_JOINABLE', 'Link room is not accepting participants');
      }
      const saveRevision = await this.acquireLinkSaveLock(
        connection, roomId, participant.accountId, participant.romId, now,
      );
      await connection.execute(
        `INSERT INTO link_room_participants (
           room_id, account_id, rom_id, slot, ready, connected,
           save_revision, joined_at, updated_at
         ) VALUES (?, ?, ?, ?, FALSE, TRUE, ?, ?, ?)`,
        [
          roomId, participant.accountId, participant.romId,
          participants.length, saveRevision, now, now,
        ],
      );
      await connection.execute(
        `UPDATE link_rooms SET status = 'ready', updated_at = ? WHERE id = ?`,
        [now, roomId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkRoom(roomId);
  }

  async getLinkRoom(roomId) {
    const [rooms] = await this.pool.execute(
      `SELECT id, rom_id AS romId, status, created_by AS createdBy,
              invite_hash AS inviteHash, core_version AS coreVersion,
              protocol_version AS protocolVersion, game_group AS gameGroup,
              expires_at AS expiresAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM link_rooms WHERE id = ?`,
      [roomId],
    );
    if (!rooms[0]) return null;
    const [participants] = await this.pool.execute(
      `SELECT account_id AS accountId, rom_id AS romId, slot,
              ready, connected, save_revision AS saveRevision,
              joined_at AS joinedAt, updated_at AS updatedAt
       FROM link_room_participants WHERE room_id = ? ORDER BY slot`,
      [roomId],
    );
    return {
      ...rooms[0],
      participants: participants.map((participant) => ({
        ...participant,
        ready: Boolean(participant.ready),
        connected: Boolean(participant.connected),
      })),
    };
  }

  async getRecoverableLinkRooms(accountId, romId) {
    const [rows] = await this.pool.execute(
      `SELECT DISTINCT rooms.id, rooms.created_at AS createdAt
       FROM link_rooms AS rooms
       LEFT JOIN link_room_participants AS participants
         ON participants.room_id = rooms.id
       LEFT JOIN link_save_locks AS locks
         ON locks.room_id = rooms.id
       WHERE (
         rooms.status IN ('waiting', 'ready', 'active', 'finishing')
         AND participants.account_id = ? AND participants.rom_id = ?
       ) OR (locks.account_id = ? AND locks.rom_id = ?)
       ORDER BY rooms.created_at, rooms.id`,
      [accountId, romId, accountId, romId],
    );
    return Promise.all(rows.map((room) => this.getLinkRoom(room.id)));
  }

  async abortLinkRoom(roomId, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.execute(
        'SELECT status FROM link_rooms WHERE id = ? FOR UPDATE',
        [roomId],
      );
      if (!rooms[0]) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
      if (!TERMINAL_LINK_ROOM_STATUSES.has(rooms[0].status)) {
        await connection.execute(
          `UPDATE link_rooms SET status = 'aborted', updated_at = ? WHERE id = ?`,
          [now, roomId],
        );
      }
      await connection.execute('DELETE FROM link_save_locks WHERE room_id = ?', [roomId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkRoom(roomId);
  }

  async updateLinkRoomStatus(roomId, status, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.execute('SELECT id FROM link_rooms WHERE id = ? FOR UPDATE', [roomId]);
      if (!rooms[0]) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
      await connection.execute(
        'UPDATE link_rooms SET status = ?, updated_at = ? WHERE id = ?',
        [status, now, roomId],
      );
      if (TERMINAL_LINK_ROOM_STATUSES.has(status)) {
        await connection.execute('DELETE FROM link_save_locks WHERE room_id = ?', [roomId]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkRoom(roomId);
  }

  async abortOpenLinkRooms(now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.query(
        `SELECT id FROM link_rooms
         WHERE status IN ('waiting', 'ready', 'active', 'finishing') FOR UPDATE`,
      );
      for (const room of rooms) {
        await connection.execute(
          `UPDATE link_rooms SET status = 'aborted', updated_at = ? WHERE id = ?`,
          [now, room.id],
        );
        await connection.execute('DELETE FROM link_save_locks WHERE room_id = ?', [room.id]);
      }
      await connection.commit();
      return rooms.map((room) => room.id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async setLinkParticipantState(roomId, accountId, state, now = Date.now()) {
    const assignments = [];
    const values = [];
    if (state.ready !== undefined) {
      assignments.push('ready = ?');
      values.push(Boolean(state.ready));
    }
    if (state.connected !== undefined) {
      assignments.push('connected = ?');
      values.push(Boolean(state.connected));
    }
    if (assignments.length === 0) return this.getLinkRoom(roomId);
    assignments.push('updated_at = ?');
    values.push(now, roomId, accountId);
    const [result] = await this.pool.execute(
      `UPDATE link_room_participants SET ${assignments.join(', ')}
       WHERE room_id = ? AND account_id = ?`,
      values,
    );
    if (result.affectedRows === 0) {
      throw databaseError('LINK_ROOM_PARTICIPANT_REQUIRED', 'Account is not a participant in this link room');
    }
    return this.getLinkRoom(roomId);
  }

  async putLinkCheckpoint(roomId, accountId, sequence, payload, now = Date.now()) {
    validateCheckpointSequence(sequence);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [participants] = await connection.execute(
        `SELECT account_id FROM link_room_participants
         WHERE room_id = ? AND account_id = ? FOR UPDATE`,
        [roomId, accountId],
      );
      if (!participants[0]) {
        throw databaseError('LINK_ROOM_PARTICIPANT_REQUIRED', 'Account is not a participant in this link room');
      }
      await connection.execute(
        `INSERT INTO link_checkpoints (room_id, checkpoint_sequence, account_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE payload=VALUES(payload), created_at=VALUES(created_at)`,
        [roomId, sequence, accountId, payload, now],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkCheckpointPair(roomId, sequence);
  }

  async putLinkCheckpointPair(roomId, sequence, payloads, now = Date.now()) {
    validateCheckpointSequence(sequence);
    const entries = normalizePairedPayloads(payloads).map((entry) => ({
      ...entry,
      payload: Buffer.from(entry.payload),
    }));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [participants] = await connection.execute(
        `SELECT account_id AS accountId FROM link_room_participants
         WHERE room_id = ? ORDER BY slot FOR UPDATE`,
        [roomId],
      );
      this.validateLinkPair(participants, entries);
      for (const entry of entries) {
        await connection.execute(
          `INSERT INTO link_checkpoints (room_id, checkpoint_sequence, account_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE payload=VALUES(payload), created_at=VALUES(created_at)`,
          [roomId, sequence, entry.accountId, entry.payload, now],
        );
      }
      await connection.execute(
        `DELETE FROM link_checkpoints
         WHERE room_id = ? AND checkpoint_sequence < ?`,
        [roomId, sequence],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkCheckpointPair(roomId, sequence);
  }

  validateLinkPair(participants, entries) {
    const participantIds = new Set(participants.map((participant) => participant.accountId));
    const entryIds = new Set(entries.map((entry) => entry.accountId));
    if (participants.length !== 2 || entries.length !== 2 || entryIds.size !== 2
      || [...entryIds].some((accountId) => !participantIds.has(accountId))) {
      throw databaseError('LINK_PAIR_INVALID', 'Payload pair must contain exactly the two room participants');
    }
  }

  async getLinkCheckpointPair(roomId, sequence) {
    validateCheckpointSequence(sequence);
    const [rows] = await this.pool.execute(
      `SELECT checkpoints.account_id AS accountId, checkpoints.payload,
              checkpoints.created_at AS createdAt
       FROM link_checkpoints AS checkpoints
       INNER JOIN link_room_participants AS participants
         ON participants.room_id = checkpoints.room_id
        AND participants.account_id = checkpoints.account_id
       WHERE checkpoints.room_id = ? AND checkpoints.checkpoint_sequence = ?
       ORDER BY participants.slot`,
      [roomId, sequence],
    );
    if (rows.length !== 2) return null;
    return { roomId, sequence, checkpoints: rows };
  }

  async getLatestLinkCheckpointPair(roomId) {
    const [rows] = await this.pool.execute(
      `SELECT checkpoint_sequence AS sequence FROM link_checkpoints WHERE room_id = ?
       GROUP BY checkpoint_sequence HAVING COUNT(*) = 2
       ORDER BY checkpoint_sequence DESC LIMIT 1`,
      [roomId],
    );
    return rows[0] ? this.getLinkCheckpointPair(roomId, rows[0].sequence) : null;
  }

  async commitPairedBatterySaves(roomId, payloads, now = Date.now()) {
    const entries = normalizePairedPayloads(payloads);
    const connection = await this.pool.getConnection();
    let committed;
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.execute(
        'SELECT rom_id AS romId, status FROM link_rooms WHERE id = ? FOR UPDATE',
        [roomId],
      );
      const room = rooms[0];
      if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
      if (TERMINAL_LINK_ROOM_STATUSES.has(room.status)) {
        throw databaseError('LINK_ROOM_NOT_COMMITTABLE', 'Link room is already terminal');
      }
      const [participants] = await connection.execute(
        `SELECT account_id AS accountId, rom_id AS romId,
                save_revision AS saveRevision
         FROM link_room_participants WHERE room_id = ? ORDER BY slot FOR UPDATE`,
        [roomId],
      );
      this.validateLinkPair(participants, entries);
      const [locks] = await connection.execute(
        `SELECT account_id AS accountId, rom_id AS romId, save_revision AS saveRevision
         FROM link_save_locks WHERE room_id = ? ORDER BY account_id FOR UPDATE`,
        [roomId],
      );
      if (locks.length !== 2) throw databaseError('SAVE_LOCK_LOST', 'Link room no longer owns both save locks');

      const lockByAccount = new Map(locks.map((lock) => [lock.accountId, lock]));
      committed = [];
      for (const participant of participants) {
        const lock = lockByAccount.get(participant.accountId);
        if (!lock || lock.romId !== participant.romId
          || lock.saveRevision !== participant.saveRevision) {
          throw databaseError('SAVE_LOCK_LOST', 'Link room save lock does not match its participant');
        }
        const [saves] = await connection.execute(
          `SELECT revision FROM account_saves
           WHERE account_id = ? AND rom_id = ? AND kind = 'battery' FOR UPDATE`,
          [participant.accountId, participant.romId],
        );
        const revision = saves[0]?.revision ?? 0;
        if (revision !== lock.saveRevision) {
          throw databaseError('SAVE_REVISION_CONFLICT', 'Battery save changed after the link room acquired its lock');
        }
        committed.push({
          accountId: participant.accountId,
          romId: participant.romId,
          revision: revision + 1,
        });
      }
      const payloadByAccount = new Map(entries.map((entry) => [entry.accountId, entry.payload]));
      for (const save of committed) {
        await connection.execute(
          `INSERT INTO account_saves (account_id, rom_id, kind, payload, updated_at, revision)
           VALUES (?, ?, 'battery', ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             payload=VALUES(payload), updated_at=VALUES(updated_at), revision=VALUES(revision)`,
          [save.accountId, save.romId, payloadByAccount.get(save.accountId), now, save.revision],
        );
      }
      await connection.execute('DELETE FROM link_save_locks WHERE room_id = ?', [roomId]);
      await connection.execute(
        `UPDATE link_rooms SET status = 'completed', updated_at = ? WHERE id = ?`,
        [now, roomId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return {
      roomId,
      saves: committed.map(({ romId: _romId, ...save }) => save),
    };
  }

  async commitLinkRoomBatterySaves(roomId, payloads, now = Date.now()) {
    return this.commitPairedBatterySaves(roomId, payloads, now);
  }

  async recordAccessRequest(accountId, now = Date.now()) {
    await this.pool.execute(
      `INSERT INTO access_requests (account_id, requested_at, status)
       VALUES (?, ?, 'pending')
       ON DUPLICATE KEY UPDATE requested_at=VALUES(requested_at), status='pending'`,
      [accountId, now],
    );
  }

  async getAccessRequest(accountId) {
    const [rows] = await this.pool.execute(
      'SELECT requested_at AS requestedAt, status FROM access_requests WHERE account_id = ?',
      [accountId],
    );
    return rows[0] ?? null;
  }
}

export class MemoryDatabase {
  constructor() {
    this.transactions = new Map();
    this.sessions = new Map();
    this.roms = new Map();
    this.saves = new Map();
    this.accessRequests = new Map();
    this.linkRooms = new Map();
    this.linkParticipants = new Map();
    this.linkCheckpoints = new Map();
    this.linkSaveLocks = new Map();
  }

  async close() {}
  async migrate() {}
  async putTransaction(value) { this.transactions.set(value.state, { ...value, verifier_cipher: value.verifierCipher, return_to: value.returnTo, expires_at: value.expiresAt }); }
  async consumeTransaction(state, now = Date.now()) {
    const value = this.transactions.get(state);
    this.transactions.delete(state);
    return value?.expires_at > now ? value : null;
  }
  async putSession(value) {
    this.sessions.set(value.sessionHash, {
      session_hash: value.sessionHash, account_id: value.accountId, subject: value.subject,
      display_name: value.displayName, email: value.email, permission: value.permission,
      access_token_cipher: value.accessTokenCipher, refresh_token_cipher: value.refreshTokenCipher,
      access_expires_at: value.accessExpiresAt, csrf_token: value.csrfToken,
      created_at: value.createdAt, last_seen_at: value.lastSeenAt, expires_at: value.expiresAt,
    });
  }
  async getSession(hash) { return this.sessions.get(hash) ?? null; }
  async touchSession(hash, now) { const row = this.sessions.get(hash); if (row) row.last_seen_at = now; }
  async deleteSession(hash) { this.sessions.delete(hash); }
  async upsertRom(value) { if (!this.roms.has(value.id) || this.roms.get(value.id).source !== 'fixture') this.roms.set(value.id, { ...value }); }
  async listRoms() { return [...this.roms.values()].map(({ path: _path, romIdentity: _identity, ...value }) => value); }
  async getRom(id) { return this.roms.get(id) ?? null; }
  saveKey(accountId, romId, kind) { return `${accountId}\0${romId}\0${kind}`; }
  linkParticipantKey(roomId, accountId) { return `${roomId}\0${accountId}`; }
  linkCheckpointKey(roomId, sequence, accountId) { return `${roomId}\0${sequence}\0${accountId}`; }
  linkSaveLockKey(accountId, romId) { return `${accountId}\0${romId}`; }
  async putSave(accountId, romId, kind, payload, now = Date.now()) {
    if (kind === 'battery' && this.linkSaveLocks.has(this.linkSaveLockKey(accountId, romId))) {
      throw databaseError('SAVE_LOCKED', 'Battery save is locked by a link room');
    }
    const key = this.saveKey(accountId, romId, kind);
    const current = this.saves.get(key);
    this.saves.set(key, {
      payload: Buffer.from(payload),
      updatedAt: now,
      revision: (current?.revision ?? 0) + 1,
    });
  }
  async getSave(accountId, romId, kind) {
    const row = this.saves.get(this.saveKey(accountId, romId, kind));
    return row ? { payload: Buffer.from(row.payload), updatedAt: row.updatedAt } : null;
  }
  async getSaveMetadata(accountId, romId) {
    return ['battery', 'state'].flatMap((kind) => {
      const row = this.saves.get(this.saveKey(accountId, romId, kind));
      return row ? [{ kind, size: row.payload.length, updatedAt: row.updatedAt }] : [];
    });
  }
  acquireLinkSaveLock(roomId, accountId, romId, now) {
    const key = this.linkSaveLockKey(accountId, romId);
    if (this.linkSaveLocks.has(key)) {
      throw databaseError('SAVE_LOCKED', 'Battery save is already locked by a link room');
    }
    const save = this.saves.get(this.saveKey(accountId, romId, 'battery'));
    const lock = { accountId, romId, roomId, saveRevision: save?.revision ?? 0, lockedAt: now };
    this.linkSaveLocks.set(key, lock);
    return lock.saveRevision;
  }
  participantsForRoom(roomId) {
    return [...this.linkParticipants.values()]
      .filter((participant) => participant.roomId === roomId)
      .sort((left, right) => left.slot - right.slot);
  }
  validateLinkPair(participants, entries) {
    const participantIds = new Set(participants.map((participant) => participant.accountId));
    const entryIds = new Set(entries.map((entry) => entry.accountId));
    if (participants.length !== 2 || entries.length !== 2 || entryIds.size !== 2
      || [...entryIds].some((accountId) => !participantIds.has(accountId))) {
      throw databaseError('LINK_PAIR_INVALID', 'Payload pair must contain exactly the two room participants');
    }
  }
  async createLinkRoom(value) {
    const accountId = value.accountId ?? value.createdBy;
    const now = value.now ?? value.createdAt ?? Date.now();
    if (!this.roms.has(value.romId)) throw databaseError('ROM_NOT_FOUND', 'ROM not found');
    if (this.linkRooms.has(value.id)) throw databaseError('LINK_ROOM_EXISTS', 'Link room already exists');
    const saveRevision = this.acquireLinkSaveLock(value.id, accountId, value.romId, now);
    try {
      this.linkRooms.set(value.id, {
        id: value.id,
        romId: value.romId,
        status: value.status ?? 'waiting',
        createdBy: accountId,
        inviteHash: value.inviteHash ?? null,
        coreVersion: value.coreVersion ?? null,
        protocolVersion: value.protocolVersion ?? null,
        gameGroup: value.gameGroup ?? null,
        expiresAt: value.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      });
      this.linkParticipants.set(this.linkParticipantKey(value.id, accountId), {
        roomId: value.id,
        accountId,
        romId: value.romId,
        slot: 0,
        ready: Boolean(value.ready),
        connected: value.connected !== false,
        saveRevision,
        joinedAt: now,
        updatedAt: now,
      });
    } catch (error) {
      this.linkRooms.delete(value.id);
      this.linkSaveLocks.delete(this.linkSaveLockKey(accountId, value.romId));
      throw error;
    }
    return this.getLinkRoom(value.id);
  }
  async joinLinkRoom(roomId, participantValue, now = Date.now()) {
    const room = this.linkRooms.get(roomId);
    if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
    const participant = normalizeLinkParticipant(participantValue, room.romId);
    if (!this.roms.has(participant.romId)) throw databaseError('ROM_NOT_FOUND', 'ROM not found');
    const existing = this.linkParticipants.get(
      this.linkParticipantKey(roomId, participant.accountId),
    );
    if (existing) return this.getLinkRoom(roomId);
    const participants = this.participantsForRoom(roomId);
    if (participants.length >= 2) throw databaseError('LINK_ROOM_FULL', 'Link room already has two participants');
    if (room.status !== 'waiting') {
      throw databaseError('LINK_ROOM_NOT_JOINABLE', 'Link room is not accepting participants');
    }
    const saveRevision = this.acquireLinkSaveLock(
      roomId, participant.accountId, participant.romId, now,
    );
    this.linkParticipants.set(this.linkParticipantKey(roomId, participant.accountId), {
      roomId,
      accountId: participant.accountId,
      romId: participant.romId,
      slot: participants.length,
      ready: false,
      connected: true,
      saveRevision,
      joinedAt: now,
      updatedAt: now,
    });
    room.status = 'ready';
    room.updatedAt = now;
    return this.getLinkRoom(roomId);
  }
  async getLinkRoom(roomId) {
    const room = this.linkRooms.get(roomId);
    if (!room) return null;
    return {
      ...room,
      participants: this.participantsForRoom(roomId).map(({ roomId: _roomId, ...participant }) => ({
        ...participant,
      })),
    };
  }
  async getRecoverableLinkRooms(accountId, romId) {
    const roomIds = new Set();
    for (const participant of this.linkParticipants.values()) {
      const room = this.linkRooms.get(participant.roomId);
      if (participant.accountId === accountId && participant.romId === romId
        && room && !TERMINAL_LINK_ROOM_STATUSES.has(room.status)) {
        roomIds.add(room.id);
      }
    }
    for (const lock of this.linkSaveLocks.values()) {
      if (lock.accountId === accountId && lock.romId === romId) roomIds.add(lock.roomId);
    }
    return Promise.all([...roomIds]
      .map((roomId) => this.linkRooms.get(roomId))
      .filter(Boolean)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((room) => this.getLinkRoom(room.id)));
  }
  async abortLinkRoom(roomId, now = Date.now()) {
    const room = this.linkRooms.get(roomId);
    if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
    if (!TERMINAL_LINK_ROOM_STATUSES.has(room.status)) {
      room.status = 'aborted';
      room.updatedAt = now;
    }
    for (const [key, lock] of this.linkSaveLocks) {
      if (lock.roomId === roomId) this.linkSaveLocks.delete(key);
    }
    return this.getLinkRoom(roomId);
  }
  async updateLinkRoomStatus(roomId, status, now = Date.now()) {
    const room = this.linkRooms.get(roomId);
    if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
    room.status = status;
    room.updatedAt = now;
    if (TERMINAL_LINK_ROOM_STATUSES.has(status)) {
      for (const [key, lock] of this.linkSaveLocks) {
        if (lock.roomId === roomId) this.linkSaveLocks.delete(key);
      }
    }
    return this.getLinkRoom(roomId);
  }
  async abortOpenLinkRooms(now = Date.now()) {
    const aborted = [];
    for (const room of this.linkRooms.values()) {
      if (!['waiting', 'ready', 'active', 'finishing'].includes(room.status)) continue;
      room.status = 'aborted';
      room.updatedAt = now;
      aborted.push(room.id);
      for (const [key, lock] of this.linkSaveLocks) {
        if (lock.roomId === room.id) this.linkSaveLocks.delete(key);
      }
    }
    return aborted;
  }
  async setLinkParticipantState(roomId, accountId, state, now = Date.now()) {
    const participant = this.linkParticipants.get(this.linkParticipantKey(roomId, accountId));
    if (!participant) {
      throw databaseError('LINK_ROOM_PARTICIPANT_REQUIRED', 'Account is not a participant in this link room');
    }
    if (state.ready !== undefined) participant.ready = Boolean(state.ready);
    if (state.connected !== undefined) participant.connected = Boolean(state.connected);
    participant.updatedAt = now;
    return this.getLinkRoom(roomId);
  }
  async putLinkCheckpoint(roomId, accountId, sequence, payload, now = Date.now()) {
    validateCheckpointSequence(sequence);
    if (!this.linkParticipants.has(this.linkParticipantKey(roomId, accountId))) {
      throw databaseError('LINK_ROOM_PARTICIPANT_REQUIRED', 'Account is not a participant in this link room');
    }
    this.linkCheckpoints.set(this.linkCheckpointKey(roomId, sequence, accountId), {
      accountId,
      payload: Buffer.from(payload),
      createdAt: now,
    });
    return this.getLinkCheckpointPair(roomId, sequence);
  }
  async putLinkCheckpointPair(roomId, sequence, payloads, now = Date.now()) {
    validateCheckpointSequence(sequence);
    const entries = normalizePairedPayloads(payloads).map((entry) => ({
      ...entry,
      payload: Buffer.from(entry.payload),
    }));
    this.validateLinkPair(this.participantsForRoom(roomId), entries);
    for (const entry of entries) {
      this.linkCheckpoints.set(this.linkCheckpointKey(roomId, sequence, entry.accountId), {
        accountId: entry.accountId,
        payload: entry.payload,
        createdAt: now,
      });
    }
    for (const key of this.linkCheckpoints.keys()) {
      const [checkpointRoomId, checkpointSequence] = key.split('\0');
      if (checkpointRoomId === roomId && Number(checkpointSequence) < sequence) {
        this.linkCheckpoints.delete(key);
      }
    }
    return this.getLinkCheckpointPair(roomId, sequence);
  }
  async getLinkCheckpointPair(roomId, sequence) {
    validateCheckpointSequence(sequence);
    const checkpoints = this.participantsForRoom(roomId).flatMap((participant) => {
      const checkpoint = this.linkCheckpoints.get(
        this.linkCheckpointKey(roomId, sequence, participant.accountId),
      );
      return checkpoint ? [{ ...checkpoint, payload: Buffer.from(checkpoint.payload) }] : [];
    });
    return checkpoints.length === 2 ? { roomId, sequence, checkpoints } : null;
  }
  async getLatestLinkCheckpointPair(roomId) {
    const sequences = new Set();
    for (const key of this.linkCheckpoints.keys()) {
      const [checkpointRoomId, sequence] = key.split('\0');
      if (checkpointRoomId === roomId) sequences.add(Number(sequence));
    }
    const sorted = [...sequences].sort((left, right) => right - left);
    for (const sequence of sorted) {
      const pair = await this.getLinkCheckpointPair(roomId, sequence);
      if (pair) return pair;
    }
    return null;
  }
  async commitPairedBatterySaves(roomId, payloads, now = Date.now()) {
    const room = this.linkRooms.get(roomId);
    if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
    if (TERMINAL_LINK_ROOM_STATUSES.has(room.status)) {
      throw databaseError('LINK_ROOM_NOT_COMMITTABLE', 'Link room is already terminal');
    }
    const participants = this.participantsForRoom(roomId);
    const entries = normalizePairedPayloads(payloads).map((entry) => ({
      ...entry,
      payload: Buffer.from(entry.payload),
    }));
    this.validateLinkPair(participants, entries);
    const committed = [];
    for (const participant of participants) {
      const lock = this.linkSaveLocks.get(
        this.linkSaveLockKey(participant.accountId, participant.romId),
      );
      if (!lock || lock.roomId !== roomId || lock.romId !== participant.romId
        || lock.saveRevision !== participant.saveRevision) {
        throw databaseError('SAVE_LOCK_LOST', 'Link room no longer owns both save locks');
      }
      const save = this.saves.get(
        this.saveKey(participant.accountId, participant.romId, 'battery'),
      );
      const revision = save?.revision ?? 0;
      if (revision !== lock.saveRevision) {
        throw databaseError('SAVE_REVISION_CONFLICT', 'Battery save changed after the link room acquired its lock');
      }
      committed.push({
        accountId: participant.accountId,
        romId: participant.romId,
        revision: revision + 1,
      });
    }
    const payloadByAccount = new Map(entries.map((entry) => [entry.accountId, entry.payload]));
    for (const save of committed) {
      this.saves.set(this.saveKey(save.accountId, save.romId, 'battery'), {
        payload: Buffer.from(payloadByAccount.get(save.accountId)),
        updatedAt: now,
        revision: save.revision,
      });
      this.linkSaveLocks.delete(this.linkSaveLockKey(save.accountId, save.romId));
    }
    room.status = 'completed';
    room.updatedAt = now;
    return {
      roomId,
      saves: committed.map(({ romId: _romId, ...save }) => save),
    };
  }
  async commitLinkRoomBatterySaves(roomId, payloads, now = Date.now()) {
    return this.commitPairedBatterySaves(roomId, payloads, now);
  }
  async recordAccessRequest(accountId, now = Date.now()) { this.accessRequests.set(accountId, { requestedAt: now, status: 'pending' }); }
  async getAccessRequest(accountId) { return this.accessRequests.get(accountId) ?? null; }
}
