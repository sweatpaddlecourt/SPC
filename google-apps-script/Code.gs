/**
 * Sweat Paddle Court booking API backed by a private Google Sheet.
 * Deploy as a web app executing as the owner. All requests are POSTed from
 * the GitHub Pages client through a hidden iframe to avoid cross-origin fetch.
 */
const SHEET_ID = 'PASTE_YOUR_GOOGLE_SHEET_ID_HERE';
const SETTINGS_KEY = 'site_settings';
const SESSION_TTL_SECONDS = 21600;
const BOOKING_TIME_ZONE = 'Asia/Manila';

function doGet() {
  return jsonOutput_({ ok: true, service: 'Sweat Paddle Court booking API' });
}

function doPost(e) {
  let requestId = '';
  try {
    const packet = JSON.parse((e && e.parameter && e.parameter.packet) || '{}');
    requestId = packet.requestId || '';
    const result = route_(packet);
    return bridgeOutput_(requestId, result);
  } catch (error) {
    return bridgeOutput_(requestId, { status: 500, error: message_(error) });
  }
}

function bridgeOutput_(requestId, result) {
  const payload = JSON.stringify({ requestId: requestId, result: result }).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.top.postMessage(' + payload + ',"*");</script>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function route_(packet) {
  const method = String(packet.method || 'GET').toUpperCase();
  const path = String(packet.path || '/').split('?')[0];
  const query = parseQuery_(String(packet.path || ''));
  const body = packet.body || {};
  const settings = readSettings_();

  if (method === 'GET' && path === '/api/public') return ok_({ settings: settings, adminSetupRequired: !PropertiesService.getScriptProperties().getProperty('ADMIN_HASH') });
  if (method === 'GET' && path === '/api/availability') {
    const date = query.date || '', courtId = query.courtId || '';
    if (!validDate_(date) || !courtId) return fail_(400, 'Choose a valid date and court.');
    const relevant = readBookings_().filter(function (b) {
      return b.dateISO === date && (courtId === 'exclusive' || b.courtId === courtId || b.courtId === 'exclusive');
    });
    const booked = relevant.filter(bookingBlocksTime_).reduce(function (all, b) { return all.concat(b.minutes); }, []);
    const pending = relevant.filter(bookingPendingReview_).reduce(function (all, b) { return all.concat(b.minutes); }, []);
    return ok_({ booked: Array.from(new Set(booked)), pending: Array.from(new Set(pending)) });
  }
  if (method === 'POST' && path === '/api/bookings') return createBooking_(body);
  if (method === 'POST' && path === '/api/bookings/report') {
    const booking = findBooking_(body.reference, body.name);
    if (!booking) return fail_(404, 'No booking matched that reference and name.');
    if (booking.status === 'Paid') return fail_(409, 'This booking has already been verified as paid.');
    const paymentReference = String(body.paymentReference || '').trim().slice(0, 120);
    const receiptImage = String(body.receiptImage || '');
    if (!paymentReference && !receiptImage) return fail_(400, 'Upload a receipt image or enter a payment reference number.');
    if (receiptImage && !validImage_(receiptImage)) return fail_(400, 'Receipt must be a PNG, JPEG, GIF, or WebP image under 3 MB.');
    saveBookingProof_(booking.reference, paymentReference, receiptImage);
    if (booking.status === 'Awaiting payment') updateBooking_(booking.reference, function (row) { row.status = 'Payment reported'; });
    return ok_({ ok: true });
  }
  if (method === 'POST' && path === '/api/bookings/track') {
    const booking = findBooking_(body.reference, body.name);
    if (!booking) return fail_(404, 'No booking matched that reference and name.');
    delete booking.name;
    return ok_({ booking: booking });
  }
  if (method === 'POST' && path === '/api/admin/setup') return setupAdmin_(body);
  if (method === 'POST' && path === '/api/admin/login') return login_(body);
  if (method === 'GET' && path === '/api/admin/me') {
    const user = sessionUser_(packet.token);
    return user ? ok_({ user: user }) : fail_(401, 'Admin sign-in required.');
  }
  if (method === 'POST' && path === '/api/admin/logout') {
    if (packet.token) CacheService.getScriptCache().remove('session:' + packet.token);
    return ok_({ ok: true });
  }
  if (path.indexOf('/api/admin/') === 0) {
    const user = sessionUser_(packet.token);
    if (!user) return fail_(401, 'Admin sign-in required.');
    if (method === 'GET' && path === '/api/admin/dashboard') {
      const proofs = readBookingProofSummaries_();
      const bookings = readBookings_().map(function (booking) { const proof = proofs[booking.reference] || {}; booking.paymentReference = proof.paymentReference || ''; booking.hasReceipt = Boolean(proof.hasReceipt); return booking; }).filter(function (booking) { return Boolean(booking.paymentReference || booking.hasReceipt) || /^cancel/i.test(booking.status || ''); });
      return ok_({ settings: settings, bookings: bookings.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }), user: user });
    }
    if (method === 'POST' && path === '/api/admin/bookings/proof') {
      const booking = readBookings_().find(function (item) { return item.reference === String(body.reference || ''); });
      if (!booking) return fail_(404, 'Booking not found.');
      return ok_(readBookingProof_(booking.reference));
    }
    if (method === 'POST' && path === '/api/admin/courts') {
      const court = normalizeCourt_(body);
      if (!court) return fail_(400, 'Check the court details and image format.');
      settings.courts.push(court); writeSettings_(settings); return ok_({ court: court }, 201);
    }
    const courtMatch = path.match(/^\/api\/admin\/courts\/([^/]+)$/);
    if (courtMatch && (method === 'PATCH' || method === 'DELETE')) {
      const id = decodeURIComponent(courtMatch[1]), index = settings.courts.findIndex(function (c) { return c.id === id; });
      if (index < 0) return fail_(404, 'Court not found.');
      if (method === 'DELETE') settings.courts.splice(index, 1);
      else { const court = normalizeCourt_(Object.assign({}, settings.courts[index], body, { id: id })); if (!court) return fail_(400, 'Check the court details and image format.'); settings.courts[index] = court; }
      writeSettings_(settings); return ok_({ settings: settings });
    }
    if (method === 'PATCH' && path === '/api/admin/settings') {
      if ('instapayUrl' in body) { if (body.instapayUrl && !/^https:\/\//i.test(body.instapayUrl)) return fail_(400, 'Payment links must use HTTPS.'); settings.instapayUrl = String(body.instapayUrl).slice(0, 500); }
      ['instapayQr', 'heroImage'].forEach(function (key) { if (key in body) settings[key] = validImage_(body[key]) ? body[key] : ''; });
      writeSettings_(settings); return ok_({ settings: settings });
    }
    if (method === 'PATCH' && path === '/api/admin/password') {
      const props = PropertiesService.getScriptProperties(), current = digest_(String(body.currentPassword || '') + props.getProperty('ADMIN_SALT'));
      if (current !== props.getProperty('ADMIN_HASH')) return fail_(401, 'Current password is incorrect.');
      const email = String(body.email || '').trim().toLowerCase(), password = String(body.newPassword || '');
      if (!validEmail_(email) || (password && password.length < 12)) return fail_(400, 'Enter a valid email and a password of at least 12 characters.');
      props.setProperty('ADMIN_EMAIL', email);
      if (password) { const salt = Utilities.getUuid(); props.setProperties({ ADMIN_SALT: salt, ADMIN_HASH: digest_(password + salt) }); }
      return ok_({ user: { email: email } });
    }
    const bookingMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)$/);
    if (bookingMatch && (method === 'PATCH' || method === 'DELETE')) {
      const ref = decodeURIComponent(bookingMatch[1]);
      if (method === 'DELETE') deleteBooking_(ref);
      else if (body.status === 'Paid') return markPaid_(ref);
      else return fail_(400, 'Unsupported booking status.');
      return ok_({ ok: true });
    }
  }
  return fail_(404, 'API route not found.');
}

