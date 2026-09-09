import assert from 'node:assert/strict';
import test from 'node:test';

import { MultibootClientEndpoint, MultibootProtocol, multibootInternals } from '../web/multiboot-client.js';

const KEY_MULTIPLIER = 0x6f646573;

function word(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function runProtocol(mode) {
  const protocol = new MultibootProtocol({ clientRandom: 0xd1 });
  const response16 = (data) => {
    const response = protocol.exchange(data, mode) >>> 0;
    return mode === 1 ? response >>> 16 : response & 0xffff;
  };
  assert.equal(response16(0x6200), 0);
  for (let count = 0; count < 15; count += 1) assert.equal(response16(0x6200), 0x7202);
  assert.equal(response16(0x6102), 0x7202);

  const header = Uint8Array.from({ length: 0xc0 }, (_, index) => (index * 13 + 7) & 0xff);
  for (let offset = 0; offset < header.length; offset += 2) {
    assert.equal(response16(header[offset] | (header[offset + 1] << 8)),
      (((0x60 - offset / 2) << 8) | 2) & 0xffff);
  }
  assert.equal(response16(0x6200), 0x0002);
  assert.equal(response16(0x6202), 0x7202);
  assert.equal(response16(0x6393), 0x73d1);
  const handshake = (0x11 + 0xd1 + 0xff + 0xff) & 0xff;
  assert.equal(response16(0x6400 | handshake), 0x73d1);

  const main = Uint8Array.from({ length: 0x100 }, (_, index) => (index * 29 + 3) & 0xff);
  assert.equal(response16(main.length / 4 - 0x34), 0x73d1);
  let key = (0x93 | (0xd1 << 8) | 0xffff0000) >>> 0;
  let crc = mode === 1 ? 0xc387 : 0xfff8;
  const polynomial = mode === 1 ? 0xc37b : 0xa517;
  const keyXor = mode === 1 ? 0x43202f2f : 0x6465646f;
  for (let offset = 0; offset < main.length; offset += 4) {
    const plain = word(main, offset);
    key = (Math.imul(key, KEY_MULTIPLIER) + 1) >>> 0;
    const destination = 0x020000c0 + offset;
    const encrypted = (plain ^ ((-destination) >>> 0) ^ key ^ keyXor) >>> 0;
    if (mode === 1) response16(encrypted);
    else {
      response16(encrypted & 0xffff);
      response16(encrypted >>> 16);
    }
    crc = multibootInternals.crcWord(crc, plain, polynomial);
  }
  const finalWord = (handshake | (0xd1 << 8) | 0xffff0000) >>> 0;
  crc = multibootInternals.crcWord(crc, finalWord, polynomial);
  assert.equal(response16(0x0065), 0x01c0);
  assert.equal(response16(0x0065), 0x0074);
  assert.equal(response16(0x0065), 0x0075);
  assert.equal(response16(0x0066), 0x0075);
  assert.equal(response16(crc), crc);

  const expected = Uint8Array.from([...header, ...main]);
  expected[0xc4] = mode === 1 ? 0x02 : 0x03;
  expected[0xc5] = 1;
  assert.deepEqual(protocol.payload(), expected);
}

test('clean-room multiboot receiver accepts Normal32 encrypted transfer', () => {
  runProtocol(1);
});

test('clean-room multiboot receiver accepts Multiplayer16 encrypted transfer', () => {
  runProtocol(2);
});

test('multiboot endpoint exposes the generic SIO responder contract', () => {
  const endpoint = new MultibootClientEndpoint();
  endpoint._vba_link_set_peer_state(1, 0x1083, 1);
  assert.equal(endpoint._vba_link_mode(), 15);
  assert.equal(endpoint.peerMode, 1);
  assert.equal(endpoint._vba_link_prepare_remote(0, 1, 32, 1, 0, 0x6200, 0), 1);
  assert.equal(endpoint._vba_link_response_data(), 0x6200);
  assert.equal(endpoint._vba_link_apply_transfer(0, 1, 32, 1, 0, 0x6200, 0x6200), 1);
  assert.equal(endpoint._vba_link_request_sequence(), 1);
  endpoint.protocol.complete = true;
  assert.equal(endpoint._vba_link_prepare_remote(1, 1, 32, 1, 0, 0, 0), 0);
  assert.equal(endpoint._vba_link_set_player(-1), 1);
  assert.equal(endpoint._vba_link_player(), -1);
});
