import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import createVbaModule from '../core/dist/vba172.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('WebAssembly exposes the two-slot VBA Link transport contract', async () => {
  const wasmBinary = await readFile(path.join(ROOT, 'core', 'dist', 'vba172.wasm'));
  const romName = (await readdir(path.join(ROOT, 'data'))).find((name) => name.endsWith('.gba'));
  const rom = await readFile(path.join(ROOT, 'data', romName));
  const core = await createVbaModule({ wasmBinary });
  const pointer = core._malloc(rom.length);
  try {
    core.HEAPU8.set(rom, pointer);
    assert.equal(core._vba_load_rom(pointer, rom.length, 0), 1);
  } finally {
    core._free(pointer);
  }
  assert.equal(core._vba_link_set_player(0), 1);
  assert.equal(core._vba_link_player(), 0);
  assert.equal(core._vba_link_waiting(), 0);
  assert.equal(core._vba_link_transfer_active(), 0);
  assert.equal(core._vba_link_set_player(1), 1);
  assert.equal(core._vba_link_player(), 1);
  assert.equal(core._vba_link_set_player(-1), 1);
  core._vba_shutdown();
});

test('external VBA state audio quality is normalized to the web 44.1kHz contract', async () => {
  const wasmBinary = await readFile(path.join(ROOT, 'core', 'dist', 'vba172.wasm'));
  const dataFiles = await readdir(path.join(ROOT, 'data'));
  const rom = await readFile(path.join(ROOT, 'data', dataFiles.find((name) => name.endsWith('.gba'))));
  const state = await readFile(path.join(ROOT, 'data', dataFiles.find((name) => name.endsWith('1.sg1'))));
  const core = await createVbaModule({ wasmBinary });
  const withBytes = (bytes, action) => {
    const pointer = core._malloc(bytes.length);
    try {
      core.HEAPU8.set(bytes, pointer);
      return action(pointer, bytes.length);
    } finally {
      core._free(pointer);
    }
  };
  assert.equal(withBytes(rom, (pointer, size) => core._vba_load_rom(pointer, size, 0)), 1);
  assert.equal(withBytes(state, (pointer, size) => core._vba_load_state(pointer, size)), 1);
  assert.equal(core._vba_state_audio_quality(), 2);
  assert.equal(core._vba_audio_quality(), 1);
  core._vba_shutdown();
});