function bookingBlocksTime_(booking) { return ['paid', 'confirmed', 'booked'].indexOf(String(booking.status || '').trim().toLowerCase()) >= 0; }
function bookingPendingReview_(booking) { return String(booking.status || '').trim().toLowerCase() === 'payment reported' && !bookingBlocksTime_(booking); }

function normalizeDateISO_(value, timeZone) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timeZone || BOOKING_TIME_ZONE, 'yyyy-MM-dd');
  }
  const text = String(value || '').trim(), match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : text;
}
function bookingClock_() {
  const stamp = Utilities.formatDate(new Date(), BOOKING_TIME_ZONE, 'yyyy-MM-dd HH:mm');
  const parts = stamp.split(' '), hm = parts[1].split(':').map(Number);
  return { dateISO: parts[0], minuteOfDay: hm[0] * 60 + hm[1] };
}
function bookingTimeHasPassed_(dateISO, minutes) {
  const now = bookingClock_();
  return dateISO < now.dateISO || (dateISO === now.dateISO && minutes.some(function (minute) { return minute < now.minuteOfDay; }));
}

function createBooking_(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_(503, 'Bookings are busy. Please try again.');
  try {
    const name = String(body.name || '').trim().slice(0, 80), courtId = String(body.courtId || ''), date = String(body.dateISO || '');
    const times = Array.isArray(body.times) ? Array.from(new Set(body.times)).slice(0, 24) : [];
    if (name.length < 2 || !validDate_(date) || !times.length) return fail_(400, 'Enter your name, choose a valid date, and select at least one hour.');
    const settings = readSettings_(), court = settings.courts.find(function (c) { return c.id === courtId; });
    if (!court) return fail_(400, 'That court is no longer available. Refresh and try again.');
    const minutes = times.map(parseTime_);
    if (minutes.some(function (n) { return n === null; }) || new Set(minutes).size !== minutes.length) return fail_(400, 'One or more selected times are invalid.');
    minutes.sort(function (a, b) { return a - b; });
    if (bookingTimeHasPassed_(date, minutes)) return fail_(400, 'One or more selected times have already passed. Choose a future time.');
    if (courtId === 'exclusive' && minutes.length > 1) return fail_(400, 'Exclusive court bookings must be reserved one hour at a time.');
    const rows = readBookings_();
    const clash = rows.some(function (b) { return bookingBlocksTime_(b) && b.dateISO === date && (courtId === 'exclusive' || b.courtId === 'exclusive' || b.courtId === courtId) && b.minutes.some(function (m) { return minutes.indexOf(m) >= 0; }); });
    if (clash) return fail_(409, 'That time was just booked. Please choose another available time.');
    const opening = Number.isInteger(Number(court.openingMinute)) ? Number(court.openingMinute) : 300;
    const closing = Number.isInteger(Number(court.closingMinute)) ? Number(court.closingMinute) : 1320;
    const dayRateStart = Number.isInteger(Number(court.dayRateStartMinute)) ? Number(court.dayRateStartMinute) : opening; const nightRateStart = Number.isInteger(Number(court.nightRateStartMinute)) ? Number(court.nightRateStartMinute) : (Number.isInteger(Number(court.priceChangeMinute)) ? Number(court.priceChangeMinute) : 1020);
    if (minutes.some(function (minute) { return minute < opening || minute + 60 > closing; })) return fail_(400, 'Selected hours fall outside this court opening schedule. Refresh and choose an open time.');
    const labels = minutes.map(formatTime_), amount = minutes.reduce(function (sum, minute) { return sum + Number(minute >= dayRateStart && minute < nightRateStart ? court.dayRate : court.nightRate); }, 0);
    const booking = { reference: 'SP-' + Utilities.getUuid().replace(/-/g, '').toUpperCase(), name: name, courtId: courtId, court: court.name, dateISO: date, date: formatDate_(date), times: labels, time: labels.join(', '), minutes: minutes, duration: minutes.length, amount: amount, status: 'Awaiting payment', createdAt: new Date().toISOString(), paidAt: '' };
    appendBooking_(booking);
    return ok_({ booking: booking, settings: settings }, 201);
  } finally { lock.releaseLock(); }
}

