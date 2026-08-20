export function gamepadMaskForSlot(gamepads, slot) {
  const gamepad = gamepads?.[slot];
  if (!gamepad) return 0;
  let mask = 0;
  if (gamepad.buttons[0]?.pressed) mask |= 1;
  if (gamepad.buttons[1]?.pressed) mask |= 2;
  if (gamepad.buttons[8]?.pressed) mask |= 4;
  if (gamepad.buttons[9]?.pressed) mask |= 8;
  if (gamepad.buttons[15]?.pressed || gamepad.axes[0] > .5) mask |= 16;
  if (gamepad.buttons[14]?.pressed || gamepad.axes[0] < -.5) mask |= 32;
  if (gamepad.buttons[12]?.pressed || gamepad.axes[1] < -.5) mask |= 64;
  if (gamepad.buttons[13]?.pressed || gamepad.axes[1] > .5) mask |= 128;
  if (gamepad.buttons[5]?.pressed) mask |= 256;
  if (gamepad.buttons[4]?.pressed) mask |= 512;
  return mask;
}
