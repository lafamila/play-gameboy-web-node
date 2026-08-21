import createVbaModule from '/core/vba172.js';
import { hostTransferData, isSlaveHandshake, LinkMessageQueue } from '/link-message-queue.js';
import {
  applyDirectCablePair,
  directCableIdle,
  releaseDirectCableGuest,
} from '/local-link-transport.js';
import { gamepadMaskForSlot } from '/player-input.js';

const FRAME_RATE = 59.7275;
const CORE_SAMPLE_RATE = 44100;
const SPEED_MODE_MULTIPLIER = 1.125;
const LINK_CHECKPOINT_INTERVAL = 30_000;
const LINK_ROOM_POLL_INTERVAL = 3_000;
const LINK_DIAGNOSTIC_INTERVAL = 1_000;
const STANDALONE_BATTERY_RECOVERY_KEY = 'gbc-standalone-battery-recovery';

function stalePlayerTwoLoadError() {
  const error = new Error('Player 2 load was superseded');
  error.code = 'PLAYER2_LOAD_STALE';
  return error;
}

function assertCurrentLoad(isCurrent) {
  if (!isCurrent()) throw stalePlayerTwoLoadError();
}

async function optionalSaveBytes(response, label) {
  if (response.status === 404) return null;
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `${label} failed (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const elements = Object.fromEntries([
  'auth-loading', 'login-view', 'login-link', 'visitor-view', 'app-view', 'visitor-account',
  'request-access', 'access-request-status', 'visitor-logout', 'account-name',
  'menu-toggle', 'app-menu-panel', 'logout',
  'rom-upload', 'refresh-roms', 'rom-select', 'load-rom', 'rom-meta', 'screen',
  'screen-shell', 'screen-empty', 'pause', 'mute', 'fullscreen', 'runtime-status',
  'speed-toggle',
  'quick-save', 'quick-load', 'export-state', 'import-state', 'import-state-label',
  'quick-state-meta', 'export-battery', 'import-battery', 'import-battery-label',
  'battery-meta', 'fixture-list', 'event-log', 'link-socket-status', 'link-lobby',
  'link-create', 'link-room-input', 'link-invite-input', 'link-join', 'link-room',
  'link-room-id', 'link-invite-row', 'link-invite-code', 'link-room-status',
  'link-room-copy-feedback', 'link-pw-copy-feedback',
  'link-participants', 'link-ready', 'link-start', 'link-finish', 'link-abort', 'link-close',
  'workspace', 'save-column', 'local-2p-toggle', 'local-2p-bar', 'local-2p-status',
  'local-p1-ready', 'local-p2-ready', 'local-start', 'local-exit', 'player-one-panel',
  'player-two-panel', 'player2-account', 'player2-logout', 'player2-choice', 'player2-login',
  'player2-guest', 'player2-close', 'player2-auth-status', 'player2-visitor',
  'player2-visitor-status', 'player2-request-access', 'player2-visitor-back', 'player2-runtime',
  'player2-toolbar',
  'player2-rom-select', 'player2-load', 'player2-screen', 'player2-screen-shell',
  'player2-screen-empty', 'player2-mute', 'player2-runtime-status',
].map((id) => [id, document.getElementById(id)]));

let wasmBinaryPromise;

function sharedWasmBinary() {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch('/core/vba172.wasm', { cache: 'no-cache' }).then(async (response) => {
      if (!response.ok) throw new Error(`Core download failed (${response.status})`);
      return response.arrayBuffer();
    });
  }
  return wasmBinaryPromise;
}

class PlayerRuntime {
  constructor({ slot, canvas, shell, statusElement, defaultMuted = false }) {
    this.slot = slot;
    this.canvas = canvas;
    this.shell = shell;
    this.statusElement = statusElement;
    this.defaultMuted = defaultMuted;
    this.generation = 0;
    this.shutdownPromise = Promise.resolve();
    this.canvasContext = canvas.getContext('2d', { alpha: false });
    this.frameWidth = 240;
    this.frameHeight = 160;
    this.imageData = this.canvasContext.createImageData(this.frameWidth, this.frameHeight);
    this.core = null;
    this.activeRom = null;
    this.romIdentity = '';
    this.running = false;
    this.paused = false;
    this.muted = defaultMuted;
    this.speedMode = false;
    this.animationHandle = 0;
    this.lastFrameTime = 0;
    this.frameDebt = 0;
    this.keyMask = 0;
    this.touchMask = 0;
    this.audioContext = null;
    this.audioNode = null;
    this.audioPointer = 0;
    this.audioQueue = [];
    this.audioPosition = 0;
    this.batteryTimer = 0;
    this.batterySavePromise = Promise.resolve();
    this.hasStoredQuickState = false;
  }

  setStatus(text, kind = 'idle') {
    if (!this.statusElement) return;
    this.statusElement.textContent = text;
    this.statusElement.className = `status ${kind}`;
  }

  async ensureCore() {
    if (this.core) return this.core;
    this.setStatus('Loading core', 'loading');
    this.core = await createVbaModule({
      wasmBinary: await sharedWasmBinary(),
      locateFile: (filename) => `/core/${filename}`,
      printErr: (message) => logEvent(`P${this.slot + 1} core: ${message}`, true),
    });
    ++this.generation;
    if (typeof this.core._vba_link_test_begin_request === 'function' && window.__gbaPoc) {
      window.__gbaPoc.runDirectCableProbe = () => localTwoPlayer.runDirectCableProbe();
    }
    if (this.core._vba_state_version() !== 8) throw new Error('Unexpected core state version');
    return this.core;
  }

  withBytes(bytes, callback) {
    const pointer = this.core._malloc(bytes.byteLength);
    try {
      this.core.HEAPU8.set(bytes, pointer);
      return callback(pointer, bytes.byteLength);
    } finally {
      this.core._free(pointer);
    }
  }

  error(fallback) {
    const pointer = this.core?._vba_last_error();
    return pointer ? this.core.UTF8ToString(pointer) || fallback : fallback;
  }

  exportBytes() {
    const pointer = this.core._vba_export_data();
    const size = this.core._vba_export_size();
    if (!pointer || size <= 0) throw new Error('Core returned an empty export');
    return Uint8Array.from(this.core.HEAPU8.subarray(pointer, pointer + size));
  }

  async ensureAudio() {
    await this.shutdownPromise;
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: CORE_SAMPLE_RATE, latencyHint: 'interactive' });
      this.audioNode = this.audioContext.createScriptProcessor(2048, 0, 2);
      this.audioPointer = this.core._malloc(16384 * Int16Array.BYTES_PER_ELEMENT);
      this.audioNode.onaudioprocess = (event) => this.renderAudio(event);
      this.audioNode.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
  }

  renderAudio(event) {
    const left = event.outputBuffer.getChannelData(0);
    const right = event.outputBuffer.getChannelData(1);
    if (!this.core || !this.running || this.paused || this.muted) {
      left.fill(0); right.fill(0); return;
    }
    while (this.audioQueue.length < left.length * 4) {
      const available = this.core._vba_audio_available();
      if (available <= 0) break;
      const count = Math.min(available, 16384);
      const read = this.core._vba_audio_read(this.audioPointer, count);
      const start = this.audioPointer >> 1;
      for (const sample of this.core.HEAP16.subarray(start, start + read)) {
        this.audioQueue.push(sample / 32768);
      }
    }
    const ratio = CORE_SAMPLE_RATE / this.audioContext.sampleRate;
    for (let index = 0; index < left.length; ++index) {
      const frame = Math.floor(this.audioPosition);
      left[index] = this.audioQueue[frame * 2] || 0;
      right[index] = this.audioQueue[frame * 2 + 1] || 0;
      this.audioPosition += ratio;
    }
    const consumed = Math.floor(this.audioPosition);
    if (consumed > 0) {
      this.audioQueue.splice(0, consumed * 2);
      this.audioPosition -= consumed;
    }
  }

  renderFrame() {
    const pointer = this.core?._vba_framebuffer();
    const stride = this.core?._vba_frame_stride();
    if (!pointer || !stride) return;
    for (let row = 0; row < this.frameHeight; ++row) {
      const source = pointer + row * stride * 4;
      this.imageData.data.set(
        this.core.HEAPU8.subarray(source, source + this.frameWidth * 4),
        row * this.frameWidth * 4,
      );
    }
    this.canvasContext.putImageData(this.imageData, 0, 0);
  }

  async loadRom(rom, romBytes, isCurrent = () => true) {
    await this.ensureCore();
    assertCurrentLoad(isCurrent);
    await this.ensureAudio();
    assertCurrentLoad(isCurrent);
    const isGba = rom.platform === 'gba';
    this.romIdentity = ascii(romBytes.subarray(isGba ? 0xa0 : 0x134, isGba ? 0xb0 : 0x143));
    const loaded = this.withBytes(romBytes, (pointer, size) =>
      this.core._vba_load_rom(pointer, size, isGba ? 0 : 1));
    if (!loaded) throw new Error(this.error('ROM load failed'));
    this.activeRom = rom;
    this.frameWidth = this.core._vba_frame_width();
    this.frameHeight = this.core._vba_frame_height();
    this.canvas.width = this.frameWidth;
    this.canvas.height = this.frameHeight;
    this.shell.style.aspectRatio = `${this.frameWidth} / ${this.frameHeight}`;
    this.imageData = this.canvasContext.createImageData(this.frameWidth, this.frameHeight);
    this.running = true;
    this.paused = false;
    this.lastFrameTime = 0;
    this.frameDebt = 1000 / FRAME_RATE;
    this.setStatus('Ready', 'running');
  }

  loadBattery(bytes) {
    validateBattery(bytes);
    const loaded = this.withBytes(bytes, (pointer, size) => this.core._vba_load_battery(pointer, size));
    if (!loaded) throw new Error(this.error('Battery load failed'));
  }

  loadState(bytes) {
    const loaded = this.withBytes(bytes, (pointer, size) => this.core._vba_load_state(pointer, size));
    if (!loaded) throw new Error(this.error('State load failed'));
    this.audioQueue = [];
    this.audioPosition = 0;
    this.renderFrame();
  }

  exportState() {
    if (!this.core?._vba_export_state()) throw new Error(this.error('State export failed'));
    return this.exportBytes();
  }

  exportBattery() {
    if (!this.core?._vba_export_battery()) throw new Error(this.error('Battery export failed'));
    return this.exportBytes();
  }

  runFrame() {
    this.core._vba_set_joypad(this.keyMask | this.touchMask | gamepadMask(this.slot));
    const result = this.core._vba_run_frame();
    if (result !== 2) this.renderFrame();
    return result;
  }

  shutdown() {
    clearInterval(this.batteryTimer);
    this.batteryTimer = 0;
    this.running = false;
    this.keyMask = 0;
    this.touchMask = 0;
    this.audioQueue = [];
    if (this.audioNode) {
      this.audioNode.onaudioprocess = null;
      this.audioNode.disconnect();
    }
    if (this.core && this.audioPointer) this.core._free(this.audioPointer);
    const closingAudioContext = this.audioContext;
    this.shutdownPromise = closingAudioContext && closingAudioContext.state !== 'closed'
      ? closingAudioContext.close().catch(() => {})
      : Promise.resolve();
    if (this.core) this.core._vba_shutdown();
    this.core = null;
    this.activeRom = null;
    this.audioContext = null;
    this.audioNode = null;
    this.audioPointer = 0;
    this.audioPosition = 0;
    this.muted = this.defaultMuted;
    this.setStatus('Idle', 'idle');
  }
}

const playerOne = new PlayerRuntime({
  slot: 0,
  canvas: elements.screen,
  shell: elements['screen-shell'],
  statusElement: elements['runtime-status'],
});
const playerTwo = new PlayerRuntime({
  slot: 1,
  canvas: elements['player2-screen'],
  shell: elements['player2-screen-shell'],
  statusElement: elements['player2-runtime-status'],
  defaultMuted: true,
});

for (const property of [
  'canvasContext', 'frameWidth', 'frameHeight', 'imageData', 'core', 'activeRom',
  'romIdentity', 'running', 'paused', 'muted', 'speedMode', 'animationHandle',
  'lastFrameTime', 'frameDebt', 'keyMask', 'touchMask', 'audioContext', 'audioNode',
  'audioPointer', 'audioQueue', 'audioPosition', 'batteryTimer', 'hasStoredQuickState',
]) {
  Object.defineProperty(globalThis, property, {
    configurable: true,
    get: () => playerOne[property],
    set: (value) => { playerOne[property] = value; },
  });
}

let roms = [];
let fixtures = [];
let sessionTimer;
let currentSession;
let currentPlayer2Session;
const player2AuthChannel = new BroadcastChannel('gbc-player2-auth');
let emulatorControlsEnabled = false;
let linkRoom;
let linkInviteCode = '';
let linkSocket;
let linkSocketGeneration = 0;
let linkReconnectTimer;
let linkRoomTimer;
let linkCheckpointTimer;
let linkDiagnosticTimer;
let linkPumpScheduled = false;
let linkRoomRefreshing = false;
let linkCheckpointing = false;
let linkCheckpointPendingSequence = null;
let linkCheckpointPendingState = '';
let linkFinishSubmitted = false;
let linkCorePlayer = -1;
let linkDetachPending = false;
let linkLastOfferSequence = -1;
let linkGuestHandshakePending = false;
let linkLastReleaseSequence = -1;
let linkTransferActive = false;
let linkIdleSince = 0;
let linkFinishIdle = false;
let linkDebugEnabled = false;
let localTwoPlayer;
const linkMessageQueue = new LinkMessageQueue();
const copyFeedbackTimers = new Map();

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    if (currentSession?.csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', currentSession.csrfToken);
    }
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && currentSession &&
      !url.includes('/player2/') && !url.startsWith('/api/local-2p')) {
    stopEmulation();
    currentSession = null;
    showAuthView('login');
  }
  return response;
}

function stopEmulation() {
  running = false;
  clearInterval(batteryTimer);
  cancelAnimationFrame(animationHandle);
  closeLinkSocket();
  clearLinkTimers();
  if (core) core._vba_shutdown();
  linkCorePlayer = -1;
  linkMessageQueue.clear();
}

function setStatus(text, kind = 'idle') {
  elements['runtime-status'].textContent = text;
  elements['runtime-status'].className = `status ${kind}`;
}

function logEvent(message, error = false) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  if (error) item.className = 'error';
  elements['event-log'].prepend(item);
  while (elements['event-log'].children.length > 30) {
    elements['event-log'].lastElementChild.remove();
  }
}

function logCableSequence(message, sequence) {
  if (sequence < 10 || sequence % 100 === 0) logEvent(`${message} ${sequence}`);
}

function setMenuOpen(open, focusToggle = false) {
  elements['app-menu-panel'].hidden = !open;
  elements['menu-toggle'].setAttribute('aria-expanded', String(open));
  if (!open && focusToggle) elements['menu-toggle'].focus();
}

function applyPermissionVisibility() {
  const permission = currentSession?.permission;
  for (const element of document.querySelectorAll('.superadmin-only')) {
    element.hidden = permission !== 'superadmin';
  }
  for (const element of document.querySelectorAll('.save-admin-only')) {
    element.hidden = !['admin', 'superadmin'].includes(permission);
  }
}

function showCopyFeedback(element, message) {
  clearTimeout(copyFeedbackTimers.get(element));
  element.textContent = message;
  copyFeedbackTimers.set(element, setTimeout(() => {
    element.textContent = '';
    copyFeedbackTimers.delete(element);
  }, 1800));
}

async function copyLinkValue(valueElement, feedbackElement, label) {
  const value = valueElement.textContent.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showCopyFeedback(feedbackElement, 'Copied');
  } catch (error) {
    showCopyFeedback(feedbackElement, 'Failed');
    throw new Error(`${label} copy failed: ${error.message}`);
  }
}

function isLinkRoomOpen(room = linkRoom) {
  return Boolean(room && !['completed', 'aborted'].includes(room.status));
}

function currentLinkParticipant(room = linkRoom) {
  const accountId = currentSession?.account?.id;
  return room?.participants?.find((participant) => participant?.accountId === accountId) || null;
}

function activeGbaSelected() {
  return Boolean(activeRom?.platform === 'gba' && activeRom.id === elements['rom-select'].value);
}

function cableIdle() {
  return Boolean(core && !core._vba_link_waiting() && !core._vba_link_transfer_active() &&
    !core._vba_link_request_pending());
}

function updateLinkIdleGate(now = performance.now()) {
  const idle = cableIdle();
  if (!idle) {
    linkIdleSince = 0;
    if (linkFinishIdle) {
      linkFinishIdle = false;
      renderLinkRoom();
    }
    return;
  }
  if (!linkIdleSince) linkIdleSince = now;
  if (!linkFinishIdle && now - linkIdleSince >= 750) {
    linkFinishIdle = true;
    renderLinkRoom();
  }
}

function setControls(enabled) {
  emulatorControlsEnabled = enabled;
  applyControlState();
  if (enabled) updateStoredStateControls();
}

function applyControlState() {
  const roomOpen = isLinkRoomOpen();
  const localOpen = Boolean(localTwoPlayer?.enabled);
  const localCableOpen = Boolean(localTwoPlayer?.preparing || localTwoPlayer?.active);
  for (const id of ['pause', 'mute', 'fullscreen']) elements[id].disabled = !emulatorControlsEnabled;
  elements['speed-toggle'].disabled = !emulatorControlsEnabled || roomOpen || localCableOpen;
  elements['quick-save'].disabled = !emulatorControlsEnabled || roomOpen || localCableOpen;
  elements['quick-load'].disabled = !emulatorControlsEnabled || roomOpen || localCableOpen || !hasStoredQuickState;

  const saveAdminEnabled = emulatorControlsEnabled &&
    ['admin', 'superadmin'].includes(currentSession?.permission);
  elements['export-state'].disabled = !saveAdminEnabled || roomOpen || localCableOpen;
  elements['import-state'].disabled = !saveAdminEnabled || roomOpen || localCableOpen;
  elements['import-battery'].disabled = !saveAdminEnabled || roomOpen || localCableOpen;
  elements['export-battery'].disabled = !saveAdminEnabled || localCableOpen;
  elements['import-state-label'].classList.toggle('disabled', elements['import-state'].disabled);
  elements['import-battery-label'].classList.toggle('disabled', elements['import-battery'].disabled);
  elements['rom-select'].disabled = roomOpen || localCableOpen;
  elements['load-rom'].disabled = roomOpen || localCableOpen || roms.length === 0;
  const playerTwoLoadBlocked = localCableOpen || Boolean(localTwoPlayer?.playerTwoLoading);
  elements['player2-rom-select'].disabled = playerTwoLoadBlocked;
  elements['player2-load'].disabled = playerTwoLoadBlocked || !localTwoPlayer?.mode ||
    !elements['player2-rom-select'].value;

  const canEnterRoom = activeGbaSelected() && !linkRoom && !localOpen;
  elements['link-create'].disabled = !canEnterRoom;
  elements['link-join'].disabled = !canEnterRoom || !elements['link-room-input'].value.trim() ||
    !elements['link-invite-input'].value.trim();
  elements['local-2p-toggle'].disabled = roomOpen;
  renderFixtures();
}

function coreError(fallback) {
  if (!core) return fallback;
  const pointer = core._vba_last_error();
  return pointer ? core.UTF8ToString(pointer) || fallback : fallback;
}

function withCoreBytes(bytes, callback) {
  const pointer = core._malloc(bytes.byteLength);
  try {
    core.HEAPU8.set(bytes, pointer);
    return callback(pointer, bytes.byteLength);
  } finally {
    core._free(pointer);
  }
}

function getExportBytes() {
  const pointer = core._vba_export_data();
  const size = core._vba_export_size();
  if (!pointer || size <= 0) throw new Error('Core returned an empty export');
  return Uint8Array.from(core.HEAPU8.subarray(pointer, pointer + size));
}

async function updateStoredStateControls() {
  if (!activeRom || !core) {
    hasStoredQuickState = false;
    applyControlState();
    return;
  }
  const response = await apiFetch(`/api/saves/${activeRom.id}/meta`);
  if (!response.ok) throw new Error('Save metadata request failed');
  const metadata = await response.json();
  const state = metadata.saves.find((save) => save.kind === 'state');
  const battery = metadata.saves.find((save) => save.kind === 'battery');
  hasStoredQuickState = Boolean(state);
  elements['quick-state-meta'].textContent = state
    ? `Account state / ${new Date(Number(state.updatedAt)).toLocaleString()}`
    : 'No account state';
  elements['battery-meta'].textContent = battery
    ? `Account battery / ${new Date(Number(battery.updatedAt)).toLocaleString()}`
    : 'No account battery save';
  applyControlState();
}

function ascii(bytes) {
  return String.fromCharCode(...bytes).replace(/\0+$/, '');
}

async function inspectState(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot inspect gzip states');
  }
  let raw;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error('State is not a valid gzip file');
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(0, true);
  const isGba = activeRom?.platform === 'gba';
  const identity = ascii(raw.subarray(4, isGba ? 20 : 19));
  const usesBios = isGba && view.getUint32(20, true) !== 0;
  return { version, identity, usesBios, rawSize: raw.byteLength };
}

async function validateState(bytes) {
  const info = await inspectState(bytes);
  const expectedVersion = activeRom.platform === 'gba' ? 8 : 10;
  if (info.version !== expectedVersion) {
    throw new Error(`State version ${info.version} is not VBA 1.7.2 v${expectedVersion}`);
  }
  if ((activeRom.platform === 'gba' && info.rawSize !== 739838) ||
      (activeRom.platform !== 'gba' && info.rawSize < 300)) {
    throw new Error(`Unexpected state size: ${info.rawSize}`);
  }
  if (info.identity !== romIdentity) {
    throw new Error(`State ROM ${info.identity} does not match ${romIdentity}`);
  }
  if (info.usesBios) throw new Error('BIOS states are not supported by this POC');
  return info;
}

function validateBattery(bytes) {
  if (![256, 512, 2048, 8192, 32768, 32812, 65536, 131072].includes(bytes.byteLength)) {
    throw new Error(`Unsupported battery size: ${bytes.byteLength}`);
  }
}

async function ensureCore() {
  if (core) return core;
  setStatus('Loading core', 'loading');
  core = await createVbaModule({
    wasmBinary: await sharedWasmBinary(),
    locateFile: (filename) => `/core/${filename}`,
    printErr: (message) => logEvent(`Core: ${message}`, true),
  });
  if (core._vba_state_version() !== 8) throw new Error('Unexpected core state version');
  return core;
}

async function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: CORE_SAMPLE_RATE, latencyHint: 'interactive' });
    audioNode = audioContext.createScriptProcessor(2048, 0, 2);
    audioPointer = core._malloc(16384 * Int16Array.BYTES_PER_ELEMENT);
    audioNode.onaudioprocess = renderAudio;
    audioNode.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') await audioContext.resume();
}

function pullAudio(minimumSamples) {
  while (audioQueue.length < minimumSamples) {
    const available = core._vba_audio_available();
    if (available <= 0) break;
    const count = Math.min(available, 16384);
    const read = core._vba_audio_read(audioPointer, count);
    const start = audioPointer >> 1;
    for (const sample of core.HEAP16.subarray(start, start + read)) audioQueue.push(sample / 32768);
  }
}

function renderAudio(event) {
  const left = event.outputBuffer.getChannelData(0);
  const right = event.outputBuffer.getChannelData(1);
  const linkBlocked = isLinkRoomOpen() &&
    (linkRoom.paused || linkRoom.status === 'finishing' || linkCheckpointing);
  if (!core || !running || paused || linkBlocked || muted || speedMode) {
    if (core && speedMode && audioPointer) {
      while (core._vba_audio_available() > 0) {
        core._vba_audio_read(audioPointer, Math.min(core._vba_audio_available(), 16384));
      }
      audioQueue = [];
      audioPosition = 0;
    }
    left.fill(0); right.fill(0); return;
  }
  const ratio = CORE_SAMPLE_RATE / audioContext.sampleRate;
  const bufferMultiplier = linkRoom?.status === 'active' ? 3 : 1;
  pullAudio(Math.ceil((left.length * bufferMultiplier * ratio + 2) * 2));
  for (let i = 0; i < left.length; ++i) {
    const frame = Math.floor(audioPosition);
    left[i] = audioQueue[frame * 2] || 0;
    right[i] = audioQueue[frame * 2 + 1] || 0;
    audioPosition += ratio;
  }
  const consumed = Math.floor(audioPosition);
  if (consumed > 0) {
    audioQueue.splice(0, consumed * 2);
    audioPosition -= consumed;
  }
}

function renderFrame() {
  const pointer = core._vba_framebuffer();
  const stride = core._vba_frame_stride();
  if (!pointer) return;
  for (let row = 0; row < frameHeight; ++row) {
    const source = pointer + row * stride * 4;
    imageData.data.set(
      core.HEAPU8.subarray(source, source + frameWidth * 4),
      row * frameWidth * 4,
    );
  }
  canvasContext.putImageData(imageData, 0, 0);
}

function gamepadMask(slot = 0) {
  return gamepadMaskForSlot(navigator.getGamepads?.(), slot);
}

class LocalTwoPlayerController {
  constructor() {
    this.enabled = false;
    this.active = false;
    this.preparing = false;
    this.playerTwoLoading = false;
    this.playerTwoLoadGeneration = 0;
    this.mode = null;
    this.session = null;
    this.ready = [false, false];
    this.lastPairSequence = -1;
    this.lastReleaseSequence = -1;
    this.guestHandshakePending = false;
    this.checkpointSequence = 0;
    this.pendingCheckpoint = null;
    this.lastCheckpoint = null;
    this.heartbeatTimer = 0;
    this.checkpointTimer = 0;
    this.exiting = false;
    this.rollbackCount = 0;
    this.boundUpdateLayout = () => this.updateLayout();
    this.resizeObserver = new ResizeObserver(() => this.updateLayout());
  }

  updateLayout() {
    if (!this.enabled) return;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    elements.workspace.classList.toggle('local-portrait', height > width);
  }

  async runGuarded(action) {
    try {
      return await action();
    } catch (error) {
      let cleanupError = null;
      try {
        if (this.session) await this.abortServerSession();
      } catch (caught) {
        cleanupError = caught;
      } finally {
        this.restoreSinglePlayer();
      }
      if (cleanupError) {
        throw new Error(`${error.message}; local cleanup failed: ${cleanupError.message}`);
      }
      throw error;
    }
  }

  async enter() {
    if (isLinkRoomOpen()) throw new Error('Close the remote Room before starting local 2P');
    this.enabled = true;
    elements.workspace.classList.add('local-2p');
    elements['player-two-panel'].hidden = false;
    elements['local-2p-bar'].hidden = false;
    elements['local-2p-toggle'].textContent = 'Exit 2P';
    elements['player2-choice'].hidden = false;
    elements['player2-runtime'].hidden = true;
    elements['player2-toolbar'].hidden = true;
    elements['player2-visitor'].hidden = true;
    this.clearReady();
    this.resizeObserver.observe(elements.workspace);
    window.visualViewport?.addEventListener('resize', this.boundUpdateLayout);
    window.addEventListener('resize', this.boundUpdateLayout);
    this.updateLayout();
    setMenuOpen(false);
    applyControlState();
    await this.refreshPlayer2Session();
  }

  async refreshPlayer2Session() {
    const response = await fetch('/api/player2/session', { cache: 'no-store' });
    const result = response.ok ? await response.json() : { authenticated: false };
    currentPlayer2Session = result.authenticated ? result : null;
    if (!currentPlayer2Session) return;
    if (currentPlayer2Session.account.id === currentSession.account.id) {
      currentPlayer2Session = null;
      elements['player2-auth-status'].textContent = 'Choose a different account';
      return;
    }
    if (currentPlayer2Session.permission === 'visitor') {
      elements['player2-choice'].hidden = true;
      elements['player2-visitor'].hidden = false;
      const access = await fetch('/api/player2/access-request').then((item) =>
        item.ok ? item.json() : { application: null });
      const pending = access.application?.status === 'pending';
      elements['player2-visitor-status'].textContent = pending
        ? 'Player 2 access request pending' : 'Player 2 needs user access';
      elements['player2-request-access'].disabled = pending;
      return;
    }
    this.selectMode('account');
  }

  selectMode(mode) {
    this.mode = mode;
    elements['player2-choice'].hidden = true;
    elements['player2-visitor'].hidden = true;
    elements['player2-runtime'].hidden = false;
    elements['player2-toolbar'].hidden = false;
    elements['player2-logout'].hidden = mode !== 'account';
    elements['player2-account'].textContent = mode === 'guest'
      ? `${currentSession.account.name || currentSession.account.id} / Guest P2`
      : currentPlayer2Session.account.name || currentPlayer2Session.account.email ||
        currentPlayer2Session.account.id;
    this.renderRomCatalog();
    applyControlState();
  }

  renderRomCatalog() {
    const selected = elements['player2-rom-select'].value;
    elements['player2-rom-select'].replaceChildren(...roms.filter((rom) => rom.platform === 'gba').map((rom) => {
      const option = document.createElement('option');
      option.value = rom.id;
      option.textContent = `[GBA] ${rom.title} (${rom.gameCode})`;
      return option;
    }));
    if (roms.some((rom) => rom.id === selected && rom.platform === 'gba')) {
      elements['player2-rom-select'].value = selected;
    }
  }

  resetCableMetadata() {
    this.guestHandshakePending = false;
    this.lastPairSequence = -1;
    this.lastReleaseSequence = -1;
    this.checkpointSequence = 0;
    this.pendingCheckpoint = null;
    this.lastCheckpoint = null;
  }

  bothRuntimesLoaded() {
    return Boolean(playerOne.running && playerTwo.running &&
      playerOne.activeRom?.platform === 'gba' && playerTwo.activeRom?.platform === 'gba');
  }

  clearReady() {
    this.ready = [false, false];
    this.renderReadyControls();
  }

  renderReadyControls() {
    const canReady = this.enabled && this.bothRuntimesLoaded() && !this.playerTwoLoading &&
      !this.preparing && !this.active;
    for (const slot of [0, 1]) {
      const button = elements[slot === 0 ? 'local-p1-ready' : 'local-p2-ready'];
      button.disabled = !canReady;
      button.textContent = this.ready[slot] ? `P${slot + 1} Not ready` : `P${slot + 1} Ready`;
      button.setAttribute('aria-pressed', String(this.ready[slot]));
    }
    elements['local-start'].disabled = !canReady || !this.ready.every(Boolean);
    if (this.active) elements['local-2p-status'].textContent = 'Local cable active';
    else if (this.preparing) elements['local-2p-status'].textContent = 'Starting local cable';
    else if (!this.bothRuntimesLoaded()) elements['local-2p-status'].textContent = 'Load both GBA players';
    else if (this.ready.every(Boolean)) elements['local-2p-status'].textContent = 'Ready to start';
    else elements['local-2p-status'].textContent = 'Players running independently';
  }

  async loadPlayerTwo() {
    if (!activeRom || activeRom.platform !== 'gba') {
      throw new Error('Load a GBA ROM for Player 1 first');
    }
    const selected = roms.find((rom) =>
      rom.id === elements['player2-rom-select'].value && rom.platform === 'gba');
    if (!selected) throw new Error('Select a GBA ROM for Player 2');
    if (this.preparing || this.active) throw new Error('Stop the local cable before loading another ROM');
    if (this.playerTwoLoading) throw new Error('Player 2 is already loading');
    const generation = ++this.playerTwoLoadGeneration;
    const isCurrent = () => this.enabled && generation === this.playerTwoLoadGeneration;
    const previous = playerTwo.running && playerTwo.activeRom ? {
      rom: playerTwo.activeRom,
      state: playerTwo.exportState(),
      battery: playerTwo.core._vba_export_battery() ? playerTwo.exportBytes() : null,
      paused: playerTwo.paused,
      muted: playerTwo.muted,
    } : null;
    this.playerTwoLoading = true;
    this.clearReady();
    clearInterval(playerTwo.batteryTimer);
    applyControlState();
    if (previous) playerTwo.paused = true;
    playerTwo.setStatus('Loading ROM', 'loading');
    let loadData = null;
    let mutationStarted = false;
    try {
      if (previous) await persistStandaloneBattery(playerTwo, this.mode);
      assertCurrentLoad(isCurrent);
      loadData = await this.fetchRuntimeLoadData(selected, this.mode, null, isCurrent);
      assertCurrentLoad(isCurrent);
      mutationStarted = true;
      await this.applyRuntimeLoad(playerTwo, selected, loadData, isCurrent);
      elements['player2-screen-empty'].hidden = true;
      elements['player2-mute'].disabled = false;
      return true;
    } catch (error) {
      if (error.code === 'PLAYER2_LOAD_STALE') return false;
      let failure = error;
      if (previous) {
        try {
          if (mutationStarted) {
            let previousRomBytes = previous.rom.id === selected.id ? loadData?.romBytes : null;
            if (!previousRomBytes) {
              const response = await apiFetch(`/api/roms/${previous.rom.id}/file`);
              if (!response.ok) throw new Error('Previous Player 2 ROM recovery failed');
              previousRomBytes = new Uint8Array(await response.arrayBuffer());
            }
            assertCurrentLoad(isCurrent);
            await playerTwo.loadRom(previous.rom, previousRomBytes, isCurrent);
            if (previous.battery) playerTwo.loadBattery(previous.battery);
            playerTwo.loadState(previous.state);
          }
          playerTwo.paused = previous.paused;
          playerTwo.muted = previous.muted;
          playerTwo.setStatus(previous.paused ? 'Paused' : 'Running',
            previous.paused ? 'idle' : 'running');
        } catch (recoveryError) {
          failure = new Error(`${error.message}; Player 2 recovery failed: ${recoveryError.message}`);
        }
      } else if (mutationStarted) {
        playerTwo.shutdown();
        elements['player2-screen-empty'].hidden = false;
      } else {
        playerTwo.setStatus('Idle', 'idle');
      }
      throw failure;
    } finally {
      if (generation === this.playerTwoLoadGeneration) {
        this.playerTwoLoading = false;
        if (playerTwo.running) restartPlayerTwoBatteryTimer();
        this.renderReadyControls();
        applyControlState();
      }
    }
  }

  async fetchRuntimeLoadData(rom, mode, checkpointState, isCurrent = () => true) {
    assertCurrentLoad(isCurrent);
    const romResponse = await apiFetch(`/api/roms/${rom.id}/file`);
    if (!romResponse.ok) throw new Error('ROM download failed');
    const romBytes = new Uint8Array(await romResponse.arrayBuffer());
    assertCurrentLoad(isCurrent);
    const savePrefix = `/api/player2/${mode}/saves`;
    const batteryResponse = await apiFetch(`${savePrefix}/${rom.id}/battery`);
    const batteryBytes = await optionalSaveBytes(batteryResponse, 'Player 2 battery request');
    assertCurrentLoad(isCurrent);
    let stateBytes = checkpointState ? base64Bytes(checkpointState) : null;
    if (!stateBytes) {
      const stateResponse = await apiFetch(`${savePrefix}/${rom.id}/state`);
      stateBytes = await optionalSaveBytes(stateResponse, 'Player 2 state request');
    }
    assertCurrentLoad(isCurrent);
    return { romBytes, batteryBytes, stateBytes };
  }

  async applyRuntimeLoad(runtime, rom, data, isCurrent = () => true) {
    await runtime.loadRom(rom, data.romBytes, isCurrent);
    assertCurrentLoad(isCurrent);
    if (data.batteryBytes) runtime.loadBattery(data.batteryBytes);
    if (data.stateBytes) runtime.loadState(data.stateBytes);
    runtime.renderFrame();
  }

  async loadRuntime(runtime, rom, mode, checkpointState = null) {
    runtime.setStatus('Loading ROM', 'loading');
    if (runtime.slot === 0) {
      const romResponse = await apiFetch(`/api/roms/${rom.id}/file`);
      if (!romResponse.ok) throw new Error('ROM download failed');
      await runtime.loadRom(rom, new Uint8Array(await romResponse.arrayBuffer()));
      const batteryResponse = await apiFetch(`/api/saves/${rom.id}/battery`);
      if (batteryResponse.ok) runtime.loadBattery(new Uint8Array(await batteryResponse.arrayBuffer()));
      if (checkpointState) runtime.loadState(base64Bytes(checkpointState));
      runtime.renderFrame();
      return;
    }
    const data = await this.fetchRuntimeLoadData(rom, mode, checkpointState);
    await this.applyRuntimeLoad(runtime, rom, data);
  }

  async setReady(slot) {
    if (!this.bothRuntimesLoaded()) throw new Error('Load both GBA players before readying');
    if (this.preparing || this.active) return;
    this.ready[slot] = !this.ready[slot];
    this.renderReadyControls();
  }

  async start() {
    if (this.preparing || this.active || this.playerTwoLoading) return;
    if (!this.bothRuntimesLoaded() || !this.ready.every(Boolean)) {
      throw new Error('Both loaded GBA players must be ready');
    }
    const previousPaused = [playerOne.paused, playerTwo.paused];
    this.preparing = true;
    playerOne.paused = true;
    playerTwo.paused = true;
    clearInterval(batteryTimer);
    clearInterval(playerTwo.batteryTimer);
    this.renderReadyControls();
    applyControlState();
    try {
      await Promise.all([
        persistStandaloneBattery(playerOne, 'account'),
        persistStandaloneBattery(playerTwo, this.mode),
      ]);
      const response = await apiFetch('/api/local-2p', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player2Mode: this.mode,
          player1RomId: playerOne.activeRom.id,
          player2RomId: playerTwo.activeRom.id,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Local 2P setup failed');
      this.session = body.session;
      this.resetCableMetadata();
      await this.setServerReady(0);
      await this.setServerReady(1);
      await this.checkpoint(true);
      if (!this.lastCheckpoint) throw new Error('Initial paired checkpoint failed');
      const startResponse = await apiFetch(`/api/local-2p/${this.session.id}/start`, { method: 'POST' });
      const startBody = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(startBody.error || 'Local 2P start failed');
      this.session = startBody.session;
      if (!cableIdle() || !core._vba_link_set_player(0) ||
          !playerTwo.core?._vba_link_set_player(1)) {
        throw new Error('Both cable cores must be idle before Start');
      }
      this.active = true;
      this.preparing = false;
      paused = false;
      playerTwo.paused = false;
      playerTwo.running = true;
      speedMode = false;
      elements['speed-toggle'].setAttribute('aria-pressed', 'false');
      elements['speed-toggle'].textContent = 'Speed off';
      this.lastPairSequence = -1;
      this.lastReleaseSequence = -1;
      this.rollbackCount = 0;
      this.renderReadyControls();
      setStatus('Running / P1', 'running');
      playerTwo.setStatus('Running / P2', 'running');
      this.startTimers();
      applyControlState();
    } catch (error) {
      let failure = error;
      for (const runtime of [playerOne, playerTwo]) {
        runtime.core?._vba_link_cancel_wait();
        runtime.core?._vba_link_set_player(-1);
      }
      if (this.session) {
        try {
          await this.abortServerSession();
        } catch (abortError) {
          failure = new Error(`${error.message}; local abort failed: ${abortError.message}`);
        }
      }
      this.session = null;
      this.active = false;
      this.preparing = false;
      this.resetCableMetadata();
      playerOne.paused = previousPaused[0];
      playerTwo.paused = previousPaused[1];
      setStatus(playerOne.paused ? 'Paused' : 'Running', playerOne.paused ? 'idle' : 'running');
      playerTwo.setStatus(playerTwo.paused ? 'Paused' : 'Running', playerTwo.paused ? 'idle' : 'running');
      restartBatteryTimer();
      restartPlayerTwoBatteryTimer();
      this.renderReadyControls();
      applyControlState();
      throw failure;
    }
  }

  async setServerReady(slot) {
    const headers = { 'Content-Type': 'application/json' };
    if (slot === 1 && this.mode === 'account') {
      headers['X-Player2-CSRF-Token'] = currentPlayer2Session.csrfToken;
    }
    const response = await apiFetch(
      `/api/local-2p/${this.session.id}/${slot === 0 ? 'player1-ready' : 'player2-ready'}`,
      { method: 'POST', headers, body: JSON.stringify({ ready: true }) },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Server Ready failed');
    this.session = body.session;
  }

  startTimers() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.checkpointTimer);
    this.heartbeatTimer = setInterval(() => runAction(() => this.heartbeat()), 30_000);
    this.checkpointTimer = setInterval(() => runAction(() => this.checkpoint()), LINK_CHECKPOINT_INTERVAL);
  }

  async heartbeat() {
    if (!this.session || !this.active) return;
    const response = await apiFetch(`/api/local-2p/${this.session.id}/heartbeat`, { method: 'POST' });
    if (!response.ok) {
      if ([401, 403, 410].includes(response.status)) await this.exit();
      throw new Error('Local 2P session expired');
    }
    this.session = (await response.json()).session;
  }

  step(timestamp) {
    if (!this.active) return;
    for (const runtime of [playerOne, playerTwo]) {
      const elapsed = runtime.lastFrameTime ? Math.min(timestamp - runtime.lastFrameTime, 100) : 0;
      runtime.lastFrameTime = timestamp;
      runtime.frameDebt += elapsed;
    }
    const frameDuration = 1000 / FRAME_RATE;
    let cycles = 0;
    while (cycles < 3 && (playerOne.frameDebt >= frameDuration || playerTwo.frameDebt >= frameDuration)) {
      this.releaseGuestIfIdle();
      if (playerOne.frameDebt >= frameDuration && !playerOne.paused &&
          !core._vba_link_waiting() && !core._vba_link_guest_held()) {
        playerOne.runFrame();
        playerOne.frameDebt -= frameDuration;
      }
      this.exchangeCable();
      if (playerTwo.frameDebt >= frameDuration && !playerTwo.paused &&
          !playerTwo.core._vba_link_waiting() && !playerTwo.core._vba_link_guest_held()) {
        playerTwo.runFrame();
        playerTwo.frameDebt -= frameDuration;
      }
      this.exchangeCable();
      ++cycles;
    }
    playerOne.frameDebt = Math.min(playerOne.frameDebt, frameDuration * 2);
    playerTwo.frameDebt = Math.min(playerTwo.frameDebt, frameDuration * 2);
  }

  stepIndependent(timestamp) {
    if (!this.enabled || this.active || this.preparing || !playerTwo.running || !playerTwo.core) return;
    const elapsed = playerTwo.lastFrameTime ? Math.min(timestamp - playerTwo.lastFrameTime, 100) : 0;
    playerTwo.lastFrameTime = timestamp;
    playerTwo.frameDebt += elapsed;
    const frameDuration = 1000 / FRAME_RATE;
    let frames = 0;
    while (!playerTwo.paused && playerTwo.frameDebt >= frameDuration && frames < 3) {
      playerTwo.runFrame();
      playerTwo.frameDebt -= frameDuration;
      ++frames;
    }
    playerTwo.frameDebt = Math.min(playerTwo.frameDebt, frameDuration * 2);
  }

  exchangeCable() {
    const result = applyDirectCablePair(playerOne.core, playerTwo.core, {
      lastPairSequence: this.lastPairSequence,
      guestHandshakePending: this.guestHandshakePending,
    });
    if (!result.applied) return;
    this.guestHandshakePending = result.guestHandshakePending;
    this.lastPairSequence = result.lastPairSequence;
    logCableSequence('Local cable pair', result.sequence);
  }

  releaseGuestIfIdle() {
    const result = releaseDirectCableGuest(
      playerOne.core, playerTwo.core, this.lastReleaseSequence,
    );
    this.lastReleaseSequence = result.lastReleaseSequence;
  }

  runDirectCableProbe() {
    if (this.active || this.preparing || !playerOne.core || !playerTwo.core) {
      throw new Error('Direct cable probe requires two loaded inactive runtimes');
    }
    const host = playerOne.core;
    const guest = playerTwo.core;
    if (!host._vba_link_set_player(0) || !guest._vba_link_set_player(1) ||
        !guest._vba_link_test_set_data(0xabcd) ||
        !host._vba_link_test_begin_request(0x1234, 3)) {
      throw new Error('Real core cable probe setup failed');
    }
    try {
      const pair = applyDirectCablePair(host, guest, {
        lastPairSequence: -1,
        guestHandshakePending: false,
      });
      if (!pair.applied) throw new Error('Real core cable pair was not applied');
      const hostPeerData = Number(host._vba_link_test_finish_and_peer_data());
      const guestPeerData = Number(guest._vba_link_test_finish_and_peer_data());
      return {
        applied: pair.applied,
        sequence: pair.sequence,
        masterData: pair.masterData,
        slaveData: pair.slaveData,
        hostPeerData,
        guestPeerData,
        independentMemories: host.HEAPU8.buffer !== guest.HEAPU8.buffer,
      };
    } finally {
      host._vba_link_cancel_wait();
      guest._vba_link_cancel_wait();
      host._vba_link_set_player(-1);
      guest._vba_link_set_player(-1);
    }
  }

  isCableIdle() {
    return directCableIdle([playerOne, playerTwo]);
  }

  async checkpoint(allowReady = false) {
    if ((!this.active && !allowReady) || (!this.pendingCheckpoint && !this.isCableIdle())) return false;
    if (!this.pendingCheckpoint) {
      this.pendingCheckpoint = {
        sequence: this.checkpointSequence,
        states: [playerOne, playerTwo].map((runtime) => ({
          slot: runtime.slot,
          data: bytesBase64(runtime.exportState()),
        })),
        metadata: {
          guestHandshakePending: this.guestHandshakePending,
          lastPairSequence: this.lastPairSequence,
          lastReleaseSequence: this.lastReleaseSequence,
        },
      };
    }
    const pending = this.pendingCheckpoint;
    const response = await apiFetch(`/api/local-2p/${this.session.id}/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pending),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Paired checkpoint failed');
    this.lastCheckpoint = body.checkpoint;
    this.checkpointSequence = pending.sequence + 1;
    this.pendingCheckpoint = null;
    return true;
  }

  async exit({ revokePlayer2 = true } = {}) {
    if (this.exiting) return;
    this.exiting = true;
    let failure = null;
    try {
      clearInterval(this.heartbeatTimer);
      clearInterval(this.checkpointTimer);
      if (this.session && this.active) {
        playerOne.paused = true;
        playerTwo.paused = true;
        const idle = await this.waitForCableIdle(750);
        if (idle) {
          const batteries = [playerOne, playerTwo].map((runtime) => ({
            slot: runtime.slot,
            data: bytesBase64(runtime.exportBattery()),
          }));
          const response = await apiFetch(`/api/local-2p/${this.session.id}/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batteries }),
          });
          if (!response.ok) throw new Error((await response.json()).error || 'Paired battery commit failed');
        } else {
          this.restorePairedCheckpoint();
          await this.abortServerSession();
        }
      } else if (this.session) {
        await this.abortServerSession();
      } else if (playerTwo.running) {
        await persistStandaloneBattery(playerTwo, this.mode);
      }
    } catch (error) {
      failure = error;
      if (this.lastCheckpoint) {
        try {
          this.restorePairedCheckpoint();
        } catch (rollbackError) {
          failure = new Error(`${error.message}; paired rollback failed: ${rollbackError.message}`);
        }
      }
      try {
        await this.abortServerSession();
      } catch (abortError) {
        failure = new Error(`${failure.message}; local abort failed: ${abortError.message}`);
      }
    } finally {
      if (revokePlayer2 && this.mode === 'account' && currentPlayer2Session) {
        try {
          const response = await apiFetch('/auth/player2/logout', {
            method: 'POST',
            headers: { 'X-Player2-CSRF-Token': currentPlayer2Session.csrfToken },
          });
          if (!response.ok) throw new Error('Player 2 logout failed');
          currentPlayer2Session = null;
        } catch (logoutError) {
          failure = failure
            ? new Error(`${failure.message}; ${logoutError.message}`)
            : logoutError;
        }
      }
      this.restoreSinglePlayer();
      this.exiting = false;
    }
    if (failure) throw failure;
  }

  restorePairedCheckpoint() {
    if (!this.lastCheckpoint) return false;
    for (const state of this.lastCheckpoint.states) {
      (state.slot === 0 ? playerOne : playerTwo).loadState(base64Bytes(state.data));
    }
    ++this.rollbackCount;
    return true;
  }

  waitForCableIdle(timeout) {
    const deadline = performance.now() + timeout;
    return new Promise((resolve) => {
      const check = () => {
        if (this.isCableIdle()) resolve(true);
        else if (performance.now() >= deadline) resolve(false);
        else setTimeout(check, 25);
      };
      check();
    });
  }

  async abortServerSession() {
    if (!this.session) return;
    const response = await apiFetch(`/api/local-2p/${this.session.id}/abort`, { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Local 2P abort failed');
    }
  }

  restoreSinglePlayer() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.checkpointTimer);
    if (playerOne.core) {
      playerOne.core._vba_link_cancel_wait();
      playerOne.core._vba_link_set_player(-1);
    }
    playerTwo.shutdown();
    elements['player2-mute'].textContent = 'Unmute';
    this.active = false;
    this.preparing = false;
    ++this.playerTwoLoadGeneration;
    this.playerTwoLoading = false;
    this.enabled = false;
    this.mode = null;
    this.session = null;
    this.lastCheckpoint = null;
    playerOne.paused = false;
    elements.workspace.classList.remove('local-2p', 'local-portrait');
    elements['player-two-panel'].hidden = true;
    elements['local-2p-bar'].hidden = true;
    elements['local-2p-toggle'].textContent = '2P';
    elements['player2-screen-empty'].hidden = false;
    elements['player2-runtime'].hidden = true;
    elements['player2-toolbar'].hidden = true;
    elements['player2-choice'].hidden = false;
    elements['player2-logout'].hidden = true;
    this.resizeObserver.disconnect();
    window.visualViewport?.removeEventListener('resize', this.boundUpdateLayout);
    window.removeEventListener('resize', this.boundUpdateLayout);
    setStatus(activeRom ? 'Running' : 'Idle', activeRom ? 'running' : 'idle');
    if (activeRom) restartBatteryTimer();
    applyControlState();
    elements.screen.focus?.();
  }

  async recover() {
    const response = await apiFetch('/api/local-2p/recover', { method: 'POST' });
    if (!response.ok) return;
    const recovered = await response.json();
    if (!recovered.session) return;
    this.session = recovered.session;
    await this.enter();
    this.mode = recovered.session.player2Mode;
    if (this.mode === 'account' && !currentPlayer2Session) {
      await this.abortServerSession();
      this.restoreSinglePlayer();
      return;
    }
    this.selectMode(this.mode);
    this.guestHandshakePending = recovered.session.guestHandshakePending;
    this.lastPairSequence = recovered.session.lastPairSequence;
    this.lastReleaseSequence = recovered.session.lastReleaseSequence;
    this.checkpointSequence = recovered.session.lastCheckpointSequence + 1;
    this.pendingCheckpoint = null;
    const p1Rom = roms.find((rom) => rom.id === recovered.session.participants[0].romId);
    const p2Rom = roms.find((rom) => rom.id === recovered.session.participants[1].romId);
    if (!p1Rom || !p2Rom || !recovered.checkpoint) {
      await this.abortServerSession();
      this.restoreSinglePlayer();
      return;
    }
    await this.loadRuntime(playerOne, p1Rom, 'account', recovered.checkpoint.states[0].data);
    await this.loadRuntime(playerTwo, p2Rom, this.mode, recovered.checkpoint.states[1].data);
    elements['screen-empty'].hidden = true;
    elements['player2-screen-empty'].hidden = true;
    if (!playerOne.core._vba_link_set_player(0) || !playerTwo.core._vba_link_set_player(1)) {
      await this.abortServerSession();
      this.restoreSinglePlayer();
      return;
    }
    this.lastCheckpoint = recovered.checkpoint;
    this.active = true;
    this.preparing = false;
    setControls(true);
    elements['player2-mute'].disabled = false;
    this.startTimers();
    startLoop();
    setStatus('Running / P1', 'running');
    playerTwo.setStatus('Running / P2', 'running');
    this.renderReadyControls();
    elements['local-2p-status'].textContent = 'Recovered paired checkpoint';
    applyControlState();
  }
}

function bytesBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; ++index) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

localTwoPlayer = new LocalTwoPlayerController();

function animationLoop(timestamp) {
  if (!running) return;
  if (localTwoPlayer?.active) {
    try {
      localTwoPlayer.step(timestamp);
    } catch (error) {
      runAction(async () => {
        logEvent(`Local cable failed / ${error.message}`, true);
        await localTwoPlayer.exit();
      });
    }
    animationHandle = requestAnimationFrame(animationLoop);
    return;
  }
  if (linkDetachPending && !core._vba_link_transfer_active()) detachLinkCore();
  drainLinkMessages();
  const elapsed = lastFrameTime ? Math.min(timestamp - lastFrameTime, 100) : 0;
  lastFrameTime = timestamp;
  frameDebt += elapsed * (speedMode ? SPEED_MODE_MULTIPLIER : 1);
  const frameDuration = 1000 / FRAME_RATE;
  const linkBlocked = isLinkRoomOpen() &&
    (linkRoom.paused || linkRoom.status === 'finishing' || linkCheckpointing ||
      (linkRoom.status === 'active' &&
        (linkCorePlayer < 0 || Boolean(core?._vba_link_guest_held()))));
  if (linkBlocked) frameDebt = Math.min(frameDebt, frameDuration);
  if (!paused && !linkBlocked) {
    let frames = 0;
    const maxFrames = 3;
    while (frameDebt >= frameDuration && frames < maxFrames) {
      core._vba_set_joypad(keyMask | touchMask | gamepadMask());
      const result = core._vba_run_frame();
      if (result === 2) {
        maybeSendLinkOffer();
        frameDebt = Math.min(frameDebt, frameDuration);
        break;
      }
      frameDebt -= frameDuration;
      ++frames;
    }
    if (frames) renderFrame();
  }
  const transferActive = Boolean(core._vba_link_transfer_active());
  if (transferActive !== linkTransferActive) {
    linkTransferActive = transferActive;
    if (linkRoom) renderLinkRoom();
  }
  drainLinkMessages();
  maybeSendLinkRelease();
  if (linkRoom?.status === 'active') updateLinkIdleGate(timestamp);
  localTwoPlayer?.stepIndependent(timestamp);
  animationHandle = requestAnimationFrame(animationLoop);
}

function startLoop() {
  cancelAnimationFrame(animationHandle);
  running = true;
  paused = false;
  lastFrameTime = 0;
  frameDebt = 1000 / FRAME_RATE;
  elements.pause.textContent = 'Pause';
  setStatus('Running', 'running');
  animationHandle = requestAnimationFrame(animationLoop);
}

function linkSocketOpen() {
  return linkSocket?.readyState === WebSocket.OPEN;
}

function sendLinkMessage(message) {
  if (!linkSocketOpen()) return false;
  linkSocket.send(JSON.stringify(message));
  return true;
}

function sendLinkDiagnostic() {
  const participant = currentLinkParticipant();
  if (!linkDebugEnabled || !core || !participant || linkRoom?.status !== 'active' ||
      !linkSocketOpen()) return;
  sendLinkMessage({
    type: 'diagnostic',
    state: {
      slot: participant.slot,
      corePlayer: linkCorePlayer,
      sequence: Number(core._vba_link_request_sequence()),
      waiting: Boolean(core._vba_link_waiting()),
      transferActive: Boolean(core._vba_link_transfer_active()),
      requestPending: Boolean(core._vba_link_request_pending()),
      guestHeld: Boolean(core._vba_link_guest_held()),
      guestHandshakePending: linkGuestHandshakePending,
      requestData: Number(core._vba_link_request_data()),
      requestTicks: Number(core._vba_link_request_ticks()),
      linkTime: Number(core._vba_link_time()),
      siocnt: Number(core._vba_link_siocnt()),
      siodata8: Number(core._vba_link_siodata8()),
      lastOfferSequence: linkLastOfferSequence,
      pendingOffers: linkMessageQueue.pendingOffers,
      pendingPairs: linkMessageQueue.pendingPairs,
      preparedResponses: linkMessageQueue.preparedResponses,
      frameCount: Number(core._vba_frame_counter()),
    },
  });
}

function syncLinkTransfer() {
  if (!core || linkRoom?.status !== 'active') return;
  sendLinkMessage({ type: 'sync', sequence: Number(core._vba_link_request_sequence()) });
}

function maybeSendLinkOffer() {
  const participant = currentLinkParticipant();
  if (participant?.slot !== 0 || linkRoom?.status !== 'active' || linkRoom.paused ||
      !core._vba_link_request_pending()) return;
  const sequence = Number(core._vba_link_request_sequence());
  if (sequence === linkLastOfferSequence) return;
  const rawData = Number(core._vba_link_request_data());
  const data = hostTransferData(rawData, linkGuestHandshakePending);
  if (sendLinkMessage({
    type: 'link-offer',
    sequence,
    speed: Number(core._vba_link_request_speed()),
    data,
    ticks: Number(core._vba_link_request_ticks()),
  })) {
    linkLastOfferSequence = sequence;
    if (data !== rawData && (sequence < 10 || sequence % 100 === 0)) {
      logEvent('Cable master handshake restored');
    }
    logCableSequence('Cable offer sent', sequence);
    renderLinkRoom();
  }
}

function maybeSendLinkRelease() {
  const participant = currentLinkParticipant();
  if (participant?.slot !== 0 || linkRoom?.status !== 'active' || linkRoom.paused ||
      !core || core._vba_link_waiting() || core._vba_link_transfer_active() ||
      core._vba_link_request_pending() || (Number(core._vba_link_siocnt()) & 0x4000)) return;
  const sequence = Number(core._vba_link_request_sequence());
  if (sequence <= 0 || sequence === linkLastReleaseSequence) return;
  if (sendLinkMessage({ type: 'link-release', sequence })) {
    linkLastReleaseSequence = sequence;
    logEvent('Cable peer released');
  }
}

function drainLinkMessages() {
  const participant = currentLinkParticipant();
  if (!core || !participant || linkRoom?.status !== 'active' || linkRoom.paused) return;
  linkMessageQueue.drain({
    slot: participant.slot,
    currentSequence: () => Number(core._vba_link_request_sequence()),
    transferActive: () => Boolean(core._vba_link_transfer_active()),
    prepareRemote: (sequence, speed, masterData, ticks) =>
      core._vba_link_prepare_remote(sequence, speed, masterData, ticks),
    sendResponse: (message) => {
      const sent = sendLinkMessage(message);
      if (sent) logCableSequence('Cable response sent', message.sequence);
      return sent;
    },
    applyPair: (sequence, speed, masterData, slaveData) =>
      core._vba_link_apply_pair(sequence, speed, masterData, slaveData),
    onPairApplied: (pair) => {
      if (participant.slot === 0) {
        linkGuestHandshakePending = isSlaveHandshake(pair.slaveData);
      }
      linkLastOfferSequence = -1;
      linkRoom = {
        ...linkRoom,
        nextTransferSequence: Math.max(linkRoom.nextTransferSequence || 0, pair.sequence + 1),
      };
      logCableSequence('Cable pair applied', pair.sequence);
      renderLinkRoom();
    },
  });
}

function scheduleLinkPump() {
  if (linkPumpScheduled) return;
  linkPumpScheduled = true;
  queueMicrotask(() => {
    linkPumpScheduled = false;
    pumpLinkCore();
  });
}

function pumpLinkCore() {
  if (!core || !running || paused || linkRoom?.status !== 'active' || linkRoom.paused ||
      linkCheckpointing || linkCorePlayer < 0) return;

  drainLinkMessages();
  if (core._vba_link_waiting()) {
    maybeSendLinkOffer();
    return;
  }
  if (core._vba_link_guest_held()) return;

  core._vba_set_joypad(keyMask | touchMask | gamepadMask());
  const previousFrame = Number(core._vba_frame_counter());
  const result = core._vba_run_frame();
  if (Number(core._vba_frame_counter()) !== previousFrame) renderFrame();
  if (result === 2) maybeSendLinkOffer();
  drainLinkMessages();
  maybeSendLinkRelease();
  lastFrameTime = performance.now();
  frameDebt = 0;
  if (result === 0) scheduleLinkPump();
}

function attachLinkCore() {
  const participant = currentLinkParticipant();
  if (!core || !participant || activeRom?.platform !== 'gba' || linkRoom?.status !== 'active') return;
  if (linkCorePlayer === participant.slot) return;
  if (!cableIdle() || !core._vba_link_set_player(participant.slot)) {
    logEvent('Link core is not ready', true);
    return;
  }
  linkCorePlayer = participant.slot;
  linkDetachPending = false;
  logEvent(`Link player ${participant.slot + 1} ready`);
}

function detachLinkCore() {
  if (!core || linkCorePlayer < 0) return;
  if (core._vba_link_transfer_active()) {
    linkDetachPending = true;
    return;
  }
  core._vba_link_cancel_wait();
  if (core._vba_link_set_player(-1)) {
    linkCorePlayer = -1;
    linkDetachPending = false;
  } else {
    linkDetachPending = true;
  }
}

function renderLinkRoom() {
  const room = linkRoom;
  elements['link-lobby'].hidden = Boolean(room);
  elements['link-room'].hidden = !room;
  const socketState = linkSocketOpen() ? 'Online' : linkSocket ? 'Connecting' : 'Offline';
  elements['link-socket-status'].textContent = socketState;
  elements['link-socket-status'].className = `link-socket-status ${
    socketState === 'Online' ? 'online' : socketState === 'Connecting' ? 'waiting' : ''}`;
  if (!room) {
    applyControlState();
    return;
  }

  const participant = currentLinkParticipant(room);
  const terminal = ['completed', 'aborted'].includes(room.status);
  const host = room.createdBy === currentSession?.account?.id || participant?.slot === 0;
  elements['link-room-id'].textContent = room.id;
  elements['link-invite-row'].hidden = !linkInviteCode;
  elements['link-invite-code'].textContent = linkInviteCode;
  elements['link-room-status'].textContent = room.paused && !terminal ? 'paused' : room.status;
  elements['link-participants'].replaceChildren(...[0, 1].map((slot) => {
    const item = room.participants?.[slot];
    const row = document.createElement('li');
    const role = document.createElement('span');
    role.textContent = slot === 0 ? 'P1 host' : 'P2 guest';
    const name = document.createElement('span');
    name.className = 'participant-name';
    name.textContent = item ? `${item.accountId}${item.accountId === currentSession?.account?.id ? ' (you)' : ''}` : 'Empty';
    name.title = name.textContent;
    const state = document.createElement('span');
    state.className = 'participant-state';
    if (!item) state.textContent = 'Waiting';
    else if (!item.connected) { state.textContent = 'Offline'; state.classList.add('offline'); }
    else if (['active', 'finishing', 'completed'].includes(room.status)) {
      state.textContent = 'Online'; state.classList.add('ready');
    } else if (item.ready) { state.textContent = 'Ready'; state.classList.add('ready'); }
    else state.textContent = 'Waiting';
    row.append(role, name, state);
    return row;
  }));

  const canReady = ['waiting', 'ready'].includes(room.status);
  elements['link-ready'].hidden = !canReady;
  elements['link-ready'].textContent = participant?.ready ? 'Not ready' : 'Ready';
  elements['link-ready'].disabled = !participant || room.paused || !linkSocketOpen();
  elements['link-start'].hidden = !canReady || !host;
  elements['link-start'].disabled = room.status !== 'ready' || room.paused || !linkSocketOpen();
  elements['link-finish'].hidden = !['active', 'finishing'].includes(room.status);
  elements['link-finish'].disabled = !['active', 'finishing'].includes(room.status) || room.paused || linkFinishSubmitted ||
    linkCheckpointPendingSequence !== null || !linkSocketOpen() || !linkFinishIdle;
  elements['link-finish'].textContent = linkFinishSubmitted ? 'Saving...' : 'Finish + save';
  elements['link-abort'].hidden = terminal;
  elements['link-close'].hidden = !terminal;
  applyControlState();
}

function updateLinkRoom(room) {
  if (!room || (linkRoom && room.id !== linkRoom.id)) return;
  const previous = linkRoom;
  linkRoom = { ...previous, ...room };
  if (linkCheckpointPendingSequence !== null &&
      Number(linkRoom.nextCheckpointSequence || 0) > linkCheckpointPendingSequence) {
    linkCheckpointPendingSequence = null;
    linkCheckpointPendingState = '';
  }
  if (linkRoom.status === 'active') {
    speedMode = false;
    elements['speed-toggle'].setAttribute('aria-pressed', 'false');
    elements['speed-toggle'].textContent = 'Speed off';
    clearInterval(batteryTimer);
    attachLinkCore();
    scheduleLinkPump();
  } else if (['completed', 'aborted'].includes(linkRoom.status)) {
    detachLinkCore();
    clearLinkTimers();
  }
  if (linkRoom.paused && running) setStatus('Link paused', 'loading');
  else if (previous?.paused && running && !paused) setStatus('Running', 'running');
  renderLinkRoom();
}

function clearLinkTimers() {
  clearTimeout(linkReconnectTimer);
  clearInterval(linkRoomTimer);
  clearInterval(linkCheckpointTimer);
  clearInterval(linkDiagnosticTimer);
  linkReconnectTimer = undefined;
  linkRoomTimer = undefined;
  linkCheckpointTimer = undefined;
  linkDiagnosticTimer = undefined;
}

function startLinkTimers() {
  clearInterval(linkRoomTimer);
  clearInterval(linkCheckpointTimer);
  clearInterval(linkDiagnosticTimer);
  linkRoomTimer = setInterval(() => refreshLinkRoom().catch((error) => logEvent(error.message, true)),
    LINK_ROOM_POLL_INTERVAL);
  linkCheckpointTimer = setInterval(() => submitLinkCheckpoint().catch((error) => {
    linkCheckpointPendingSequence = null;
    logEvent(error.message, true);
  }), LINK_CHECKPOINT_INTERVAL);
  linkDiagnosticTimer = setInterval(sendLinkDiagnostic, LINK_DIAGNOSTIC_INTERVAL);
}

function closeLinkSocket() {
  ++linkSocketGeneration;
  const socket = linkSocket;
  linkSocket = undefined;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  renderLinkRoom();
}

function openLinkSocket() {
  if (!isLinkRoomOpen() || linkSocket?.readyState === WebSocket.OPEN ||
      linkSocket?.readyState === WebSocket.CONNECTING) return;
  const generation = ++linkSocketGeneration;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/link/rooms/${encodeURIComponent(linkRoom.id)}/socket`);
  linkSocket = socket;
  renderLinkRoom();
  socket.addEventListener('open', () => {
    if (generation !== linkSocketGeneration) return;
    linkLastOfferSequence = -1;
    if (linkCheckpointPendingSequence !== null && linkCheckpointPendingState) {
      sendLinkMessage({
        type: 'checkpoint', sequence: linkCheckpointPendingSequence, state: linkCheckpointPendingState,
      });
    }
    renderLinkRoom();
  });
  socket.addEventListener('message', (event) => {
    if (generation !== linkSocketGeneration) return;
    runAction(() => handleLinkMessage(JSON.parse(event.data)));
  });
  socket.addEventListener('close', () => {
    if (generation !== linkSocketGeneration) return;
    linkSocket = undefined;
    linkLastOfferSequence = -1;
    if (isLinkRoomOpen()) {
      linkRoom = { ...linkRoom, paused: true };
      if (running) setStatus('Link paused', 'loading');
      renderLinkRoom();
      linkReconnectTimer = setTimeout(openLinkSocket, 1500);
    }
  });
  socket.addEventListener('error', () => {
    if (generation === linkSocketGeneration) renderLinkRoom();
  });
}

async function handleLinkMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'connected') {
    linkDebugEnabled = Boolean(message.debug);
    updateLinkRoom(message.room);
    syncLinkTransfer();
    sendLinkDiagnostic();
    scheduleLinkPump();
    return;
  }
  if (message.type === 'room') {
    updateLinkRoom(message.room);
    scheduleLinkPump();
    return;
  }
  if (message.type === 'paused') {
    linkLastOfferSequence = -1;
    const participants = linkRoom.participants?.map((participant) => participant?.accountId === message.accountId
      ? { ...participant, connected: false } : participant);
    updateLinkRoom({ ...linkRoom, paused: true, participants });
    return;
  }
  if (message.type === 'link-offer') {
    if (currentLinkParticipant()?.slot !== 1 || linkRoom.status !== 'active' || linkRoom.paused) return;
    logCableSequence('Cable offer received', message.sequence);
    linkMessageQueue.enqueueOffer(message);
    drainLinkMessages();
    scheduleLinkPump();
    renderLinkRoom();
    return;
  }
  if (message.type === 'link-pair') {
    logCableSequence('Cable pair received', message.sequence);
    linkMessageQueue.enqueuePair(message);
    drainLinkMessages();
    scheduleLinkPump();
    return;
  }
  if (message.type === 'link-release') {
    if (currentLinkParticipant()?.slot !== 1 || linkRoom.status !== 'active' ||
        Number(core?._vba_link_request_sequence()) !== message.sequence) return;
    core._vba_link_cancel_wait();
    logEvent('Cable peer finished');
    scheduleLinkPump();
    return;
  }
  if (message.type === 'checkpoint-saved') {
    if (linkCheckpointPendingSequence === message.sequence) {
      linkCheckpointPendingSequence = null;
      linkCheckpointPendingState = '';
    }
    linkRoom = {
      ...linkRoom,
      nextCheckpointSequence: Math.max(linkRoom.nextCheckpointSequence || 0, message.sequence + 1),
    };
    renderLinkRoom();
    return;
  }
  if (message.type === 'finishing') {
    updateLinkRoom({ ...linkRoom, status: 'finishing' });
    return;
  }
  if (message.type === 'completed') {
    linkFinishSubmitted = true;
    updateLinkRoom({ ...linkRoom, status: 'completed', paused: false });
    closeLinkSocket();
    await updateStoredStateControls();
    logEvent('Link battery saves completed');
    return;
  }
  if (message.type === 'aborted') {
    updateLinkRoom({ ...linkRoom, status: 'aborted', paused: false, abortReason: message.reason });
    closeLinkSocket();
    logEvent(`Link room aborted${message.reason ? ` / ${message.reason}` : ''}`);
    return;
  }
  if (message.type === 'error') {
    linkCheckpointPendingSequence = null;
    linkCheckpointPendingState = '';
    throw new Error(message.message || message.code || 'Link error');
  }
}

async function linkJsonRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  const response = await apiFetch(url, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || result.message || `Link request failed (${response.status})`);
  return result;
}

