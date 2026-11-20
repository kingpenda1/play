'use strict';

const MICRO_PI = 10_000_000;
const MAX_PI = 1_000_000;

/** Parse a Pi amount with at most 7 decimal places into integer micro-Pi. */
function parsePiAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let input;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_PI) return null;
    input = value.toFixed(7);
    if (Number(input) !== value) return null;
  } else {
    input = value.trim();
  }
  const match = /^(\d{1,7})(?:\.(\d{1,7}))?$/.exec(input);
  if (!match) return null;

  const whole = Number(match[1]);
  const fraction = Number((match[2] || '').padEnd(7, '0'));
  const micros = whole * MICRO_PI + fraction;
  if (!Number.isSafeInteger(micros) || micros <= 0 || micros > MAX_PI * MICRO_PI) return null;
  return micros;
}

function formatPiAmount(micros) {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new TypeError('Invalid micro-Pi amount');
  const whole = Math.floor(micros / MICRO_PI);
  const fraction = String(micros % MICRO_PI).padStart(7, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

module.exports = { MICRO_PI, MAX_PI, parsePiAmount, formatPiAmount };
