'use strict';

const $ = id => document.getElementById(id);
let accessToken = null;
let piReady = false;
let selectedInvoice = null;
let merchantProfile = null;
let pendingIncompletePayment = null;
let qrScanner = null;
let paymentFlowActive = false;

function status(message) { $('status').textContent = message; }
function showPanel(id) {
  ['payPanel', 'receivePanel', 'codePanel'].forEach(panelId => $(panelId).classList.toggle('hidden', panelId !== id));
}
function authHeaders() {
  if (!accessToken) throw new Error('Sign in with Pi first.');
  return { Authorization: `Bearer ${accessToken}` };
}
async function api(path, options = {}, auth = true) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth) Object.assign(headers, authHeaders());
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function safeText(element, value) { element.textContent = value == null ? '' : String(value); }
function moneyLabel(amount) { return `${amount} π`; }
function dateLabel(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}

async function initPi() {
  try {
    const config = await api('/api/config', {}, false);
    if (!window.Pi) {
      status('Open KHAYE PI PAY inside Pi Browser to connect your Pi account.');
      $('login').disabled = false;
      return;
    }
    window.Pi.init({ version: '2.0', sandbox: config.sandbox === true });
    piReady = true;
    $('login').disabled = false;
    status(config.sandbox ? 'Pi Sandbox mode is enabled.' : 'Pi production mode is configured.');
    const code = new URLSearchParams(window.location.search).get('invoice');
    if (code) {
      $('paymentCode').value = code;
      await loadInvoice(code);
    }
  } catch (error) {
    status(error.message || 'Could not initialize KHAYE PI PAY.');
    $('login').disabled = false;
  }
}

async function verifyLogin() {
  const result = await api('/api/verify', { method: 'POST', body: '{}' });
  $('welcome').textContent = `Connected as @${result.username || 'Pi user'}`;
  $('login').textContent = 'Pi account connected';
  $('login').disabled = true;
  $('registerMerchant').disabled = false;
  renderSelectedInvoice();
  await loadMerchantProfile();
  await loadActivity();
  if (pendingIncompletePayment) {
    const payment = pendingIncompletePayment;
    pendingIncompletePayment = null;
    await recoverIncompletePayment(payment);
  }
}

function onIncompletePayment(payment) {
  pendingIncompletePayment = payment;
  if (accessToken) {
    const pending = pendingIncompletePayment;
    pendingIncompletePayment = null;
    recoverIncompletePayment(pending);
  }
}

async function recoverIncompletePayment(payment) {
  if (!payment?.identifier || !payment?.transaction?.txid || !accessToken) return;
  status('Checking an unfinished Pi payment with the server…');
  try {
    const result = await api('/api/payments/recover', {
      method: 'POST',
      body: JSON.stringify({ paymentId: payment.identifier, txid: payment.transaction.txid })
    });
    status(result.completed ? 'The saved Pi payment is verified and complete.' : 'The payment is still being checked.');
    await loadActivity();
  } catch (error) {
    status(`${error.message} Do not pay the same invoice again until it is reconciled.`);
  }
}

$('login').addEventListener('click', async () => {
  try {
    if (!window.Pi || !piReady) throw new Error('Please open KHAYE PI PAY inside Pi Browser.');
    $('login').disabled = true;
    status('Connecting to Pi…');
    const auth = await window.Pi.authenticate(['username', 'payments'], onIncompletePayment);
    accessToken = auth.accessToken;
    await verifyLogin();
    status('Your Pi identity has been verified by the KHAYE PI PAY server.');
  } catch (error) {
    $('login').disabled = false;
    status(error.message || 'Pi sign-in failed.');
  }
});

$('scan').addEventListener('click', async () => {
  showPanel('codePanel');
  try { await startQrScanner(); } catch (error) { status(`${error.message} You can still enter the merchant code manually.`); }
});
$('stopScan').addEventListener('click', stopQrScanner);
$('receive').addEventListener('click', () => showPanel('receivePanel'));
$('code').addEventListener('click', () => showPanel('codePanel'));


function extractInvoiceCode(decodedText) {
  const value = String(decodedText || '').trim();
  const direct = value.toUpperCase();
  if (/^KP-[A-F0-9]{32}$/.test(direct)) return direct;
  try {
    const parsed = new URL(value);
    const code = (parsed.searchParams.get('invoice') || '').trim().toUpperCase();
    if (/^KP-[A-F0-9]{32}$/.test(code)) return code;
  } catch { /* not a URL; no arbitrary navigation is performed */ }
  return null;
}

async function stopQrScanner() {
  if (qrScanner) {
    try { if (qrScanner.isScanning) await qrScanner.stop(); } catch { /* camera may already be stopped */ }
    try { qrScanner.clear(); } catch { /* ignore cleanup errors */ }
    qrScanner = null;
  }
  $('scannerWrap').classList.add('hidden');
}

