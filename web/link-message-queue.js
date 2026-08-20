export const MASTER_HANDSHAKE = 0x8fff;
export const SLAVE_HANDSHAKE = 0xb9a0;

export function hostTransferData(data, guestHandshakePending = false) {
  return guestHandshakePending || data === SLAVE_HANDSHAKE ? MASTER_HANDSHAKE : data;
}

export function isSlaveHandshake(data) {
  return data === SLAVE_HANDSHAKE;
}

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
      const offer = !this.prepared.has(sequence) && (this.offers.get(sequence) ?? (pair ? {
        sequence,
        speed: pair.speed,
        data: pair.masterData,
        ticks: pair.ticks,
      } : null));
      if (offer) {
        const slaveData = adapter.prepareRemote(offer.sequence, offer.speed, offer.data, offer.ticks);
        if (slaveData < 0) return false;
        if (!adapter.sendResponse({
          type: 'link-response',
          sequence: offer.sequence,
          speed: offer.speed,
          data: slaveData,
          ticks: offer.ticks,
        })) return false;
        this.offers.delete(sequence);
        this.prepared.add(sequence);
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
    this.prepared.delete(sequence);
    adapter.onPairApplied(pair);
    return true;
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
