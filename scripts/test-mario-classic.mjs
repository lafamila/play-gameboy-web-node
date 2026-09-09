import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import createVbaModule from '../core/dist/vba172.js';
import { applyDirectSioTransfer, synchronizeDirectCableState } from '../web/local-link-transport.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const romDirectory = path.join(ROOT, 'roms');
const romFiles = await readdir(romDirectory).catch(() => []);
let rom;
for (const filename of romFiles.filter((item) => item.endsWith('.gba'))) {
  const candidate = await readFile(path.join(romDirectory, filename));
  if (candidate.subarray(0xac, 0xb0).toString('ascii') === 'AX4E') {
    rom = candidate;
    break;
  }
}
if (!rom) {
  console.log('Mario Classic regression skipped (AX4E ROM fixture unavailable)');
  process.exit(0);
}

const wasm = await readFile(path.join(ROOT, 'core', 'dist', 'vba172.wasm'));
const cores = [];
for (let slot = 0; slot < 2; slot += 1) {
  const core = await createVbaModule({ wasmBinary: wasm });
  const pointer = core._malloc(rom.length);
  try {
    core.HEAPU8.set(rom, pointer);
    assert.equal(core._vba_load_rom(pointer, rom.length, 0), 1);
  } finally {
    core._free(pointer);
  }
  cores.push(core);
}

const run = (core, frames, mask = 0) => {
  core._vba_set_joypad(mask);
  for (let index = 0; index < frames; index += 1) core._vba_run_frame();
};
for (const core of cores) {
  run(core, 1200);
  run(core, 3, 1);
  run(core, 1000);
  run(core, 3, 8);
  run(core, 100);
}

assert.equal(cores[0]._vba_link_set_player(0), 1);
assert.equal(cores[1]._vba_link_set_player(1), 1);
let lastPairSequence = -1;
let pairCount = 0;
const exchange = () => {
  const result = applyDirectSioTransfer(cores, { lastPairSequence });
  if (!result.applied) return false;
  lastPairSequence = result.lastPairSequence;
  pairCount += 1;
  return true;
};
const frameStep = (masks = [0, 0]) => {
  synchronizeDirectCableState(cores[0], cores[1]);
  for (let slot = 0; slot < 2; slot += 1) {
    const core = cores[slot];
    core._vba_set_joypad(masks[slot]);
    if (!core._vba_link_waiting()) core._vba_run_frame();
    exchange();
  }
};
const frameSteps = (count, masks = [0, 0]) => {
  for (let index = 0; index < count; index += 1) frameStep(masks);
};
const press = (slot, mask) => {
  const masks = [0, 0];
  masks[slot] = mask;
  frameSteps(3, masks);
  frameSteps(10);
};

press(0, 16);
press(1, 16);
press(0, 8);
press(1, 8);
frameSteps(600);
press(0, 8);
press(1, 8);
frameSteps(600);
press(1, 8);
press(0, 1);
frameSteps(1200);
frameSteps(3, [8, 8]);
frameSteps(1200);

const frameHash = (core) => {
  const pointer = core._vba_framebuffer();
  const stride = core._vba_frame_stride();
  let hash = 2166136261;
  for (let y = 0; y < 160; y += 1) {
    for (let x = 0; x < 240 * 4; x += 1) {
      hash ^= core.HEAPU8[pointer + y * stride * 4 + x];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return hash;
};
const titleHashes = cores.map(frameHash);
const beforeFrames = cores.map((core) => Number(core._vba_frame_counter()));
const beforePairs = pairCount;

frameSteps(3, [8, 8]);
for (let frame = 0; frame < 180; frame += 1) {
  for (let slice = 0; slice < 69; slice += 1) {
    exchange();
    for (const core of cores) {
      core._vba_set_joypad(0);
      if (!core._vba_link_waiting()) core._vba_run_cycles(4096);
      exchange();
    }
  }
}

const deltas = cores.map((core, slot) => Number(core._vba_frame_counter()) - beforeFrames[slot]);
assert.ok(deltas.every((value) => value >= 150 && value <= 210), `frame deltas ${deltas}`);
assert.ok(Math.abs(deltas[0] - deltas[1]) <= 1, `frame drift ${deltas}`);
assert.ok(pairCount - beforePairs > 500, `pair count ${pairCount - beforePairs}`);
assert.notDeepEqual(cores.map(frameHash), titleHashes);
for (const core of cores) core._vba_shutdown();
console.log(JSON.stringify({ marioClassic: 'passed', frameDeltas: deltas,
  sioPairs: pairCount - beforePairs }));
