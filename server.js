'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'booking.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bookings (reference TEXT PRIMARY KEY, name TEXT NOT NULL, court_id TEXT NOT NULL, court_name TEXT NOT NULL, date_iso TEXT NOT NULL, date_label TEXT NOT NULL, times TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT);
  CREATE TABLE IF NOT EXISTS booking_slots (date_iso TEXT NOT NULL, court_id TEXT NOT NULL, start_minute INTEGER NOT NULL, reference TEXT NOT NULL REFERENCES bookings(reference) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS booking_slots_date ON booking_slots(date_iso, start_minute);
`);
if (!db.prepare('SELECT value FROM settings WHERE id=1').get()) {
  db.prepare('INSERT INTO settings(id,value) VALUES(1,?)').run(JSON.stringify({ courts: [], instapayUrl: '', instapayQr: '', heroImage: '' }));
}
const statements = {
  settings: db.prepare('SELECT value FROM settings WHERE id=1'),
  saveSettings: db.prepare('UPDATE settings SET value=? WHERE id=1'),
  userCount: db.prepare('SELECT COUNT(*) AS count FROM users'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE'),
  userById: db.prepare('SELECT id,email FROM users WHERE id=?'),
  insertUser: db.prepare('INSERT INTO users(id,email,salt,password_hash,created_at) VALUES(?,?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)'),
  session: db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  booking: db.prepare('SELECT * FROM bookings WHERE reference=?'),
  bookings: db.prepare('SELECT * FROM bookings ORDER BY created_at DESC'),
  deleteBooking: db.prepare('DELETE FROM bookings WHERE reference=?'),
};
const PORT = Number(process.env.PORT || 3000);
const SESSION_MS = 12 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';
const loginAttempts = new Map();
const siteOrigin = process.env.SITE_ORIGIN || '';
const setupToken = process.env.ADMIN_SETUP_TOKEN || randomBytes(32).toString('base64url');
if (statements.userCount.get().count === 0) console.log(`One-time initial admin setup token: ${setupToken}`);

function settings() { return JSON.parse(statements.settings.get().value); }
function send(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function fail(res, status, message) { send(res, status, { error: message }); }
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; frame-src https://www.google.com https://script.google.com https://script.googleusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://script.google.com; frame-ancestors 'none'; upgrade-insecure-requests");
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function cookieValue(req, name) {
  const part = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function currentUser(req) {
  const token = cookieValue(req, 'sp_session');
  if (!token) return null;
  const row = statements.session.get(tokenHash(token));
  if (!row || row.expires_at < Date.now()) {
    if (row) statements.deleteSession.run(tokenHash(token));
    return null;
  }
  return statements.userById.get(row.user_id) || null;
}
function cookieOptions(maxAge) {
  return `sp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (siteOrigin) return origin === siteOrigin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = isProduction ? 'https' : (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return origin === `${proto}://${host}`;
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 7 * 1024 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON request.'), { status: 400 }); }
}
function cleanText(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function parseTime(label) {
  const match = /^(\d{1,2}):(00)\s*(AM|PM)$/i.exec(String(label));
  if (!match) return null;
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  const minute = hour * 60;
  return minute >= 300 && minute <= 1260 ? minute : null;
}
function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-PH', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
}
function validIsoDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; }
function jsonBooking(row) {
  return { reference: row.reference, name: row.name, court: row.court_name, courtId: row.court_id, date: row.date_label, dateISO: row.date_iso, times: JSON.parse(row.times), time: JSON.parse(row.times).join(', '), duration: JSON.parse(row.times).length, amount: row.amount, status: row.status, createdAt: row.created_at, paidAt: row.paid_at || '' };
}
function normalizeCourt(input) {
  const name = cleanText(input.name, 80);
  const dayRate = Number(input.dayRate), nightRate = Number(input.nightRate);
  if (!name || !Number.isInteger(dayRate) || !Number.isInteger(nightRate) || dayRate < 1 || nightRate < 1 || dayRate > 100000 || nightRate > 100000) return null;
  const image = cleanText(input.image, 5_000_000);
  if (image && !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(image)) return null;
  return { id: cleanText(input.id, 80) || `court-${randomUUID()}`, name, location: cleanText(input.location, 160) || 'Sweat Paddle Court', dayRate, nightRate, displayPrice: Math.max(1, Math.min(100000, Number(input.displayPrice) || dayRate)), maxPlayers: Math.max(1, Math.min(100, Number(input.maxPlayers) || 10)), hours: 'Daily · 5AM–10PM', description: cleanText(input.description, 1000), image };
}
function adminOnly(req, res) {
  if (currentUser(req)) return true;
  fail(res, 401, 'Admin sign-in required.');
  return false;
}
function hitRateLimit(key, max, windowMs) {
  const now = Date.now();
  const row = loginAttempts.get(key) || { count: 0, start: now };
  if (now - row.start > windowMs) { row.count = 0; row.start = now; }
  row.count++;
  loginAttempts.set(key, row);
  return row.count > max;
}

