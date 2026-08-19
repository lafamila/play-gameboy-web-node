export class LinkMessageQueue {
  constructor() {
    this.offers = new Map();
    this.pairs = new Map();
  }

  clear() {
    this.offers.clear();
    this.pairs.clear();
  }

  enqueueOffer(message) {
    this.offers.set(message.sequence, { ...message });
  }

  enqueuePair(message) {
    this.pairs.set(message.sequence, { ...message });
  }

  drain(adapter) {
    const sequence = adapter.currentSequence();
    this.#dropBefore(sequence);
    if (adapter.transferActive()) return false;

    const pair = this.pairs.get(sequence);
    if (adapter.slot === 1) {
      const offer = this.offers.get(sequence) ?? (pair ? {
        sequence,
        speed: pair.speed,
        data: pair.masterData,
      } : null);
      if (offer) {
        const slaveData = adapter.prepareRemote(offer.sequence, offer.speed, offer.data);
        if (slaveData < 0) return false;
        if (!adapter.sendResponse({
          type: 'link-response',
          sequence: offer.sequence,
          speed: offer.speed,
          data: slaveData,
        })) return false;
        this.offers.delete(sequence);
      }
    }

    if (adapter.transferActive()) return false;
    if (!pair) return false;
    const applied = adapter.applyPair(
      pair.sequence,
      pair.speed,
      pair.masterData,
      pair.slaveData,
    );
    if (!applied) return false;
    this.pairs.delete(sequence);
    this.offers.delete(sequence);
    adapter.onPairApplied(pair);
    return true;
  }

  get pendingOffers() { return this.offers.size; }
  get pendingPairs() { return this.pairs.size; }

  #dropBefore(sequence) {
    for (const key of this.offers.keys()) if (key < sequence) this.offers.delete(key);
    for (const key of this.pairs.keys()) if (key < sequence) this.pairs.delete(key);
  }
}

