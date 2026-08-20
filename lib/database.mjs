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

function normalizeLocalPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length !== 2) {
    throw databaseError('LOCAL_PAIR_INVALID', 'Local payload pair must contain both player slots');
  }
  const slots = new Set(payloads.map((entry) => entry?.slot));
  if (slots.size !== 2 || !slots.has(0) || !slots.has(1)) {
    throw databaseError('LOCAL_PAIR_INVALID', 'Local payload pair must identify slots 0 and 1');
  }
  return payloads;
}

function normalizeCableMetadata(metadata = {}) {
  const integer = (value, fallback = -1) => Number.isSafeInteger(value) ? value : fallback;
  return {
    guestHandshakePending: Boolean(metadata.guestHandshakePending),
    lastPairSequence: integer(metadata.lastPairSequence),
    lastReleaseSequence: integer(metadata.lastReleaseSequence),
  };
}

function assertLocalMutable(session, expectedStatuses, now) {
  if (!session) throw databaseError('LOCAL_SESSION_NOT_FOUND', 'Local session does not exist');
  if (!expectedStatuses.includes(session.status)) {
    throw databaseError('LOCAL_STATE_INVALID', `Local session status ${session.status} is not mutable`);
  }
  if (Number(session.leaseExpiresAt ?? session.lease_expires_at) <= now) {
    throw databaseError('LOCAL_SESSION_EXPIRED', 'Local session lease expired');
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
    const migrationConnection = await this.pool.getConnection();
    const migrationLockName = `play-gameboy:${this.config.name}:schema`;
    const [migrationLock] = await migrationConnection.execute(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [migrationLockName],
    );
    if (Number(migrationLock[0]?.acquired) !== 1) {
      migrationConnection.release();
      throw new Error('Unable to acquire database migration lock');
    }
    this.schemaExecutor = migrationConnection;
    try {
    const statements = [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(128) PRIMARY KEY,
        applied_at BIGINT UNSIGNED NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS oidc_transactions (
        state VARCHAR(128) PRIMARY KEY,
        verifier_cipher TEXT NOT NULL,
        return_to TEXT NOT NULL,
        purpose ENUM('primary', 'player2') NOT NULL DEFAULT 'primary',
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
        profile_key VARCHAR(32) NOT NULL DEFAULT 'primary',
        rom_id CHAR(64) NOT NULL,
        kind ENUM('state', 'battery') NOT NULL,
        payload MEDIUMBLOB NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, profile_key, rom_id, kind),
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
        profile_key VARCHAR(32) NOT NULL DEFAULT 'primary',
        rom_id CHAR(64) NOT NULL,
        room_id VARCHAR(64) NOT NULL,
        save_revision BIGINT UNSIGNED NOT NULL,
        locked_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (account_id, profile_key, rom_id),
        INDEX link_save_locks_room_idx (room_id),
        CONSTRAINT link_save_locks_room_fk
          FOREIGN KEY (room_id) REFERENCES link_rooms(id) ON DELETE CASCADE,
        CONSTRAINT link_save_locks_rom_fk
          FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS local_link_sessions (
        id VARCHAR(64) PRIMARY KEY,
        owner_account_id VARCHAR(128) NOT NULL,
        player2_account_id VARCHAR(128) NULL,
        player2_mode ENUM('account', 'guest') NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'preparing',
        last_checkpoint_sequence BIGINT NOT NULL DEFAULT -1,
        guest_handshake_pending BOOLEAN NOT NULL DEFAULT FALSE,
        last_pair_sequence BIGINT NOT NULL DEFAULT -1,
        last_release_sequence BIGINT NOT NULL DEFAULT -1,
        lease_expires_at BIGINT UNSIGNED NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        INDEX local_link_owner_idx (owner_account_id, status),
        INDEX local_link_player2_idx (player2_account_id, status),
        INDEX local_link_lease_idx (lease_expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS play_admission_locks (
        account_id VARCHAR(128) PRIMARY KEY,
        mode ENUM('remote', 'local') NOT NULL,
        owner_id VARCHAR(64) NOT NULL,
        acquired_at BIGINT UNSIGNED NOT NULL,
        INDEX play_admission_owner_idx (mode, owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS local_link_participants (
        session_id VARCHAR(64) NOT NULL,
        slot TINYINT UNSIGNED NOT NULL,
        account_id VARCHAR(128) NOT NULL,
        profile_key VARCHAR(32) NOT NULL,
        rom_id CHAR(64) NOT NULL,
        save_revision BIGINT UNSIGNED NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (session_id, slot),
        UNIQUE KEY local_link_participant_profile_uniq
          (session_id, account_id, profile_key, rom_id),
        CONSTRAINT local_link_participant_session_fk
          FOREIGN KEY (session_id) REFERENCES local_link_sessions(id) ON DELETE CASCADE,
        CONSTRAINT local_link_participant_rom_fk
          FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS local_link_checkpoints (
        session_id VARCHAR(64) NOT NULL,
        checkpoint_sequence BIGINT UNSIGNED NOT NULL,
        slot TINYINT UNSIGNED NOT NULL,
        payload MEDIUMBLOB NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (session_id, checkpoint_sequence, slot),
        CONSTRAINT local_link_checkpoint_participant_fk
          FOREIGN KEY (session_id, slot)
          REFERENCES local_link_participants(session_id, slot) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS local_save_locks (
        account_id VARCHAR(128) NOT NULL,
        profile_key VARCHAR(32) NOT NULL,
        rom_id CHAR(64) NOT NULL,
        local_session_id VARCHAR(64) NOT NULL,
        save_revision BIGINT UNSIGNED NOT NULL,
        locked_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (account_id, profile_key, rom_id),
        INDEX local_save_locks_session_idx (local_session_id),
        CONSTRAINT local_save_locks_session_fk
          FOREIGN KEY (local_session_id) REFERENCES local_link_sessions(id) ON DELETE CASCADE,
        CONSTRAINT local_save_locks_rom_fk
          FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
    for (const statement of statements) await this.schemaExecutor.query(statement);
    await this.schemaExecutor.query(
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
      'oidc_transactions',
      'purpose',
      "ENUM('primary', 'player2') NOT NULL DEFAULT 'primary' AFTER `return_to`",
    );
    await this.ensureColumn(
      'account_saves',
      'revision',
      'BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `updated_at`',
    );
    await this.ensureColumn(
      'account_saves',
      'profile_key',
      "VARCHAR(32) NOT NULL DEFAULT 'primary' AFTER `account_id`",
    );
    await this.ensureColumn(
      'link_save_locks',
      'profile_key',
      "VARCHAR(32) NOT NULL DEFAULT 'primary' AFTER `account_id`",
    );
    await this.ensureColumn(
      'local_link_sessions',
      'last_checkpoint_sequence',
      'BIGINT NOT NULL DEFAULT -1 AFTER `status`',
    );
    await this.ensureColumn(
      'local_link_sessions',
      'guest_handshake_pending',
      'BOOLEAN NOT NULL DEFAULT FALSE AFTER `last_checkpoint_sequence`',
    );
    await this.ensureColumn(
      'local_link_sessions',
      'last_pair_sequence',
      'BIGINT NOT NULL DEFAULT -1 AFTER `guest_handshake_pending`',
    );
    await this.ensureColumn(
      'local_link_sessions',
      'last_release_sequence',
      'BIGINT NOT NULL DEFAULT -1 AFTER `last_pair_sequence`',
    );
    await this.ensurePrimaryKey('account_saves', ['account_id', 'profile_key', 'rom_id', 'kind']);
    await this.ensurePrimaryKey('link_save_locks', ['account_id', 'profile_key', 'rom_id']);
    await this.ensureColumn('link_rooms', 'invite_hash', 'VARCHAR(128) NULL AFTER `created_by`');
    await this.ensureColumn('link_rooms', 'core_version', 'VARCHAR(128) NULL AFTER `invite_hash`');
    await this.ensureColumn('link_rooms', 'protocol_version', 'VARCHAR(64) NULL AFTER `core_version`');
    await this.ensureColumn('link_rooms', 'game_group', 'VARCHAR(64) NULL AFTER `protocol_version`');
    await this.ensureColumn('link_rooms', 'expires_at', 'BIGINT UNSIGNED NULL AFTER `game_group`');
    await this.ensureColumn('link_room_participants', 'rom_id', 'CHAR(64) NULL AFTER `account_id`');
    await this.schemaExecutor.query(
      `UPDATE link_room_participants AS participants
       INNER JOIN link_rooms AS rooms ON rooms.id = participants.room_id
       SET participants.rom_id = rooms.rom_id
       WHERE participants.rom_id IS NULL`,
    );
    await this.schemaExecutor.query(
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
    await this.schemaExecutor.execute(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE applied_at=applied_at`,
      ['local-2p-v2', Date.now()],
    );
    } finally {
      this.schemaExecutor = null;
      await migrationConnection.execute('SELECT RELEASE_LOCK(?)', [migrationLockName]);
      migrationConnection.release();
    }
  }

  async ensureColumn(table, column, definition) {
    const executor = this.schemaExecutor ?? this.pool;
    const [rows] = await executor.execute(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [this.config.name, table, column],
    );
    if (rows.length === 0) {
      await executor.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  }

  async ensureIndex(table, index, definition) {
    const executor = this.schemaExecutor ?? this.pool;
    const [rows] = await executor.execute(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [this.config.name, table, index],
    );
    if (rows.length === 0) {
      await executor.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` ${definition}`);
    }
  }

  async ensureForeignKey(table, constraint, definition) {
    const executor = this.schemaExecutor ?? this.pool;
    const [rows] = await executor.execute(
      `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
         AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
      [this.config.name, table, constraint],
    );
    if (rows.length === 0) {
      await executor.query(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` ${definition}`,
      );
    }
  }

  async ensurePrimaryKey(table, columns) {
    const executor = this.schemaExecutor ?? this.pool;
    const [rows] = await executor.execute(
      `SELECT COLUMN_NAME AS columnName FROM information_schema.KEY_COLUMN_USAGE
       WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
       ORDER BY ORDINAL_POSITION`,
      [this.config.name, table],
    );
    if (rows.map((row) => row.columnName).join('\0') === columns.join('\0')) return;
    const definition = columns.map((column) => `\`${column}\``).join(', ');
    await executor.query(`ALTER TABLE \`${table}\` DROP PRIMARY KEY, ADD PRIMARY KEY (${definition})`);
  }

  async close() { await this.pool.end(); }

  async putTransaction(transaction) {
    await this.pool.execute(
      `INSERT INTO oidc_transactions (state, verifier_cipher, return_to, purpose, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [transaction.state, transaction.verifierCipher, transaction.returnTo,
        transaction.purpose ?? 'primary', transaction.expiresAt],
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
        platform=VALUES(platform),
        filename=IF(source='fixture' AND VALUES(source)<>'fixture', filename, VALUES(filename)),
        title=VALUES(title), game_code=VALUES(game_code),
        rom_identity=VALUES(rom_identity), revision=VALUES(revision), size=VALUES(size),
        storage_path=IF(
          source='fixture' AND VALUES(source)<>'fixture',
          storage_path,
          VALUES(storage_path)
        ),
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

  async putSave(accountId, romId, kind, payload, now = Date.now(), profileKey = 'primary') {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (kind === 'battery') {
        const [locks] = await connection.execute(
          `SELECT room_id FROM link_save_locks
           WHERE account_id = ? AND profile_key = ? AND rom_id = ? FOR UPDATE`,
          [accountId, profileKey, romId],
        );
        if (locks.length > 0) throw databaseError('SAVE_LOCKED', 'Battery save is locked by a link room');
        const [localLocks] = await connection.execute(
          `SELECT local_session_id FROM local_save_locks
           WHERE account_id = ? AND profile_key = ? AND rom_id = ? FOR UPDATE`,
          [accountId, profileKey, romId],
        );
        if (localLocks.length > 0) throw databaseError('SAVE_LOCKED', 'Battery save is locked by local 2P');
      }
      await connection.execute(
        `INSERT INTO account_saves (account_id, profile_key, rom_id, kind, payload, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           payload=VALUES(payload), updated_at=VALUES(updated_at), revision=revision + 1`,
        [accountId, profileKey, romId, kind, payload, now],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSave(accountId, romId, kind, profileKey = 'primary') {
    const [rows] = await this.pool.execute(
      `SELECT payload, updated_at AS updatedAt FROM account_saves
       WHERE account_id = ? AND profile_key = ? AND rom_id = ? AND kind = ?`,
      [accountId, profileKey, romId, kind],
    );
    return rows[0] ?? null;
  }

  async getSaveMetadata(accountId, romId, profileKey = 'primary') {
    const [rows] = await this.pool.execute(
      `SELECT kind, OCTET_LENGTH(payload) AS size, updated_at AS updatedAt
       FROM account_saves WHERE account_id = ? AND profile_key = ? AND rom_id = ? ORDER BY kind`,
      [accountId, profileKey, romId],
    );
    return rows;
  }

  async acquireLinkSaveLock(connection, roomId, accountId, romId, now) {
    const [localLocks] = await connection.execute(
      `SELECT local_session_id FROM local_save_locks
       WHERE account_id = ? AND profile_key = 'primary' AND rom_id = ? FOR UPDATE`,
      [accountId, romId],
    );
    if (localLocks.length > 0) {
      throw databaseError('SAVE_LOCKED', 'Battery save is already locked by local 2P');
    }
    try {
      await connection.execute(
        `INSERT INTO link_save_locks (
           account_id, profile_key, rom_id, room_id, save_revision, locked_at
         ) VALUES (?, 'primary', ?, ?, 0, ?)`,
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
       WHERE account_id = ? AND profile_key = 'primary' AND rom_id = ?
         AND kind = 'battery' FOR UPDATE`,
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

  async acquirePlayAdmissions(connection, mode, ownerId, accountIds, now) {
    for (const accountId of [...new Set(accountIds)].sort()) {
      try {
        await connection.execute(
          `INSERT INTO play_admission_locks (account_id, mode, owner_id, acquired_at)
           VALUES (?, ?, ?, ?)`,
          [accountId, mode, ownerId, now],
        );
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          throw databaseError('PLAY_ADMISSION_LOCKED', 'Account is already in a play session');
        }
        throw error;
      }
    }
  }

  async releasePlayAdmissions(connection, mode, ownerId) {
    await connection.execute(
      'DELETE FROM play_admission_locks WHERE mode = ? AND owner_id = ?',
      [mode, ownerId],
    );
  }

  async createLinkRoom(room) {
    const accountId = room.accountId ?? room.createdBy;
    const now = room.now ?? room.createdAt ?? Date.now();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.acquirePlayAdmissions(connection, 'remote', room.id, [accountId], now);
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
      await this.acquirePlayAdmissions(
        connection, 'remote', roomId, [participant.accountId], now,
      );
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
      await this.releasePlayAdmissions(connection, 'remote', roomId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLinkRoom(roomId);
  }

  async updateLinkRoomStatus(roomId, status, now = Date.now(), expectedStatuses = []) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.execute(
        'SELECT id, status FROM link_rooms WHERE id = ? FOR UPDATE', [roomId],
      );
      if (!rooms[0]) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
      if (!expectedStatuses.includes(rooms[0].status)) {
        throw databaseError('LINK_ROOM_STATE_CONFLICT',
          `Link room status ${rooms[0].status} cannot transition to ${status}`);
      }
      await connection.execute(
        'UPDATE link_rooms SET status = ?, updated_at = ? WHERE id = ?',
        [status, now, roomId],
      );
      if (TERMINAL_LINK_ROOM_STATUSES.has(status)) {
        await connection.execute('DELETE FROM link_save_locks WHERE room_id = ?', [roomId]);
        await this.releasePlayAdmissions(connection, 'remote', roomId);
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

  async setLinkReadyState(roomId, accountId, ready, status, expectedStatuses, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rooms] = await connection.execute(
        'SELECT status FROM link_rooms WHERE id = ? FOR UPDATE', [roomId],
      );
      if (!rooms[0]) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
      if (!expectedStatuses.includes(rooms[0].status)) {
        throw databaseError('LINK_ROOM_STATE_CONFLICT', 'Link room is no longer ready-mutable');
      }
      const [participant] = await connection.execute(
        `UPDATE link_room_participants SET ready = ?, updated_at = ?
         WHERE room_id = ? AND account_id = ?`,
        [Boolean(ready), now, roomId, accountId],
      );
      if (participant.affectedRows !== 1) {
        throw databaseError('LINK_ROOM_PARTICIPANT_REQUIRED',
          'Account is not a participant in this link room');
      }
      await connection.execute(
        'UPDATE link_rooms SET status = ?, updated_at = ? WHERE id = ?',
        [status, now, roomId],
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
        await this.releasePlayAdmissions(connection, 'remote', room.id);
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
         FROM link_save_locks WHERE room_id = ? AND profile_key = 'primary'
         ORDER BY account_id FOR UPDATE`,
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
           WHERE account_id = ? AND profile_key = 'primary' AND rom_id = ?
             AND kind = 'battery' FOR UPDATE`,
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
          `INSERT INTO account_saves (
             account_id, profile_key, rom_id, kind, payload, updated_at, revision
           ) VALUES (?, 'primary', ?, 'battery', ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             payload=VALUES(payload), updated_at=VALUES(updated_at), revision=VALUES(revision)`,
          [save.accountId, save.romId, payloadByAccount.get(save.accountId), now, save.revision],
        );
      }
      await connection.execute('DELETE FROM link_save_locks WHERE room_id = ?', [roomId]);
      await this.releasePlayAdmissions(connection, 'remote', roomId);
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

  async hasOpenLinkRoomForAccount(accountId) {
    const [rows] = await this.pool.execute(
      `SELECT 1 FROM link_room_participants AS participants
       INNER JOIN link_rooms AS rooms ON rooms.id = participants.room_id
       WHERE participants.account_id = ?
         AND rooms.status NOT IN ('completed', 'aborted', 'cancelled', 'closed') LIMIT 1`,
      [accountId],
    );
    return rows.length > 0;
  }

  async hasOpenLocalSessionForAccount(accountId, now = Date.now()) {
    const [rows] = await this.pool.execute(
      `SELECT 1 FROM local_link_sessions
       WHERE (owner_account_id = ? OR player2_account_id = ?)
         AND status NOT IN ('completed', 'aborted') AND lease_expires_at > ? LIMIT 1`,
      [accountId, accountId, now],
    );
    return rows.length > 0;
  }

  async createLocalLinkSession(value) {
    const participants = [...value.participants].sort((left, right) => left.slot - right.slot);
    if (participants.length !== 2 || participants[0]?.slot !== 0 || participants[1]?.slot !== 1) {
      throw databaseError('LOCAL_PAIR_INVALID', 'Local session requires slots 0 and 1');
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const accountIds = [...new Set(participants.map((participant) => participant.accountId))].sort();
      await this.acquirePlayAdmissions(connection, 'local', value.id, accountIds, value.now);
      for (const accountId of accountIds) {
        const [rooms] = await connection.execute(
          `SELECT 1 FROM link_room_participants AS participants
           INNER JOIN link_rooms AS rooms ON rooms.id = participants.room_id
           WHERE participants.account_id = ?
             AND rooms.status NOT IN ('completed', 'aborted', 'cancelled', 'closed')
           LIMIT 1 FOR UPDATE`,
          [accountId],
        );
        if (rooms.length) throw databaseError('REMOTE_LINK_ACTIVE', 'A remote link room is active');
        const [localSessions] = await connection.execute(
          `SELECT 1 FROM local_link_sessions
           WHERE (owner_account_id = ? OR player2_account_id = ?)
             AND status NOT IN ('completed', 'aborted') AND lease_expires_at > ?
           LIMIT 1 FOR UPDATE`,
          [accountId, accountId, value.now],
        );
        if (localSessions.length) {
          throw databaseError('LOCAL_SESSION_ACTIVE', 'An existing local 2P session is active');
        }
      }
      await connection.execute(
        `INSERT INTO local_link_sessions (
          id, owner_account_id, player2_account_id, player2_mode, status,
          lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?)`,
        [value.id, value.ownerAccountId, value.player2AccountId ?? null, value.player2Mode,
          value.leaseExpiresAt, value.now, value.now],
      );
      for (const participant of participants) {
        const [remoteLocks] = await connection.execute(
          `SELECT room_id FROM link_save_locks
           WHERE account_id = ? AND profile_key = ? AND rom_id = ? FOR UPDATE`,
          [participant.accountId, participant.profileKey, participant.romId],
        );
        if (remoteLocks.length) throw databaseError('SAVE_LOCKED', 'Save is locked by a remote room');
        const [saves] = await connection.execute(
          `SELECT revision FROM account_saves
           WHERE account_id = ? AND profile_key = ? AND rom_id = ?
             AND kind = 'battery' FOR UPDATE`,
          [participant.accountId, participant.profileKey, participant.romId],
        );
        const revision = saves[0]?.revision ?? 0;
        try {
          await connection.execute(
            `INSERT INTO local_save_locks (
              account_id, profile_key, rom_id, local_session_id, save_revision, locked_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [participant.accountId, participant.profileKey, participant.romId,
              value.id, revision, value.now],
          );
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') {
            throw databaseError('SAVE_LOCKED', 'Save is already locked by local 2P');
          }
          throw error;
        }
        await connection.execute(
          `INSERT INTO local_link_participants (
            session_id, slot, account_id, profile_key, rom_id, save_revision, ready
          ) VALUES (?, ?, ?, ?, ?, ?, FALSE)`,
          [value.id, participant.slot, participant.accountId, participant.profileKey,
            participant.romId, revision],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLocalLinkSession(value.id);
  }

  async getLocalLinkSession(id) {
    const [sessions] = await this.pool.execute(
      `SELECT id, owner_account_id AS ownerAccountId,
              player2_account_id AS player2AccountId, player2_mode AS player2Mode,
              status, last_checkpoint_sequence AS lastCheckpointSequence,
              guest_handshake_pending AS guestHandshakePending,
              last_pair_sequence AS lastPairSequence,
              last_release_sequence AS lastReleaseSequence,
              lease_expires_at AS leaseExpiresAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM local_link_sessions WHERE id = ?`,
      [id],
    );
    if (!sessions[0]) return null;
    const [participants] = await this.pool.execute(
      `SELECT slot, account_id AS accountId, profile_key AS profileKey, rom_id AS romId,
              save_revision AS saveRevision, ready
       FROM local_link_participants WHERE session_id = ? ORDER BY slot`,
      [id],
    );
    return {
      ...sessions[0],
      guestHandshakePending: Boolean(sessions[0].guestHandshakePending),
      participants: participants.map((item) => ({ ...item, ready: Boolean(item.ready) })),
    };
  }

  async getRecoverableLocalLinkSession(accountId, now = Date.now()) {
    const [rows] = await this.pool.execute(
      `SELECT id FROM local_link_sessions
       WHERE owner_account_id = ? AND status NOT IN ('completed', 'aborted')
         AND lease_expires_at > ? ORDER BY updated_at DESC LIMIT 1`,
      [accountId, now],
    );
    return rows[0] ? this.getLocalLinkSession(rows[0].id) : null;
  }

  async getRecoverableLocalLinkSessionForPair(ownerAccountId, player2AccountId, now = Date.now()) {
    const [rows] = await this.pool.execute(
      `SELECT id FROM local_link_sessions
       WHERE owner_account_id = ? AND player2_account_id = ? AND player2_mode = 'account'
         AND status NOT IN ('completed', 'aborted') AND lease_expires_at > ?
       ORDER BY updated_at DESC LIMIT 1`,
      [ownerAccountId, player2AccountId, now],
    );
    return rows[0] ? this.getLocalLinkSession(rows[0].id) : null;
  }

  async updateLocalLinkSession(id, updates, now = Date.now()) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [sessions] = await connection.execute(
        `SELECT status, lease_expires_at AS leaseExpiresAt
         FROM local_link_sessions WHERE id = ? FOR UPDATE`, [id],
      );
      if (!Array.isArray(updates.expectedStatuses) || updates.expectedStatuses.length === 0) {
        throw databaseError('LOCAL_STATE_INVALID', 'Expected local session status is required');
      }
      assertLocalMutable(sessions[0], updates.expectedStatuses, now);
      if (updates.requireCheckpoint) {
        const [checkpoint] = await connection.execute(
          'SELECT last_checkpoint_sequence AS sequence FROM local_link_sessions WHERE id = ?',
          [id],
        );
        if (Number(checkpoint[0]?.sequence) < 0) {
          throw databaseError('LOCAL_CHECKPOINT_REQUIRED', 'Initial paired checkpoint is required');
        }
      }
      if (updates.slot !== undefined) {
        const [result] = await connection.execute(
          'UPDATE local_link_participants SET ready = ? WHERE session_id = ? AND slot = ?',
          [Boolean(updates.ready), id, updates.slot],
        );
        if (result.affectedRows !== 1) {
          throw databaseError('LOCAL_PARTICIPANT_NOT_FOUND', 'Local player slot does not exist');
        }
      }
      let nextStatus = updates.status ?? null;
      if (updates.deriveReadyStatus) {
        const [participants] = await connection.execute(
          `SELECT ready FROM local_link_participants WHERE session_id = ? FOR UPDATE`,
          [id],
        );
        if (participants.length !== 2) {
          throw databaseError('LOCAL_PAIR_INVALID', 'Local participants are incomplete');
        }
        nextStatus = participants.every((participant) => Boolean(participant.ready))
          ? 'ready' : 'preparing';
      }
      await connection.execute(
        `UPDATE local_link_sessions
         SET status = COALESCE(?, status),
             lease_expires_at = COALESCE(?, lease_expires_at), updated_at = ?
         WHERE id = ?`,
        [nextStatus, updates.leaseExpiresAt ?? null, now, id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLocalLinkSession(id);
  }

  async putLocalCheckpointPair(id, sequence, payloads, metadata = {}, now = Date.now()) {
    validateCheckpointSequence(sequence);
    const entries = normalizeLocalPayloads(payloads);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [sessions] = await connection.execute(
        `SELECT status, lease_expires_at AS leaseExpiresAt,
                last_checkpoint_sequence AS lastCheckpointSequence,
                guest_handshake_pending AS guestHandshakePending,
                last_pair_sequence AS lastPairSequence,
                last_release_sequence AS lastReleaseSequence
         FROM local_link_sessions WHERE id = ? FOR UPDATE`, [id],
      );
      assertLocalMutable(sessions[0], ['ready', 'active', 'recovering'], now);
      const cable = normalizeCableMetadata(metadata);
      if (sequence === Number(sessions[0].lastCheckpointSequence)) {
        const [saved] = await connection.execute(
          `SELECT slot, payload, created_at AS createdAt FROM local_link_checkpoints
           WHERE session_id = ? AND checkpoint_sequence = ? ORDER BY slot FOR UPDATE`,
          [id, sequence],
        );
        const payloadBySlot = new Map(entries.map((entry) => [entry.slot, Buffer.from(entry.payload)]));
        const matches = saved.length === 2 && saved.every((entry) =>
          payloadBySlot.get(entry.slot)?.equals(Buffer.from(entry.payload))) &&
          Boolean(sessions[0].guestHandshakePending) === cable.guestHandshakePending &&
          Number(sessions[0].lastPairSequence) === cable.lastPairSequence &&
          Number(sessions[0].lastReleaseSequence) === cable.lastReleaseSequence;
        if (!matches) {
          throw databaseError('LOCAL_CHECKPOINT_REPLAY_CONFLICT',
            'Checkpoint retry does not match the stored pair');
        }
        await connection.commit();
        return { sessionId: id, sequence, checkpoints: saved };
      }
      if (sequence !== Number(sessions[0].lastCheckpointSequence) + 1) {
        throw databaseError('LOCAL_CHECKPOINT_SEQUENCE', 'Checkpoint sequence must be exactly next');
      }
      await connection.execute('DELETE FROM local_link_checkpoints WHERE session_id = ?', [id]);
      for (const entry of entries) {
        await connection.execute(
          `INSERT INTO local_link_checkpoints (
             session_id, checkpoint_sequence, slot, payload, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [id, sequence, entry.slot, entry.payload, now],
        );
      }
      await connection.execute(
        `UPDATE local_link_sessions
         SET last_checkpoint_sequence = ?, guest_handshake_pending = ?,
             last_pair_sequence = ?, last_release_sequence = ?,
             lease_expires_at = COALESCE(?, lease_expires_at), updated_at = ?
         WHERE id = ?`,
        [sequence, cable.guestHandshakePending, cable.lastPairSequence,
          cable.lastReleaseSequence, metadata.leaseExpiresAt ?? null, now, id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.getLatestLocalCheckpointPair(id);
  }

  async getLatestLocalCheckpointPair(id) {
    const [rows] = await this.pool.execute(
      `SELECT checkpoint_sequence AS sequence FROM local_link_checkpoints
       WHERE session_id = ? GROUP BY checkpoint_sequence HAVING COUNT(*) = 2
       ORDER BY checkpoint_sequence DESC LIMIT 1`,
      [id],
    );
    if (!rows[0]) return null;
    const [checkpoints] = await this.pool.execute(
      `SELECT slot, payload, created_at AS createdAt FROM local_link_checkpoints
       WHERE session_id = ? AND checkpoint_sequence = ? ORDER BY slot`,
      [id, rows[0].sequence],
    );
    return { sessionId: id, sequence: rows[0].sequence, checkpoints };
  }

  async commitLocalBatteryPair(id, payloads, now = Date.now()) {
    const entries = normalizeLocalPayloads(payloads);
    const connection = await this.pool.getConnection();
    let committed;
    try {
      await connection.beginTransaction();
      const [sessions] = await connection.execute(
        `SELECT status, lease_expires_at AS leaseExpiresAt
         FROM local_link_sessions WHERE id = ? FOR UPDATE`, [id],
      );
      assertLocalMutable(sessions[0], ['finishing'], now);
      const [participants] = await connection.execute(
        `SELECT slot, account_id AS accountId, profile_key AS profileKey,
                rom_id AS romId, save_revision AS saveRevision
         FROM local_link_participants WHERE session_id = ? ORDER BY slot FOR UPDATE`,
        [id],
      );
      if (participants.length !== 2) throw databaseError('LOCAL_PAIR_INVALID', 'Local participants are incomplete');
      committed = [];
      const payloadBySlot = new Map(entries.map((entry) => [entry.slot, entry.payload]));
      for (const participant of participants) {
        const [locks] = await connection.execute(
          `SELECT save_revision AS saveRevision FROM local_save_locks
           WHERE account_id = ? AND profile_key = ? AND rom_id = ?
             AND local_session_id = ? FOR UPDATE`,
          [participant.accountId, participant.profileKey, participant.romId, id],
        );
        if (!locks[0] || locks[0].saveRevision !== participant.saveRevision) {
          throw databaseError('SAVE_LOCK_LOST', 'Local session no longer owns both save locks');
        }
        const [saves] = await connection.execute(
          `SELECT revision FROM account_saves
           WHERE account_id = ? AND profile_key = ? AND rom_id = ?
             AND kind = 'battery' FOR UPDATE`,
          [participant.accountId, participant.profileKey, participant.romId],
        );
        const revision = saves[0]?.revision ?? 0;
        if (revision !== participant.saveRevision) {
          throw databaseError('SAVE_REVISION_CONFLICT', 'Battery save changed after local 2P started');
        }
        await connection.execute(
          `INSERT INTO account_saves (
             account_id, profile_key, rom_id, kind, payload, updated_at, revision
           ) VALUES (?, ?, ?, 'battery', ?, ?, ?)
           ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=VALUES(updated_at),
             revision=VALUES(revision)`,
          [participant.accountId, participant.profileKey, participant.romId,
            payloadBySlot.get(participant.slot), now, revision + 1],
        );
        committed.push({ slot: participant.slot, revision: revision + 1 });
      }
      await connection.execute('DELETE FROM local_save_locks WHERE local_session_id = ?', [id]);
      await this.releasePlayAdmissions(connection, 'local', id);
      await connection.execute('DELETE FROM local_link_checkpoints WHERE session_id = ?', [id]);
      await connection.execute(
        `UPDATE local_link_sessions SET status = 'completed', updated_at = ? WHERE id = ?`,
        [now, id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return { sessionId: id, saves: committed };
  }

  async abortLocalLinkSession(id, now = Date.now(), options = {}) {
    const connection = await this.pool.getConnection();
    let skipped = false;
    try {
      await connection.beginTransaction();
      const [sessions] = await connection.execute(
        `SELECT status, lease_expires_at AS leaseExpiresAt
         FROM local_link_sessions WHERE id = ? FOR UPDATE`,
        [id],
      );
      if (!sessions[0]) throw databaseError('LOCAL_SESSION_NOT_FOUND', 'Local session does not exist');
      if (options.onlyIfExpired && Number(sessions[0].leaseExpiresAt) > now) {
        skipped = true;
        await connection.commit();
        return null;
      }
      if (!['completed', 'aborted'].includes(sessions[0].status)) {
        await connection.execute(
          `UPDATE local_link_sessions SET status = 'aborted', updated_at = ? WHERE id = ?`,
          [now, id],
        );
      }
      await connection.execute('DELETE FROM local_save_locks WHERE local_session_id = ?', [id]);
      await this.releasePlayAdmissions(connection, 'local', id);
      await connection.execute('DELETE FROM local_link_checkpoints WHERE session_id = ?', [id]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return skipped ? null : this.getLocalLinkSession(id);
  }

  async abortLocalLinkSessionsForAccount(accountId, now = Date.now()) {
    const [rows] = await this.pool.execute(
      `SELECT id FROM local_link_sessions
       WHERE (owner_account_id = ? OR player2_account_id = ?)
         AND status NOT IN ('completed', 'aborted')`,
      [accountId, accountId],
    );
    for (const row of rows) await this.abortLocalLinkSession(row.id, now);
    return rows.map((row) => row.id);
  }

  async abortExpiredLocalLinkSessions(now = Date.now()) {
    const [rows] = await this.pool.execute(
      `SELECT id FROM local_link_sessions
       WHERE status NOT IN ('completed', 'aborted') AND lease_expires_at <= ?`,
      [now],
    );
    const aborted = [];
    for (const row of rows) {
      if (await this.abortLocalLinkSession(row.id, now, { onlyIfExpired: true })) aborted.push(row.id);
    }
    return aborted;
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
    this.localLinkSessions = new Map();
    this.localLinkParticipants = new Map();
    this.localLinkCheckpoints = new Map();
    this.localSaveLocks = new Map();
    this.playAdmissionLocks = new Map();
  }

  async close() {}
  async migrate() {}
  async putTransaction(value) { this.transactions.set(value.state, { ...value, verifier_cipher: value.verifierCipher, return_to: value.returnTo, purpose: value.purpose ?? 'primary', expires_at: value.expiresAt }); }
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
  async upsertRom(value) {
    const current = this.roms.get(value.id);
    if (!current || current.source !== 'fixture' || value.source === 'fixture') {
      this.roms.set(value.id, { ...value });
    }
  }
  async listRoms() { return [...this.roms.values()].map(({ path: _path, romIdentity: _identity, ...value }) => value); }
  async getRom(id) { return this.roms.get(id) ?? null; }
  saveKey(accountId, romId, kind, profileKey = 'primary') {
    return `${accountId}\0${profileKey}\0${romId}\0${kind}`;
  }
  linkParticipantKey(roomId, accountId) { return `${roomId}\0${accountId}`; }
  linkCheckpointKey(roomId, sequence, accountId) { return `${roomId}\0${sequence}\0${accountId}`; }
  linkSaveLockKey(accountId, romId, profileKey = 'primary') {
    return `${accountId}\0${profileKey}\0${romId}`;
  }
  async putSave(accountId, romId, kind, payload, now = Date.now(), profileKey = 'primary') {
    const lockKey = this.linkSaveLockKey(accountId, romId, profileKey);
    if (kind === 'battery' && (this.linkSaveLocks.has(lockKey) || this.localSaveLocks.has(lockKey))) {
      throw databaseError('SAVE_LOCKED', 'Battery save is locked by a link room');
    }
    const key = this.saveKey(accountId, romId, kind, profileKey);
    const current = this.saves.get(key);
    this.saves.set(key, {
      payload: Buffer.from(payload),
      updatedAt: now,
      revision: (current?.revision ?? 0) + 1,
    });
  }
  async getSave(accountId, romId, kind, profileKey = 'primary') {
    const row = this.saves.get(this.saveKey(accountId, romId, kind, profileKey));
    return row ? { payload: Buffer.from(row.payload), updatedAt: row.updatedAt } : null;
  }
  async getSaveMetadata(accountId, romId, profileKey = 'primary') {
    return ['battery', 'state'].flatMap((kind) => {
      const row = this.saves.get(this.saveKey(accountId, romId, kind, profileKey));
      return row ? [{ kind, size: row.payload.length, updatedAt: row.updatedAt }] : [];
    });
  }
  acquireLinkSaveLock(roomId, accountId, romId, now) {
    const key = this.linkSaveLockKey(accountId, romId);
    if (this.linkSaveLocks.has(key) || this.localSaveLocks.has(key)) {
      throw databaseError('SAVE_LOCKED', 'Battery save is already locked by a link room');
    }
    const save = this.saves.get(this.saveKey(accountId, romId, 'battery', 'primary'));
    const lock = { accountId, romId, roomId, saveRevision: save?.revision ?? 0, lockedAt: now };
    this.linkSaveLocks.set(key, lock);
    return lock.saveRevision;
  }
  acquirePlayAdmissions(mode, ownerId, accountIds, now) {
    const sorted = [...new Set(accountIds)].sort();
    if (sorted.some((accountId) => this.playAdmissionLocks.has(accountId))) {
      throw databaseError('PLAY_ADMISSION_LOCKED', 'Account is already in a play session');
    }
    for (const accountId of sorted) {
      this.playAdmissionLocks.set(accountId, { accountId, mode, ownerId, acquiredAt: now });
    }
  }
  releasePlayAdmissions(mode, ownerId) {
    for (const [accountId, lock] of this.playAdmissionLocks) {
      if (lock.mode === mode && lock.ownerId === ownerId) this.playAdmissionLocks.delete(accountId);
    }
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
    this.acquirePlayAdmissions('remote', value.id, [accountId], now);
    try {
      const saveRevision = this.acquireLinkSaveLock(value.id, accountId, value.romId, now);
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
      this.releasePlayAdmissions('remote', value.id);
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
    this.acquirePlayAdmissions('remote', roomId, [participant.accountId], now);
    let saveRevision;
    try {
      saveRevision = this.acquireLinkSaveLock(
        roomId, participant.accountId, participant.romId, now,
      );
    } catch (error) {
      for (const [accountId, lock] of this.playAdmissionLocks) {
        if (accountId === participant.accountId && lock.ownerId === roomId) {
          this.playAdmissionLocks.delete(accountId);
        }
      }
      throw error;
    }
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
    this.releasePlayAdmissions('remote', roomId);
    return this.getLinkRoom(roomId);
  }
  async updateLinkRoomStatus(roomId, status, now = Date.now(), expectedStatuses = []) {
    const room = this.linkRooms.get(roomId);
    if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
    if (!expectedStatuses.includes(room.status)) {
      throw databaseError('LINK_ROOM_STATE_CONFLICT',
        `Link room status ${room.status} cannot transition to ${status}`);
    }
    room.status = status;
    room.updatedAt = now;
    if (TERMINAL_LINK_ROOM_STATUSES.has(status)) {
      for (const [key, lock] of this.linkSaveLocks) {
        if (lock.roomId === roomId) this.linkSaveLocks.delete(key);
      }
      this.releasePlayAdmissions('remote', roomId);
    }
    return this.getLinkRoom(roomId);
  }
  async setLinkReadyState(roomId, accountId, ready, status, expectedStatuses, now = Date.now()) {
    const room = this.linkRooms.get(roomId);
    if (!room) throw databaseError('LINK_ROOM_NOT_FOUND', 'Link room not found');
    if (!expectedStatuses.includes(room.status)) {
      throw databaseError('LINK_ROOM_STATE_CONFLICT', 'Link room is no longer ready-mutable');
    }
    const participant = this.linkParticipants.get(this.linkParticipantKey(roomId, accountId));
    if (!participant) {
      throw databaseError('LINK_ROOM_PARTICIPANT_REQUIRED',
        'Account is not a participant in this link room');
    }
    participant.ready = Boolean(ready);
    participant.updatedAt = now;
    room.status = status;
    room.updatedAt = now;
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
      this.releasePlayAdmissions('remote', room.id);
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
    this.releasePlayAdmissions('remote', roomId);
    return {
      roomId,
      saves: committed.map(({ romId: _romId, ...save }) => save),
    };
  }
  async commitLinkRoomBatterySaves(roomId, payloads, now = Date.now()) {
    return this.commitPairedBatterySaves(roomId, payloads, now);
  }
  async hasOpenLinkRoomForAccount(accountId) {
    return [...this.linkParticipants.values()].some((participant) => {
      const room = this.linkRooms.get(participant.roomId);
      return participant.accountId === accountId && room && !TERMINAL_LINK_ROOM_STATUSES.has(room.status);
    });
  }
  async hasOpenLocalSessionForAccount(accountId, now = Date.now()) {
    return [...this.localLinkSessions.values()].some((session) =>
      (session.ownerAccountId === accountId || session.player2AccountId === accountId) &&
      !['completed', 'aborted'].includes(session.status) && session.leaseExpiresAt > now);
  }
  localParticipantKey(sessionId, slot) { return `${sessionId}\0${slot}`; }
  localCheckpointKey(sessionId, sequence, slot) { return `${sessionId}\0${sequence}\0${slot}`; }
  localParticipantsForSession(sessionId) {
    return [...this.localLinkParticipants.values()]
      .filter((participant) => participant.sessionId === sessionId)
      .sort((left, right) => left.slot - right.slot);
  }
  async createLocalLinkSession(value) {
    const participants = [...value.participants].sort((left, right) => left.slot - right.slot);
    if (participants.length !== 2 || participants[0]?.slot !== 0 || participants[1]?.slot !== 1) {
      throw databaseError('LOCAL_PAIR_INVALID', 'Local session requires slots 0 and 1');
    }
    const accountIds = [...new Set(participants.map((participant) => participant.accountId))].sort();
    this.acquirePlayAdmissions('local', value.id, accountIds, value.now);
    const locks = [];
    try {
      for (const participant of participants) {
        const key = this.linkSaveLockKey(
          participant.accountId, participant.romId, participant.profileKey,
        );
        if (this.linkSaveLocks.has(key) || this.localSaveLocks.has(key)) {
          throw databaseError('SAVE_LOCKED', 'Save is already locked');
        }
        const save = this.saves.get(this.saveKey(
          participant.accountId, participant.romId, 'battery', participant.profileKey,
        ));
        locks.push({ key, participant, revision: save?.revision ?? 0 });
      }
    } catch (error) {
      this.releasePlayAdmissions('local', value.id);
      throw error;
    }
    const session = {
      id: value.id,
      ownerAccountId: value.ownerAccountId,
      player2AccountId: value.player2AccountId ?? null,
      player2Mode: value.player2Mode,
      status: 'preparing',
      lastCheckpointSequence: -1,
      guestHandshakePending: false,
      lastPairSequence: -1,
      lastReleaseSequence: -1,
      leaseExpiresAt: value.leaseExpiresAt,
      createdAt: value.now,
      updatedAt: value.now,
    };
    this.localLinkSessions.set(value.id, session);
    for (const { key, participant, revision } of locks) {
      this.localSaveLocks.set(key, {
        accountId: participant.accountId, profileKey: participant.profileKey,
        romId: participant.romId, localSessionId: value.id,
        saveRevision: revision, lockedAt: value.now,
      });
      this.localLinkParticipants.set(this.localParticipantKey(value.id, participant.slot), {
        sessionId: value.id, ...participant, saveRevision: revision, ready: false,
      });
    }
    return this.getLocalLinkSession(value.id);
  }
  async getLocalLinkSession(id) {
    const session = this.localLinkSessions.get(id);
    return session ? { ...session, participants: this.localParticipantsForSession(id).map((item) => ({ ...item })) } : null;
  }
  async getRecoverableLocalLinkSession(accountId, now = Date.now()) {
    const sessions = [...this.localLinkSessions.values()]
      .filter((session) => session.ownerAccountId === accountId &&
        !['completed', 'aborted'].includes(session.status) && session.leaseExpiresAt > now)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return sessions[0] ? this.getLocalLinkSession(sessions[0].id) : null;
  }
  async getRecoverableLocalLinkSessionForPair(ownerAccountId, player2AccountId, now = Date.now()) {
    const sessions = [...this.localLinkSessions.values()]
      .filter((session) => session.ownerAccountId === ownerAccountId &&
        session.player2AccountId === player2AccountId && session.player2Mode === 'account' &&
        !['completed', 'aborted'].includes(session.status) && session.leaseExpiresAt > now)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return sessions[0] ? this.getLocalLinkSession(sessions[0].id) : null;
  }
  async updateLocalLinkSession(id, updates, now = Date.now()) {
    const session = this.localLinkSessions.get(id);
    if (!Array.isArray(updates.expectedStatuses) || updates.expectedStatuses.length === 0) {
      throw databaseError('LOCAL_STATE_INVALID', 'Expected local session status is required');
    }
    assertLocalMutable(session, updates.expectedStatuses, now);
    if (updates.requireCheckpoint && session.lastCheckpointSequence < 0) {
      throw databaseError('LOCAL_CHECKPOINT_REQUIRED', 'Initial paired checkpoint is required');
    }
    if (updates.slot !== undefined) {
      const participant = this.localLinkParticipants.get(this.localParticipantKey(id, updates.slot));
      if (!participant) throw databaseError('LOCAL_PARTICIPANT_NOT_FOUND', 'Local player slot does not exist');
      participant.ready = Boolean(updates.ready);
    }
    if (updates.deriveReadyStatus) {
      const participants = this.localParticipantsForSession(id);
      if (participants.length !== 2) {
        throw databaseError('LOCAL_PAIR_INVALID', 'Local participants are incomplete');
      }
      session.status = participants.every((participant) => participant.ready) ? 'ready' : 'preparing';
    } else if (updates.status) session.status = updates.status;
    if (updates.leaseExpiresAt) session.leaseExpiresAt = updates.leaseExpiresAt;
    session.updatedAt = now;
    return this.getLocalLinkSession(id);
  }
  async putLocalCheckpointPair(id, sequence, payloads, metadata = {}, now = Date.now()) {
    validateCheckpointSequence(sequence);
    const entries = normalizeLocalPayloads(payloads);
    const session = this.localLinkSessions.get(id);
    assertLocalMutable(session, ['ready', 'active', 'recovering'], now);
    const cable = normalizeCableMetadata(metadata);
    if (sequence === session.lastCheckpointSequence) {
      const payloadBySlot = new Map(entries.map((entry) => [entry.slot, Buffer.from(entry.payload)]));
      const saved = [0, 1].flatMap((slot) => {
        const item = this.localLinkCheckpoints.get(this.localCheckpointKey(id, sequence, slot));
        return item ? [{ ...item, payload: Buffer.from(item.payload) }] : [];
      });
      const matches = saved.length === 2 && saved.every((entry) =>
        payloadBySlot.get(entry.slot)?.equals(entry.payload)) &&
        session.guestHandshakePending === cable.guestHandshakePending &&
        session.lastPairSequence === cable.lastPairSequence &&
        session.lastReleaseSequence === cable.lastReleaseSequence;
      if (!matches) {
        throw databaseError('LOCAL_CHECKPOINT_REPLAY_CONFLICT',
          'Checkpoint retry does not match the stored pair');
      }
      return { sessionId: id, sequence, checkpoints: saved };
    }
    if (sequence !== session.lastCheckpointSequence + 1) {
      throw databaseError('LOCAL_CHECKPOINT_SEQUENCE', 'Checkpoint sequence must be exactly next');
    }
    for (const key of this.localLinkCheckpoints.keys()) {
      if (key.startsWith(`${id}\0`)) this.localLinkCheckpoints.delete(key);
    }
    for (const entry of entries) {
      this.localLinkCheckpoints.set(this.localCheckpointKey(id, sequence, entry.slot), {
        slot: entry.slot, payload: Buffer.from(entry.payload), createdAt: now,
      });
    }
    session.lastCheckpointSequence = sequence;
    session.guestHandshakePending = cable.guestHandshakePending;
    session.lastPairSequence = cable.lastPairSequence;
    session.lastReleaseSequence = cable.lastReleaseSequence;
    if (metadata.leaseExpiresAt) session.leaseExpiresAt = metadata.leaseExpiresAt;
    session.updatedAt = now;
    return this.getLatestLocalCheckpointPair(id);
  }
  async getLatestLocalCheckpointPair(id) {
    const sequences = new Set();
    for (const key of this.localLinkCheckpoints.keys()) {
      const [sessionId, sequence] = key.split('\0');
      if (sessionId === id) sequences.add(Number(sequence));
    }
    for (const sequence of [...sequences].sort((left, right) => right - left)) {
      const checkpoints = [0, 1].flatMap((slot) => {
        const item = this.localLinkCheckpoints.get(this.localCheckpointKey(id, sequence, slot));
        return item ? [{ ...item, payload: Buffer.from(item.payload) }] : [];
      });
      if (checkpoints.length === 2) return { sessionId: id, sequence, checkpoints };
    }
    return null;
  }
  async commitLocalBatteryPair(id, payloads, now = Date.now()) {
    const entries = normalizeLocalPayloads(payloads).map((entry) => ({
      slot: entry.slot, payload: Buffer.from(entry.payload),
    }));
    const session = this.localLinkSessions.get(id);
    assertLocalMutable(session, ['finishing'], now);
    const participants = this.localParticipantsForSession(id);
    if (participants.length !== 2) throw databaseError('LOCAL_PAIR_INVALID', 'Local participants are incomplete');
    const writes = [];
    for (const participant of participants) {
      const lockKey = this.linkSaveLockKey(
        participant.accountId, participant.romId, participant.profileKey,
      );
      const lock = this.localSaveLocks.get(lockKey);
      if (!lock || lock.localSessionId !== id || lock.saveRevision !== participant.saveRevision) {
        throw databaseError('SAVE_LOCK_LOST', 'Local session no longer owns both save locks');
      }
      const saveKey = this.saveKey(
        participant.accountId, participant.romId, 'battery', participant.profileKey,
      );
      const save = this.saves.get(saveKey);
      if ((save?.revision ?? 0) !== participant.saveRevision) {
        throw databaseError('SAVE_REVISION_CONFLICT', 'Battery save changed after local 2P started');
      }
      writes.push({ participant, lockKey, saveKey, revision: participant.saveRevision + 1 });
    }
    const payloadBySlot = new Map(entries.map((entry) => [entry.slot, entry.payload]));
    for (const write of writes) {
      this.saves.set(write.saveKey, {
        payload: Buffer.from(payloadBySlot.get(write.participant.slot)),
        updatedAt: now,
        revision: write.revision,
      });
      this.localSaveLocks.delete(write.lockKey);
    }
    session.status = 'completed';
    session.updatedAt = now;
    this.releasePlayAdmissions('local', id);
    for (const key of this.localLinkCheckpoints.keys()) {
      if (key.startsWith(`${id}\0`)) this.localLinkCheckpoints.delete(key);
    }
    return { sessionId: id, saves: writes.map((write) => ({ slot: write.participant.slot, revision: write.revision })) };
  }
  async abortLocalLinkSession(id, now = Date.now(), options = {}) {
    const session = this.localLinkSessions.get(id);
    if (!session) return null;
    if (options.onlyIfExpired && session.leaseExpiresAt > now) return null;
    if (!['completed', 'aborted'].includes(session.status)) {
      session.status = 'aborted';
      session.updatedAt = now;
    }
    for (const [key, lock] of this.localSaveLocks) {
      if (lock.localSessionId === id) this.localSaveLocks.delete(key);
    }
    this.releasePlayAdmissions('local', id);
    for (const key of this.localLinkCheckpoints.keys()) {
      if (key.startsWith(`${id}\0`)) this.localLinkCheckpoints.delete(key);
    }
    return this.getLocalLinkSession(id);
  }
  async abortLocalLinkSessionsForAccount(accountId, now = Date.now()) {
    const sessions = [...this.localLinkSessions.values()].filter((session) =>
      (session.ownerAccountId === accountId || session.player2AccountId === accountId) &&
      !['completed', 'aborted'].includes(session.status));
    for (const session of sessions) await this.abortLocalLinkSession(session.id, now);
    return sessions.map((session) => session.id);
  }
  async abortExpiredLocalLinkSessions(now = Date.now()) {
    const sessions = [...this.localLinkSessions.values()].filter((session) =>
      !['completed', 'aborted'].includes(session.status) && session.leaseExpiresAt <= now);
    const aborted = [];
    for (const session of sessions) {
      if (await this.abortLocalLinkSession(session.id, now, { onlyIfExpired: true })) {
        aborted.push(session.id);
      }
    }
    return aborted;
  }
  async recordAccessRequest(accountId, now = Date.now()) { this.accessRequests.set(accountId, { requestedAt: now, status: 'pending' }); }
  async getAccessRequest(accountId) { return this.accessRequests.get(accountId) ?? null; }
}