async function createLinkRoom() {
  if (!activeGbaSelected()) throw new Error('Load the selected GBA ROM first');
  const result = await linkJsonRequest('/api/link/rooms', {
    method: 'POST', body: JSON.stringify({ romId: activeRom.id }),
  });
  enterLinkRoom(result.room, result.inviteCode);
  logEvent('Link room created');
}

async function joinLinkRoom() {
  if (!activeGbaSelected()) throw new Error('Load the selected GBA ROM first');
  const roomId = elements['link-room-input'].value.trim();
  const inviteCode = elements['link-invite-input'].value.trim();
  const result = await linkJsonRequest(`/api/link/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST', body: JSON.stringify({ inviteCode, romId: activeRom.id }),
  });
  enterLinkRoom(result.room, '');
  logEvent('Link room joined');
}

function enterLinkRoom(room, inviteCode) {
  closeLinkSocket();
  clearLinkTimers();
  linkRoom = room;
  linkInviteCode = inviteCode;
  linkCheckpointPendingSequence = null;
  linkCheckpointPendingState = '';
  linkFinishSubmitted = false;
  linkIdleSince = 0;
  linkFinishIdle = false;
  linkLastOfferSequence = -1;
  linkGuestHandshakePending = false;
  linkLastReleaseSequence = -1;
  linkMessageQueue.clear();
  speedMode = false;
  elements['speed-toggle'].setAttribute('aria-pressed', 'false');
  elements['speed-toggle'].textContent = 'Speed off';
  clearInterval(batteryTimer);
  updateLinkRoom(room);
  startLinkTimers();
  openLinkSocket();
}

async function refreshLinkRoom() {
  if (!isLinkRoomOpen() || linkRoomRefreshing) return;
  linkRoomRefreshing = true;
  try {
    const response = await apiFetch(`/api/link/rooms/${encodeURIComponent(linkRoom.id)}`,
      { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Room refresh failed');
    updateLinkRoom(result.room);
  } finally {
    linkRoomRefreshing = false;
  }
}

async function setLinkReady() {
  const participant = currentLinkParticipant();
  const result = await linkJsonRequest(`/api/link/rooms/${encodeURIComponent(linkRoom.id)}/ready`, {
    method: 'POST', body: JSON.stringify({ ready: !participant?.ready }),
  });
  updateLinkRoom(result.room);
}

async function startLinkRoom() {
  const result = await linkJsonRequest(`/api/link/rooms/${encodeURIComponent(linkRoom.id)}/start`, {
    method: 'POST', body: '{}',
  });
  updateLinkRoom(result.room);
  logEvent('Link room started');
}

async function abortLinkRoom() {
  const result = await linkJsonRequest(`/api/link/rooms/${encodeURIComponent(linkRoom.id)}/abort`, {
    method: 'POST', body: JSON.stringify({ reason: 'cancelled by participant' }),
  });
  updateLinkRoom({ ...linkRoom, ...result.room });
  closeLinkSocket();
}

function checkpointBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function submitLinkCheckpoint() {
  if (linkRoom?.status !== 'active' || linkRoom.paused || paused || !linkSocketOpen() ||
      linkCheckpointing || linkCheckpointPendingSequence !== null || !cableIdle()) return;
  const sequence = Number(linkRoom.nextCheckpointSequence || 0);
  linkCheckpointing = true;
  renderLinkRoom();
  try {
    if (!core._vba_export_state()) throw new Error(coreError('Checkpoint export failed'));
    const bytes = getExportBytes();
    if (!cableIdle()) return;
    const state = checkpointBase64(bytes);
    if (!sendLinkMessage({ type: 'checkpoint', sequence, state })) return;
    linkCheckpointPendingSequence = sequence;
    linkCheckpointPendingState = state;
  } finally {
    linkCheckpointing = false;
    renderLinkRoom();
  }
}

async function finishLinkRoom() {
  if (!cableIdle()) throw new Error('Wait for the cable transfer to finish');
  if (linkCheckpointPendingSequence !== null) throw new Error('Wait for the checkpoint to finish');
  if (!core._vba_export_battery()) throw new Error(coreError('Battery export failed'));
  const bytes = getExportBytes();
  validateBattery(bytes);
  linkFinishSubmitted = true;
  renderLinkRoom();
  try {
    const response = await apiFetch(`/api/link/rooms/${encodeURIComponent(linkRoom.id)}/battery`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || 'Battery submission failed');
    if (result.status === 'completed') {
      updateLinkRoom({ ...linkRoom, status: 'completed', paused: false });
      closeLinkSocket();
      await updateStoredStateControls();
      logEvent('Link battery saves completed');
    } else {
      updateLinkRoom({ ...linkRoom, status: 'finishing' });
    }
  } catch (error) {
    linkFinishSubmitted = false;
    renderLinkRoom();
    throw error;
  }
}

function restartBatteryTimer() {
  clearInterval(batteryTimer);
  if (activeRom && !isLinkRoomOpen() && !localTwoPlayer?.preparing && !localTwoPlayer?.active) {
    batteryTimer = setInterval(() => saveBattery(false).catch((error) => logEvent(error.message, true)), 10000);
  }
}

function batterySaveIdentity(runtime, mode) {
  const owner = runtime.slot === 0 || mode === 'guest' ? currentSession : currentPlayer2Session;
  return {
    accountId: owner?.account?.id,
    csrfToken: owner?.csrfToken,
  };
}

function clearStandaloneBatteryRecovery(slot, mode, accountId, romId) {
  try {
    const records = JSON.parse(sessionStorage.getItem(STANDALONE_BATTERY_RECOVERY_KEY) || '[]');
    if (!Array.isArray(records)) return;
    const remaining = records.filter((record) =>
      record.slot !== slot || record.mode !== mode || record.accountId !== accountId ||
      record.romId !== romId);
    if (remaining.length) {
      sessionStorage.setItem(STANDALONE_BATTERY_RECOVERY_KEY, JSON.stringify(remaining));
    } else {
      sessionStorage.removeItem(STANDALONE_BATTERY_RECOVERY_KEY);
    }
  } catch {
    sessionStorage.removeItem(STANDALONE_BATTERY_RECOVERY_KEY);
  }
}

function queueBatteryWrite(runtime, mode, { romId, accountId, csrfToken, bytes }) {
  validateBattery(bytes);
  const save = async () => {
    const prefix = runtime.slot === 0 ? '/api/saves' : `/api/player2/${mode}/saves`;
    const response = await apiFetch(`${prefix}/${romId}/battery`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(runtime.slot === 1 && mode === 'account'
          ? { 'X-Player2-CSRF-Token': csrfToken }
          : { 'X-CSRF-Token': csrfToken }),
      },
      body: bytes,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `P${runtime.slot + 1} battery save failed`);
    }
    clearStandaloneBatteryRecovery(runtime.slot, mode, accountId, romId);
    return bytes.byteLength;
  };
  runtime.batterySavePromise = runtime.batterySavePromise.catch(() => {}).then(save);
  return runtime.batterySavePromise;
}

function persistStandaloneBattery(runtime, mode) {
  if (!runtime.running || !runtime.activeRom || !runtime.core) return Promise.resolve(false);
  const romId = runtime.activeRom.id;
  const { accountId, csrfToken } = batterySaveIdentity(runtime, mode);
  if (!accountId || !csrfToken || !runtime.core._vba_export_battery()) return Promise.resolve(false);
  return queueBatteryWrite(runtime, mode, {
    romId, accountId, csrfToken, bytes: runtime.exportBytes(),
  });
}

function restartPlayerTwoBatteryTimer() {
  clearInterval(playerTwo.batteryTimer);
  if (localTwoPlayer?.enabled && playerTwo.running &&
      !localTwoPlayer.preparing && !localTwoPlayer.active) {
    playerTwo.batteryTimer = setInterval(() => {
      persistStandaloneBattery(playerTwo, localTwoPlayer.mode)
        .catch((error) => logEvent(error.message, true));
    }, 10000);
  }
}

function stashStandaloneBatteries() {
  const records = [];
  for (const [runtime, mode, accountId] of [
    [playerOne, 'account', currentSession?.account?.id],
    [playerTwo, localTwoPlayer?.mode, localTwoPlayer?.mode === 'account'
      ? currentPlayer2Session?.account?.id : currentSession?.account?.id],
  ]) {
    if (!runtime.running || !runtime.activeRom || !runtime.core || !accountId) continue;
    if (!runtime.core._vba_export_battery()) continue;
    const bytes = runtime.exportBytes();
    validateBattery(bytes);
    records.push({ slot: runtime.slot, mode, accountId, romId: runtime.activeRom.id,
      data: bytesBase64(bytes) });
  }
  try {
    if (records.length) {
      const existing = JSON.parse(sessionStorage.getItem(STANDALONE_BATTERY_RECOVERY_KEY) || '[]');
      const merged = new Map((Array.isArray(existing) ? existing : []).map((record) => [
        `${record.slot}:${record.mode}:${record.accountId}:${record.romId}`, record,
      ]));
      for (const record of records) {
        merged.set(`${record.slot}:${record.mode}:${record.accountId}:${record.romId}`, record);
      }
      sessionStorage.setItem(STANDALONE_BATTERY_RECOVERY_KEY,
        JSON.stringify([...merged.values()]));
    }
  } catch (error) {
    logEvent(`Reload battery recovery unavailable / ${error.message}`, true);
  }
}

async function flushStandaloneBatteryRecovery() {
  let records;
  try {
    records = JSON.parse(sessionStorage.getItem(STANDALONE_BATTERY_RECOVERY_KEY) || '[]');
  } catch {
    sessionStorage.removeItem(STANDALONE_BATTERY_RECOVERY_KEY);
    return;
  }
  if (!Array.isArray(records) || !records.length) return;
  const needsPlayer2 = records.some((record) => record?.slot === 1 && record.mode === 'account');
  const player2Response = needsPlayer2
    ? await fetch('/api/player2/session', { cache: 'no-store' }).catch(() => null)
    : null;
  let player2OwnerResolved = false;
  if (player2Response?.ok) {
    const result = await player2Response.json();
    if (result.authenticated) {
      currentPlayer2Session = result;
      player2OwnerResolved = true;
    }
  }
  const remaining = [];
  for (const record of records) {
    if (![0, 1].includes(record?.slot) || !['account', 'guest'].includes(record?.mode) ||
        typeof record.accountId !== 'string' || typeof record.romId !== 'string' ||
        !roms.some((rom) => rom.id === record.romId)) continue;
    let bytes;
    try {
      bytes = base64Bytes(record.data);
      validateBattery(bytes);
    } catch {
      continue;
    }
    let owner;
    if (record.slot === 1 && record.mode === 'account') {
      if (!player2OwnerResolved) {
        remaining.push(record);
        continue;
      }
      owner = currentPlayer2Session;
    } else {
      owner = currentSession;
    }
    if (!owner || owner.account.id !== record.accountId) continue;
    const runtime = record.slot === 0 ? playerOne : playerTwo;
    try {
      await queueBatteryWrite(runtime, record.mode, {
        romId: record.romId,
        accountId: record.accountId,
        csrfToken: owner.csrfToken,
        bytes,
      });
    } catch {
      remaining.push(record);
    }
  }
  if (remaining.length) {
    sessionStorage.setItem(STANDALONE_BATTERY_RECOVERY_KEY, JSON.stringify(remaining));
  } else {
    sessionStorage.removeItem(STANDALONE_BATTERY_RECOVERY_KEY);
  }
}

function clearLinkRoom() {
  if (isLinkRoomOpen()) return;
  closeLinkSocket();
  clearLinkTimers();
  linkRoom = undefined;
  linkInviteCode = '';
  linkFinishSubmitted = false;
  linkCheckpointPendingSequence = null;
  linkCheckpointPendingState = '';
  linkMessageQueue.clear();
  elements['link-room-copy-feedback'].textContent = '';
  elements['link-pw-copy-feedback'].textContent = '';
  detachLinkCore();
  renderLinkRoom();
  restartBatteryTimer();
}

async function exportStateBytes() {
  if (!core._vba_export_state()) throw new Error(coreError('State export failed'));
  const bytes = getExportBytes();
  await validateState(bytes);
  return bytes;
}

async function saveQuickState() {
  const bytes = await exportStateBytes();
  await putAccountSave('state', bytes);
  await saveBattery(false);
  await updateStoredStateControls();
  logEvent(`Quick state saved (${bytes.byteLength} bytes)`);
  return bytes;
}

async function loadStateBytes(bytes, source) {
  const info = await validateState(bytes);
  const result = withCoreBytes(bytes, (pointer, size) => core._vba_load_state(pointer, size));
  if (!result) throw new Error(coreError('State load failed'));
  audioQueue = [];
  audioPosition = 0;
  renderFrame();
  logEvent(`${source} loaded / v${info.version}`);
}

async function loadQuickState() {
  const response = await apiFetch(`/api/saves/${activeRom.id}/state`);
  if (!response.ok) throw new Error(response.status === 404 ? 'No account quick state' : 'State request failed');
  await loadStateBytes(new Uint8Array(await response.arrayBuffer()), 'Account state');
}

async function saveBattery(showLog = true) {
  const size = await persistStandaloneBattery(playerOne, 'account');
  if (!size) return false;
  if (showLog) logEvent(`Battery saved (${size} bytes)`);
  await updateStoredStateControls();
  return true;
}

async function loadBatteryBytes(bytes, source, persist = false) {
  validateBattery(bytes);
  const result = withCoreBytes(bytes, (pointer, size) => core._vba_load_battery(pointer, size));
  if (!result) throw new Error(coreError('Battery load failed'));
  if (persist) {
    const { accountId, csrfToken } = batterySaveIdentity(playerOne, 'account');
    await queueBatteryWrite(playerOne, 'account', {
      romId: activeRom.id, accountId, csrfToken, bytes,
    });
  }
  logEvent(`${source} loaded (${bytes.byteLength} bytes)`);
  await updateStoredStateControls();
}

async function putAccountSave(kind, bytes) {
  if (kind === 'battery') {
    const { accountId, csrfToken } = batterySaveIdentity(playerOne, 'account');
    return queueBatteryWrite(playerOne, 'account', {
      romId: activeRom.id, accountId, csrfToken, bytes,
    });
  }
  const response = await apiFetch(`/api/saves/${activeRom.id}/${kind}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `${kind} save failed`);
  }
}

