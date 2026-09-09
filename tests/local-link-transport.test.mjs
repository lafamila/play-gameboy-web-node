import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDirectSioTransfer,
  pendingSioOffer,
  synchronizeDirectCableState,
} from '../web/local-link-transport.js';

function core(slot, overrides = {}) {
  const state = {
    mode: 2,
    siocnt: slot === 0 ? 0x600b : 0x601f,
    rcnt: slot === 0 ? 0x000b : 0x000f,
    epoch: 1,
    sequence: 0,
    pending: slot === 0,
    waiting: slot === 0,
    active: false,
    requestMode: 2,
    requestBits: 16,
    requestSpeed: 3,
    requestInitiator: slot,
    requestData: slot === 0 ? 0x1234 : 0xabcd,
    responseData: slot === 0 ? 0x1234 : 0xabcd,
    prepareStatus: 1,
    peerStates: [],
    applied: [],
    ...overrides,
  };
  return {
    state,
    _vba_link_mode: () => state.mode,
    _vba_link_siocnt: () => state.siocnt,
    _vba_link_rcnt: () => state.rcnt,
    _vba_link_state_epoch: () => state.epoch,
    _vba_link_set_peer_state: (...values) => { state.peerStates.push(values); return 1; },
    _vba_link_request_pending: () => state.pending ? 1 : 0,
    _vba_link_request_sequence: () => state.sequence,
    _vba_link_request_mode: () => state.requestMode,
    _vba_link_request_bits: () => state.requestBits,
    _vba_link_request_speed: () => state.requestSpeed,
    _vba_link_request_initiator: () => state.requestInitiator,
    _vba_link_request_data: () => state.requestData,
    _vba_link_request_ticks: () => 400,
    _vba_link_prepare_remote: (...values) => { state.prepared = values; return state.prepareStatus; },
    _vba_link_response_data: () => state.responseData,
    _vba_link_apply_transfer: (...values) => {
      state.applied.push(values);
      state.pending = false;
      state.waiting = false;
      state.active = true;
      return 1;
    },
    _vba_link_waiting: () => state.waiting ? 1 : 0,
    _vba_link_transfer_active: () => state.active ? 1 : 0,
  };
}

test('direct cable state resolves each peer from one atomic snapshot', () => {
  const first = core(0);
  const second = core(1);
  assert.deepEqual(synchronizeDirectCableState(first, second), [
    { mode: 2, siocnt: 0x600b, rcnt: 0x000b, epoch: 1 },
    { mode: 2, siocnt: 0x601f, rcnt: 0x000f, epoch: 1 },
  ]);
  assert.deepEqual(first.state.peerStates, [[2, 0x601f, 0x000f]]);
  assert.deepEqual(second.state.peerStates, [[2, 0x600b, 0x000b]]);
});

test('slot 0 applies one generic Multiplayer transfer to both cores', () => {
  const first = core(0);
  const second = core(1);
  const result = applyDirectSioTransfer([first, second], { lastPairSequence: -1 });
  assert.equal(result.applied, true);
  assert.deepEqual(result.dataBySlot, [0x1234, 0xabcd]);
  assert.deepEqual(second.state.prepared, [0, 2, 16, 3, 0, 0x1234, 400]);
  assert.deepEqual(first.state.applied[0], [0, 2, 16, 3, 0, 0x1234, 0xabcd]);
  assert.deepEqual(second.state.applied[0], first.state.applied[0]);
  assert.equal(applyDirectSioTransfer([first, second], result).applied, false);
});

test('slot 1 can initiate a full-width Normal32 transfer', () => {
  const first = core(0, {
    mode: 1, pending: false, waiting: true, requestMode: 1, requestBits: 32,
    responseData: 0xfedcba98,
  });
  const second = core(1, {
    mode: 1, pending: true, waiting: true, requestMode: 1, requestBits: 32,
    requestSpeed: 1, requestInitiator: 1, requestData: 0x89abcdef,
  });
  const result = applyDirectSioTransfer([first, second], { lastPairSequence: -1 });
  assert.equal(result.applied, true);
  assert.equal(result.initiatorSlot, 1);
  assert.deepEqual(result.dataBySlot, [0xfedcba98, 0x89abcdef]);
  assert.deepEqual(first.state.applied[0], [0, 1, 32, 1, 1, 0xfedcba98, 0x89abcdef]);
});

test('pending offers preserve mode-neutral transfer data', () => {
  const first = core(0);
  assert.equal(pendingSioOffer(first).data, 0x1234);
});
