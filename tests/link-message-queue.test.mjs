import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostTransferData,
  isSlaveHandshake,
  LinkMessageQueue,
  MASTER_HANDSHAKE,
  SLAVE_HANDSHAKE,
} from '../web/link-message-queue.js';

test('late cable attachment keeps promoting host handshakes until the game advances', () => {
  assert.equal(hostTransferData(SLAVE_HANDSHAKE), MASTER_HANDSHAKE);
  assert.equal(hostTransferData(SLAVE_HANDSHAKE), MASTER_HANDSHAKE);
  assert.equal(hostTransferData(0, true), MASTER_HANDSHAKE);
  assert.equal(isSlaveHandshake(SLAVE_HANDSHAKE), true);
  assert.equal(isSlaveHandshake(0), false);
  assert.equal(hostTransferData(0x1234), 0x1234);
});

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
  queue.enqueueOffer({ type: 'link-offer', sequence: 2, speed: 3, data: 0x1234, ticks: 8520 });
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 1);
  assert.deepEqual(state.prepared, []);

  state.sequence = 2;
  state.active = false;
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 0);
  assert.deepEqual(state.prepared, [[2, 3, 0x1234, 8520]]);
  assert.deepEqual(state.responses, [{
    type: 'link-response', sequence: 2, speed: 3, data: 0xabcd, ticks: 8520,
  }]);
});

test('pair waits behind an active transfer and applies without being discarded', () => {
  const queue = new LinkMessageQueue();
  const state = {
    sequence: 2, active: true, slaveData: 0xabcd,
    prepared: [], responses: [], applied: [], completed: [],
  };
  queue.enqueuePair({
    type: 'link-pair', sequence: 2, speed: 3, ticks: 8520, masterData: 0x1234, slaveData: 0xabcd,
  });
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingPairs, 1);

  state.active = false;
  assert.equal(queue.drain(adapter(state)), true);
  assert.equal(queue.pendingPairs, 0);
  assert.deepEqual(state.applied, [[2, 3, 0x1234, 0xabcd]]);
  assert.deepEqual(state.completed, [2]);
});

test('guest does not submit a duplicate response when the pair arrives', () => {
  const queue = new LinkMessageQueue();
  const state = {
    sequence: 4, active: false, slaveData: 0xabcd,
    prepared: [], responses: [], applied: [], completed: [],
  };
  queue.enqueueOffer({ type: 'link-offer', sequence: 4, speed: 3, data: 0x1234, ticks: 6044 });
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(state.responses.length, 1);
  assert.equal(queue.preparedResponses, 1);

  queue.enqueuePair({
    type: 'link-pair', sequence: 4, speed: 3, ticks: 6044, masterData: 0x1234, slaveData: 0xabcd,
  });
  assert.equal(queue.drain(adapter(state)), true);
  assert.equal(state.responses.length, 1);
  assert.equal(queue.preparedResponses, 0);
});

test('stale offers and pairs are pruned after the core advances', () => {
  const queue = new LinkMessageQueue();
  queue.enqueueOffer({ sequence: 1, speed: 3, data: 1, ticks: 6044 });
  queue.enqueuePair({ sequence: 1, speed: 3, ticks: 6044, masterData: 1, slaveData: 2 });
  const state = {
    sequence: 2, active: false, slaveData: 0,
    prepared: [], responses: [], applied: [], completed: [],
  };
  assert.equal(queue.drain(adapter(state)), false);
  assert.equal(queue.pendingOffers, 0);
  assert.equal(queue.pendingPairs, 0);
  assert.equal(queue.preparedResponses, 0);
});
