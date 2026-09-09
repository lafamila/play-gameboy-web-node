const MULTIBOOT_MAX_BYTES = 0x40000;
const KEY_MULTIPLIER = 0x6f646573;

function appendHalfword(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function appendWord(bytes, value) {
  appendHalfword(bytes, value);
  appendHalfword(bytes, value >>> 16);
}

function crcWord(crc, data, polynomial) {
  let value = data >>> 0;
  let result = crc & 0xffff;
  for (let bit = 0; bit < 32; bit += 1) {
    const carry = (result ^ value) & 1;
    result >>>= 1;
    if (carry) result ^= polynomial;
    value >>>= 1;
  }
  return result & 0xffff;
}

function normalWireResponse(response, sent) {
  return (((response & 0xffff) << 16) | (sent & 0xffff)) >>> 0;
}

export class MultibootProtocol {
  constructor({ clientId = 1, clientRandom = 0xd1 } = {}) {
    this.clientId = clientId;
    this.clientBit = 1 << clientId;
    this.clientRandom = clientRandom & 0xff;
    this.reset();
  }

  reset() {
    this.phase = 'recognition';
    this.recognitionCount = 0;
    this.header = [];
    this.image = [];
    this.headerWords = 0;
    this.palette = 0;
    this.handshake = 0;
    this.mainLength = 0;
    this.dataWords = 0;
    this.dataHalf = null;
    this.key = 0;
    this.crc = 0;
    this.crcPolynomial = 0;
    this.keyXor = 0;
    this.finalWord = 0;
    this.readyPolls = 0;
    this.complete = false;
    this.failed = false;
  }

  exchange(data, mode) {
    if (this.complete || this.failed || ![1, 2].includes(mode)) return 0xffff;
    const sent = data >>> 0;
    const halfword = sent & 0xffff;
    let response = 0xffff;

    if (this.phase === 'recognition') {
      if (halfword === 0x6200) {
        ++this.recognitionCount;
        response = this.recognitionCount === 1 ? 0 : 0x7200 | this.clientBit;
      } else if ((halfword & 0xfff0) === 0x6100 && this.recognitionCount > 1) {
        this.phase = 'header';
        response = 0x7200 | this.clientBit;
      }
    } else if (this.phase === 'header') {
      response = ((0x60 - this.headerWords) << 8) | this.clientBit;
      appendHalfword(this.header, halfword);
      ++this.headerWords;
      if (this.headerWords === 0x60) this.phase = 'header-end';
    } else if (this.phase === 'header-end') {
      if (halfword === 0x6200) {
        response = this.clientBit;
        this.phase = 'header-confirm';
      }
    } else if (this.phase === 'header-confirm') {
      if ((halfword & 0xfff0) === 0x6200) {
        response = 0x7200 | this.clientBit;
        this.phase = 'palette';
      }
    } else if (this.phase === 'palette') {
      if ((halfword & 0xff00) === 0x6300) {
        this.palette = halfword & 0xff;
        response = 0x7300 | this.clientRandom;
        this.phase = 'handshake';
      } else {
        response = 0x7200 | this.clientBit;
      }
    } else if (this.phase === 'handshake') {
      if ((halfword & 0xff00) === 0x6400) {
        this.handshake = halfword & 0xff;
        response = 0x7300 | this.clientRandom;
        this.phase = 'length';
      }
    } else if (this.phase === 'length') {
      this.mainLength = (halfword + 0x34) * 4;
      if (this.mainLength < 0x100 || this.mainLength > MULTIBOOT_MAX_BYTES - 0xc0 ||
          (this.mainLength & 0x0f)) {
        this.failed = true;
      } else {
        this.image = [...this.header];
        this.key = (this.palette | (this.clientRandom << 8) | 0xffff0000) >>> 0;
        this.finalWord = (this.handshake | (this.clientRandom << 8) | 0xffff0000) >>> 0;
        this.crc = mode === 1 ? 0xc387 : 0xfff8;
        this.crcPolynomial = mode === 1 ? 0xc37b : 0xa517;
        this.keyXor = mode === 1 ? 0x43202f2f : 0x6465646f;
        this.phase = 'data';
        response = 0x7300 | this.clientRandom;
      }
    } else if (this.phase === 'data') {
      const destinationOffset = this.image.length;
      response = destinationOffset & 0xffff;
      if (mode === 2 && this.dataHalf === null) {
        this.dataHalf = halfword;
      } else {
        const encrypted = mode === 2
          ? ((halfword << 16) | this.dataHalf) >>> 0
          : sent;
        this.dataHalf = null;
        this.key = (Math.imul(this.key, KEY_MULTIPLIER) + 1) >>> 0;
        const destination = (0x02000000 + destinationOffset) >>> 0;
        const plain = (encrypted ^ ((-destination) >>> 0) ^ this.key ^ this.keyXor) >>> 0;
        appendWord(this.image, plain);
        this.crc = crcWord(this.crc, plain, this.crcPolynomial);
        ++this.dataWords;
        if (this.dataWords * 4 === this.mainLength) {
          this.crc = crcWord(this.crc, this.finalWord, this.crcPolynomial);
          this.phase = 'data-end';
        }
      }
    } else if (this.phase === 'data-end') {
      if (halfword === 0x0065) {
        response = this.image.length & 0xffff;
        this.phase = 'crc-ready';
      }
    } else if (this.phase === 'crc-ready') {
      if (halfword === 0x0065) {
        ++this.readyPolls;
        response = this.readyPolls === 1 ? 0x0074 : 0x0075;
      } else if (halfword === 0x0066 && this.readyPolls > 1) {
        response = 0x0075;
        this.phase = 'crc';
      }
    } else if (this.phase === 'crc') {
      response = this.crc;
      this.complete = halfword === this.crc;
      this.failed = !this.complete;
      if (this.complete) {
        this.image[0xc4] = mode === 1 ? 0x02 : 0x03;
        this.image[0xc5] = this.clientId;
      }
    }

    return mode === 1 ? normalWireResponse(response, sent) : response;
  }

  payload() {
    return this.complete ? Uint8Array.from(this.image) : null;
  }
}

export class MultibootClientEndpoint {
  constructor({ onComplete } = {}) {
    this.protocol = new MultibootProtocol();
    this.onComplete = onComplete;
    this.player = 1;
    this.mode = 15;
    this.peerMode = -1;
    this.siocnt = 0x0008;
    this.rcnt = 0x0007;
    this.epoch = 0;
    this.sequence = 0;
    this.pending = null;
    this.response = 0xffff;
  }

  _vba_link_player() { return this.player; }
  _vba_link_mode() { return this.mode; }
  _vba_link_siocnt() { return this.siocnt; }
  _vba_link_rcnt() { return this.rcnt; }
  _vba_link_state_epoch() { return this.epoch; }
  _vba_link_request_sequence() { return this.sequence; }
  _vba_link_request_pending() { return 0; }
  _vba_link_request_mode() { return -1; }
  _vba_link_request_bits() { return 0; }
  _vba_link_request_speed() { return 0; }
  _vba_link_request_initiator() { return -1; }
  _vba_link_request_data() { return 0xffffffff; }
  _vba_link_request_ticks() { return 0; }
  _vba_link_transfer_active() { return 0; }
  _vba_link_waiting() { return 0; }
  _vba_link_time() { return 0; }
  _vba_link_siodata8() { return 0xffff; }
  _vba_link_set_player(player) {
    if (![1, -1].includes(player)) return 0;
    this.player = player;
    return 1;
  }
  _vba_link_set_sequence(sequence) { this.sequence = sequence; return 1; }
  _vba_link_cancel_wait() { this.pending = null; }

  _vba_link_set_peer_state(mode) {
    if (mode === 1 || mode === 2) {
      this.peerMode = mode;
      ++this.epoch;
    }
    return 1;
  }

  _vba_link_prepare_remote(sequence, mode, bits, _speed, initiator, data) {
    if (sequence !== this.sequence || initiator !== 0 || ![1, 2].includes(mode) ||
        bits !== (mode === 1 ? 32 : 16)) return -1;
    if (this.protocol.complete) return 0;
    if (!this.pending) {
      this.response = this.protocol.exchange(data, mode) >>> 0;
      this.pending = { sequence, mode };
    }
    return 1;
  }

  _vba_link_response_data() { return this.response; }

  _vba_link_apply_transfer(sequence, mode, _bits, _speed, initiator) {
    if (!this.pending || this.pending.sequence !== sequence ||
        this.pending.mode !== mode || initiator !== 0) return 0;
    this.pending = null;
    ++this.sequence;
    const payload = this.protocol.payload();
    if (payload) this.onComplete?.(payload, mode);
    return 1;
  }
}

export const multibootInternals = { crcWord };
