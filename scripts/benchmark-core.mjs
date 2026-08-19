import { performance } from 'node:perf_hooks';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import createVbaModule from '../core/dist/vba172.js';

const root = path.resolve(import.meta.dirname, '..');
const wasmBinary = await readFile(path.join(root, 'core', 'dist', 'vba172.wasm'));
const romFilename = (await readdir(path.join(root, 'data'))).find((name) => name.endsWith('.gba'));
const rom = await readFile(path.join(root, 'data', romFilename));

const started = performance.now();
const core = await createVbaModule({ wasmBinary, printErr: console.error });
const initialized = performance.now();
const pointer = core._malloc(rom.length);
core.HEAPU8.set(rom, pointer);
const loaded = core._vba_load_rom(pointer, rom.length, 0);
core._free(pointer);
const romLoaded = performance.now();
if (!loaded) throw new Error(core.UTF8ToString(core._vba_last_error()));

const frames = 10;
for (let index = 0; index < frames; ++index) core._vba_run_frame();
const completed = performance.now();

console.log(JSON.stringify({
  moduleMs: Math.round(initialized - started),
  romLoadMs: Math.round(romLoaded - initialized),
  frameMs: Number(((completed - romLoaded) / frames).toFixed(2)),
  frames: Number(core._vba_frame_counter()),
  audioSamples: Number(core._vba_audio_total_samples()),
}));