async function startQrScanner() {
  if (!window.Html5Qrcode) throw new Error('The QR camera component did not load. Check your internet connection.');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support camera access. Open the app in Pi Browser over HTTPS.');
  await stopQrScanner();
  $('scannerWrap').classList.remove('hidden');
  qrScanner = new Html5Qrcode('qrReader');
  await qrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    async decodedText => {
      const code = extractInvoiceCode(decodedText);
      if (!code) { status('That QR code is not a KHAYE PI PAY invoice.'); return; }
      await stopQrScanner();
      $('paymentCode').value = code;
      try {
        await loadInvoice(code);
        status('QR code scanned. Check the merchant and amount before paying.');
      } catch (error) { status(error.message); }
    },
    () => { /* ignore per-frame decode misses */ }
  );
  status('Camera ready. Point it at a KHAYE PI PAY merchant QR code.');
}

async function loadMerchantProfile() {
  try {
    const result = await api('/api/merchant/me');
    merchantProfile = result.merchant;
    if (merchantProfile) {
      $('storeName').value = merchantProfile.display_name;
      safeText($('merchantState'), `Merchant profile active: ${merchantProfile.display_name}`);
      $('makeQr').disabled = false;
      await loadMerchantInvoices();
    } else {
      safeText($('merchantState'), 'No merchant profile yet. Create one to issue payment invoices.');
      $('makeQr').disabled = true;
    }
  } catch (error) { status(error.message); }
}

$('registerMerchant').addEventListener('click', async () => {
  try {
    const displayName = $('storeName').value.trim();
    const result = await api('/api/merchant/register', {
      method: 'POST', body: JSON.stringify({ displayName })
    });
    merchantProfile = result.merchant;
    $('makeQr').disabled = false;
    safeText($('merchantState'), `Merchant profile active: ${merchantProfile.displayName}`);
    status('Merchant profile saved to the KHAYE PI PAY database.');
  } catch (error) { status(error.message); }
});

$('makeQr').addEventListener('click', async () => {
  try {
    if (!merchantProfile) throw new Error('Create your merchant profile first.');
    const result = await api('/api/invoices', {
      method: 'POST',
      body: JSON.stringify({
        amount: $('receiveAmount').value,
        memo: $('invoiceMemo').value.trim(),
        expiresInMinutes: Number($('invoiceExpiry').value)
      })
    });
    const invoice = result.invoice;
    $('qr').innerHTML = '';
    if (!window.QRCode) throw new Error('QR generator did not load. Check your internet connection and retry.');
    const url = new URL('/', window.location.origin);
    url.searchParams.set('invoice', invoice.code);
    new QRCode($('qr'), { text: url.toString(), width: 190, height: 190, correctLevel: QRCode.CorrectLevel.M });
    safeText($('requestCode'), invoice.code);
    safeText($('invoiceExpiryText'), `Invoice expires ${dateLabel(invoice.expiresAt)}. Share this QR or code with your customer.`);
    $('qrWrap').classList.remove('hidden');
    status('A server-backed merchant invoice and QR code have been created. No payment has been made yet.');
    await loadMerchantInvoices();
  } catch (error) { status(error.message); }
});

$('copyCode').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('requestCode').textContent);
    status('Merchant payment code copied.');
  } catch { status('Copy is unavailable here. Select and copy the code manually.'); }
});

async function loadInvoice(code) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!/^KP-[A-F0-9]{32}$/.test(cleanCode)) throw new Error('Enter a valid KHAYE payment code (KP- followed by 32 letters or numbers).');
  const result = await api(`/api/invoices/${encodeURIComponent(cleanCode)}`, {}, false);
  selectedInvoice = result.invoice;
  renderSelectedInvoice();
  showPanel('payPanel');
  return selectedInvoice;
}

function renderSelectedInvoice() {
  const target = $('invoicePreview');
  target.innerHTML = '';
  if (!selectedInvoice) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Load a merchant payment code or open a merchant QR link. The merchant name and exact Pi amount will be shown here before you pay.';
    target.appendChild(p);
    $('pay').disabled = true;
    return;
  }
  const merchant = document.createElement('div');
  merchant.className = 'merchant';
  merchant.textContent = selectedInvoice.merchantName;
  const amount = document.createElement('div');
  amount.className = 'amount';
  amount.textContent = moneyLabel(selectedInvoice.amount);
  const memo = document.createElement('div');
  memo.className = 'detail';
  memo.textContent = `${selectedInvoice.memo} · Code ${selectedInvoice.code}`;
  const expiry = document.createElement('div');
  expiry.className = 'detail';
  expiry.textContent = `Expires ${dateLabel(selectedInvoice.expiresAt)}`;
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = selectedInvoice.status === 'open' ? 'Open invoice · not yet paid' : selectedInvoice.status;
  target.append(merchant, amount, memo, expiry, state);
  $('pay').disabled = selectedInvoice.status !== 'open' || !accessToken || !piReady || paymentFlowActive;
}

