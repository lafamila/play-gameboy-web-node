import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');

async function fixtureFiles(extension) {
  return (await readdir(DATA))
    .filter((filename) => path.extname(filename).toLowerCase() === extension)
    .sort();
}

test('provided ROM and VBA Link states are a matching v8 fixture set', async () => {
  const romFilename = (await fixtureFiles('.gba'))[0];
  assert.ok(romFilename, 'GBA fixture is missing');
  const rom = await readFile(path.join(DATA, romFilename));
  assert.equal(rom.length, 16 * 1024 * 1024);
  const romIdentity = rom.subarray(0xa0, 0xb0).toString('ascii');
  assert.equal(romIdentity, 'POKEMON FIREBPRE');

  const stateFilenames = await fixtureFiles('.sg1');
  assert.equal(stateFilenames.length, 3);
  const hashes = new Set();
  for (const filename of stateFilenames) {
    const compressed = await readFile(path.join(DATA, filename));
    const raw = gunzipSync(compressed);
    assert.equal(raw.length, 739838, filename);
    assert.equal(raw.readUInt32LE(0), 8, filename);
    assert.equal(raw.subarray(4, 20).toString('ascii'), romIdentity, filename);
    assert.equal(raw.readUInt32LE(20), 0, filename);
    hashes.add(createHash('sha256').update(compressed).digest('hex'));
  }
  assert.equal(hashes.size, 3, 'quick state fixtures must be distinct');
});

test('provided battery save has the expected Flash 128K shape', async () => {
  const batteryFilename = (await fixtureFiles('.sa1'))[0];
  assert.ok(batteryFilename, 'SA1 fixture is missing');
  const battery = await readFile(path.join(DATA, batteryFilename));
  assert.equal(battery.length, 131072);
  assert.ok(battery.some((byte) => byte !== 0), 'battery fixture is empty');
});

test('root Red_K fixture is a GB MBC5 battery ROM', async () => {
  const rom = await readFile(path.join(ROOT, 'Red_K.gb'));
  assert.equal(rom.length, 1024 * 1024);
  assert.equal(rom.subarray(0x134, 0x143).toString('ascii').replace(/\0+$/, ''), 'POKEMON RED');
  assert.equal(rom[0x147], 0x1b);
  assert.equal(rom[0x149], 0x03);
});

test('built WebAssembly artifacts are present', async () => {
  const javascript = await readFile(path.join(ROOT, 'core', 'dist', 'vba172.js'));
  const wasm = await readFile(path.join(ROOT, 'core', 'dist', 'vba172.wasm'));
  assert.ok(javascript.length > 1000);
  assert.ok(wasm.length > 100000);
  assert.equal(Buffer.from(wasm.subarray(0, 4)).toString('hex'), '0061736d');
});
