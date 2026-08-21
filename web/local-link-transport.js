import { hostTransferData, isSlaveHandshake } from './link-message-queue.js';

export function applyDirectCablePair(host, guest, state) {
  if (!host?._vba_link_request_pending()) return { ...state, applied: false };
  const sequence = Number(host._vba_link_request_sequence());
  if (sequence === state.lastPairSequence) return { ...state, applied: false };
  const rawData = Number(host._vba_link_request_data());
  const masterData = hostTransferData(rawData, state.guestHandshakePending);
  const speed = Number(host._vba_link_request_speed());
  const ticks = Number(host._vba_link_request_ticks());
  const slaveData = Number(guest._vba_link_prepare_remote(sequence, speed, masterData, ticks));
  if (slaveData < 0) return { ...state, applied: false };
  if (!host._vba_link_apply_pair(sequence, speed, masterData, slaveData) ||
      !guest._vba_link_apply_pair(sequence, speed, masterData, slaveData)) {
    throw new Error('Direct local cable pair failed');
  }
  return {
    applied: true,
    sequence,
    masterData,
    slaveData,
    lastPairSequence: sequence,
    guestHandshakePending: isSlaveHandshake(slaveData),
  };
}

export function releaseDirectCableGuest(host, guest, lastReleaseSequence) {
  if (!host || !guest?._vba_link_guest_held() || host._vba_link_waiting() ||
      host._vba_link_transfer_active() || host._vba_link_request_pending() ||
      (Number(host._vba_link_siocnt()) & 0x4000)) {
    return { released: false, lastReleaseSequence };
  }
  const sequence = Number(host._vba_link_request_sequence());
  if (sequence === lastReleaseSequence) return { released: false, lastReleaseSequence };
  guest._vba_link_cancel_wait();
  return { released: true, lastReleaseSequence: sequence };
}

export function directCableIdle(runtimes) {
  return runtimes.every((runtime) => runtime.core &&
    !runtime.core._vba_link_waiting() && !runtime.core._vba_link_transfer_active() &&
    !runtime.core._vba_link_request_pending());
}

export function guestCableResponsePending(host, guest) {
  return Boolean(host?._vba_link_request_pending() && guest &&
    Number(host._vba_link_request_sequence()) === Number(guest._vba_link_request_sequence()) &&
    !guest._vba_link_waiting() && !guest._vba_link_transfer_active() &&
    !guest._vba_link_guest_held());
}
