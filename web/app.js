import createVbaModule from '/core/vba172.js';

const FRAME_RATE = 59.7275;
const CORE_SAMPLE_RATE = 44100;

const elements = Object.fromEntries([
  'auth-loading', 'login-view', 'login-link', 'visitor-view', 'app-view', 'visitor-account',
  'request-access', 'access-request-status', 'visitor-logout', 'account-name',
  'account-permission', 'logout',
  'rom-upload', 'refresh-roms', 'rom-select', 'load-rom', 'rom-meta', 'screen',
  'screen-shell', 'screen-empty', 'pause', 'mute', 'fullscreen', 'runtime-status',
  'speed-toggle',
  'quick-save', 'quick-load', 'export-state', 'import-state', 'import-state-label',
  'quick-state-meta', 'export-battery', 'import-battery', 'import-battery-label',
  'battery-meta', 'fixture-list', 'event-log',
].map((id) => [id, document.getElementById(id)]));

const canvasContext = elements.screen.getContext('2d', { alpha: false });
let frameWidth = 240;
let frameHeight = 160;
let imageData = canvasContext.createImageData(frameWidth, frameHeight);

let core;
let roms = [];
let fixtures = [];
let activeRom;
let romIdentity;
let running = false;
let paused = false;
let muted = false;
let speedMode = false;
let animationHandle;
let lastFrameTime = 0;
let frameDebt = 0;
let keyMask = 0;
let touchMask = 0;
let audioContext;
let audioNode;
let audioPointer = 0;
let audioQueue = [];
let audioPosition = 0;
let batteryTimer;
let sessionTimer;
let currentSession;

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    if (currentSession?.csrfToken) headers.set('X-CSRF-Token', currentSession.csrfToken);
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && currentSession) {
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
  if (core) core._vba_shutdown();
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

function setControls(enabled) {
  for (const id of ['pause', 'mute', 'fullscreen', 'speed-toggle', 'quick-save', 'quick-load']) {
    elements[id].disabled = !enabled;
  }
  const superadminEnabled = enabled && currentSession?.permission === 'superadmin';
  for (const id of ['export-state', 'export-battery', 'import-state', 'import-battery']) {
    elements[id].disabled = !superadminEnabled;
  }
  elements['import-state-label'].classList.toggle('disabled', !superadminEnabled);
  elements['import-battery-label'].classList.toggle('disabled', !superadminEnabled);
  if (enabled) updateStoredStateControls();
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
    elements['quick-load'].disabled = true;
    return;
  }
  const response = await apiFetch(`/api/saves/${activeRom.id}/meta`);
  if (!response.ok) throw new Error('Save metadata request failed');
  const metadata = await response.json();
  const state = metadata.saves.find((save) => save.kind === 'state');
  const battery = metadata.saves.find((save) => save.kind === 'battery');
  elements['quick-load'].disabled = !state;
  elements['quick-state-meta'].textContent = state
    ? `Account state / ${new Date(Number(state.updatedAt)).toLocaleString()}`
    : 'No account state';
  elements['battery-meta'].textContent = battery
    ? `Account battery / ${new Date(Number(battery.updatedAt)).toLocaleString()}`
    : 'No account battery save';
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
  const wasmResponse = await fetch('/core/vba172.wasm', { cache: 'no-cache' });
  if (!wasmResponse.ok) throw new Error(`Core download failed (${wasmResponse.status})`);
  const wasmBinary = await wasmResponse.arrayBuffer();
  core = await createVbaModule({
    wasmBinary,
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
  if (!core || !running || paused || muted || speedMode) {
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
  pullAudio(Math.ceil((left.length * ratio + 2) * 2));
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

function gamepadMask() {
  const gamepad = navigator.getGamepads?.().find(Boolean);
  if (!gamepad) return 0;
  let mask = 0;
  if (gamepad.buttons[0]?.pressed) mask |= 1;
  if (gamepad.buttons[1]?.pressed) mask |= 2;
  if (gamepad.buttons[8]?.pressed) mask |= 4;
  if (gamepad.buttons[9]?.pressed) mask |= 8;
  if (gamepad.buttons[15]?.pressed || gamepad.axes[0] > .5) mask |= 16;
  if (gamepad.buttons[14]?.pressed || gamepad.axes[0] < -.5) mask |= 32;
  if (gamepad.buttons[12]?.pressed || gamepad.axes[1] < -.5) mask |= 64;
  if (gamepad.buttons[13]?.pressed || gamepad.axes[1] > .5) mask |= 128;
  if (gamepad.buttons[5]?.pressed) mask |= 256;
  if (gamepad.buttons[4]?.pressed) mask |= 512;
  return mask;
}

function animationLoop(timestamp) {
  if (!running) return;
  const elapsed = lastFrameTime ? Math.min(timestamp - lastFrameTime, 100) : 0;
  lastFrameTime = timestamp;
  frameDebt += elapsed * (speedMode ? 4 : 1);
  const frameDuration = 1000 / FRAME_RATE;
  if (!paused) {
    let frames = 0;
    const maxFrames = speedMode ? 12 : 3;
    while (frameDebt >= frameDuration && frames < maxFrames) {
      core._vba_set_joypad(keyMask | touchMask | gamepadMask() | (speedMode ? 1024 : 0));
      core._vba_run_frame();
      frameDebt -= frameDuration;
      ++frames;
    }
    if (frames) renderFrame();
  }
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
  renderFrame();
  logEvent(`${source} loaded / v${info.version}`);
}

async function loadQuickState() {
  const response = await apiFetch(`/api/saves/${activeRom.id}/state`);
  if (!response.ok) throw new Error(response.status === 404 ? 'No account quick state' : 'State request failed');
  await loadStateBytes(new Uint8Array(await response.arrayBuffer()), 'Account state');
}

async function saveBattery(showLog = true) {
  if (!activeRom || !core._vba_export_battery()) return;
  const bytes = getExportBytes();
  validateBattery(bytes);
  await putAccountSave('battery', bytes);
  if (showLog) logEvent(`Battery saved (${bytes.byteLength} bytes)`);
  await updateStoredStateControls();
}

async function loadBatteryBytes(bytes, source, persist = false) {
  validateBattery(bytes);
  const result = withCoreBytes(bytes, (pointer, size) => core._vba_load_battery(pointer, size));
  if (!result) throw new Error(coreError('Battery load failed'));
  if (persist) await putAccountSave('battery', bytes);
  logEvent(`${source} loaded (${bytes.byteLength} bytes)`);
  await updateStoredStateControls();
}

async function putAccountSave(kind, bytes) {
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
  const selected = roms.find((rom) => rom.id === elements['rom-select'].value);
  if (!selected) return;
  setStatus('Loading ROM', 'loading');
  setControls(false);
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
  clearInterval(batteryTimer);
  batteryTimer = setInterval(() => saveBattery(false).catch((error) => logEvent(error.message, true)), 10000);
  logEvent(`ROM loaded / ${selected.gameCode}`);
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
  elements['load-rom'].disabled = roms.length === 0;
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
    button.disabled = !activeRom;
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

function handleKey(event, pressed) {
  if (!activeRom || event.target.matches('input, select, button')) return;
  const value = keyBindings.get(event.code);
  if (!value) return;
  event.preventDefault();
  if (pressed) keyMask |= value;
  else keyMask &= ~value;
}

function showAuthView(view) {
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
    elements['login-link'].href = sessionStorage.getItem('gbc-force-login') === '1'
      ? '/auth/login?prompt=login'
      : '/auth/login';
    showAuthView('login');
    return;
  }
  sessionStorage.removeItem('gbc-force-login');
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
  elements['account-permission'].textContent = result.permission;
  for (const element of document.querySelectorAll('.superadmin-only')) {
    element.hidden = result.permission !== 'superadmin';
  }
  showAuthView('app');
  setControls(false);
  await refreshCatalog();
  setStatus('Idle', 'idle');
  logEvent('Catalog ready');
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
  elements['account-permission'].textContent = result.permission;
  for (const element of document.querySelectorAll('.superadmin-only')) {
    element.hidden = result.permission !== 'superadmin';
  }
}

async function logout() {
  stopEmulation();
  clearInterval(sessionTimer);
  await apiFetch('/auth/logout', { method: 'POST' });
  currentSession = null;
  sessionStorage.setItem('gbc-force-login', '1');
  elements['login-link'].href = '/auth/login?prompt=login';
  showAuthView('login');
}

elements['load-rom'].addEventListener('click', () => runAction(loadSelectedRom));
elements['refresh-roms'].addEventListener('click', () => runAction(refreshCatalog));
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
  logEvent(`ROM uploaded / ${result.gameCode}`);
}));

elements.pause.addEventListener('click', () => {
  paused = !paused;
  elements.pause.textContent = paused ? 'Resume' : 'Pause';
  setStatus(paused ? 'Paused' : 'Running', paused ? 'idle' : 'running');
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
elements.fullscreen.addEventListener('click', () => elements['screen-shell'].requestFullscreen());
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

document.addEventListener('keydown', (event) => handleKey(event, true));
document.addEventListener('keyup', (event) => handleKey(event, false));
window.addEventListener('blur', () => { keyMask = 0; touchMask = 0; });

for (const button of document.querySelectorAll('[data-button]')) {
  const value = Number(button.dataset.button);
  const release = (event) => { event.preventDefault(); touchMask &= ~value; };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touchMask |= value;
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

window.addEventListener('pagehide', () => {
  if (activeRom) saveBattery(false).catch(() => {});
});

window.__gbaPoc = {
  diagnostics() {
    const pixels = canvasContext.getImageData(0, 0, frameWidth, frameHeight).data;
    let visiblePixels = 0;
    let pixelHash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] || pixels[index + 1] || pixels[index + 2]) ++visiblePixels;
      pixelHash ^= pixels[index] | (pixels[index + 1] << 8) | (pixels[index + 2] << 16);
      pixelHash = Math.imul(pixelHash, 16777619) >>> 0;
    }
    return {
      running,
      paused,
      activeRom: activeRom?.id || null,
      permission: currentSession?.permission || null,
      stateVersion: core?._vba_state_version() || null,
      frameCount: core ? Number(core._vba_frame_counter()) : 0,
      audioSamples: core ? Number(core._vba_audio_total_samples()) : 0,
      audioState: audioContext?.state || 'uninitialized',
      inputMask: keyMask | touchMask,
      speedMode,
      emulationSteps: core ? Number(core._vba_emulation_steps()) : 0,
      frameWidth,
      frameHeight,
      visiblePixels,
      pixelHash,
      status: elements['runtime-status'].textContent,
    };
  },
};

runAction(bootstrap);
