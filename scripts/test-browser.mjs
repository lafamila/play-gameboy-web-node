import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const serverPort = 4174;
const cdpPort = 9334;
const origin = `http://127.0.0.1:${serverPort}`;
const buildDirectory = path.join(root, '.build');
const downloadDirectory = path.join(buildDirectory, 'browser-downloads');
const profileDirectory = path.join(os.tmpdir(), `play-gameboy-web-node-chrome-${process.pid}`);
const uploadDirectory = path.join(os.tmpdir(), `play-gameboy-web-node-roms-${process.pid}`);

async function findChrome(directory, depth = 0) {
  if (depth > 8) return null;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'Google Chrome for Testing') return filename;
    if (entry.isDirectory()) {
      const found = await findChrome(filename, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function waitFor(check, timeout = 30000, label = 'condition') {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) || [];
      for (const listener of listeners.splice(0)) listener(message.params);
    });
  }

  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitEvent(method) {
    return new Promise((resolve) => {
      const listeners = this.events.get(method) || [];
      listeners.push(resolve);
      this.events.set(method, listeners);
    });
  }

  close() { this.socket.close(); }
}

async function main() {
  await mkdir(downloadDirectory, { recursive: true });
  for (const filename of await readdir(downloadDirectory)) {
    await rm(path.join(downloadDirectory, filename), { force: true });
  }
  await rm(profileDirectory, { recursive: true, force: true });
  await mkdir(uploadDirectory, { recursive: true });
  for (const filename of await readdir(uploadDirectory)) {
    if (filename !== '.gitkeep') await rm(path.join(uploadDirectory, filename), { force: true });
  }

  const chrome = await findChrome(path.join(os.homedir(), '.agent-browser', 'browsers'));
  if (!chrome) throw new Error('Chrome for Testing is not installed');

  const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTH_TEST_MODE: 'true',
      DB_DRIVER: 'memory',
      PORT: String(serverPort),
      PUBLIC_BASE_URL: origin,
      GBC_PORTING_SESSION_ENCRYPTION_KEY: 'browser-test-session-encryption-key',
      ROM_STORAGE_DIR: uploadDirectory,
      FIXTURE_DIR: path.join(root, 'data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const browser = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=Translate',
    '--use-mock-keychain',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  let browserLog = '';
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  browser.stderr.on('data', (chunk) => { browserLog += chunk.toString(); });

  const cleanup = async () => {
    browser.kill('SIGTERM');
    server.kill('SIGTERM');
    await rm(profileDirectory, { recursive: true, force: true });
    await rm(uploadDirectory, { recursive: true, force: true });
  };

  try {
    await waitFor(async () => {
      if (server.exitCode !== null) throw new Error(serverLog || `server exit ${server.exitCode}`);
      const response = await fetch(`${origin}/api/health`);
      return response.ok;
    }, 15000, 'local server');
    const target = await waitFor(async () => {
      if (browser.exitCode !== null) throw new Error(browserLog || `browser exit ${browser.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' });
      return response.ok ? response.json() : null;
    }, 15000, 'Chrome DevTools');
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.ready();
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('DOM.enable'),
      cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory }),
      cdp.send('Browser.grantPermissions', {
        origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      }),
    ]);

    const evaluate = async (expression, userGesture = false) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    };
    const waitExpression = (expression, label, timeout) =>
      waitFor(() => evaluate(expression), timeout, label);
    const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`, true);
    const setFile = async (selector, filename) => {
      const document = await cdp.send('DOM.getDocument', { depth: 1 });
      const node = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector });
      await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filename] });
    };

    await waitExpression('!document.getElementById("login-view").hidden', 'login view');
    await evaluate(`fetch('/__test/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({accountId: 'browser-visitor', permission: 'visitor', name: 'Browser Visitor'})
    }).then(response => response.ok)`, true);
    let loaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: origin });
    await loaded;
    await waitExpression('!document.getElementById("visitor-view").hidden', 'visitor access request view');
    assert.equal(await evaluate('document.getElementById("app-view").hidden'), true);
    await click('request-access');
    await waitExpression('document.getElementById("access-request-status").innerText === "Request pending"', 'visitor access request');

    await evaluate(`fetch('/__test/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({accountId: 'browser-save-admin', permission: 'admin', name: 'Save Admin'})
    }).then(response => response.ok)`, true);
    loaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: origin });
    await loaded;
    await waitExpression('document.getElementById("event-log").innerText.includes("Catalog ready")', 'admin catalog');
    assert.equal(await evaluate('document.querySelector(".topbar")'), null);
    assert.equal(await evaluate('document.getElementById("account-permission")'), null);
    assert.equal(await evaluate('document.getElementById("app-menu-panel").hidden'), true);
    assert.equal(await evaluate('document.querySelectorAll(".rom-toolbar > .rom-toolbar-player").length'), 2);
    assert.equal(await evaluate('document.querySelectorAll(".rom-toolbar-player-one > *").length'), 3);
    await click('menu-toggle');
    assert.equal(await evaluate('document.getElementById("app-menu-panel").hidden'), false);
    assert.equal(await evaluate('document.getElementById("menu-toggle").getAttribute("aria-expanded")'), 'true');
    assert.equal(await evaluate('document.getElementById("account-name").innerText'), 'Save Admin');
    assert.equal(await evaluate('document.querySelector("label[for=rom-upload]").hidden'), true);
    assert.equal(await evaluate('document.getElementById("export-state").closest(".save-admin-only").hidden'), false);
    assert.equal(await evaluate('document.getElementById("import-state-label").closest(".save-admin-only").hidden'), false);
    assert.equal(await evaluate('document.getElementById("fixture-list").closest("section").hidden'), true);
    await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}))', true);
    assert.equal(await evaluate('document.getElementById("app-menu-panel").hidden'), true);

    await evaluate(`fetch('/__test/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({accountId: 'browser-admin', permission: 'superadmin', name: 'Browser Admin'})
    }).then(response => response.ok)`, true);
    loaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: origin });
    await loaded;
    await waitExpression('document.getElementById("event-log").innerText.includes("Catalog ready")', 'catalog');
    await click('menu-toggle');
    assert.equal(await evaluate('document.getElementById("account-name").innerText'), 'Browser Admin');
    assert.equal(await evaluate('document.querySelector("label[for=rom-upload]").hidden'), false);
    assert.equal(await evaluate('document.getElementById("export-state").closest(".save-admin-only").hidden'), false);
    assert.equal(await evaluate('document.getElementById("fixture-list").closest("section").hidden'), false);
    const fixtureRom = path.join(root, 'data', (await readdir(path.join(root, 'data'))).find((name) => name.endsWith('.gba')));
    await setFile('#rom-upload', fixtureRom);
    await waitExpression('document.getElementById("event-log").innerText.includes("ROM uploaded / BPRE")', 'ROM upload');
    await click('load-rom');
    await waitExpression('document.getElementById("runtime-status").innerText === "Running"', 'ROM load');
    await new Promise((resolve) => setTimeout(resolve, 1800));

    const startup = await evaluate('window.__gbaPoc.diagnostics()');
    assert.equal(startup.running, true);
    assert.equal(startup.stateVersion, 8);
    assert.ok(startup.frameCount >= 20, JSON.stringify(startup));
    assert.ok(startup.audioSamples >= 1000, JSON.stringify(startup));
    assert.ok(startup.visiblePixels >= 1000, JSON.stringify(startup));
    assert.equal(await evaluate('document.getElementById("link-create").disabled'), false);
    await click('link-create');
    await waitExpression(
      'window.__gbaPoc.diagnostics().linkRoom?.status === "waiting" && window.__gbaPoc.diagnostics().linkRoom?.socketOpen',
      'link room socket',
    );
    assert.equal(await evaluate('document.getElementById("speed-toggle").disabled'), true);
    assert.equal(await evaluate('document.getElementById("link-abort").innerText'), 'Leave room');
    assert.equal(await evaluate('document.querySelector("#link-invite-row dt").innerText'), 'PW');
    const roomId = await evaluate('document.getElementById("link-room-id").innerText');
    const roomPw = await evaluate('document.getElementById("link-invite-code").innerText');
    await click('link-room-id');
    await waitExpression('document.getElementById("link-room-copy-feedback").innerText === "Copied"', 'room ID copy feedback');
    assert.equal(await evaluate('navigator.clipboard.readText()'), roomId);
    assert.equal(await evaluate('document.getElementById("link-room-id").innerText'), roomId);
    assert.equal(await evaluate('document.getElementById("link-invite-code").innerText'), roomPw);
    await click('link-invite-code');
    await waitExpression('document.getElementById("link-pw-copy-feedback").innerText === "Copied"', 'room PW copy feedback');
    assert.equal(await evaluate('navigator.clipboard.readText()'), roomPw);
    assert.equal(await evaluate('document.getElementById("link-room-id").innerText'), roomId);
    assert.equal(await evaluate('document.getElementById("link-invite-code").innerText'), roomPw);
    await click('link-abort');
    await waitExpression(
      'window.__gbaPoc.diagnostics().linkRoom?.status === "aborted"',
      'link room abort',
    );
    await click('link-close');
    await waitExpression('window.__gbaPoc.diagnostics().linkRoom === null', 'link room close');
    assert.equal(await evaluate('document.getElementById("speed-toggle").disabled'), false);

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 1', 'A button keydown');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 0', 'A button keyup');

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 2', 'B button keydown');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 0', 'B button keyup');

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 8', 'Start button keydown');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 0', 'Start button keyup');

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
    await waitExpression('window.__gbaPoc.diagnostics().speedMode === true', 'Space enables speed mode');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
    await waitExpression('window.__gbaPoc.diagnostics().speedMode === false', 'Space disables speed mode');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });

    await click('pause');
    const hashes = [];
    for (let index = 1; index <= 3; ++index) {
      await evaluate(`document.querySelectorAll('#fixture-list button')[${index}].click()`, true);
      await waitExpression(`document.getElementById('event-log').innerText.includes('${index}.sg1')`, `fixture ${index}`);
      hashes.push((await evaluate('window.__gbaPoc.diagnostics()')).pixelHash);
    }
    assert.equal(new Set(hashes).size, 3, `State canvas hashes: ${hashes.join(', ')}`);
    const externalStateAudio = await evaluate('window.__gbaPoc.diagnostics()');
    assert.equal(externalStateAudio.stateAudioQuality, 2);
    assert.equal(externalStateAudio.audioQuality, 1);

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'F1', code: 'F1', modifiers: 8,
      windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'F1', code: 'F1', modifiers: 8,
      windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112,
    });
    await waitExpression(
      'document.querySelector("#event-log li")?.innerText.includes("Quick state saved")',
      'Shift+F1 quick save',
    );
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112,
    });
    await waitExpression(
      'document.querySelector("#event-log li")?.innerText.includes("Account state loaded")',
      'F1 quick load',
    );
    assert.ok(await evaluate('document.getElementById("quick-state-meta").innerText.includes("Account state")'));

    const localRomId = await evaluate('window.__gbaPoc.diagnostics().activeRom');
    assert.equal(await evaluate(`fetch('/__test/player2/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({accountId: 'browser-player-two-visitor', permission: 'visitor', name: 'P2 Visitor'})
    }).then(response => response.ok)`), true);
    await click('local-2p-toggle');
    await waitExpression('!document.getElementById("player2-visitor").hidden', 'Player 2 visitor panel');
    await click('player2-request-access');
    await waitExpression(
      'document.getElementById("player2-visitor-status").innerText.includes("pending")',
      'Player 2 visitor request',
    );
    const beforePlayerTwoVisitorLogout = await evaluate(
      'document.querySelector("#event-log li")?.innerText || ""',
    );
    await click('player2-visitor-back');
    await waitExpression(
      `!document.getElementById('player2-choice').hidden || ` +
      `(document.querySelector('#event-log li')?.innerText || '') !== ` +
      `${JSON.stringify(beforePlayerTwoVisitorLogout)}`,
      'Player 2 visitor logout result',
    );
    const playerTwoSessionAfterVisitorLogout = await evaluate(`fetch('/api/player2/session', {
      cache: 'no-store'
    }).then(async response => ({status: response.status, body: await response.json()}))`);
    assert.equal(playerTwoSessionAfterVisitorLogout.status, 200,
      JSON.stringify(playerTwoSessionAfterVisitorLogout));
    assert.equal(playerTwoSessionAfterVisitorLogout.body.authenticated, false,
      JSON.stringify(playerTwoSessionAfterVisitorLogout));
    assert.equal(await evaluate('!document.getElementById("player2-choice").hidden'), true,
      JSON.stringify(playerTwoSessionAfterVisitorLogout));
    await click('local-exit');
    await waitExpression('window.__gbaPoc.diagnostics().localTwoPlayer === null', 'close visitor setup');
    await click('local-2p-toggle');
    await waitExpression(
      '!document.getElementById("player2-choice").hidden || document.querySelector("#event-log li.error")',
      'Player 2 BroadcastChannel setup result',
    );
    const playerTwoSetupResult = await evaluate(`({
      choiceVisible: !document.getElementById('player2-choice').hidden,
      diagnostics: window.__gbaPoc.diagnostics(),
      event: document.querySelector('#event-log li')?.innerText || ''
    })`);
    assert.equal(playerTwoSetupResult.choiceVisible, true, JSON.stringify(playerTwoSetupResult));
    assert.equal(await evaluate(`fetch('/__test/player2/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({accountId: 'browser-player-two', permission: 'user', name: 'Browser Player Two'})
    }).then(response => response.ok)`), true);
    const seededPlayerTwoBatteryHash = await evaluate(`Promise.all([
      fetch('/api/player2/session').then(response => response.json()),
      fetch('/api/saves/${localRomId}/state').then(response => response.arrayBuffer())
    ]).then(async ([session, state]) => {
      const battery = new Uint8Array(131072);
      for (let index = 0; index < battery.length; ++index) battery[index] = (index * 37 + 11) & 255;
      let hash = 2166136261;
      for (const byte of battery) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const responses = await Promise.all([
        fetch('/api/player2/account/saves/${localRomId}/state', {
          method: 'PUT',
          headers: {'X-Player2-CSRF-Token': session.csrfToken, 'Content-Type': 'application/gzip'},
          body: state
        }),
        fetch('/api/player2/account/saves/${localRomId}/battery', {
          method: 'PUT',
          headers: {'X-Player2-CSRF-Token': session.csrfToken,
            'Content-Type': 'application/octet-stream'},
          body: battery
        })
      ]);
      if (!responses.every(response => response.ok)) throw new Error('P2 save seed failed');
      return hash.toString(16).padStart(8, '0');
    })`);
    await evaluate(`(() => {
      const NativeWebSocket = window.WebSocket;
      window.__localWebSocketCount = 0;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          window.__localWebSocketCount += 1;
          return Reflect.construct(Target, args);
        }
      });
      const nativeFetch = window.fetch;
      window.__localRequestCounts = {};
      window.__localEvents = [];
      window.__requestSequences = {};
      window.__romFileRequestCount = 0;
      window.fetch = (...args) => {
        const path = new URL(String(args[0]), location.href).pathname;
        const method = String(args[1]?.method || 'GET').toUpperCase();
        const tracked = path === '/api/local-2p' ||
          (path.startsWith('/api/local-2p/') && path !== '/api/local-2p/recover') ||
          (method === 'PUT' && path.endsWith('/battery'));
        let sequence = 0;
        if (tracked) {
          sequence = (window.__requestSequences[path] || 0) + 1;
          window.__requestSequences[path] = sequence;
          window.__localEvents.push('request:' + path + ':' + sequence);
        }
        if (path === '/api/local-2p' ||
            (path.startsWith('/api/local-2p/') && path !== '/api/local-2p/recover')) {
          window.__localRequestCounts[path] = (window.__localRequestCounts[path] || 0) + 1;
        }
        const romFile = path.endsWith('/file') && path.startsWith('/api/roms/');
        if (romFile) {
          window.__romFileRequestCount += 1;
        }
        const delayMs = romFile ? Number(window.__romFileDelayMs || 0) : 0;
        if (romFile) window.__romFileDelayMs = 0;
        let request;
        if (method === 'GET' && path.includes('/api/player2/') && path.endsWith('/battery') &&
            window.__failNextPlayerTwoBattery) {
          window.__failNextPlayerTwoBattery = false;
          request = Promise.resolve(new Response(JSON.stringify({error: 'simulated battery failure'}), {
            status: 500, headers: {'Content-Type': 'application/json'}
          }));
        } else {
          request = delayMs
            ? new Promise(resolve => setTimeout(resolve, delayMs)).then(() => nativeFetch(...args))
            : nativeFetch(...args);
        }
        return request.then(async response => {
          if (tracked && method === 'PUT' && path.endsWith('/battery') &&
              window.__batteryResponseDelays > 0) {
            --window.__batteryResponseDelays;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          if (tracked) window.__localEvents.push('response:' + path + ':' + sequence);
          return response;
        }, error => {
          if (tracked) window.__localEvents.push('rejection:' + path + ':' + sequence);
          throw error;
        });
      };
    })()`);
    await evaluate(`(() => {
      const channel = new BroadcastChannel('gbc-player2-auth');
      channel.postMessage({type: 'gbc-player2-auth-complete', ok: true});
      channel.close();
    })()`);
    await waitExpression('!document.getElementById("player2-runtime").hidden', 'Player 2 account panel');
    assert.equal(await evaluate(`(async () => {
      const [session, battery] = await Promise.all([
        fetch('/api/player2/session').then(response => response.json()),
        fetch('/api/player2/account/saves/${localRomId}/battery')
          .then(response => response.arrayBuffer()).then(buffer => new Uint8Array(buffer))
      ]);
      let binary = '';
      for (let offset = 0; offset < battery.length; offset += 0x8000) {
        binary += String.fromCharCode(...battery.subarray(offset, offset + 0x8000));
      }
      sessionStorage.setItem('gbc-standalone-battery-recovery', JSON.stringify([{
        slot: 1, mode: 'account', accountId: session.account.id,
        romId: ${JSON.stringify(localRomId)}, data: btoa(binary)
      }]));
      const nativeFetch = window.fetch;
      let unresolved = true;
      window.fetch = (...args) => {
        const path = new URL(String(args[0]), location.href).pathname;
        if (unresolved && path === '/api/player2/session') {
          unresolved = false;
          return Promise.resolve(new Response(JSON.stringify({authenticated: false}), {
            status: 200, headers: {'Content-Type': 'application/json'}
          }));
        }
        return nativeFetch(...args);
      };
      await window.__gbaPoc.flushBatteryRecovery();
      const retained = JSON.parse(sessionStorage.getItem('gbc-standalone-battery-recovery'))
        .some(record => record.slot === 1 && record.mode === 'account');
      window.fetch = nativeFetch;
      await window.__gbaPoc.flushBatteryRecovery();
      return retained && sessionStorage.getItem('gbc-standalone-battery-recovery') === null;
    })()`), true);
    await evaluate(`document.getElementById('player2-rom-select').value = ${JSON.stringify(localRomId)}`);
    const p1BeforeP2Load = await evaluate('window.__gbaPoc.diagnostics().players[0].emulationSteps');
    const romRequestsBeforeInitialP2Load = await evaluate('window.__romFileRequestCount');
    await evaluate('window.__romFileDelayMs = 500');
    await click('player2-load');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.playerTwoLoading && ' +
      'document.getElementById("player2-load").disabled && ' +
      'document.getElementById("player2-rom-select").disabled',
      'exclusive Player 2 load controls',
    );
    await click('player2-load');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate('window.__romFileRequestCount'), romRequestsBeforeInitialP2Load + 1);
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.status === null && window.__gbaPoc.diagnostics().coresDistinct',
      'two independent VBA modules',
      30000,
    );
    const dualLoaded = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(dualLoaded.players[0].emulationSteps > p1BeforeP2Load, JSON.stringify(dualLoaded));
    assert.equal(dualLoaded.players[0].activeRom, localRomId);
    assert.equal(dualLoaded.players[1].activeRom, localRomId);
    assert.equal(dualLoaded.players[1].muted, true);
    assert.equal(dualLoaded.players[0].paused, false);
    assert.equal(dualLoaded.players[1].paused, false);
    assert.equal(dualLoaded.localTwoPlayer.preparing, false);
    assert.deepEqual(dualLoaded.localTwoPlayer.ready, [false, false]);
    assert.equal(dualLoaded.localTwoPlayer.sessionId, null);
    assert.ok(dualLoaded.player2VisiblePixels > 1000, JSON.stringify(dualLoaded));
    assert.equal(await evaluate(
      `['quick-save', 'quick-load', 'speed-toggle', 'player2-quick-save',
        'player2-quick-load', 'player2-speed-toggle'].every(id =>
          getComputedStyle(document.getElementById(id)).display !== 'none')`,
    ), true);
    assert.equal(await evaluate('document.getElementById("player2-quick-save").disabled'), false);
    assert.equal(await evaluate('document.getElementById("player2-quick-load").disabled'), false);
    assert.equal(await evaluate('document.getElementById("player2-speed-toggle").disabled'), false);
    const runtimeStructure = await evaluate(`(() => {
      const describe = panel => ({
        runtimeView: panel.querySelectorAll('[data-player-runtime]').length,
        playbackActions: panel.querySelectorAll('.playback-bar button').length,
        controlGroups: [...panel.querySelector('.touch-controls').children]
          .map(element => element.className),
        compact: panel.querySelector('.touch-controls').classList.contains('compact-touch'),
      });
      return {
        playerOne: describe(document.getElementById('player-one-panel')),
        playerTwo: describe(document.getElementById('player-two-panel')),
      };
    })()`);
    assert.deepEqual(runtimeStructure.playerOne, runtimeStructure.playerTwo,
      JSON.stringify(runtimeStructure));
    assert.equal(runtimeStructure.playerOne.runtimeView, 1);
    assert.equal(runtimeStructure.playerOne.playbackActions, 3);
    assert.equal(runtimeStructure.playerOne.compact, false);
    await click('player2-pause');
    await waitExpression(
      'window.__gbaPoc.diagnostics().players[1].paused && ' +
      '!window.__gbaPoc.diagnostics().players[0].paused',
      'Player 2 independent pause',
    );
    await click('player2-pause');
    await waitExpression(
      '!window.__gbaPoc.diagnostics().players[1].paused',
      'Player 2 independent resume',
    );
    assert.equal(await evaluate(`fetch('/api/player2/account/saves/${localRomId}/battery')
      .then(response => response.arrayBuffer()).then(buffer => {
        let hash = 2166136261;
        for (const byte of new Uint8Array(buffer)) {
          hash ^= byte;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
      })`), seededPlayerTwoBatteryHash);
    await click('player2-speed-toggle');
    assert.equal(await evaluate(
      'document.getElementById("player2-speed-toggle").getAttribute("aria-pressed")',
    ), 'true');
    await click('player2-speed-toggle');
    await click('player2-quick-save');
    await waitExpression(
      'document.getElementById("event-log").innerText.includes("P2 quick state saved")',
      'Player 2 quick state save',
    );
    await click('player2-quick-load');
    await waitExpression(
      'document.getElementById("event-log").innerText.includes("P2 quick state loaded")',
      'Player 2 quick state load',
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    const independentRunning = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(independentRunning.players[0].emulationSteps > dualLoaded.players[0].emulationSteps,
      JSON.stringify({ dualLoaded, independentRunning }));
    assert.ok(independentRunning.players[1].emulationSteps > dualLoaded.players[1].emulationSteps,
      JSON.stringify({ dualLoaded, independentRunning }));
    const beforeFailedP2Load = await evaluate('window.__gbaPoc.diagnostics()');
    const beforeFailedP2Event = await evaluate(
      'document.querySelector("#event-log li")?.innerText || ""',
    );
    await evaluate('window.__failNextPlayerTwoBattery = true; window.__romFileDelayMs = 250');
    await click('player2-load');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.playerTwoLoading && ' +
      'document.getElementById("player2-load").disabled',
      'failed Player 2 load enters loading state',
    );
    await waitExpression(
      `!window.__gbaPoc.diagnostics().localTwoPlayer?.playerTwoLoading && ` +
      `(document.querySelector('#event-log li')?.innerText || '') !== ${JSON.stringify(beforeFailedP2Event)}`,
      'failed Player 2 load recovery',
      30000,
    );
    const afterFailedP2Load = await evaluate('window.__gbaPoc.diagnostics()');
    assert.equal(afterFailedP2Load.players[1].activeRom, beforeFailedP2Load.players[1].activeRom);
    assert.equal(afterFailedP2Load.players[1].generation, beforeFailedP2Load.players[1].generation);
    assert.equal(afterFailedP2Load.players[1].running, true);
    assert.equal(afterFailedP2Load.players[1].paused, false);
    assert.equal(afterFailedP2Load.standaloneAutosave[1], true);
    const failedP2Progress = afterFailedP2Load.players[1].emulationSteps;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(await evaluate(
      `window.__gbaPoc.diagnostics().players[1].emulationSteps > ${failedP2Progress}`,
    ));
    const p1BeforeP2Reload = independentRunning.players[0].emulationSteps;
    const p2HashBeforeReload = await evaluate('window.__gbaPoc.batteryHash(1)');
    const romRequestsBeforeP2Reload = await evaluate('window.__romFileRequestCount');
    await click('player2-load');
    await waitExpression(
      `window.__romFileRequestCount > ${romRequestsBeforeP2Reload}`,
      'Player 2 reload request',
      30000,
    );
    await waitExpression(
      'document.getElementById("player2-runtime-status").innerText === "Ready"',
      'Player 2 independent reload',
      30000,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const independentReloaded = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(independentReloaded.players[0].emulationSteps > p1BeforeP2Reload,
      JSON.stringify({ independentRunning, independentReloaded }));
    assert.ok(independentReloaded.players[1].emulationSteps > 0, JSON.stringify(independentReloaded));
    assert.deepEqual(await evaluate('window.__gbaPoc.batteryHash(1)'), p2HashBeforeReload);
    assert.deepEqual(await evaluate(`fetch('/api/player2/account/saves/${localRomId}/battery')
      .then(response => response.arrayBuffer()).then(buffer => {
        const bytes = new Uint8Array(buffer);
        let hash = 2166136261;
        for (const byte of bytes) {
          hash ^= byte;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        return {hash: hash.toString(16).padStart(8, '0'), size: bytes.byteLength};
      })`), p2HashBeforeReload);
    assert.equal(await evaluate('window.__localWebSocketCount'), 0);
    assert.deepEqual(await evaluate('window.__localRequestCounts'), {});
    assert.equal(await evaluate('document.getElementById("speed-toggle").disabled'), false);
    assert.equal(await evaluate('document.getElementById("quick-load").disabled'), false);
    assert.equal(await evaluate('document.getElementById("import-state").disabled'), false);
    assert.equal(await evaluate('document.getElementById("rom-select").disabled'), false);
    assert.equal(await evaluate('document.getElementById("load-rom").disabled'), false);
    assert.equal(await evaluate(`fetch('/api/session').then(response => response.json()).then(session =>
      fetch('/api/local-2p/recover', {
        method: 'POST', headers: {'X-CSRF-Token': session.csrfToken}
      })).then(response => response.json()).then(body => body.session)`), null);
    const realCoreCableProbe = await evaluate('window.__gbaPoc.runDirectCableProbe()');
    assert.deepEqual(realCoreCableProbe, {
      applied: true,
      sequence: 0,
      masterData: 0x1234,
      slaveData: 0xabcd,
      hostPeerData: 0xabcd,
      guestPeerData: 0xabcd,
      independentMemories: true,
    });

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77,
    });
    await waitExpression(
      'window.__gbaPoc.diagnostics().players[1].inputMask === 1 && window.__gbaPoc.diagnostics().players[0].inputMask === 0',
      'Player 2 keyboard isolation',
    );
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77,
    });
    const player2TouchPoint = await evaluate(`(() => {
      const button = document.querySelector('[data-player="2"][data-button="1"]');
      button.scrollIntoView({block: 'center'});
      const rect = button.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    })()`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: player2TouchPoint.x, y: player2TouchPoint.y,
      button: 'left', buttons: 1, clickCount: 1,
    });
    await waitExpression(
      'window.__gbaPoc.diagnostics().players[1].inputMask === 1 && window.__gbaPoc.diagnostics().players[0].inputMask === 0',
      'Player 2 touch isolation',
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: player2TouchPoint.x, y: player2TouchPoint.y,
      button: 'left', buttons: 0, clickCount: 1,
    });
    await waitExpression('window.__gbaPoc.diagnostics().players[1].inputMask === 0', 'Player 2 touch release');
    await click('local-p1-ready');
    assert.deepEqual(await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer.ready'), [true, false]);
    await click('local-p1-ready');
    assert.deepEqual(await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer.ready'), [false, false]);
    await click('local-p1-ready');
    await click('local-p2-ready');
    await waitExpression('!document.getElementById("local-start").disabled', 'both local players ready');
    await evaluate(`document.getElementById('player2-rom-select')
      .dispatchEvent(new Event('change', {bubbles: true}))`);
    assert.deepEqual(await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer.ready'), [false, false]);
    assert.equal(await evaluate('document.getElementById("local-start").disabled'), true);
    await click('local-p1-ready');
    await click('local-p2-ready');
    await waitExpression('!document.getElementById("local-start").disabled', 'ready after ROM selection change');
    assert.deepEqual(await evaluate('window.__localRequestCounts'), {});
    assert.equal(await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer.sessionId'), null);
    await evaluate(`(() => {
      const nativeFetch = window.fetch;
      let failed = false;
      window.fetch = (...args) => {
        const path = new URL(String(args[0]), location.href).pathname;
        if (!failed && path === '/api/local-2p') {
          failed = true;
          return Promise.resolve(new Response(JSON.stringify({error: 'simulated create failure'}), {
            status: 500, headers: {'Content-Type': 'application/json'}
          }));
        }
        return nativeFetch(...args);
      };
      window.__restoreLocalCreateFetch = () => { window.fetch = nativeFetch; };
    })()`);
    const beforeCreateFailure = await evaluate('window.__gbaPoc.diagnostics()');
    await click('local-start');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.sessionId === null && ' +
      '!window.__gbaPoc.diagnostics().localTwoPlayer?.preparing',
      'pre-session Start failure rollback',
      30000,
    );
    await evaluate('window.__restoreLocalCreateFetch()');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterCreateFailure = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(afterCreateFailure.players[0].emulationSteps > beforeCreateFailure.players[0].emulationSteps,
      JSON.stringify({beforeCreateFailure, afterCreateFailure}));
    assert.ok(afterCreateFailure.players[1].emulationSteps > beforeCreateFailure.players[1].emulationSteps,
      JSON.stringify({beforeCreateFailure, afterCreateFailure}));
    assert.deepEqual(afterCreateFailure.standaloneAutosave, [true, true]);
    assert.deepEqual(afterCreateFailure.localTwoPlayer.ready, [true, true]);
    await waitExpression('!document.getElementById("local-start").disabled',
      'retry after pre-session failure');
    await evaluate(`(() => {
      const nativeFetch = window.fetch;
      let failed = false;
      window.fetch = (...args) => {
        const path = new URL(String(args[0]), location.href).pathname;
        if (!failed && path.endsWith('/start') && path.startsWith('/api/local-2p/')) {
          failed = true;
          return Promise.resolve(new Response(JSON.stringify({error: 'simulated Start failure'}), {
            status: 500, headers: {'Content-Type': 'application/json'}
          }));
        }
        return nativeFetch(...args);
      };
      window.__restoreLocalStartFetch = () => { window.fetch = nativeFetch; };
    })()`);
    const beforeFailedStart = await evaluate('window.__gbaPoc.diagnostics()');
    await click('local-start');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.sessionId === null && ' +
      '!window.__gbaPoc.diagnostics().localTwoPlayer?.preparing',
      'failed local Start rollback',
      30000,
    );
    await evaluate('window.__restoreLocalStartFetch()');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterFailedStart = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(afterFailedStart.players[0].emulationSteps > beforeFailedStart.players[0].emulationSteps,
      JSON.stringify({ beforeFailedStart, afterFailedStart }));
    assert.ok(afterFailedStart.players[1].emulationSteps > beforeFailedStart.players[1].emulationSteps,
      JSON.stringify({ beforeFailedStart, afterFailedStart }));
    assert.deepEqual(afterFailedStart.standaloneAutosave, [true, true]);
    assert.deepEqual(afterFailedStart.localTwoPlayer.ready, [true, true]);
    assert.equal(await evaluate(`fetch('/api/session').then(response => response.json()).then(session =>
      fetch('/api/local-2p/recover', {
        method: 'POST', headers: {'X-CSRF-Token': session.csrfToken}
      })).then(response => response.json()).then(body => body.session)`), null);
    await waitExpression('!document.getElementById("local-start").disabled', 'retry local Start');
    await evaluate(`(() => {
      window.__localRequestCounts = {};
      window.__localEvents = [];
      window.__requestSequences = {};
      window.__batteryResponseDelays = 2;
      window.__priorStandaloneFlush = window.__gbaPoc.flushStandaloneBatteries();
      return true;
    })()`);
    await waitExpression(
      `window.__requestSequences['/api/saves/${localRomId}/battery'] === 1 && ` +
      `window.__requestSequences['/api/player2/account/saves/${localRomId}/battery'] === 1`,
      'queued prior battery flushes',
    );
    await click('local-start');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.active && window.__gbaPoc.diagnostics().players[0].linkPlayer === 0 && window.__gbaPoc.diagnostics().players[1].linkPlayer === 1',
      'direct local cable start',
    );
    const dualStart = await evaluate('window.__gbaPoc.diagnostics()');
    const localStartCounts = await evaluate(`(() => {
      const counts = window.__localRequestCounts;
      const sessionId = window.__gbaPoc.diagnostics().localTwoPlayer.sessionId;
      return {
        create: counts['/api/local-2p'] || 0,
        p1Ready: counts['/api/local-2p/' + sessionId + '/player1-ready'] || 0,
        p2Ready: counts['/api/local-2p/' + sessionId + '/player2-ready'] || 0,
        checkpoint: counts['/api/local-2p/' + sessionId + '/checkpoint'] || 0,
        start: counts['/api/local-2p/' + sessionId + '/start'] || 0,
      };
    })()`);
    assert.deepEqual(localStartCounts, {
      create: 1, p1Ready: 1, p2Ready: 1, checkpoint: 1, start: 1,
    });
    const localStartEvents = await evaluate('window.__localEvents');
    const p1BatteryPath = `/api/saves/${localRomId}/battery`;
    const p2BatteryPath = `/api/player2/account/saves/${localRomId}/battery`;
    const createRequestIndex = localStartEvents.indexOf('request:/api/local-2p:1');
    assert.equal(await evaluate(`window.__requestSequences[${JSON.stringify(p1BatteryPath)}]`), 2);
    assert.equal(await evaluate(`window.__requestSequences[${JSON.stringify(p2BatteryPath)}]`), 2);
    assert.ok(localStartEvents.indexOf(`response:${p1BatteryPath}:1`) <
      localStartEvents.indexOf(`request:${p1BatteryPath}:2`), JSON.stringify(localStartEvents));
    assert.ok(localStartEvents.indexOf(`response:${p2BatteryPath}:1`) <
      localStartEvents.indexOf(`request:${p2BatteryPath}:2`), JSON.stringify(localStartEvents));
    assert.ok(localStartEvents.indexOf(`response:${p1BatteryPath}:2`) < createRequestIndex,
      JSON.stringify(localStartEvents));
    assert.ok(localStartEvents.indexOf(`response:${p2BatteryPath}:2`) < createRequestIndex,
      JSON.stringify(localStartEvents));
    assert.equal(dualStart.localTwoPlayer.hasPairedCheckpoint, true);
    assert.equal(dualStart.localTwoPlayer.checkpointSequence, 1);
    assert.equal(await evaluate(
      `['quick-save', 'quick-load', 'speed-toggle', 'player2-quick-save',
        'player2-quick-load', 'player2-speed-toggle'].every(id =>
          document.getElementById(id).disabled)`,
    ), true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const dualRunning = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(dualRunning.players[0].emulationSteps > dualStart.players[0].emulationSteps,
      JSON.stringify({ dualStart, dualRunning }));
    assert.ok(dualRunning.players[1].emulationSteps > dualStart.players[1].emulationSteps,
      JSON.stringify({ dualStart, dualRunning }));
    assert.equal(await evaluate('window.__localWebSocketCount'), 0);
    await evaluate(`(() => {
      const nativeFetch = window.fetch;
      let lost = false;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (!lost && String(args[0]).endsWith('/checkpoint')) {
          lost = true;
          throw new Error('simulated committed response loss');
        }
        return response;
      };
      window.__restoreCheckpointFetch = () => { window.fetch = nativeFetch; };
    })()`);
    assert.match(await evaluate(
      'window.__gbaPoc.checkpointLocal().then(() => "unexpected").catch(error => error.message)',
    ), /simulated committed response loss/);
    const lostCheckpoint = await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer');
    assert.equal(lostCheckpoint.checkpointSequence, 1);
    assert.equal(lostCheckpoint.checkpointPending, true);
    assert.equal(await evaluate('window.__gbaPoc.checkpointLocal()'), true);
    await evaluate('window.__restoreCheckpointFetch()');
    const retriedCheckpoint = await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer');
    assert.equal(retriedCheckpoint.checkpointSequence, 2);
    assert.equal(retriedCheckpoint.checkpointPending, false);
    const recoverableLocalSessionId = dualRunning.localTwoPlayer.sessionId;
    loaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: origin });
    await loaded;
    await waitExpression(
      `window.__gbaPoc?.diagnostics().localTwoPlayer?.active && ` +
      `window.__gbaPoc.diagnostics().localTwoPlayer.sessionId === ${JSON.stringify(recoverableLocalSessionId)}`,
      'paired local checkpoint recovery',
      30000,
    );
    const recoveredLocal = await evaluate('window.__gbaPoc.diagnostics()');
    assert.equal(recoveredLocal.coresDistinct, true);
    assert.equal(recoveredLocal.localTwoPlayer.hasPairedCheckpoint, true);
    assert.equal(await evaluate('document.getElementById("local-2p-status").innerText'),
      'Recovered paired checkpoint');
    await evaluate(`(() => {
      const NativeWebSocket = window.WebSocket;
      window.__localWebSocketCount = 0;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          window.__localWebSocketCount += 1;
          return Reflect.construct(Target, args);
        }
      });
    })()`);

    const captureLocal = async (width, height, filename) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width < 600,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(path.join(buildDirectory, filename), Buffer.from(screenshot.data, 'base64'));
    };
    await captureLocal(1440, 900, 'local-2p-landscape.png');
    const localLandscape = await evaluate(`(() => {
      const first = document.getElementById('player-one-panel').getBoundingClientRect();
      const second = document.getElementById('player-two-panel').getBoundingClientRect();
      const firstToolbar = document.querySelector('.rom-toolbar-player-one').getBoundingClientRect();
      const secondToolbar = document.getElementById('player2-toolbar').getBoundingClientRect();
      const firstScreen = document.getElementById('screen-shell').getBoundingClientRect();
      const secondScreen = document.getElementById('player2-screen-shell').getBoundingClientRect();
      const firstControls = document.querySelector('#player-one-panel .touch-controls').getBoundingClientRect();
      const secondControls = document.querySelector('#player-two-panel .touch-controls').getBoundingClientRect();
      const firstCenter = document.querySelector('#player-one-panel .center-controls').getBoundingClientRect();
      const secondCenter = document.querySelector('#player-two-panel .center-controls').getBoundingClientRect();
      const firstAction = document.querySelector('#player-one-panel .action-controls').getBoundingClientRect();
      const secondAction = document.querySelector('#player-two-panel .action-controls').getBoundingClientRect();
      const firstActions = document.querySelector('#player-one-panel .local-link-actions').getBoundingClientRect();
      const secondActions = document.querySelector('#player-two-panel .local-link-actions').getBoundingClientRect();
      return {firstLeft: first.left, firstRight: first.right, secondLeft: second.left,
        secondRight: second.right, firstToolbarLeft: firstToolbar.left,
        firstToolbarRight: firstToolbar.right, firstToolbarTop: firstToolbar.top,
        secondToolbarLeft: secondToolbar.left, secondToolbarRight: secondToolbar.right,
        secondToolbarTop: secondToolbar.top, firstControlsBottom: firstControls.bottom,
        firstScreenWidth: firstScreen.width, secondScreenWidth: secondScreen.width,
        firstScreenHeight: firstScreen.height, secondScreenHeight: secondScreen.height,
        firstControlsOffset: firstControls.top - firstScreen.bottom,
        secondControlsOffset: secondControls.top - secondScreen.bottom,
        firstCenterOffset: firstCenter.top - firstControls.top,
        secondCenterOffset: secondCenter.top - secondControls.top,
        firstActionOffset: firstAction.top - firstControls.top,
        secondActionOffset: secondAction.top - secondControls.top,
        firstActionsTop: firstActions.top, secondControlsBottom: secondControls.bottom,
        secondActionsTop: secondActions.top, scrollWidth: document.documentElement.scrollWidth,
        innerWidth, hasPlayerHeading: Boolean(document.querySelector('.player-heading')),
        hasPlayerRomToolbar: Boolean(document.querySelector('.player-rom-toolbar'))};
    })()`);
    assert.ok(localLandscape.firstRight <= localLandscape.secondLeft + 1, JSON.stringify(localLandscape));
    assert.ok(localLandscape.firstToolbarRight <= localLandscape.secondToolbarLeft + 1,
      JSON.stringify(localLandscape));
    assert.ok(Math.abs(localLandscape.firstToolbarTop - localLandscape.secondToolbarTop) <= 1,
      JSON.stringify(localLandscape));
    assert.ok(Math.abs(localLandscape.firstScreenWidth - localLandscape.secondScreenWidth) <= 1,
      JSON.stringify(localLandscape));
    assert.ok(Math.abs(localLandscape.firstScreenHeight - localLandscape.secondScreenHeight) <= 1,
      JSON.stringify(localLandscape));
    assert.ok(Math.abs(localLandscape.firstControlsOffset - localLandscape.secondControlsOffset) <= 1,
      JSON.stringify(localLandscape));
    assert.ok(Math.abs(localLandscape.firstCenterOffset - localLandscape.secondCenterOffset) <= 1,
      JSON.stringify(localLandscape));
    assert.ok(Math.abs(localLandscape.firstActionOffset - localLandscape.secondActionOffset) <= 1,
      JSON.stringify(localLandscape));
    assert.ok(localLandscape.firstControlsBottom <= localLandscape.firstActionsTop + 1,
      JSON.stringify(localLandscape));
    assert.ok(localLandscape.secondControlsBottom <= localLandscape.secondActionsTop + 1,
      JSON.stringify(localLandscape));
    assert.equal(localLandscape.hasPlayerHeading, false);
    assert.equal(localLandscape.hasPlayerRomToolbar, false);
    assert.ok(localLandscape.scrollWidth <= localLandscape.innerWidth, JSON.stringify(localLandscape));
    await captureLocal(600, 360, 'local-2p-compact-landscape.png');
    const localCompactLandscape = await evaluate(`(() => {
      const firstToolbar = document.querySelector('.rom-toolbar-player-one').getBoundingClientRect();
      const secondToolbar = document.getElementById('player2-toolbar').getBoundingClientRect();
      const controls = [...document.querySelectorAll('#player2-toolbar > *')]
        .filter(element => !element.hidden)
        .map(element => {
          const rect = element.getBoundingClientRect();
          return {id: element.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
        });
      return {firstLeft: firstToolbar.left, firstRight: firstToolbar.right,
        firstTop: firstToolbar.top, secondLeft: secondToolbar.left,
        secondRight: secondToolbar.right, secondTop: secondToolbar.top,
        controls, portrait: document.getElementById('workspace').classList.contains('local-portrait'),
        scrollWidth: document.documentElement.scrollWidth, innerWidth};
    })()`);
    assert.equal(localCompactLandscape.portrait, false, JSON.stringify(localCompactLandscape));
    assert.ok(localCompactLandscape.firstRight <= localCompactLandscape.secondLeft + 1,
      JSON.stringify(localCompactLandscape));
    assert.ok(Math.abs(localCompactLandscape.firstTop - localCompactLandscape.secondTop) <= 1,
      JSON.stringify(localCompactLandscape));
    for (let index = 1; index < localCompactLandscape.controls.length; ++index) {
      assert.ok(localCompactLandscape.controls[index - 1].right <=
        localCompactLandscape.controls[index].left + 1, JSON.stringify(localCompactLandscape));
    }
    assert.ok(localCompactLandscape.secondRight <= localCompactLandscape.innerWidth,
      JSON.stringify(localCompactLandscape));
    assert.ok(localCompactLandscape.scrollWidth <= localCompactLandscape.innerWidth,
      JSON.stringify(localCompactLandscape));
    await captureLocal(430, 932, 'local-2p-portrait.png');
    const localPortrait = await evaluate(`(() => {
      const first = document.getElementById('player-one-panel').getBoundingClientRect();
      const second = document.getElementById('player-two-panel').getBoundingClientRect();
      const firstToolbar = document.querySelector('.rom-toolbar-player-one').getBoundingClientRect();
      const secondToolbar = document.getElementById('player2-toolbar').getBoundingClientRect();
      const firstActions = document.querySelector('#player-one-panel .local-link-actions').getBoundingClientRect();
      const secondActions = document.querySelector('#player-two-panel .local-link-actions').getBoundingClientRect();
      return {firstBottom: first.bottom, secondTop: second.top, secondBottom: second.bottom,
        firstToolbarBottom: firstToolbar.bottom, secondToolbarTop: secondToolbar.top,
        firstActionsBottom: firstActions.bottom, secondActionsBottom: secondActions.bottom,
        scrollWidth: document.documentElement.scrollWidth, innerWidth};
    })()`);
    assert.ok(localPortrait.firstBottom <= localPortrait.secondTop + 1, JSON.stringify(localPortrait));
    assert.ok(localPortrait.firstToolbarBottom <= localPortrait.secondToolbarTop + 1,
      JSON.stringify(localPortrait));
    assert.ok(localPortrait.firstActionsBottom <= localPortrait.firstBottom + 1,
      JSON.stringify(localPortrait));
    assert.ok(localPortrait.secondActionsBottom <= localPortrait.secondBottom + 1,
      JSON.stringify(localPortrait));
    assert.ok(localPortrait.scrollWidth <= localPortrait.innerWidth, JSON.stringify(localPortrait));
    await captureLocal(1440, 900, 'local-2p-landscape-restored.png');
    const localLandscapeRestored = await evaluate(`(() => {
      const first = document.getElementById('player-one-panel').getBoundingClientRect();
      const second = document.getElementById('player-two-panel').getBoundingClientRect();
      return {firstRight: first.right, secondLeft: second.left,
        scrollWidth: document.documentElement.scrollWidth, innerWidth,
        active: window.__gbaPoc.diagnostics().localTwoPlayer?.active};
    })()`);
    assert.equal(localLandscapeRestored.active, true);
    assert.ok(localLandscapeRestored.firstRight <= localLandscapeRestored.secondLeft + 1,
      JSON.stringify(localLandscapeRestored));
    assert.ok(localLandscapeRestored.scrollWidth <= localLandscapeRestored.innerWidth,
      JSON.stringify(localLandscapeRestored));
    await evaluate(`(() => {
      const nativeFetch = window.fetch;
      let failed = false;
      window.fetch = (...args) => {
        const url = String(args[0]);
        if (!failed && url.includes('/api/local-2p/') && url.endsWith('/finish')) {
          failed = true;
          return Promise.resolve(new Response(JSON.stringify({error: 'simulated finish failure'}), {
            status: 500, headers: {'Content-Type': 'application/json'}
          }));
        }
        return nativeFetch(...args);
      };
      window.__restoreFetchAfterLocalFailure = () => { window.fetch = nativeFetch; };
    })()`);
    await click('local-exit');
    await waitExpression('window.__gbaPoc.diagnostics().localTwoPlayer === null', 'local 2P exit', 30000);
    await evaluate('window.__restoreFetchAfterLocalFailure()');
    const afterLocalExit = await evaluate('window.__gbaPoc.diagnostics()');
    assert.equal(afterLocalExit.players[0].running, true);
    assert.equal(afterLocalExit.players[1].running, false);
    assert.equal(afterLocalExit.players[0].linkPlayer, -1);
    assert.equal(afterLocalExit.players[1].audioPointer, 0);
    assert.equal(afterLocalExit.players[1].audioContextState, 'closed');
    assert.equal(await evaluate('document.getElementById("player2-mute").innerText'), 'Unmute');
    assert.equal(afterLocalExit.lastLocalRollbackCount, 1);
    assert.equal(await evaluate('fetch("/api/player2/session").then(response => response.json()).then(body => body.authenticated)'), false);
    assert.equal(await evaluate('fetch("/api/session").then(response => response.json()).then(body => body.account.id)'), 'browser-admin');
    assert.equal(await evaluate(`fetch('/api/session').then(response => response.json()).then(session =>
      fetch('/api/local-2p/recover', {
        method: 'POST', headers: {'X-CSRF-Token': session.csrfToken}
      })).then(response => response.json()).then(body => body.session)`), null);

    await click('local-2p-toggle');
    await waitExpression('!document.getElementById("player2-choice").hidden', 'Guest P2 choice');
    await click('player2-guest');
    await evaluate(`document.getElementById('player2-rom-select').value = ${JSON.stringify(localRomId)}`);
    await click('player2-load');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.mode === "guest" && window.__gbaPoc.diagnostics().coresDistinct',
      'Guest P2 dual runtime',
      30000,
    );
    const guestDualLoaded = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(guestDualLoaded.players[1].generation > dualLoaded.players[1].generation);
    assert.ok(guestDualLoaded.players[1].audioPointer > 0);
    assert.equal(guestDualLoaded.players[1].muted, true);
    const guestIndependentStart = guestDualLoaded.players[1].emulationSteps;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok(await evaluate(
      `window.__gbaPoc.diagnostics().players[1].emulationSteps > ${guestIndependentStart}`,
    ));
    assert.equal(await evaluate('window.__gbaPoc.diagnostics().localTwoPlayer.sessionId'), null);
    const guestP2HashBeforeExit = await evaluate('window.__gbaPoc.batteryHash(1)');
    await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))");
    assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('gbc-standalone-battery-recovery'))
      .some(record => record.slot === 1 && record.mode === 'guest' && record.romId === ${JSON.stringify(localRomId)})`), true);
    await click('local-exit');
    await waitExpression('window.__gbaPoc.diagnostics().localTwoPlayer === null',
      'independent Guest P2 exit', 30000);
    assert.deepEqual(await evaluate(`fetch('/api/player2/guest/saves/${localRomId}/battery')
      .then(response => response.arrayBuffer()).then(buffer => {
        const bytes = new Uint8Array(buffer);
        let hash = 2166136261;
        for (const byte of bytes) {
          hash ^= byte;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        return {hash: hash.toString(16).padStart(8, '0'), size: bytes.byteLength};
      })`), guestP2HashBeforeExit);

    await click('local-2p-toggle');
    await waitExpression('!document.getElementById("player2-choice").hidden', 'Guest P2 restart choice');
    await click('player2-guest');
    await evaluate(`document.getElementById('player2-rom-select').value = ${JSON.stringify(localRomId)}`);
    await click('player2-load');
    await waitExpression(
      'window.__gbaPoc.diagnostics().localTwoPlayer?.mode === "guest" && window.__gbaPoc.diagnostics().coresDistinct',
      'Guest P2 reload after independent save',
      30000,
    );
    await click('local-p1-ready');
    await click('local-p2-ready');
    await waitExpression('!document.getElementById("local-start").disabled', 'Guest P2 ready');
    const beforeGuestStartEvent = await evaluate(
      'document.querySelector("#event-log li")?.innerText || ""',
    );
    await click('local-start');
    await waitExpression(
      `window.__gbaPoc.diagnostics().localTwoPlayer?.active || ` +
      `(document.querySelector('#event-log li')?.innerText || '') !== ${JSON.stringify(beforeGuestStartEvent)}`,
      'Guest P2 start result',
      30000,
    );
    const guestStartResult = await evaluate(`({
      diagnostics: window.__gbaPoc.diagnostics(),
      event: document.querySelector('#event-log li')?.innerText || ''
    })`);
    assert.equal(guestStartResult.diagnostics.localTwoPlayer?.active, true,
      JSON.stringify(guestStartResult));
    const guestStart = await evaluate('window.__gbaPoc.diagnostics().players[1].emulationSteps');
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok(await evaluate(`window.__gbaPoc.diagnostics().players[1].emulationSteps > ${guestStart}`));
    assert.equal(await evaluate('window.__localWebSocketCount'), 0);
    await click('local-exit');
    await waitExpression('window.__gbaPoc.diagnostics().localTwoPlayer === null', 'Guest P2 exit', 30000);

    await click('export-battery');
    const exportedBattery = await waitFor(async () => {
      const candidates = (await readdir(downloadDirectory)).filter((name) => name.endsWith('.sa1'));
      if (!candidates.length) return null;
      const filename = path.join(downloadDirectory, candidates[0]);
      return (await stat(filename)).size > 0 ? filename : null;
    }, 15000, 'battery download');
    assert.equal((await stat(exportedBattery)).size, 131072);
    await setFile('#import-battery', exportedBattery);
    await waitExpression('document.getElementById("event-log").innerText.includes(".sa1 loaded")', 'battery reimport');

    await click('export-state');
    const downloaded = await waitFor(async () => {
      const candidates = (await readdir(downloadDirectory)).filter((name) => name.endsWith('.sg1'));
      if (!candidates.length) return null;
      const filename = path.join(downloadDirectory, candidates[0]);
      return (await stat(filename)).size > 0 ? filename : null;
    }, 15000, 'state download');
    const exported = path.join(downloadDirectory, 'roundtrip.sg1');
    if (downloaded !== exported) await rename(downloaded, exported);

    const state = gunzipSync(await readFile(exported));
    assert.equal(state.length, 739838);
    assert.equal(state.readUInt32LE(0), 8);
    assert.equal(state.subarray(4, 20).toString('ascii'), 'POKEMON FIREBPRE');
    assert.equal(state.readUInt32LE(20), 0);

    await setFile('#import-state', exported);
    await waitExpression('document.getElementById("event-log").innerText.includes("roundtrip.sg1 loaded")', 'state reimport');

    const wrongState = Buffer.from(state);
    wrongState[4] = 'X'.charCodeAt(0);
    const badState = path.join(downloadDirectory, 'wrong-rom.sg1');
    await writeFile(badState, gzipSync(wrongState));
    await setFile('#import-state', badState);
    await waitExpression('document.getElementById("event-log").innerText.includes("does not match")', 'wrong ROM rejection');
    const corruptState = path.join(downloadDirectory, 'corrupt.sg1');
    await writeFile(corruptState, Buffer.from('not a gzip state'));
    await setFile('#import-state', corruptState);
    await waitExpression('document.getElementById("event-log").innerText.includes("not a valid gzip file")', 'corrupt state rejection');
    assert.equal((await evaluate('window.__gbaPoc.diagnostics()')).running, true);

    loaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: origin });
    await loaded;
    await waitExpression('document.getElementById("event-log").innerText.includes("Catalog ready")', 'catalog after reload');
    assert.equal(await evaluate(
      `sessionStorage.getItem('gbc-standalone-battery-recovery')`,
    ), null);
    await click('load-rom');
    await waitExpression('document.getElementById("event-log").innerText.includes("Account state loaded")', 'account save restore');

    const gbRom = path.join(root, 'Red_K.gb');
    await setFile('#rom-upload', gbRom);
    await waitExpression('document.getElementById("event-log").innerText.includes("ROM uploaded / GB")', 'GB ROM upload');
    await click('load-rom');
    await waitExpression('document.getElementById("event-log").innerText.includes("ROM loaded / GB")', 'GB ROM load');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const gbStartup = await evaluate('window.__gbaPoc.diagnostics()');
    assert.equal(gbStartup.stateVersion, 10);
    assert.equal(gbStartup.frameWidth, 160);
    assert.equal(gbStartup.frameHeight, 144);
    assert.ok(gbStartup.visiblePixels > 500, JSON.stringify(gbStartup));

    const normalStart = gbStartup.emulationSteps;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const normalSteps = (await evaluate('window.__gbaPoc.diagnostics()')).emulationSteps - normalStart;
    await click('speed-toggle');
    assert.equal(await evaluate('document.getElementById("speed-toggle").getAttribute("aria-pressed")'), 'true');
    const speedStart = (await evaluate('window.__gbaPoc.diagnostics()')).emulationSteps;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const speedSteps = (await evaluate('window.__gbaPoc.diagnostics()')).emulationSteps - speedStart;
    assert.ok(speedSteps > normalSteps * 1.6, `normal=${normalSteps}, speed=${speedSteps}`);
    assert.ok(speedSteps < normalSteps * 2.4, `normal=${normalSteps}, speed=${speedSteps}`);
    await click('speed-toggle');

    await click('quick-save');
    await waitExpression('document.getElementById("event-log").innerText.includes("Quick state saved")', 'GB account state save');
    await click('quick-load');
    await waitExpression('document.getElementById("event-log").innerText.includes("Account state loaded / v10")', 'GB account state load');
    await click('export-state');
    const gbStateFile = path.join(downloadDirectory, 'POKEMON_RED1.sg1');
    await waitFor(async () => {
      try { return (await stat(gbStateFile)).size > 0; } catch { return false; }
    }, 15000, 'GB state download');
    const gbState = gunzipSync(await readFile(gbStateFile));
    assert.equal(gbState.readUInt32LE(0), 10);
    assert.equal(gbState.subarray(4, 19).toString('ascii').replace(/\0+$/, ''), 'POKEMON RED');
    await click('export-battery');
    const gbBatteryFile = path.join(downloadDirectory, 'POKEMON_RED.sa1');
    await waitFor(async () => {
      try { return (await stat(gbBatteryFile)).size > 0; } catch { return false; }
    }, 15000, 'GB battery download');
    assert.equal((await stat(gbBatteryFile)).size, 32768);

    const capture = async (width, height, filename) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width < 600,
      });
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(path.join(buildDirectory, filename), Buffer.from(screenshot.data, 'base64'));
    };
    await capture(1440, 900, 'poc-desktop.png');
    const desktopLayout = await evaluate(`(() => {
      const touch = document.querySelector('.touch-controls').getBoundingClientRect();
      const action = document.querySelector('.action-controls').getBoundingClientRect();
      const face = document.querySelector('.face-buttons').getBoundingClientRect();
      const shoulder = document.querySelector('.shoulder-buttons').getBoundingClientRect();
      return {scrollWidth: document.documentElement.scrollWidth, innerWidth, actionRight: action.right,
        touchRight: touch.right, rowGap: shoulder.top - face.bottom};
    })()`);
    assert.ok(desktopLayout.scrollWidth <= desktopLayout.innerWidth, JSON.stringify(desktopLayout));
    assert.ok(desktopLayout.touchRight - desktopLayout.actionRight < 2, JSON.stringify(desktopLayout));
    assert.ok(desktopLayout.rowGap >= 18, JSON.stringify(desktopLayout));
    await capture(390, 844, 'poc-mobile.png');
    const mobileLayout = await evaluate(`(() => {
      const dpad = document.querySelector('.dpad').getBoundingClientRect();
      const action = document.querySelector('.action-controls').getBoundingClientRect();
      const system = document.querySelector('.system-controls').getBoundingClientRect();
      const quick = document.querySelector('.quick-controls').getBoundingClientRect();
      return {scrollWidth: document.documentElement.scrollWidth, innerWidth, dpadRight: dpad.right,
        actionLeft: action.left, quickTop: quick.top, systemBottom: system.bottom};
    })()`);
    assert.ok(mobileLayout.scrollWidth <= mobileLayout.innerWidth, JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.actionLeft >= mobileLayout.dpadRight, JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.quickTop > mobileLayout.systemBottom, JSON.stringify(mobileLayout));
    await click('menu-toggle');
    const mobileMenu = await evaluate(`(() => {
      const panel = document.getElementById('app-menu-panel').getBoundingClientRect();
      return {left: panel.left, right: panel.right, innerWidth, account: document.getElementById('account-name').innerText};
    })()`);
    assert.ok(mobileMenu.left >= 0 && mobileMenu.right <= mobileMenu.innerWidth, JSON.stringify(mobileMenu));
    assert.equal(mobileMenu.account, 'Browser Admin');
    await capture(390, 844, 'poc-mobile-menu.png');

    const finalState = await evaluate('window.__gbaPoc.diagnostics()');
    const localWebSocketsCreated = await evaluate('window.__localWebSocketCount');
    assert.ok(finalState.activeRom);
    assert.equal(finalState.status, 'Running');
    loaded = cdp.waitEvent('Page.loadEventFired');
    await click('logout');
    await loaded;
    await waitExpression('!document.getElementById("login-view").hidden', 'explicit logout login view');
    assert.equal(
      await evaluate('location.pathname'),
      '/',
    );
    assert.equal(
      await evaluate('location.search'),
      '',
    );
    assert.equal(
      await evaluate('new URL(document.getElementById("login-link").href).searchParams.get("prompt")'),
      null,
    );
    assert.equal(
      await evaluate('fetch("/api/session").then(response => response.json()).then(body => body.authenticated)'),
      false,
    );
    cdp.close();

    console.log(JSON.stringify({
      startup,
      gbStartup,
      speedSteps: { normal: normalSteps, accelerated: speedSteps },
      stateHashes: hashes,
      exportedStateSha256: createHash('sha256').update(await readFile(exported)).digest('hex'),
      accountPersistence: 'passed',
      visitorGate: 'passed',
      roomAndPwClipboard: 'passed',
      local2P: {
        account: dualRunning.localTwoPlayer,
        coresDistinct: dualRunning.coresDistinct,
        realCoreCableProbe,
        progressOver1800ms: dualRunning.players.map((player, index) => ({
          slot: player.slot,
          frames: player.frameCount - dualStart.players[index].frameCount,
          emulationSteps: player.emulationSteps - dualStart.players[index].emulationSteps,
          audioSamples: player.audioSamples - dualStart.players[index].audioSamples,
        })),
        webSocketsCreated: localWebSocketsCreated,
        landscape: localLandscape,
        compactLandscape: localCompactLandscape,
        portrait: localPortrait,
        landscapeRestored: localLandscapeRestored,
      },
      logoutUrlRedirect: 'passed',
      wrongRomRejection: 'passed',
    }));
  } finally {
    await cleanup();
  }
}

await main();
