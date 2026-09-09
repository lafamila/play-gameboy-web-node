export function sioPortState(core) {
  return {
    mode: Number(core._vba_link_mode()),
    siocnt: Number(core._vba_link_siocnt()),
    rcnt: Number(core._vba_link_rcnt()),
    epoch: Number(core._vba_link_state_epoch()),
  };
}

export function synchronizeDirectCableState(first, second) {
  const states = [sioPortState(first), sioPortState(second)];
  first._vba_link_set_peer_state(states[1].mode, states[1].siocnt, states[1].rcnt);
  second._vba_link_set_peer_state(states[0].mode, states[0].siocnt, states[0].rcnt);
  return states;
}

export function pendingSioOffer(core) {
  if (!core?._vba_link_request_pending()) return null;
  return {
    sequence: Number(core._vba_link_request_sequence()),
    mode: Number(core._vba_link_request_mode()),
    bits: Number(core._vba_link_request_bits()),
    speed: Number(core._vba_link_request_speed()),
    initiatorSlot: Number(core._vba_link_request_initiator()),
    data: Number(core._vba_link_request_data()) >>> 0,
    ticks: Number(core._vba_link_request_ticks()),
  };
}

export function applyDirectSioTransfer(cores, state) {
  synchronizeDirectCableState(cores[0], cores[1]);
  const offers = cores.map(pendingSioOffer).filter(Boolean)
    .filter((offer) => offer.sequence !== state.lastPairSequence)
    .sort((left, right) => left.sequence - right.sequence || left.initiatorSlot - right.initiatorSlot);
  const offer = offers[0];
  if (!offer) return { ...state, applied: false };
  const responder = cores[offer.initiatorSlot === 0 ? 1 : 0];
  const status = Number(responder._vba_link_prepare_remote(
    offer.sequence, offer.mode, offer.bits, offer.speed,
    offer.initiatorSlot, offer.data, offer.ticks,
  ));
  if (status <= 0) return { ...state, applied: false };
  const dataBySlot = [0, 1].map((slot) => slot === offer.initiatorSlot
    ? offer.data : Number(responder._vba_link_response_data()) >>> 0);
  for (const core of cores) {
    if (!core._vba_link_apply_transfer(
      offer.sequence, offer.mode, offer.bits, offer.speed,
      offer.initiatorSlot, dataBySlot[0], dataBySlot[1],
    )) throw new Error('Direct local SIO transfer failed');
  }
  return {
    applied: true,
    ...offer,
    dataBySlot,
    lastPairSequence: offer.sequence,
  };
}
