import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultGamepadMapping,
  detectGamepadInput,
  gamepadControllerKey,
  gamepadMaskForSlot,
} from '../web/player-input.js';

function gamepad(pressed = [], axes = [0, 0]) {
  return {
    id: 'Xbox Wireless Controller',
    mapping: 'standard',
    buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: pressed.includes(index) })),
    axes,
  };
}

test('gamepad indices remain fixed to P1 slot 0 and P2 slot 1', () => {
  const gamepads = [gamepad([0, 4]), gamepad([1, 5])];
  assert.equal(gamepadMaskForSlot(gamepads, 0), 1 | 512);
  assert.equal(gamepadMaskForSlot(gamepads, 1), 2 | 256);
  gamepads[0] = null;
  assert.equal(gamepadMaskForSlot(gamepads, 0), 0);
  assert.equal(gamepadMaskForSlot(gamepads, 1), 2 | 256);
});

test('gamepad directional axes map only within the requested player slot', () => {
  const gamepads = [gamepad([], [-1, 0]), gamepad([], [1, -1])];
  assert.equal(gamepadMaskForSlot(gamepads, 0), 32);
  assert.equal(gamepadMaskForSlot(gamepads, 1), 16 | 64);
});

test('custom mappings replace standard buttons for one controller profile', () => {
  const mapping = createDefaultGamepadMapping();
  mapping.a = [{ type: 'button', index: 3 }];
  mapping.left = [{ type: 'axis', index: 2, direction: -1 }];
  const input = gamepad([0, 3], [0, 0, -1]);
  assert.equal(gamepadMaskForSlot([input], 0, mapping), 1 | 32);
  assert.equal(gamepadControllerKey(input), 'Xbox Wireless Controller|standard|b16|a3');
});

test('mapping capture detects fresh button and axis input only', () => {
  const input = gamepad([4], [0, .9]);
  assert.deepEqual(detectGamepadInput(input, { buttons: [], axes: [0, 0] }), {
    type: 'button', index: 4,
  });
  assert.deepEqual(detectGamepadInput(gamepad([], [0, -.9]), {
    buttons: [], axes: [0, 0],
  }), { type: 'axis', index: 1, direction: -1 });
  assert.equal(detectGamepadInput(input, {
    buttons: Array.from({ length: 16 }, (_, index) => index === 4), axes: [0, .9],
  }), null);
});
