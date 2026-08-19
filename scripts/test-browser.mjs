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
const profileDirectory = path.join(os.tmpdir(), `gbc-porting-chrome-${process.pid}`);
const uploadDirectory = path.join(os.tmpdir(), `gbc-porting-roms-${process.pid}`);

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
      body: JSON.stringify({accountId: 'browser-admin', permission: 'superadmin', name: 'Browser Admin'})
    }).then(response => response.ok)`, true);
    loaded = cdp.waitEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: origin });
    await loaded;
    await waitExpression('document.getElementById("event-log").innerText.includes("Catalog ready")', 'catalog');
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

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 1', 'A button keydown');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    });
    await waitExpression('window.__gbaPoc.diagnostics().inputMask === 0', 'A button keyup');

    await click('pause');
    const hashes = [];
    for (let index = 1; index <= 3; ++index) {
      await evaluate(`document.querySelectorAll('#fixture-list button')[${index}].click()`, true);
      await waitExpression(`document.getElementById('event-log').innerText.includes('${index}.sg1')`, `fixture ${index}`);
      hashes.push((await evaluate('window.__gbaPoc.diagnostics()')).pixelHash);
    }
    assert.equal(new Set(hashes).size, 3, `State canvas hashes: ${hashes.join(', ')}`);

    await click('quick-save');
    await waitExpression('document.getElementById("quick-state-meta").innerText.includes("Account state")', 'account state');
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    const normalSteps = (await evaluate('window.__gbaPoc.diagnostics()')).emulationSteps - normalStart;
    await click('speed-toggle');
    assert.equal(await evaluate('document.getElementById("speed-toggle").getAttribute("aria-pressed")'), 'true');
    const speedStart = (await evaluate('window.__gbaPoc.diagnostics()')).emulationSteps;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const speedSteps = (await evaluate('window.__gbaPoc.diagnostics()')).emulationSteps - speedStart;
    assert.ok(speedSteps > normalSteps * 2, `normal=${normalSteps}, speed=${speedSteps}`);
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
    await capture(390, 844, 'poc-mobile.png');

    const finalState = await evaluate('window.__gbaPoc.diagnostics()');
    assert.ok(finalState.activeRom);
    assert.equal(finalState.status, 'Running');
    await click('logout');
    await waitExpression('!document.getElementById("login-view").hidden', 'explicit logout login view');
    assert.equal(
      await evaluate('new URL(document.getElementById("login-link").href).searchParams.get("prompt")'),
      'login',
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
      explicitLogoutForcesLogin: 'passed',
      wrongRomRejection: 'passed',
    }));
  } finally {
    await cleanup();
  }
}

await main();
