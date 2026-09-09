import assert from 'node:assert/strict';
import test from 'node:test';

import { LinkMessageQueue } from '../web/link-message-queue.js';

function envelope(overrides = {}) {
  return {
    sequence: 2,
    mode: 1,
    bits: 32,
    speed: 1,
    initiatorSlot: 1,
    data: 0x89abcdef,
    ticks: 2048,
    ...overrides,
  };
}

function adapter(state) {
  return {
    slot: state.slot,
    currentSequence: () => state.sequence,
    transferActive: () => state.active,
    prepareRemote: (offer) => {
      state.prepared.push(offer);
      return state.prepareStatus;
    },
    responseData: () => state.responseData,
    sendResponse: (message) => {
      state.responses.push(message);
      return true;
    },
    applyTransfer: (pair) => {
      state.applied.push(pair);
      state.active = true;
      return true;
    },
    onPairApplied: (pair) => state.completed.push(pair.sequence),
  };
}

test('a Normal32 offer waits for the responder core and preserves unsigned data', () => {
  const queue = new LinkMessageQueue();
  const state = {
    slot: 0, sequence: 2, active: false, prepareStatus: 0,
    responseData: 0xfedcba98, prepared: [], responses: [], applied: [], completed: [],
  };
  const offer = { type: 'sio-offer', ...envelope() };
  queue.enqueueOffer(offer);
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 1);
  assert.equal(state.responses.length, 0);

  state.prepareStatus = 1;
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 0);
  assert.deepEqual(state.responses, [{
    type: 'sio-response', ...envelope({ data: 0xfedcba98 }),
  }]);

  queue.enqueueOffer(offer);
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(state.responses.length, 2);
  assert.deepEqual(state.responses[1], state.responses[0]);
});

test('a completed SIO pair waits behind an active core and applies once', () => {
  const queue = new LinkMessageQueue();
  const state = {
    slot: 0, sequence: 2, active: true, prepareStatus: 1,
    responseData: 0, prepared: [], responses: [], applied: [], completed: [],
  };
  const pair = {
    type: 'sio-pair', ...envelope(), dataBySlot: [0xfedcba98, 0x89abcdef],
  };
  delete pair.data;
  queue.enqueuePair(pair);
  assert.equal(queue.drain(adapter(state)), false);
  state.active = false;
  assert.equal(queue.drain(adapter(state)), true);
  assert.deepEqual(state.applied, [pair]);
  assert.deepEqual(state.completed, [2]);
  assert.equal(queue.drain(adapter(state)), false);
});

test('the initiator never responds to its own offer and stale envelopes are pruned', () => {
  const queue = new LinkMessageQueue();
  const state = {
    slot: 1, sequence: 2, active: false, prepareStatus: 1,
    responseData: 0, prepared: [], responses: [], applied: [], completed: [],
  };
  queue.enqueueOffer({ type: 'sio-offer', ...envelope() });
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(state.prepared.length, 0);
  queue.enqueueOffer({ type: 'sio-offer', ...envelope({ sequence: 1 }) });
  state.sequence = 3;
  queue.drain(adapter(state));
  assert.equal(queue.pendingOffers, 0);
});