async function handleApi(req, res, url) {
  const method = req.method;
  const route = url.pathname;
  if (method === 'GET' && route === '/api/public') {
    const data = settings();
    return send(res, 200, { settings: data, adminSetupRequired: statements.userCount.get().count === 0 });
  }
  if (method === 'GET' && route === '/api/availability') {
    const date = url.searchParams.get('date') || '', courtId = url.searchParams.get('courtId') || '';
    if (!validIsoDate(date) || !courtId) return fail(res, 400, 'Choose a valid date and court.');
    const rows = db.prepare("SELECT DISTINCT s.start_minute FROM booking_slots s JOIN bookings b ON b.reference=s.reference WHERE s.date_iso=? AND b.status='Paid' AND (?='exclusive' OR s.court_id=? OR s.court_id='exclusive')").all(date, courtId, courtId);
    return send(res, 200, { booked: rows.map(row => row.start_minute) });
  }
  if (method === 'POST' && route === '/api/bookings') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (hitRateLimit(`booking:${ip}`, 20, 60 * 60 * 1000)) return fail(res, 429, 'Too many booking attempts. Please try again later.');
    const body = await readBody(req);
    const name = cleanText(body.name, 80), courtId = cleanText(body.courtId, 80), date = cleanText(body.dateISO, 10);
    const times = Array.isArray(body.times) ? [...new Set(body.times)].slice(0, 17) : [];
    if (name.length < 2 || !validIsoDate(date) || date < new Date().toISOString().slice(0, 10) || !times.length) return fail(res, 400, 'Enter your name, choose a valid date, and select at least one hour.');
    const court = settings().courts.find(c => c.id === courtId);
    if (!court) return fail(res, 400, 'That court is no longer available. Refresh and try again.');
    const starts = times.map(parseTime);
    if (starts.some(v => v === null) || new Set(starts).size !== starts.length) return fail(res, 400, 'One or more selected times are invalid.');
    const ordered = [...starts].sort((a, b) => a - b);
    if (courtId === 'exclusive' && ordered.length > 1) return fail(res, 400, 'Exclusive court bookings must be reserved one hour at a time.');
    const amount = ordered.reduce((sum, minute) => sum + (minute < 1020 ? Number(court.dayRate) : Number(court.nightRate)), 0);
    const reference = `SP-${randomBytes(16).toString('hex').toUpperCase()}`;
    const labels = ordered.map(minute => `${String((Math.floor(minute / 60) + 11) % 12 + 1).padStart(2, '0')}:00 ${minute / 60 >= 12 ? 'PM' : 'AM'}`);
    const insert = db.prepare('INSERT INTO bookings(reference,name,court_id,court_name,date_iso,date_label,times,amount,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const slotInsert = db.prepare('INSERT INTO booking_slots(date_iso,court_id,start_minute,reference) VALUES(?,?,?,?)');
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const minute of ordered) {
        const conflict = db.prepare("SELECT 1 FROM booking_slots s JOIN bookings b ON b.reference=s.reference WHERE s.date_iso=? AND s.start_minute=? AND b.status='Paid' AND (?='exclusive' OR s.court_id=? OR s.court_id='exclusive') LIMIT 1").get(date, minute, courtId, courtId);
        if (conflict) { db.exec('ROLLBACK'); return fail(res, 409, 'That time was just booked. Please choose another available time.'); }
      }
      insert.run(reference, name, courtId, court.name, date, formatDate(date), JSON.stringify(labels), amount, 'Awaiting payment', new Date().toISOString());
      for (const minute of ordered) slotInsert.run(date, courtId, minute, reference);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return send(res, 201, { booking: jsonBooking(statements.booking.get(reference)), settings: settings() });
  }
  if (method === 'POST' && route === '/api/bookings/report') {
    const body = await readBody(req), reference = cleanText(body.reference, 40), name = cleanText(body.name, 80);
    const row = statements.booking.get(reference);
    if (!row || row.name.toLowerCase() !== name.toLowerCase()) return fail(res, 404, 'No booking matched that reference and name.');
    if (row.status === 'Awaiting payment') db.prepare("UPDATE bookings SET status='Payment reported' WHERE reference=?").run(reference);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && route === '/api/bookings/track') {
    const body = await readBody(req), reference = cleanText(body.reference, 40), name = cleanText(body.name, 80);
    const row = statements.booking.get(reference);
    if (!row || row.name.toLowerCase() !== name.toLowerCase()) return fail(res, 404, 'No booking matched that reference and name.');
    const booking = jsonBooking(row); delete booking.name;
    return send(res, 200, { booking });
  }
  if (method === 'POST' && route === '/api/admin/setup') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (hitRateLimit(`setup:${ip}`, 5, 15 * 60 * 1000)) return fail(res, 429, 'Too many setup attempts. Please wait and try again.');
    if (statements.userCount.get().count !== 0) return fail(res, 409, 'Admin setup is already complete. Sign in instead.');
    const body = await readBody(req), email = cleanText(body.email, 254).toLowerCase(), password = typeof body.password === 'string' ? body.password : '', token = typeof body.setupToken === 'string' ? body.setupToken : '';
    const supplied = Buffer.from(token), expectedToken = Buffer.from(setupToken);
    if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) return fail(res, 403, 'The one-time setup token is incorrect. Check the Node server log or ADMIN_SETUP_TOKEN setting.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 200) return fail(res, 400, 'Enter a valid email and a password of at least 12 characters.');
    const salt = randomBytes(16).toString('hex'), hash = scryptSync(password, salt, 64).toString('hex'), id = randomUUID();
    try { db.exec('BEGIN IMMEDIATE'); if (statements.userCount.get().count !== 0) { db.exec('ROLLBACK'); return fail(res, 409, 'Admin setup is already complete.'); } statements.insertUser.run(id, email, salt, hash, new Date().toISOString()); db.exec('COMMIT'); }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return createSession(res, id);
  }
  if (method === 'POST' && route === '/api/admin/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (hitRateLimit(`login:${ip}`, 8, 15 * 60 * 1000)) return fail(res, 429, 'Too many sign-in attempts. Please wait 15 minutes.');
    const body = await readBody(req), email = cleanText(body.email, 254).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
    const user = statements.userByEmail.get(email);
    if (!user) { scryptSync(password.slice(0, 200), 'invalid-user-salt', 64); return fail(res, 401, 'Email or password is incorrect.'); }
    const actual = scryptSync(password, user.salt, 64), expected = Buffer.from(user.password_hash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(res, 401, 'Email or password is incorrect.');
    loginAttempts.delete(`login:${ip}`);
    return createSession(res, user.id);
  }
  if (method === 'GET' && route === '/api/admin/me') {
    const user = currentUser(req);
    return user ? send(res, 200, { user }) : fail(res, 401, 'Admin sign-in required.');
  }
  if (method === 'POST' && route === '/api/admin/logout') {
    const token = cookieValue(req, 'sp_session'); if (token) statements.deleteSession.run(tokenHash(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieOptions(0) });
  }
  if (method === 'GET' && route === '/api/admin/dashboard') {
    if (!adminOnly(req, res)) return;
    return send(res, 200, { settings: settings(), bookings: statements.bookings.all().map(jsonBooking), user: currentUser(req) });
  }
  if (method === 'POST' && route === '/api/admin/courts') {
    if (!adminOnly(req, res)) return;
    const body = await readBody(req), court = normalizeCourt(body);
    if (!court) return fail(res, 400, 'Check the court details, prices, and image format (PNG, JPEG, or WebP under 3 MB).');
    const data = settings(); data.courts.push(court); statements.saveSettings.run(JSON.stringify(data));
    return send(res, 201, { court });
  }
  const courtRoute = /^\/api\/admin\/courts\/([^/]+)$/.exec(route);
  if (courtRoute && ['PATCH', 'DELETE'].includes(method)) {
    if (!adminOnly(req, res)) return;
    const id = decodeURIComponent(courtRoute[1]), data = settings(), index = data.courts.findIndex(c => c.id === id);
    if (index < 0) return fail(res, 404, 'Court not found.');
    if (method === 'DELETE') data.courts.splice(index, 1);
    else { const body = await readBody(req), court = normalizeCourt({ ...data.courts[index], ...body, id }); if (!court) return fail(res, 400, 'Check the court details and image format.'); data.courts[index] = court; }
    statements.saveSettings.run(JSON.stringify(data));
    return send(res, 200, { settings: data });
  }
  if (method === 'PATCH' && route === '/api/admin/settings') {
    if (!adminOnly(req, res)) return;
    const body = await readBody(req), data = settings();
    if ('instapayUrl' in body) { const value = cleanText(body.instapayUrl, 500); if (value && !/^https:\/\//i.test(value)) return fail(res, 400, 'Payment links must use HTTPS.'); data.instapayUrl = value; }
    for (const key of ['instapayQr', 'heroImage']) if (key in body) { const image = cleanText(body[key], 5_000_000); if (image && !/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(image)) return fail(res, 400, 'Image must be PNG, JPEG, GIF, or WebP.'); data[key] = image; }
    statements.saveSettings.run(JSON.stringify(data));
    return send(res, 200, { settings: data });
  }
  if (method === 'PATCH' && route === '/api/admin/password') {
    if (!adminOnly(req, res)) return;
    const body = await readBody(req), oldPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '', newPassword = typeof body.newPassword === 'string' ? body.newPassword : '', email = cleanText(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Enter a valid admin email.');
    if (newPassword && (newPassword.length < 12 || newPassword.length > 200)) return fail(res, 400, 'New password must be at least 12 characters.');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(currentUser(req).id), oldHash = scryptSync(oldPassword, user.salt, 64), expected = Buffer.from(user.password_hash, 'hex');
    if (!timingSafeEqual(oldHash, expected)) return fail(res, 401, 'Current password is incorrect.');
    if (statements.userByEmail.get(email) && email !== user.email.toLowerCase()) return fail(res, 409, 'That email is already in use.');
    if (newPassword) {
      const salt = randomBytes(16).toString('hex'), hash = scryptSync(newPassword, salt, 64).toString('hex');
      db.prepare('UPDATE users SET email=?,salt=?,password_hash=? WHERE id=?').run(email, salt, hash, user.id);
    } else db.prepare('UPDATE users SET email=? WHERE id=?').run(email, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    return createSession(res, user.id);
  }
  const bookingRoute = /^\/api\/admin\/bookings\/([^/]+)$/.exec(route);
  if (bookingRoute && ['PATCH', 'DELETE'].includes(method)) {
    if (!adminOnly(req, res)) return;
    const reference = decodeURIComponent(bookingRoute[1]);
    if (method === 'DELETE') statements.deleteBooking.run(reference);
    else {
      const body = await readBody(req);
      if (body.status !== 'Paid') return fail(res, 400, 'Unsupported booking status.');
      const booking = statements.booking.get(reference);
      if (!booking) return fail(res, 404, 'Booking not found.');
      const slots = db.prepare('SELECT date_iso,court_id,start_minute FROM booking_slots WHERE reference=?').all(reference);
      for (const slot of slots) {
        const conflict = db.prepare("SELECT 1 FROM booking_slots s JOIN bookings b ON b.reference=s.reference WHERE s.date_iso=? AND s.start_minute=? AND s.reference<>? AND b.status='Paid' AND (?='exclusive' OR s.court_id=? OR s.court_id='exclusive') LIMIT 1").get(slot.date_iso, slot.start_minute, reference, booking.court_id, booking.court_id);
        if (conflict) return fail(res, 409, 'This booking conflicts with a paid booking and cannot be marked paid.');
      }
      db.prepare("UPDATE bookings SET status='Paid',paid_at=? WHERE reference=?").run(new Date().toISOString(), reference);
    }
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, 'API route not found.');
}
function createSession(res, userId) {
  const token = randomBytes(32).toString('base64url'), expires = Date.now() + SESSION_MS;
  statements.insertSession.run(tokenHash(token), userId, expires);
  const cookie = `sp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${isProduction ? '; Secure' : ''}`;
  const user = statements.userById.get(userId);
  return send(res, 200, { ok: true, user }, { 'Set-Cookie': cookie });
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return fail(res, 403, 'Cross-origin request rejected.');
      return await handleApi(req, res, url);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'Method not allowed.');
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const publicFiles = new Set(['index.html', 'app.js', 'hero-court.jpg', 'sweat-paddle-cover.jpg', 'sweat-paddle-logo.jpg']);
    if (!publicFiles.has(relative)) return fail(res, 404, 'Not found.');
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT + path.sep) || ['server.js', 'package.json', 'README.md', 'vercel.json', '_headers'].includes(path.basename(target))) return fail(res, 404, 'Not found.');
    let stat; try { stat = fs.statSync(target); } catch { return fail(res, 404, 'Not found.'); }
    if (!stat.isFile()) return fail(res, 404, 'Not found.');
    res.writeHead(200, { 'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    console.error('Request failed:', error);
    if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : 'Server error. Please try again.');
    else res.destroy();
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Sweat Paddle booking server listening on port ${PORT}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