$('loadCode').addEventListener('click', async () => {
  try {
    await loadInvoice($('paymentCode').value);
    status('Invoice found. Check the merchant and amount before continuing.');
  } catch (error) { selectedInvoice = null; renderSelectedInvoice(); status(error.message); }
});
$('paymentCode').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('loadCode').click();
});

$('pay').addEventListener('click', async () => {
  if (!selectedInvoice || !accessToken || !window.Pi || paymentFlowActive) return status('Connect your Pi account and load an open invoice first.');
  paymentFlowActive = true;
  renderSelectedInvoice();
  let intent;
  try {
    status('Creating your secure payment intent…');
    intent = await api('/api/payment-intents', {
      method: 'POST', body: JSON.stringify({ invoiceCode: selectedInvoice.code })
    });
    window.Pi.createPayment({
      amount: Number(intent.amount),
      memo: intent.memo,
      metadata: {
        app: 'KHAYE_PI_PAY',
        intentId: intent.intentId,
        invoiceId: intent.invoiceId,
        invoiceCode: intent.invoiceCode
      }
    }, {
      onReadyForServerApproval: async paymentId => {
        try {
          await api('/api/payments/approve', {
            method: 'POST', body: JSON.stringify({ paymentId, intentId: intent.intentId })
          });
          status('Pi payment approved by the KHAYE PI PAY server. Confirm the payment in Pi Browser.');
        } catch (error) { status(`${error.message} Keep this payment open; do not start another payment.`); }
      },
      onReadyForServerCompletion: async (paymentId, txid) => {
        try {
          const result = await api('/api/payments/complete', {
            method: 'POST', body: JSON.stringify({ paymentId, txid, intentId: intent.intentId })
          });
          status(result.completed ? 'Payment completed and verified by Pi. The invoice is now marked paid.' : 'Pi has not confirmed completion yet.');
          await loadActivity();
          selectedInvoice = { ...selectedInvoice, status: 'paid' };
          paymentFlowActive = false;
          renderSelectedInvoice();
        } catch (error) {
          status(`${error.message} Do not pay again; the server can reconcile this payment.`);
        }
      },
      onCancel: async paymentId => {
        try {
          await api('/api/payments/cancel', {
            method: 'POST', body: JSON.stringify({ intentId: intent.intentId, paymentId: paymentId || null })
          });
          paymentFlowActive = false;
          status('Pi payment was cancelled. You can reload the invoice and try again.');
          await loadInvoice(selectedInvoice.code);
        } catch (error) { status(error.message); }
      },
      onError: error => status(`Pi payment error: ${error?.message || error || 'unknown error'}. Do not start another payment until this request is checked.`)
    });
  } catch (error) {
    paymentFlowActive = false;
    renderSelectedInvoice();
    status(error.message);
  }
});

function renderInvoiceList(invoices) {
  const target = $('merchantInvoices');
  target.innerHTML = '';
  if (!invoices.length) { target.className = 'list-empty'; target.textContent = 'No invoices created yet.'; return; }
  target.className = '';
  for (const invoice of invoices) {
    const row = document.createElement('div'); row.className = 'invoice-row';
    const left = document.createElement('div');
    const title = document.createElement('div'); title.className = 'row-title'; title.textContent = invoice.code;
    const meta = document.createElement('div'); meta.className = 'row-meta'; meta.textContent = `${invoice.memo} · ${dateLabel(invoice.createdAt)}`;
    const state = document.createElement('div'); state.className = `row-meta status-${invoice.status}`; state.textContent = invoice.status.replace('_', ' ');
    left.append(title, meta, state);
    const amount = document.createElement('div'); amount.className = 'row-amount'; amount.textContent = moneyLabel(invoice.amount);
    row.append(left, amount); target.appendChild(row);
  }
}

async function loadMerchantInvoices() {
  if (!accessToken || !merchantProfile) return;
  try {
    const result = await api('/api/merchant/invoices');
    renderInvoiceList(result.invoices);
  } catch (error) { status(error.message); }
}

async function loadActivity() {
  if (!accessToken) return;
  try {
    const result = await api('/api/activity');
    const target = $('activity');
    target.innerHTML = '';
    if (!result.activity.length) {
      target.className = 'list-empty';
      target.textContent = 'No completed KHAYE PI PAY invoice payments yet.';
      return;
    }
    target.className = '';
    for (const item of result.activity) {
      const row = document.createElement('div'); row.className = 'activity-row';
      const left = document.createElement('div');
      const title = document.createElement('div'); title.className = 'row-title';
      title.textContent = item.direction === 'paid' ? `Paid · ${item.merchantName}` : `Received · ${item.merchantName}`;
      const meta = document.createElement('div'); meta.className = 'row-meta'; meta.textContent = `${item.invoiceCode} · ${dateLabel(item.completedAt)}`;
      left.append(title, meta);
      const amount = document.createElement('div'); amount.className = 'row-amount'; amount.textContent = `${item.direction === 'received' ? '+' : '−'}${moneyLabel(item.amount)}`;
      row.append(left, amount); target.appendChild(row);
    }
  } catch (error) { status(error.message); }
}

initPi();