function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportName(extension) {
  const name = activeRom.title.replace(/[^A-Za-z0-9_-]+/g, '_') || 'game';
  return extension === '.sg1' ? `${name}1.sg1` : `${name}.sa1`;
}

async function loadSelectedRom() {
  if (isLinkRoomOpen()) throw new Error('Close the link room before loading another ROM');
  if (localTwoPlayer?.preparing || localTwoPlayer?.active) {
    throw new Error('Stop the local cable before loading another ROM');
  }
  const selected = roms.find((rom) => rom.id === elements['rom-select'].value);
  if (!selected) return;
  if (localTwoPlayer?.enabled) localTwoPlayer.clearReady();
  const previousRunning = Boolean(activeRom && core && running);
  if (previousRunning) {
    clearInterval(batteryTimer);
    await persistStandaloneBattery(playerOne, 'account');
  }
  setStatus('Loading ROM', 'loading');
  setControls(false);
  try {
    await ensureCore();
    await ensureAudio();
    const response = await apiFetch(`/api/roms/${selected.id}/file`);
    if (!response.ok) throw new Error('ROM download failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isGba = selected.platform === 'gba';
    romIdentity = ascii(bytes.subarray(isGba ? 0xa0 : 0x134, isGba ? 0xb0 : 0x143));
    const result = withCoreBytes(bytes, (pointer, size) =>
      core._vba_load_rom(pointer, size, isGba ? 0 : 1));
    if (!result) throw new Error(coreError('ROM load failed'));
    linkCorePlayer = -1;
    linkDetachPending = false;
    linkTransferActive = false;
    linkMessageQueue.clear();
    frameWidth = core._vba_frame_width();
    frameHeight = core._vba_frame_height();
    elements.screen.width = frameWidth;
    elements.screen.height = frameHeight;
    elements['screen-shell'].style.aspectRatio = `${frameWidth} / ${frameHeight}`;
    imageData = canvasContext.createImageData(frameWidth, frameHeight);
    speedMode = false;
    elements['speed-toggle'].setAttribute('aria-pressed', 'false');
    elements['speed-toggle'].textContent = 'Speed off';
    activeRom = selected;
    elements['screen-empty'].hidden = true;
    elements['rom-meta'].textContent = `${selected.platform.toUpperCase()} / ${selected.title} / rev ${selected.revision} / ${(selected.size / 1048576).toFixed(1)} MiB`;

    const batteryResponse = await apiFetch(`/api/saves/${selected.id}/battery`);
    if (batteryResponse.ok) {
      await loadBatteryBytes(new Uint8Array(await batteryResponse.arrayBuffer()), 'Account battery');
    }
    const stateResponse = await apiFetch(`/api/saves/${selected.id}/state`);
    if (stateResponse.ok) {
      await loadStateBytes(new Uint8Array(await stateResponse.arrayBuffer()), 'Account state');
    }

    setControls(true);
    renderFixtures();
    await updateStoredStateControls();
    startLoop();
    restartBatteryTimer();
    localTwoPlayer?.renderReadyControls();
    logEvent(`ROM loaded / ${selected.gameCode}`);
  } catch (error) {
    if (previousRunning && activeRom && core) {
      setControls(true);
      setStatus('Running', 'running');
      restartBatteryTimer();
    }
    throw error;
  }
}

async function refreshCatalog() {
  const romResponse = await apiFetch('/api/roms');
  if (!romResponse.ok) throw new Error('Catalog request failed');
  roms = await romResponse.json();
  if (currentSession.permission === 'superadmin') {
    const fixtureResponse = await apiFetch('/api/fixtures');
    if (!fixtureResponse.ok) throw new Error('Fixture catalog request failed');
    fixtures = await fixtureResponse.json();
  } else {
    fixtures = [];
  }
  const selectedId = elements['rom-select'].value;
  elements['rom-select'].replaceChildren(...roms.map((rom) => {
    const option = document.createElement('option');
    option.value = rom.id;
    option.textContent = `[${rom.platform.toUpperCase()}] ${rom.title}${rom.platform === 'gba' ? ` (${rom.gameCode})` : ''}`;
    option.dataset.platform = rom.platform;
    return option;
  }));
  if (roms.some((rom) => rom.id === selectedId)) elements['rom-select'].value = selectedId;
  applyControlState();
  renderFixtures();
}

function renderFixtures() {
  elements['fixture-list'].replaceChildren(...fixtures.map((fixture) => {
    const row = document.createElement('div');
    row.className = 'fixture-item';
    const name = document.createElement('span');
    name.textContent = fixture.filename;
    name.title = fixture.filename;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = fixture.type === 'state' ? 'Load' : 'Import';
    button.disabled = !activeRom || isLinkRoomOpen();
    button.addEventListener('click', () => runAction(async () => {
      const response = await apiFetch(`/api/fixtures/${fixture.id}/file`);
      if (!response.ok) throw new Error('Fixture download failed');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (fixture.type === 'state') await loadStateBytes(bytes, fixture.filename);
      else await loadBatteryBytes(bytes, fixture.filename);
    }));
    row.append(name, button);
    return row;
  }));
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setStatus('Error', 'error');
    logEvent(error.message, true);
    console.error(error);
  }
}

