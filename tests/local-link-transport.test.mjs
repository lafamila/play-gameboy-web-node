import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDirectCablePair,
  directCableIdle,
  guestCableResponsePending,
  releaseDirectCableGuest,
} from '../web/local-link-transport.js';

function corePair() {
  const applied = [];
  let guestHeld = false;
  let hostPending = true;
  const host = {
    _vba_link_request_pending: () => hostPending,
    _vba_link_request_sequence: () => 7,
    _vba_link_request_data: () => 0x1234,
    _vba_link_request_speed: () => 3,
    _vba_link_request_ticks: () => 400,
    _vba_link_apply_pair: (...pair) => { applied.push(['host', ...pair]); hostPending = false; return 1; },
    _vba_link_waiting: () => false,
    _vba_link_transfer_active: () => false,
    _vba_link_siocnt: () => 0,
  };
  const guest = {
    _vba_link_prepare_remote: (...offer) => {
      assert.deepEqual(offer, [7, 3, 0x1234, 400]);
      guestHeld = true;
      return 0xabcd;
    },
    _vba_link_apply_pair: (...pair) => { applied.push(['guest', ...pair]); return 1; },
    _vba_link_guest_held: () => guestHeld,
    _vba_link_waiting: () => false,
    _vba_link_transfer_active: () => false,
    _vba_link_request_pending: () => false,
    _vba_link_cancel_wait: () => { guestHeld = false; },
  };
  return { host, guest, applied, guestHeld: () => guestHeld };
}

test('direct in-page transport applies one deterministic cable pair to both cores', () => {
  const { host, guest, applied } = corePair();
  const result = applyDirectCablePair(host, guest, {
    lastPairSequence: -1,
    guestHandshakePending: false,
  });
  assert.equal(result.applied, true);
  assert.equal(result.lastPairSequence, 7);
  assert.deepEqual(applied, [
    ['host', 7, 3, 0x1234, 0xabcd],
    ['guest', 7, 3, 0x1234, 0xabcd],
  ]);
  const duplicate = applyDirectCablePair(host, guest, result);
  assert.equal(duplicate.applied, false);
  assert.equal(applied.length, 2);
});

test('direct transport releases a held guest once and reports pair-wide idle state', () => {
  const pair = corePair();
  applyDirectCablePair(pair.host, pair.guest, {
    lastPairSequence: -1, guestHandshakePending: false,
  });
  assert.equal(pair.guestHeld(), true);
  const released = releaseDirectCableGuest(pair.host, pair.guest, -1);
  assert.deepEqual(released, { released: true, lastReleaseSequence: 7 });
  assert.equal(pair.guestHeld(), false);
  assert.equal(directCableIdle([{ core: pair.host }, { core: pair.guest }]), true);
});

test('guest response timing keeps its pump alive across a completed video frame', () => {
  const host = {
    _vba_link_request_pending: () => true,
    _vba_link_request_sequence: () => 5172,
  };
  const guest = {
    _vba_link_request_sequence: () => 5172,
    _vba_link_waiting: () => false,
    _vba_link_transfer_active: () => false,
    _vba_link_guest_held: () => false,
  };
  assert.equal(guestCableResponsePending(host, guest), true);
  guest._vba_link_waiting = () => true;
  assert.equal(guestCableResponsePending(host, guest), false);
  guest._vba_link_waiting = () => false;
  guest._vba_link_request_sequence = () => 5171;
  assert.equal(guestCableResponsePending(host, guest), false);
});
