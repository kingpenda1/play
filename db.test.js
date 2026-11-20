'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, withTransaction } = require('../db');

test('persists merchant invoice and payment intent records across reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khaye-pipay-'));
  const file = path.join(dir, 'app.sqlite');
  let db = openDatabase(file);
  const now = Date.now();
  db.prepare('INSERT INTO users (pi_uid, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run('test-merchant', 'merchant', now, now);
  db.prepare('INSERT INTO merchants (pi_uid, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('test-merchant', 'Test Store', now, now);
  db.prepare(`INSERT INTO invoices (id, code, merchant_uid, amount_micros, memo, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run('invoice-1', 'KP-0123456789ABCDEF0123456789ABCDEF', 'test-merchant', 15_000_000, 'Test item', now, now + 60_000);
  db.close();

  db = openDatabase(file);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get('invoice-1');
  assert.equal(invoice.code, 'KP-0123456789ABCDEF0123456789ABCDEF');
  assert.equal(invoice.amount_micros, 15_000_000);

  withTransaction(db, () => {
    db.prepare('INSERT INTO users (pi_uid, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('test-customer', 'customer', now, now);
    db.prepare(`INSERT INTO payment_intents (id, invoice_id, payer_uid, amount_micros, memo, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`)
      .run('intent-1', 'invoice-1', 'test-customer', 15_000_000, 'Test payment', now, now + 30_000);
  });
  assert.equal(db.prepare('SELECT status FROM payment_intents WHERE id=?').get('intent-1').status, 'created');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allows only one active payment intent per invoice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khaye-pipay-'));
  const db = openDatabase(path.join(dir, 'app.sqlite'));
  const now = Date.now();
  db.prepare('INSERT INTO users (pi_uid, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run('m', 'm', now, now);
  db.prepare('INSERT INTO merchants (pi_uid, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('m', 'M', now, now);
  db.prepare('INSERT INTO users (pi_uid, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run('c1', 'c1', now, now);
  db.prepare('INSERT INTO users (pi_uid, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run('c2', 'c2', now, now);
  db.prepare(`INSERT INTO invoices (id, code, merchant_uid, amount_micros, memo, status, created_at, expires_at)
    VALUES ('i', 'KP-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'm', 10000000, 'item', 'payment_pending', ?, ?)`)
    .run(now, now + 60_000);
  db.prepare(`INSERT INTO payment_intents (id, invoice_id, payer_uid, amount_micros, memo, status, created_at, expires_at)
    VALUES ('p1', 'i', 'c1', 10000000, 'item', 'created', ?, ?)`)
    .run(now, now + 30_000);
  assert.throws(() => db.prepare(`INSERT INTO payment_intents (id, invoice_id, payer_uid, amount_micros, memo, status, created_at, expires_at)
    VALUES ('p2', 'i', 'c2', 10000000, 'item', 'created', ?, ?)`)
    .run(now, now + 30_000));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