const keyBindings = new Map([
  ['KeyX', 1], ['KeyZ', 2], ['Backspace', 4], ['Enter', 8],
  ['ArrowRight', 16], ['ArrowLeft', 32], ['ArrowUp', 64], ['ArrowDown', 128],
  ['KeyS', 256], ['KeyA', 512],
]);
const player2KeyBindings = new Map([
  ['KeyM', 1], ['KeyN', 2], ['KeyH', 4], ['KeyP', 8],
  ['KeyL', 16], ['KeyJ', 32], ['KeyI', 64], ['KeyK', 128],
  ['KeyO', 256], ['KeyU', 512],
]);

function isKeyboardControlTarget(target) {
  return target.matches?.('input, select, textarea, button, [contenteditable="true"]');
}

function handleShortcut(event) {
  if (!activeRom || event.repeat || isKeyboardControlTarget(event.target) ||
      event.altKey || event.ctrlKey || event.metaKey) return false;

  let control;
  if (event.code === 'Space' && !event.shiftKey) control = elements['speed-toggle'];
  else if (event.code === 'F1') control = elements[event.shiftKey ? 'quick-save' : 'quick-load'];
  if (!control || control.disabled) return false;

  event.preventDefault();
  control.click();
  return true;
}

function handleKey(event, pressed) {
  if (!activeRom || isKeyboardControlTarget(event.target)) return;
  const player2Value = localTwoPlayer?.enabled ? player2KeyBindings.get(event.code) : null;
  const runtime = player2Value ? playerTwo : playerOne;
  const value = player2Value || keyBindings.get(event.code);
  if (!value) return;
  event.preventDefault();
  if (pressed) runtime.keyMask |= value;
  else runtime.keyMask &= ~value;
}

