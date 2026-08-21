import { randomUUID } from 'node:crypto';

import { compatibilityForRom } from './link-service.mjs';

const PLAY_PERMISSIONS = new Set(['user', 'admin', 'superadmin']);
const BATTERY_SIZES = new Set([256, 512, 2048, 8192, 32768, 32812, 65536, 131072]);

export class LocalLinkService {
  constructor({ database, leaseMs = 90_000, now = Date.now, timers = globalThis } = {}) {
    if (!database) throw new Error('database is required');
    this.database = database;
    this.leaseMs = leaseMs;
    this.now = now;
    this.timers = timers;
    this.cleanupTimer = null;
  }

  async initialize() {
    const aborted = await this.database.abortExpiredLocalLinkSessions(this.now());
    this.cleanupTimer = this.timers.setInterval?.(() => {
      void this.database.abortExpiredLocalLinkSessions(this.now()).catch(() => {});
    }, Math.max(5_000, Math.floor(this.leaseMs / 3)));
    this.cleanupTimer?.unref?.();
    return aborted;
  }

  close() {
    if (this.cleanupTimer) this.timers.clearInterval?.(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  async create({ player1, player2, player2Mode, player1RomId, player2RomId }) {
    requirePlayer(player1);
    await this.database.abortExpiredLocalLinkSessions(this.now());
    if (!['account', 'guest'].includes(player2Mode)) {
      throw localError(400, 'LOCAL_MODE_INVALID', 'Player 2 mode is invalid');
    }
    if (player2Mode === 'account') {
      requirePlayer(player2);
      if (player1.subject === player2.subject) {
        throw localError(409, 'LOCAL_SAME_ACCOUNT', 'Player 2 must use a different account');
      }
    }
    const [player1Rom, player2Rom] = await Promise.all([
      this.#gbaRom(player1RomId), this.#gbaRom(player2RomId),
    ]);
    const firstCompatibility = compatibilityForRom(player1Rom);
    const secondCompatibility = compatibilityForRom(player2Rom);
    if (firstCompatibility.coreVersion !== secondCompatibility.coreVersion ||
        firstCompatibility.protocolVersion !== secondCompatibility.protocolVersion ||
        firstCompatibility.gameGroup !== secondCompatibility.gameGroup) {
      throw localError(409, 'LOCAL_ROM_INCOMPATIBLE', 'Selected ROMs are not cable compatible');
    }
    const id = randomUUID();
    const now = this.now();
    return this.database.createLocalLinkSession({
      id,
      ownerAccountId: player1.accountId,
      player2AccountId: player2Mode === 'account' ? player2.accountId : null,
      player2Mode,
      leaseExpiresAt: now + this.leaseMs,
      now,
      participants: [
        { slot: 0, accountId: player1.accountId, profileKey: 'primary', romId: player1Rom.id },
        player2Mode === 'account'
          ? { slot: 1, accountId: player2.accountId, profileKey: 'primary', romId: player2Rom.id }
          : { slot: 1, accountId: player1.accountId, profileKey: 'guest-p2', romId: player2Rom.id },
      ],
    });
  }

  async recover(player1, player2) {
    requirePlayer(player1);
    await this.database.abortExpiredLocalLinkSessions(this.now());
    const session = await this.database.getRecoverableLocalLinkSession(player1.accountId, this.now());
    if (!session) return null;
    if (session.player2Mode === 'account' &&
        (!player2 || player2.accountId !== session.player2AccountId || !PLAY_PERMISSIONS.has(player2.permission))) {
      await this.database.abortLocalLinkSession(session.id, this.now());
      return null;
    }
    const checkpoint = await this.database.getLatestLocalCheckpointPair(session.id);
    if (!checkpoint && ['active', 'recovering', 'finishing'].includes(session.status)) {
      await this.database.abortLocalLinkSession(session.id, this.now());
      return null;
    }
    if (checkpoint) {
      await this.database.updateLocalLinkSession(session.id, {
        expectedStatuses: ['ready', 'active', 'recovering', 'finishing'],
        status: 'recovering',
        leaseExpiresAt: this.now() + this.leaseMs,
      }, this.now());
    }
    return { session: await this.database.getLocalLinkSession(session.id), checkpoint };
  }

  async get({ id, player1, player2 }) {
    const session = await this.#authorizedSession(id, player1, player2);
    if (session.leaseExpiresAt <= this.now() && !['completed', 'aborted'].includes(session.status)) {
      const aborted = await this.database.abortLocalLinkSession(
        id, this.now(), { onlyIfExpired: true },
      );
      if (aborted) throw localError(410, 'LOCAL_SESSION_EXPIRED', 'Local session expired');
      const renewed = await this.#authorizedSession(id, player1, player2);
      if (renewed.leaseExpiresAt > this.now()) return renewed;
      throw localError(410, 'LOCAL_SESSION_EXPIRED', 'Local session expired');
    }
    return session;
  }

  async setReady({ id, slot, ready, player1, player2 }) {
    await this.#authorizedSession(id, player1, player2);
    if (![0, 1].includes(slot)) throw localError(400, 'LOCAL_SLOT_INVALID', 'Invalid player slot');
    return this.database.updateLocalLinkSession(id, {
      expectedStatuses: ['preparing', 'ready'],
      slot,
      ready: ready !== false,
      deriveReadyStatus: true,
      leaseExpiresAt: this.now() + this.leaseMs,
    }, this.now());
  }

  async start({ id, player1, player2 }) {
    const session = await this.#authorizedSession(id, player1, player2);
    if (!session.participants.every((participant) => participant.ready)) {
      throw localError(409, 'LOCAL_NOT_READY', 'Both players must be ready');
    }
    return this.database.updateLocalLinkSession(
      id, {
        expectedStatuses: ['ready'],
        status: 'active',
        requireCheckpoint: true,
        leaseExpiresAt: this.now() + this.leaseMs,
      }, this.now(),
    );
  }

  async heartbeat({ id, player1, player2 }) {
    const session = await this.#authorizedSession(id, player1, player2);
    if (['completed', 'aborted'].includes(session.status)) return session;
    return this.database.updateLocalLinkSession(
      id, {
        expectedStatuses: ['preparing', 'ready', 'active', 'recovering'],
        leaseExpiresAt: this.now() + this.leaseMs,
      }, this.now(),
    );
  }

  async checkpoint({ id, sequence, states, metadata, player1, player2 }) {
    const session = await this.#authorizedSession(id, player1, player2);
    if (!['ready', 'active', 'recovering'].includes(session.status)) {
      throw localError(409, 'LOCAL_SESSION_NOT_ACTIVE', 'Local session is not active');
    }
    const payloads = decodePair(states, 2 * 1024 * 1024, 'checkpoint');
    return this.database.putLocalCheckpointPair(
      id,
      sequence,
      payloads,
      { ...metadata, leaseExpiresAt: this.now() + this.leaseMs },
      this.now(),
    );
  }

  async finish({ id, batteries, player1, player2 }) {
    const session = await this.#authorizedSession(id, player1, player2);
    if (!['active', 'ready', 'recovering', 'finishing'].includes(session.status)) {
      throw localError(409, 'LOCAL_SESSION_NOT_ACTIVE', 'Local session cannot finish');
    }
    const payloads = decodePair(batteries, 131_072, 'battery');
    for (const entry of payloads) {
      if (!BATTERY_SIZES.has(entry.payload.length)) {
        throw localError(400, 'BATTERY_INVALID', 'Battery save size is invalid');
      }
    }
    await this.database.updateLocalLinkSession(id, {
      expectedStatuses: ['ready', 'active', 'recovering'],
      status: 'finishing',
    }, this.now());
    try {
      return await this.database.commitLocalBatteryPair(id, payloads, this.now());
    } catch (error) {
      await this.database.abortLocalLinkSession(id, this.now());
      throw error;
    }
  }

  async abort({ id, player1, player2 }) {
    requirePlayer(player1);
    const session = await this.database.getLocalLinkSession(id);
    if (!session || session.ownerAccountId !== player1.accountId) {
      throw localError(404, 'LOCAL_SESSION_NOT_FOUND', 'Local session does not exist');
    }
    return this.database.abortLocalLinkSession(id, this.now());
  }

  async abortForAccount(accountId) {
    if (!accountId) return [];
    return this.database.abortLocalLinkSessionsForAccount(accountId, this.now());
  }

  async abortForPair(player1, player2) {
    if (!player1?.accountId || !player2?.accountId) return null;
    const session = await this.database.getRecoverableLocalLinkSessionForPair(
      player1.accountId, player2.accountId, this.now(),
    );
    if (!session) return null;
    return this.database.abortLocalLinkSession(session.id, this.now());
  }

  async #authorizedSession(id, player1, player2) {
    requirePlayer(player1);
    const session = await this.database.getLocalLinkSession(id);
    if (!session || session.ownerAccountId !== player1.accountId) {
      throw localError(404, 'LOCAL_SESSION_NOT_FOUND', 'Local session does not exist');
    }
    if (session.player2Mode === 'account' && player2?.accountId !== session.player2AccountId) {
      throw localError(403, 'LOCAL_PLAYER2_REQUIRED', 'Player 2 session is required');
    }
    if (session.player2Mode === 'account') requirePlayer(player2);
    return session;
  }

  async #gbaRom(id) {
    const rom = await this.database.getRom(id);
    if (!rom) throw localError(404, 'ROM_NOT_FOUND', 'ROM does not exist');
    if (rom.platform !== 'gba') throw localError(400, 'GBA_REQUIRED', 'Local cable requires GBA ROMs');
    return rom;
  }
}

function requirePlayer(session) {
  if (!session || !PLAY_PERMISSIONS.has(session.permission)) {
    throw localError(403, 'PLAY_PERMISSION_REQUIRED', 'Player permission is required');
  }
}

function decodePair(values, maxBytes, label) {
  if (!Array.isArray(values) || values.length !== 2) {
    throw localError(400, 'LOCAL_PAIR_INVALID', `Paired ${label} payload is required`);
  }
  return values.map((entry) => {
    if (![0, 1].includes(entry?.slot) || typeof entry?.data !== 'string' || entry.data.length === 0) {
      throw localError(400, 'LOCAL_PAIR_INVALID', `Invalid ${label} payload`);
    }
    const payload = Buffer.from(entry.data, 'base64');
    if (payload.length === 0 || payload.length > maxBytes) {
      throw localError(400, 'LOCAL_PAIR_INVALID', `Invalid ${label} payload size`);
    }
    return { slot: entry.slot, payload };
  });
}

function localError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
