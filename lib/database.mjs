import mysql from 'mysql2/promise';

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
        permission ENUM('visitor', 'user', 'superadmin') NOT NULL,
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
      `ALTER TABLE roms
       ADD COLUMN IF NOT EXISTS platform ENUM('gba', 'gb', 'gbc') NOT NULL DEFAULT 'gba' AFTER id`,
      `CREATE TABLE IF NOT EXISTS account_saves (
        account_id VARCHAR(128) NOT NULL,
        rom_id CHAR(64) NOT NULL,
        kind ENUM('state', 'battery') NOT NULL,
        payload MEDIUMBLOB NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (account_id, rom_id, kind),
        CONSTRAINT account_saves_rom_fk FOREIGN KEY (rom_id) REFERENCES roms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS access_requests (
        account_id VARCHAR(128) PRIMARY KEY,
        requested_at BIGINT UNSIGNED NOT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
    for (const statement of statements) await this.pool.query(statement);
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
    await this.pool.execute(
      `INSERT INTO account_saves (account_id, rom_id, kind, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=VALUES(updated_at)`,
      [accountId, romId, kind, payload, now],
    );
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
  async putSave(accountId, romId, kind, payload, now = Date.now()) { this.saves.set(this.saveKey(accountId, romId, kind), { payload: Buffer.from(payload), updatedAt: now }); }
  async getSave(accountId, romId, kind) { return this.saves.get(this.saveKey(accountId, romId, kind)) ?? null; }
  async getSaveMetadata(accountId, romId) {
    return ['battery', 'state'].flatMap((kind) => {
      const row = this.saves.get(this.saveKey(accountId, romId, kind));
      return row ? [{ kind, size: row.payload.length, updatedAt: row.updatedAt }] : [];
    });
  }
  async recordAccessRequest(accountId, now = Date.now()) { this.accessRequests.set(accountId, { requestedAt: now, status: 'pending' }); }
  async getAccessRequest(accountId) { return this.accessRequests.get(accountId) ?? null; }
}
