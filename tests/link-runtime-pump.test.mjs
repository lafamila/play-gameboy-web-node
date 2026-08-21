import assert from 'node:assert/strict';
import test from 'node:test';

import { pumpLinkRuntime } from '../web/link-runtime-pump.js';

function adapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      drain: () => calls.push('drain'),
      waiting: () => false,
      guestHeld: () => false,
      run: () => { calls.push('run'); return 1; },
      offer: () => calls.push('offer'),
      release: () => calls.push('release'),
      ...overrides,
    },
  };
}

test('shared link pump drains, runs, drains, and releases in room order', () => {
  const subject = adapter();
  assert.equal(pumpLinkRuntime(subject.value), 1);
  assert.deepEqual(subject.calls, ['drain', 'run', 'drain', 'release']);
});

test('shared link pump offers and stops when the core is waiting', () => {
  const subject = adapter({ waiting: () => true });
  assert.equal(pumpLinkRuntime(subject.value), 2);
  assert.deepEqual(subject.calls, ['drain', 'offer']);
});

test('shared link pump forwards a newly blocked core request before returning', () => {
  const subject = adapter({
    run: () => { subject.calls.push('run'); return 2; },
  });
  assert.equal(pumpLinkRuntime(subject.value), 2);
  assert.deepEqual(subject.calls, ['drain', 'run', 'offer', 'drain', 'release']);
});

test('shared link pump does not advance a held guest', () => {
  const subject = adapter({ guestHeld: () => true });
  assert.equal(pumpLinkRuntime(subject.value), 2);
  assert.deepEqual(subject.calls, ['drain']);
});
