import assert from 'node:assert/strict';
import test from 'node:test';

import { gamepadMaskForSlot } from '../web/player-input.js';

function gamepad(pressed = [], axes = [0, 0]) {
  return {
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
