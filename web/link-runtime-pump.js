export function pumpLinkRuntime(adapter) {
  adapter.drain();
  if (adapter.waiting()) {
    adapter.offer();
    return 2;
  }
  if (adapter.guestHeld()) return 2;

  const result = adapter.run();
  if (result === 2) adapter.offer();
  adapter.drain();
  adapter.release();
  return result;
}
