import assert from 'node:assert/strict';
import test from 'node:test';

import { LinkMessageQueue } from '../web/link-message-queue.js';

function adapter(state) {
  return {
    slot: 1,
    currentSequence: () => state.sequence,
    transferActive: () => state.active,
    prepareRemote: (...args) => {
      state.prepared.push(args);
      return state.slaveData;
    },
    sendResponse: (message) => {
      state.responses.push(message);
      return true;
    },
    applyPair: (...args) => {
      state.applied.push(args);
      state.active = true;
      return true;
    },
    onPairApplied: (pair) => state.completed.push(pair.sequence),
  };
}

test('offer waits while the previous transfer is active and runs at its sequence boundary', () => {
  const queue = new LinkMessageQueue();
  const state = {
    sequence: 1, active: true, slaveData: 0xabcd,
    prepared: [], responses: [], applied: [], completed: [],
  };
  queue.enqueueOffer({ type: 'link-offer', sequence: 2, speed: 3, data: 0x1234 });
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 1);
  assert.deepEqual(state.prepared, []);

  state.sequence = 2;
  state.active = false;
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 0);
  assert.deepEqual(state.prepared, [[2, 3, 0x1234]]);
  assert.deepEqual(state.responses, [{
    type: 'link-response', sequence: 2, speed: 3, data: 0xabcd,
  }]);
});

test('pair waits behind an active transfer and applies without being discarded', () => {
  const queue = new LinkMessageQueue();
  const state = {
    sequence: 2, active: true, slaveData: 0xabcd,
    prepared: [], responses: [], applied: [], completed: [],
  };
  queue.enqueuePair({
    type: 'link-pair', sequence: 2, speed: 3, masterData: 0x1234, slaveData: 0xabcd,
  });
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingPairs, 1);

  state.active = false;
  assert.equal(queue.drain(adapter(state)), true);
  assert.equal(queue.pendingPairs, 0);
  assert.deepEqual(state.applied, [[2, 3, 0x1234, 0xabcd]]);
  assert.deepEqual(state.completed, [2]);
});

test('stale offers and pairs are pruned after the core advances', () => {
  const queue = new LinkMessageQueue();
  queue.enqueueOffer({ sequence: 1, speed: 3, data: 1 });
  queue.enqueuePair({ sequence: 1, speed: 3, masterData: 1, slaveData: 2 });
  const state = {
    sequence: 2, active: false, slaveData: 0,
    prepared: [], responses: [], applied: [], completed: [],
  };
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 0);
  assert.equal(queue.pendingPairs, 0);
});

