export const GAMEPAD_ACTIONS = Object.freeze([
  { key: 'a', label: 'A', mask: 1, bindings: [{ type: 'button', index: 0 }] },
  { key: 'b', label: 'B', mask: 2, bindings: [{ type: 'button', index: 1 }] },
  { key: 'select', label: 'Select', mask: 4, bindings: [{ type: 'button', index: 8 }] },
  { key: 'start', label: 'Start', mask: 8, bindings: [{ type: 'button', index: 9 }] },
  { key: 'right', label: 'Right', mask: 16, bindings: [
    { type: 'button', index: 15 }, { type: 'axis', index: 0, direction: 1 },
  ] },
  { key: 'left', label: 'Left', mask: 32, bindings: [
    { type: 'button', index: 14 }, { type: 'axis', index: 0, direction: -1 },
  ] },
  { key: 'up', label: 'Up', mask: 64, bindings: [
    { type: 'button', index: 12 }, { type: 'axis', index: 1, direction: -1 },
  ] },
  { key: 'down', label: 'Down', mask: 128, bindings: [
    { type: 'button', index: 13 }, { type: 'axis', index: 1, direction: 1 },
  ] },
  { key: 'r', label: 'R', mask: 256, bindings: [{ type: 'button', index: 5 }] },
  { key: 'l', label: 'L', mask: 512, bindings: [{ type: 'button', index: 4 }] },
]);

export function createDefaultGamepadMapping() {
  return Object.fromEntries(GAMEPAD_ACTIONS.map((action) => [
    action.key, action.bindings.map((binding) => ({ ...binding })),
  ]));
}

export function gamepadControllerKey(gamepad) {
  if (!gamepad) return '';
  return [
    String(gamepad.id || 'Unknown gamepad').trim(),
    String(gamepad.mapping || 'raw').trim(),
    `b${gamepad.buttons?.length ?? 0}`,
    `a${gamepad.axes?.length ?? 0}`,
  ].join('|').slice(0, 255);
}

export function gamepadBindingLabel(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) return '-';
  return bindings.map((binding) => binding.type === 'axis'
    ? `Axis ${binding.index} ${binding.direction < 0 ? '-' : '+'}`
    : `Button ${binding.index}`).join(' / ');
}

export function gamepadInputSnapshot(gamepad) {
  return {
    buttons: Array.from(gamepad?.buttons || [], (button) => Boolean(button?.pressed || button?.value > .5)),
    axes: Array.from(gamepad?.axes || [], (value) => Number(value) || 0),
  };
}

export function detectGamepadInput(gamepad, baseline = { buttons: [], axes: [] }) {
  if (!gamepad) return null;
  for (let index = 0; index < gamepad.buttons.length; index += 1) {
    const pressed = Boolean(gamepad.buttons[index]?.pressed || gamepad.buttons[index]?.value > .5);
    if (pressed && !baseline.buttons[index]) return { type: 'button', index };
  }
  for (let index = 0; index < gamepad.axes.length; index += 1) {
    const value = Number(gamepad.axes[index]) || 0;
    if (Math.abs(value) > .65 && Math.abs(baseline.axes[index] || 0) < .35) {
      return { type: 'axis', index, direction: value < 0 ? -1 : 1 };
    }
  }
  return null;
}

function bindingPressed(gamepad, binding) {
  if (binding?.type === 'button') {
    const button = gamepad.buttons[binding.index];
    return Boolean(button?.pressed || button?.value > .5);
  }
  if (binding?.type === 'axis') {
    const value = Number(gamepad.axes[binding.index]) || 0;
    return binding.direction < 0 ? value < -.5 : value > .5;
  }
  return false;
}

export function gamepadMaskForSlot(gamepads, slot, mapping = null) {
  const gamepad = gamepads?.[slot];
  if (!gamepad) return 0;
  let mask = 0;
  for (const action of GAMEPAD_ACTIONS) {
    const bindings = Array.isArray(mapping?.[action.key]) ? mapping[action.key] : action.bindings;
    if (bindings.some((binding) => bindingPressed(gamepad, binding))) mask |= action.mask;
  }
  return mask;
}
