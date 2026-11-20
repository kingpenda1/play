'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePiAmount, formatPiAmount } = require('../lib/money');

test('parses Pi amounts exactly to 7 decimal places', () => {
  assert.equal(parsePiAmount('1'), 10_000_000);
  assert.equal(parsePiAmount('12.3456789'), 123_456_789);
  assert.equal(parsePiAmount('0.0000001'), 1);
  assert.equal(parsePiAmount(0.0000001), 1);
  assert.equal(formatPiAmount(123_456_789), '12.3456789');
  assert.equal(formatPiAmount(10_000_000), '1');
});

test('rejects invalid, zero, excessive precision and excessive values', () => {
  for (const value of ['', '0', '0.0000000', '-1', '1.12345678', '1e-7', '1000000.0000001', 'abc', '  ']) {
    assert.equal(parsePiAmount(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});