function showAuthView(view) {
  setMenuOpen(false);
  elements['auth-loading'].hidden = view !== 'loading';
  elements['login-view'].hidden = view !== 'login';
  elements['visitor-view'].hidden = view !== 'visitor';
  elements['app-view'].hidden = view !== 'app';
}

async function bootstrap() {
  showAuthView('loading');
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (!response.ok) throw new Error('Session check failed');
  const result = await response.json();
  if (!result.authenticated) {
    currentSession = null;
    elements['login-link'].href = '/auth/login';
    showAuthView('login');
    return;
  }
  currentSession = result;
  if (result.permission === 'visitor') {
    elements['visitor-account'].textContent = result.account.name || result.account.email || result.account.id;
    const applicationResponse = await apiFetch('/api/access-request');
    const application = applicationResponse.ok ? (await applicationResponse.json()).application : null;
    elements['access-request-status'].textContent = application?.status === 'pending' ? 'Request pending' : '';
    elements['request-access'].disabled = application?.status === 'pending';
    showAuthView('visitor');
    return;
  }
  elements['account-name'].textContent = result.account.name || result.account.email || result.account.id;
  applyPermissionVisibility();
  showAuthView('app');
  setControls(false);
  await refreshCatalog();
  await flushStandaloneBatteryRecovery();
  setStatus('Idle', 'idle');
  logEvent('Catalog ready');
  await localTwoPlayer.runGuarded(() => localTwoPlayer.recover());
  clearInterval(sessionTimer);
  sessionTimer = setInterval(() => runAction(checkSession), 60_000);
}

