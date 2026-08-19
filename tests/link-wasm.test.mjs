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

