export class LinkMessageQueue {
  constructor() {
    this.offers = new Map();
    this.pairs = new Map();
    this.prepared = new Set();
  }

  clear() {
    this.offers.clear();
    this.pairs.clear();
    this.prepared.clear();
  }

  enqueueOffer(message) {
    // A repeated offer can be the server replaying a response that was lost
    // with the previous WebSocket. Server submissions are idempotent.
    this.prepared.delete(message.sequence);
    this.offers.set(message.sequence, { ...message });
  }

  enqueuePair(message) {
    this.pairs.set(message.sequence, {
      ...message,
      dataBySlot: [...message.dataBySlot],
    });
  }

  drain(adapter) {
    const sequence = adapter.currentSequence();
    this.#dropBefore(sequence);
    if (adapter.transferActive()) return false;

    const pair = this.pairs.get(sequence);
    if (pair) {
      const applied = adapter.applyTransfer(pair);
      if (!applied) return false;
      this.pairs.delete(sequence);
      this.offers.delete(sequence);
      this.prepared.delete(sequence);
      adapter.onPairApplied(pair);
      return true;
    }

    const offer = !this.prepared.has(sequence) ? this.offers.get(sequence) : null;
    if (!offer || offer.initiatorSlot === adapter.slot) return false;
    const status = adapter.prepareRemote(offer);
    if (status < 0) {
      this.offers.delete(sequence);
      return false;
    }
    if (status === 0) return false;
    if (!adapter.sendResponse({
      type: 'sio-response',
      sequence: offer.sequence,
      mode: offer.mode,
      bits: offer.bits,
      speed: offer.speed,
      initiatorSlot: offer.initiatorSlot,
      data: adapter.responseData(),
      ticks: offer.ticks,
    })) return false;
    this.offers.delete(sequence);
    this.prepared.add(sequence);
    return false;
  }

  get pendingOffers() { return this.offers.size; }
  get pendingPairs() { return this.pairs.size; }
  get preparedResponses() { return this.prepared.size; }

  #dropBefore(sequence) {
    for (const key of this.offers.keys()) if (key < sequence) this.offers.delete(key);
    for (const key of this.pairs.keys()) if (key < sequence) this.pairs.delete(key);
    for (const key of this.prepared.keys()) if (key < sequence) this.prepared.delete(key);
  }
}