async function checkSession() {
  const response = await fetch('/api/session', { cache: 'no-store' });
  const result = response.ok ? await response.json() : { authenticated: false };
  if (!result.authenticated || result.permission === 'visitor') {
    stopEmulation();
    await bootstrap();
    return;
  }
  currentSession = result;
  elements['account-name'].textContent = result.account.name || result.account.email || result.account.id;
  applyPermissionVisibility();
}

async function logout() {
  if (localTwoPlayer.enabled) {
    try {
      await localTwoPlayer.exit();
    } catch (error) {
      logEvent(`Local 2P cleanup failed / ${error.message}`, true);
    }
  }
  if (isLinkRoomOpen()) {
    try {
      await abortLinkRoom();
    } catch (error) {
      logEvent(`Room cleanup failed / ${error.message}`, true);
    }
  }
  stopEmulation();
  clearInterval(sessionTimer);
  const response = await apiFetch('/auth/logout', { method: 'POST' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.authLogoutUrl !== 'string' || !result.authLogoutUrl) {
    throw new Error(result.error || 'Logout failed');
  }
  window.location.assign(result.authLogoutUrl);
}

elements['load-rom'].addEventListener('click', () => runAction(loadSelectedRom));
elements['menu-toggle'].addEventListener('click', () => {
  setMenuOpen(elements['menu-toggle'].getAttribute('aria-expanded') !== 'true');
});
elements['refresh-roms'].addEventListener('click', () => runAction(async () => {
  await refreshCatalog();
  setMenuOpen(false);
}));
elements['rom-select'].addEventListener('change', applyControlState);
elements['local-2p-toggle'].addEventListener('click', () => runAction(() =>
  localTwoPlayer.enabled
    ? localTwoPlayer.exit()
    : localTwoPlayer.runGuarded(() => localTwoPlayer.enter())));
elements['local-exit'].addEventListener('click', () => runAction(() => localTwoPlayer.exit()));
elements['player2-close'].addEventListener('click', () => runAction(() => localTwoPlayer.exit()));
elements['player2-guest'].addEventListener('click', () => localTwoPlayer.selectMode('guest'));
elements['player2-login'].addEventListener('click', () => {
  const popup = window.open('/auth/player2/login', 'gbc-player2-login', 'popup,width=520,height=720');
  if (!popup) elements['player2-auth-status'].textContent = 'Popup blocked. Allow popups and retry.';
  else elements['player2-auth-status'].textContent = 'Choose the Player 2 account';
});
player2AuthChannel.addEventListener('message', (event) => {
  if (event.data?.type !== 'gbc-player2-auth-complete') return;
  runAction(async () => {
    elements['player2-auth-status'].textContent = event.data.ok ? 'Login complete' : 'Login failed';
    await localTwoPlayer.refreshPlayer2Session();
  });
});
elements['player2-visitor-back'].addEventListener('click', () => runAction(async () => {
  const response = await apiFetch('/auth/player2/logout', {
    method: 'POST',
    headers: { 'X-Player2-CSRF-Token': currentPlayer2Session.csrfToken },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Player 2 logout failed (${response.status})`);
  }
  currentPlayer2Session = null;
  elements['player2-visitor'].hidden = true;
  elements['player2-choice'].hidden = false;
}));
elements['player2-request-access'].addEventListener('click', () => runAction(async () => {
  const response = await apiFetch('/api/player2/access-request', {
    method: 'POST',
    headers: { 'X-Player2-CSRF-Token': currentPlayer2Session.csrfToken },
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Access request failed');
  elements['player2-request-access'].disabled = true;
  elements['player2-visitor-status'].textContent = 'Player 2 access request pending';
}));
elements['player2-logout'].addEventListener('click', () => runAction(() => localTwoPlayer.exit()));
elements['player2-load'].addEventListener('click', () => runAction(() =>
  localTwoPlayer.loadPlayerTwo()));
elements['rom-select'].addEventListener('change', () => {
  if (localTwoPlayer.enabled) localTwoPlayer.clearReady();
});
elements['player2-rom-select'].addEventListener('change', () => localTwoPlayer.clearReady());
elements['local-p1-ready'].addEventListener('click', () => runAction(() => localTwoPlayer.setReady(0)));
elements['local-p2-ready'].addEventListener('click', () => runAction(() => localTwoPlayer.setReady(1)));
elements['local-start'].addEventListener('click', () => runAction(() =>
  localTwoPlayer.start()));
elements['rom-upload'].addEventListener('change', () => runAction(async () => {
  const file = elements['rom-upload'].files[0];
  if (!file) return;
  const response = await apiFetch('/api/roms', {
    method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'ROM upload failed');
  await refreshCatalog();
  elements['rom-select'].value = result.id;
  setMenuOpen(false);
  logEvent(`ROM uploaded / ${result.gameCode}`);
}));

elements.pause.addEventListener('click', () => {
  paused = !paused;
  if (localTwoPlayer.active) playerTwo.paused = paused;
  elements.pause.textContent = paused ? 'Resume' : 'Pause';
  const linkPaused = isLinkRoomOpen() && (linkRoom.paused || linkRoom.status === 'finishing');
  setStatus(paused ? 'Paused' : linkPaused ? 'Link paused' : 'Running',
    paused ? 'idle' : linkPaused ? 'loading' : 'running');
});
elements.mute.addEventListener('click', () => {
  muted = !muted;
  elements.mute.textContent = muted ? 'Unmute' : 'Mute';
});
elements['speed-toggle'].addEventListener('click', () => {
  speedMode = !speedMode;
  elements['speed-toggle'].setAttribute('aria-pressed', String(speedMode));
  elements['speed-toggle'].textContent = speedMode ? 'Speed on' : 'Speed off';
});
elements.fullscreen.addEventListener('click', () =>
  (localTwoPlayer.enabled ? elements.workspace : elements['screen-shell']).requestFullscreen());
elements['player2-mute'].addEventListener('click', () => {
  playerTwo.muted = !playerTwo.muted;
  elements['player2-mute'].textContent = playerTwo.muted ? 'Unmute' : 'Mute';
});
elements['quick-save'].addEventListener('click', () => runAction(saveQuickState));
elements['quick-load'].addEventListener('click', () => runAction(loadQuickState));
elements['export-state'].addEventListener('click', () => runAction(async () => {
  const bytes = await saveQuickState();
  download(bytes, exportName('.sg1'), 'application/gzip');
  logEvent('State exported');
}));
elements['import-state'].addEventListener('change', () => runAction(async () => {
  const file = elements['import-state'].files[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadStateBytes(bytes, file.name);
  await putAccountSave('state', bytes);
  await updateStoredStateControls();
  elements['import-state'].value = '';
}));
elements['export-battery'].addEventListener('click', () => runAction(async () => {
  await saveBattery();
  if (!core._vba_export_battery()) throw new Error(coreError('Battery export failed'));
  const bytes = getExportBytes();
  download(bytes, exportName('.sa1'), 'application/octet-stream');
}));
elements['import-battery'].addEventListener('change', () => runAction(async () => {
  const file = elements['import-battery'].files[0];
  if (!file) return;
  await loadBatteryBytes(new Uint8Array(await file.arrayBuffer()), file.name, true);
  elements['import-battery'].value = '';
}));
elements['link-create'].addEventListener('click', () => runAction(createLinkRoom));
elements['link-join'].addEventListener('click', () => runAction(joinLinkRoom));
elements['link-ready'].addEventListener('click', () => runAction(setLinkReady));
elements['link-start'].addEventListener('click', () => runAction(startLinkRoom));
elements['link-finish'].addEventListener('click', () => runAction(finishLinkRoom));
elements['link-abort'].addEventListener('click', () => runAction(abortLinkRoom));
elements['link-close'].addEventListener('click', clearLinkRoom);
for (const [valueId, feedbackId, label] of [
  ['link-room-id', 'link-room-copy-feedback', 'Room ID'],
  ['link-invite-code', 'link-pw-copy-feedback', 'Room PW'],
]) {
  const copyValue = () => runAction(() => copyLinkValue(elements[valueId], elements[feedbackId], label));
  elements[valueId].addEventListener('click', copyValue);
  elements[valueId].addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    copyValue();
  });
}
for (const id of ['link-room-input', 'link-invite-input']) {
  elements[id].addEventListener('input', applyControlState);
  elements[id].addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !elements['link-join'].disabled) runAction(joinLinkRoom);
  });
}
elements.logout.addEventListener('click', () => runAction(logout));
elements['visitor-logout'].addEventListener('click', () => runAction(logout));
elements['request-access'].addEventListener('click', () => runAction(async () => {
  elements['request-access'].disabled = true;
  elements['access-request-status'].textContent = 'Sending request';
  const response = await apiFetch('/api/access-request', { method: 'POST' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    elements['request-access'].disabled = false;
    throw new Error(result.error || 'Access request failed');
  }
  elements['access-request-status'].textContent = 'Request pending';
}));

document.addEventListener('pointerdown', (event) => {
  if (!elements['app-menu-panel'].hidden && !event.target.closest('.app-menu')) setMenuOpen(false);
});
document.addEventListener('dragstart', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements['app-menu-panel'].hidden) {
    event.preventDefault();
    setMenuOpen(false, true);
    return;
  }
  if (handleShortcut(event)) return;
  handleKey(event, true);
});
document.addEventListener('keyup', (event) => handleKey(event, false));
window.addEventListener('blur', () => {
  playerOne.keyMask = 0; playerOne.touchMask = 0;
  playerTwo.keyMask = 0; playerTwo.touchMask = 0;
});

for (const button of document.querySelectorAll('[data-button]')) {
  const value = Number(button.dataset.button);
  const runtime = button.dataset.player === '2' ? playerTwo : playerOne;
  const release = (event) => { event.preventDefault(); runtime.touchMask &= ~value; };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    runtime.touchMask |= value;
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

window.addEventListener('pagehide', () => {
  player2AuthChannel.close();
  if (activeRom && !isLinkRoomOpen() && !localTwoPlayer.preparing && !localTwoPlayer.active) {
    stashStandaloneBatteries();
    persistStandaloneBattery(playerOne, 'account').catch(() => {});
  }
  if (localTwoPlayer.enabled && playerTwo.running &&
      !localTwoPlayer.preparing && !localTwoPlayer.active) {
    persistStandaloneBattery(playerTwo, localTwoPlayer.mode).catch(() => {});
  }
});

window.__gbaPoc = {
  checkpointLocal() {
    return localTwoPlayer.checkpoint();
  },
  flushStandaloneBatteries() {
    return Promise.all([
      persistStandaloneBattery(playerOne, 'account'),
      localTwoPlayer.enabled && playerTwo.running
        ? persistStandaloneBattery(playerTwo, localTwoPlayer.mode) : false,
    ]);
  },
  flushBatteryRecovery() {
    return flushStandaloneBatteryRecovery();
  },
  batteryHash(slot) {
    const runtime = slot === 1 ? playerTwo : playerOne;
    if (!runtime.core?._vba_export_battery()) return null;
    const bytes = runtime.exportBytes();
    return { hash: hashBytes(bytes), size: bytes.byteLength };
  },
  diagnostics() {
    const pixels = canvasContext.getImageData(0, 0, frameWidth, frameHeight).data;
    let visiblePixels = 0;
    let pixelHash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] || pixels[index + 1] || pixels[index + 2]) ++visiblePixels;
      pixelHash ^= pixels[index] | (pixels[index + 1] << 8) | (pixels[index + 2] << 16);
      pixelHash = Math.imul(pixelHash, 16777619) >>> 0;
    }
    const player2Pixels = playerTwo.canvasContext.getImageData(
      0, 0, playerTwo.frameWidth, playerTwo.frameHeight,
    ).data;
    let player2VisiblePixels = 0;
    for (let index = 0; index < player2Pixels.length; index += 4) {
      if (player2Pixels[index] || player2Pixels[index + 1] || player2Pixels[index + 2]) {
        ++player2VisiblePixels;
      }
    }
    return {
      running,
      paused,
      activeRom: activeRom?.id || null,
      permission: currentSession?.permission || null,
      stateVersion: core?._vba_state_version() || null,
      frameCount: core ? Number(core._vba_frame_counter()) : 0,
      audioSamples: core ? Number(core._vba_audio_total_samples()) : 0,
      audioQuality: core ? Number(core._vba_audio_quality()) : null,
      stateAudioQuality: core ? Number(core._vba_state_audio_quality()) : null,
      audioState: audioContext?.state || 'uninitialized',
      inputMask: keyMask | touchMask,
      speedMode,
      speedMultiplier: speedMode ? SPEED_MODE_MULTIPLIER : 1,
      linkRoom: linkRoom ? {
        id: linkRoom.id,
        status: linkRoom.status,
        paused: linkRoom.paused,
        slot: currentLinkParticipant()?.slot ?? null,
        socketOpen: linkSocketOpen(),
        checkpointPending: linkCheckpointPendingSequence,
        corePlayer: linkCorePlayer,
        coreSequence: core ? Number(core._vba_link_request_sequence()) : null,
        coreWaiting: core ? Boolean(core._vba_link_waiting()) : null,
        coreTransferActive: core ? Boolean(core._vba_link_transfer_active()) : null,
        coreRequestPending: core ? Boolean(core._vba_link_request_pending()) : null,
        coreGuestHeld: core ? Boolean(core._vba_link_guest_held()) : null,
        guestHandshakePending: linkGuestHandshakePending,
        coreRequestTicks: core ? Number(core._vba_link_request_ticks()) : null,
        lastOfferSequence: linkLastOfferSequence,
        pendingOffers: linkMessageQueue.pendingOffers,
        pendingPairs: linkMessageQueue.pendingPairs,
        preparedResponses: linkMessageQueue.preparedResponses,
        finishIdle: linkFinishIdle,
      } : null,
      emulationSteps: core ? Number(core._vba_emulation_steps()) : 0,
      frameWidth,
      frameHeight,
      visiblePixels,
      pixelHash,
      players: [playerOne, playerTwo].map((runtime) => ({
        slot: runtime.slot,
        running: runtime.running,
        paused: runtime.paused,
        activeRom: runtime.activeRom?.id || null,
        frameCount: runtime.core ? Number(runtime.core._vba_frame_counter()) : 0,
        audioSamples: runtime.core ? Number(runtime.core._vba_audio_total_samples()) : 0,
        emulationSteps: runtime.core ? Number(runtime.core._vba_emulation_steps()) : 0,
        inputMask: runtime.keyMask | runtime.touchMask,
        muted: runtime.muted,
        memoryBytes: runtime.core?.HEAPU8?.byteLength || 0,
        linkPlayer: runtime.core ? Number(runtime.core._vba_link_player()) : -1,
        generation: runtime.generation,
        audioPointer: runtime.audioPointer,
        audioContextState: runtime.audioContext?.state || 'closed',
      })),
      coresDistinct: Boolean(playerOne.core && playerTwo.core && playerOne.core !== playerTwo.core &&
        playerOne.core.HEAPU8.buffer !== playerTwo.core.HEAPU8.buffer),
      standaloneAutosave: [Boolean(batteryTimer), Boolean(playerTwo.batteryTimer)],
      player2VisiblePixels,
      localTwoPlayer: localTwoPlayer.enabled ? {
        active: localTwoPlayer.active,
        preparing: localTwoPlayer.preparing,
        playerTwoLoading: localTwoPlayer.playerTwoLoading,
        ready: [...localTwoPlayer.ready],
        mode: localTwoPlayer.mode,
        status: localTwoPlayer.session?.status || null,
        sessionId: localTwoPlayer.session?.id || null,
        lastPairSequence: localTwoPlayer.lastPairSequence,
        checkpointSequence: localTwoPlayer.checkpointSequence,
        checkpointPending: Boolean(localTwoPlayer.pendingCheckpoint),
        hasPairedCheckpoint: Boolean(localTwoPlayer.lastCheckpoint),
      } : null,
      lastLocalRollbackCount: localTwoPlayer.rollbackCount,
      status: elements['runtime-status'].textContent,
    };
  },
};

runAction(bootstrap);
