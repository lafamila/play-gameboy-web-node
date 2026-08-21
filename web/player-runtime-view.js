const BUTTON_LABELS = new Map([
  ['64', 'up'],
  ['32', 'left'],
  ['16', 'right'],
  ['128', 'down'],
  ['4', 'select'],
  ['8', 'start'],
  ['2', 'B'],
  ['1', 'A'],
  ['512', 'L'],
  ['256', 'R'],
]);

export function mountPlayerRuntime({
  template,
  target,
  player,
  ids,
  keymap,
  muted = false,
  cableStart = false,
}) {
  const fragment = template.content.cloneNode(true);
  const root = fragment.querySelector('[data-player-runtime]');
  root.dataset.playerRuntime = String(player);
  root.dataset.player = String(player);

  for (const [role, id] of Object.entries(ids)) {
    const element = root.querySelector(`[data-runtime-role="${role}"]`);
    if (!element) throw new Error(`Missing player runtime role: ${role}`);
    element.id = id;
  }

  const screen = root.querySelector('[data-runtime-role="screen"]');
  screen.setAttribute('aria-label', `Player ${player} game screen`);
  root.querySelector('[data-runtime-role="touch-controls"]')
    .setAttribute('aria-label', `Player ${player} game controls`);

  for (const button of root.querySelectorAll('[data-button]')) {
    button.dataset.player = String(player);
    button.setAttribute('aria-label', `Player ${player} ${BUTTON_LABELS.get(button.dataset.button)}`);
  }

  root.querySelector('[data-runtime-role="mute"]').textContent = muted ? 'Unmute' : 'Mute';
  root.querySelector('[data-runtime-role="ready"]').textContent = `P${player} Ready`;
  const actions = root.querySelector('[data-runtime-role="local-actions"]');
  actions.setAttribute('aria-label', `Player ${player} cable actions`);
  const start = root.querySelector('[data-runtime-role="cable-start"]');
  if (!cableStart) {
    start.remove();
    actions.classList.add('local-link-actions-player-two');
  }

  const keymapElement = root.querySelector('[data-runtime-role="keymap"]');
  keymapElement.replaceChildren(...keymap.map((label) => {
    const item = document.createElement('span');
    item.textContent = label;
    return item;
  }));

  target.append(fragment);
  return root;
}
