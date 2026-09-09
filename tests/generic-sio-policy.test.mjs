import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('production cable transport contains no ROM or payload-specific branches', async () => {
  const files = [
    'core/vba172_link.cpp',
    'web/link-message-queue.js',
    'web/local-link-transport.js',
    'lib/link-room.mjs',
    'lib/link-service.mjs',
  ];
  const source = (await Promise.all(files.map((file) =>
    readFile(path.join(ROOT, file), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /BPRE|BPGE|AXVE|AXPE|Pokemon|FireRed|LeafGreen/i);
});

test('PWA shell includes the clean-room multiboot receiver', async () => {
  const worker = await readFile(path.join(ROOT, 'web/service-worker.js'), 'utf8');
  assert.match(worker, /['"]\/multiboot-client\.js['"]/);
});