function setupAdmin_(body) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_HASH')) return fail_(409, 'Admin setup is already complete. Sign in instead.');
  const token = props.getProperty('ADMIN_SETUP_TOKEN') || '', email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
  if (!token || body.setupToken !== token) return fail_(403, 'Set ADMIN_SETUP_TOKEN in Apps Script project settings, then try again.');
  if (!validEmail_(email) || password.length < 12) return fail_(400, 'Enter a valid email and a password of at least 12 characters.');
  const salt = Utilities.getUuid(); props.setProperties({ ADMIN_EMAIL: email, ADMIN_SALT: salt, ADMIN_HASH: digest_(password + salt) });
  return createSession_(email);
}

function login_(body) {
  const props = PropertiesService.getScriptProperties(), salt = props.getProperty('ADMIN_SALT') || '';
  if (String(body.email || '').trim().toLowerCase() !== (props.getProperty('ADMIN_EMAIL') || '') || digest_(String(body.password || '') + salt) !== props.getProperty('ADMIN_HASH')) return fail_(401, 'Email or password is incorrect.');
  return createSession_(props.getProperty('ADMIN_EMAIL'));
}

function createSession_(email) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('session:' + token, email, SESSION_TTL_SECONDS);
  return ok_({ ok: true, token: token, user: { email: email } });
}
function sessionUser_(token) { const email = token && CacheService.getScriptCache().get('session:' + token); return email ? { email: email } : null; }
function spreadsheet_() { if (SHEET_ID.indexOf('PASTE_') === 0) throw new Error('Add your Google Sheet ID in google-apps-script/Code.gs.'); return SpreadsheetApp.openById(SHEET_ID); }
function sheet_(name, headers) { const ss = spreadsheet_(); let sh = ss.getSheetByName(name); if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); } return sh; }
function readSettings_() {
  const sh = sheet_('Settings', ['key', 'json']), rows = sh.getDataRange().getValues(), chunks = {}, settingRow = rows.slice(1).find(function (r) { return r[0] === SETTINGS_KEY; });
  rows.slice(1).forEach(function (r) { const m = String(r[0] || '').match(/^img:(.+):(\d+)$/); if (m) { chunks[m[1]] = chunks[m[1]] || []; chunks[m[1]][Number(m[2])] = String(r[1] || ''); } });
  if (!settingRow) return { courts: [], instapayUrl: '', instapayQr: '', heroImage: '' };
  try { const value = JSON.parse(settingRow[1]); hydrateImages_(value, chunks); return value; } catch (e) { return { courts: [], instapayUrl: '', instapayQr: '', heroImage: '' }; }
}
function writeSettings_(value) {
  const sh = sheet_('Settings', ['key', 'json']), current = sh.getDataRange().getValues(), rows = [], stored = JSON.parse(JSON.stringify(value)), chunkSize = 40000;
  function pack(owner, key) {
    const image = owner[key];
    if (!validImage_(image)) return;
    const imageKey = 'image_' + Utilities.getUuid().replace(/-/g, '');
    for (let i = 0; i < image.length; i += chunkSize) rows.push(['img:' + imageKey + ':' + (i / chunkSize), image.slice(i, i + chunkSize)]);
    owner[key] = { sheetImageKey: imageKey };
  }
  pack(stored, 'instapayQr'); pack(stored, 'heroImage');
  (stored.courts || []).forEach(function (court) { pack(court, 'image'); });
  rows.unshift([SETTINGS_KEY, JSON.stringify(stored)]);
  const preserved = current.slice(1).filter(function (r) { return r[0] && r[0] !== SETTINGS_KEY && String(r[0]).indexOf('img:') !== 0; });
  sh.clearContents(); sh.getRange(1, 1, 1, 2).setValues([['key', 'json']]);
  const all = rows.concat(preserved);
  if (all.length) sh.getRange(2, 1, all.length, 2).setValues(all);
}
function hydrateImages_(value, chunks) {
  function hydrate(owner, key) { const ref = owner && owner[key]; if (ref && typeof ref === 'object' && ref.sheetImageKey) owner[key] = (chunks[ref.sheetImageKey] || []).join(''); }
  hydrate(value, 'instapayQr'); hydrate(value, 'heroImage'); (value.courts || []).forEach(function (court) { hydrate(court, 'image'); });
}
const BOOKING_HEADERS = ['reference', 'name', 'courtId', 'court', 'dateISO', 'date', 'timesJson', 'minutesJson', 'duration', 'amount', 'status', 'createdAt', 'paidAt'];
function readBookings_() { const sh = sheet_('Bookings', BOOKING_HEADERS), rows = sh.getDataRange().getValues(), timeZone = sh.getParent().getSpreadsheetTimeZone() || BOOKING_TIME_ZONE; return rows.slice(1).filter(function (r) { return r[0]; }).map(function (r) { const times = JSON.parse(r[6] || '[]'), minutes = JSON.parse(r[7] || '[]'), dateISO = normalizeDateISO_(r[4], timeZone); return { reference: r[0], name: r[1], courtId: r[2], court: r[3], dateISO: dateISO, date: validDate_(dateISO) ? formatDate_(dateISO) : String(r[5] || ''), times: times, time: times.join(', '), minutes: minutes, duration: Number(r[8]), amount: Number(r[9]), status: r[10], createdAt: r[11], paidAt: r[12] || '' }; }); }
function appendBooking_(b) { sheet_('Bookings', BOOKING_HEADERS).appendRow([b.reference, b.name, b.courtId, b.court, b.dateISO, b.date, JSON.stringify(b.times), JSON.stringify(b.minutes), b.duration, b.amount, b.status, b.createdAt, b.paidAt]); }
function updateBooking_(reference, change) { const sh = sheet_('Bookings', BOOKING_HEADERS), rows = sh.getDataRange().getValues(); for (let i = 1; i < rows.length; i++) if (rows[i][0] === reference) { const b = readBookings_().find(function (x) { return x.reference === reference; }); change(b); sh.getRange(i + 1, 11, 1, 3).setValues([[b.status, b.createdAt, b.paidAt]]); return; } }
function deleteBooking_(reference) {
  const sh = sheet_('Bookings', BOOKING_HEADERS), rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i > 0; i--) if (rows[i][0] === reference) sh.deleteRow(i + 1);
  const proofSheet = sheet_('BookingProofs', ['reference', 'paymentReference', 'imagePart', 'imageData']), proofRows = proofSheet.getDataRange().getValues();
  for (let i = proofRows.length - 1; i > 0; i--) if (proofRows[i][0] === reference) proofSheet.deleteRow(i + 1);
}
function saveBookingProof_(reference, paymentReference, receiptImage) {
  const sh = sheet_('BookingProofs', ['reference', 'paymentReference', 'imagePart', 'imageData']), rows = sh.getDataRange().getValues(), output = [], chunkSize = 40000;
  for (let i = rows.length - 1; i > 0; i--) if (rows[i][0] === reference) sh.deleteRow(i + 1);
  if (receiptImage) {
    for (let i = 0; i < receiptImage.length; i += chunkSize) output.push([reference, paymentReference, i / chunkSize, receiptImage.slice(i, i + chunkSize)]);
  } else output.push([reference, paymentReference, '', '']);
  if (output.length) sh.getRange(sh.getLastRow() + 1, 1, output.length, 4).setValues(output);
}
function readBookingProofSummaries_() {
  const sh = sheet_('BookingProofs', ['reference', 'paymentReference', 'imagePart', 'imageData']), rows = sh.getDataRange().getValues(), summaries = {};
  rows.slice(1).forEach(function (row) {
    if (!row[0]) return;
    const proof = summaries[row[0]] || { paymentReference: String(row[1] || ''), hasReceipt: false };
    if (row[2] !== '' && row[2] !== null) proof.hasReceipt = true;
    summaries[row[0]] = proof;
  });
  return summaries;
}
function readBookingProof_(reference) {
  const sh = sheet_('BookingProofs', ['reference', 'paymentReference', 'imagePart', 'imageData']), rows = sh.getDataRange().getValues(), matched = rows.slice(1).filter(function (row) { return row[0] === reference; }), parts = [];
  matched.forEach(function (row) { if (row[2] !== '' && row[2] !== null) parts[Number(row[2])] = String(row[3] || ''); });
  return { paymentReference: matched.length ? String(matched[0][1] || '') : '', receiptImage: parts.join('') };
}
function markPaid_(reference) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_(503, 'Bookings are busy. Please try again.');
  try {
    const bookings = readBookings_(), booking = bookings.find(function (b) { return b.reference === reference; });
    if (!booking) return fail_(404, 'Booking not found.');
    const conflict = bookings.some(function (other) {
      return other.reference !== reference && bookingBlocksTime_(other) && other.dateISO === booking.dateISO &&
        (booking.courtId === 'exclusive' || other.courtId === 'exclusive' || other.courtId === booking.courtId) &&
        other.minutes.some(function (minute) { return booking.minutes.indexOf(minute) >= 0; });
    });
    if (conflict) return fail_(409, 'This booking conflicts with a paid booking and cannot be marked paid.');
    const proof = readBookingProof_(reference);
    if (!proof.paymentReference && !proof.receiptImage) {
      updateBooking_(reference, function (row) { row.status = 'Cancelled'; row.paidAt = ''; });
      return ok_({ ok: true, cancelled: true, message: 'No payment proof was submitted. The booking was cancelled and its time is available again.' });
    }
    updateBooking_(reference, function (row) { row.status = 'Paid'; row.paidAt = new Date().toISOString(); });
    return ok_({ ok: true });
  } finally { lock.releaseLock(); }
}
function findBooking_(reference, name) { const b = readBookings_().find(function (x) { return x.reference === String(reference || '').trim() && x.name.toLowerCase() === String(name || '').trim().toLowerCase(); }); return b || null; }
function normalizeCourt_(input) {
  const name = String(input.name || '').trim().slice(0, 80), dayRate = Number(input.dayRate), nightRate = Number(input.nightRate);
  const openingMinute = input.openingMinute === undefined ? 300 : Number(input.openingMinute), closingMinute = input.closingMinute === undefined ? 1320 : Number(input.closingMinute); const dayRateStartMinute = input.dayRateStartMinute === undefined ? openingMinute : Number(input.dayRateStartMinute); const nightRateStartMinute = input.nightRateStartMinute === undefined ? (input.priceChangeMinute === undefined ? 1020 : Number(input.priceChangeMinute)) : Number(input.nightRateStartMinute);
  if (!name || !Number.isFinite(dayRate) || dayRate < 1 || !Number.isFinite(nightRate) || nightRate < 1 || !Number.isInteger(openingMinute) || openingMinute < 0 || openingMinute >= 1440 || openingMinute % 60 || !Number.isInteger(closingMinute) || closingMinute <= openingMinute || closingMinute > 1440 || closingMinute % 60 || !Number.isInteger(dayRateStartMinute) || dayRateStartMinute < openingMinute || dayRateStartMinute >= closingMinute || dayRateStartMinute % 60 || !Number.isInteger(nightRateStartMinute) || nightRateStartMinute <= dayRateStartMinute || nightRateStartMinute >= closingMinute || nightRateStartMinute % 60) return null;
  return { id: input.id || Utilities.getUuid(), name: name, location: String(input.location || '').slice(0, 160), openingMinute: openingMinute, closingMinute: closingMinute, dayRateStartMinute: dayRateStartMinute, nightRateStartMinute: nightRateStartMinute, dayRate: dayRate, nightRate: nightRate, displayPrice: Number(input.displayPrice) || dayRate, maxPlayers: Number(input.maxPlayers) || 10, description: String(input.description || '').slice(0, 1000), image: validImage_(input.image) ? input.image : '' };
}
function validImage_(value) { return typeof value === 'string' && value.length <= 5000000 && /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value); }
function parseQuery_(url) { const query = {}; const part = url.split('?')[1] || ''; part.split('&').forEach(function (p) { if (!p) return; const pair = p.split('='); query[decodeURIComponent(pair[0])] = decodeURIComponent((pair[1] || '').replace(/\+/g, ' ')); }); return query; }
function parseTime_(value) { const m = String(value).match(/^(0?[1-9]|1[0-2]):00\s*(AM|PM)$/i); if (!m) return null; let hour = Number(m[1]) % 12; if (m[2].toUpperCase() === 'PM') hour += 12; return hour * 60; }
function formatTime_(n) { const h = Math.floor(n / 60), hr = h % 12 || 12; return String(hr).padStart(2, '0') + ':00 ' + (h >= 12 ? 'PM' : 'AM'); }
function formatDate_(iso) { const p = iso.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }); }
function validDate_(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }
function validEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function digest_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function ok_(data, status) { return Object.assign({ status: status || 200 }, data); }
function fail_(status, error) { return { status: status, error: error }; }
function message_(error) { return error && error.message ? error.message : String(error); }

