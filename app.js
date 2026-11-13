'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const modal = $('#modal'), modalContent = $('#modalContent');
  const dateInput = $('#date');
  const BOOKING_TIME_ZONE = 'Asia/Manila';
  function bookingClock() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BOOKING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type).value;
    return { dateISO: value('year') + '-' + value('month') + '-' + value('day'), minuteOfDay: Number(value('hour')) * 60 + Number(value('minute')) };
  }
  const localDate = bookingClock().dateISO;
  dateInput.min = localDate;
  dateInput.value = localDate;
  let settings = { courts: [], instapayUrl: '', instapayQr: '', heroImage: '' };
  let adminSetupRequired = true;
  let adminEmail = '';

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function openModal(html, admin = false) {
    modalContent.innerHTML = html;
    const box = $('.modal', modal);
    box.classList.toggle('admin-modal', admin);
    modal.classList.add('open');
  }
  function closeModal() { modal.classList.remove('open'); }
  $('#close').addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-close-modal]')) closeModal(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

  async function api(path, options = {}) {
    const endpoint = window.BOOKING_API_URL || '';
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint)) throw new Error('Booking API is not configured yet. Follow the Google Sheets setup in README.md.');
    const method = options.method || 'GET';
    let body = {};
    if (options.body) { try { body = JSON.parse(options.body); } catch { body = {}; } }
    const packet = { requestId: crypto.randomUUID(), method, path, body, token: sessionStorage.getItem('sp_admin_token') || '' };
    const response = await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'), form = document.createElement('form'), field = document.createElement('input');
      const frameName = `booking_api_${packet.requestId.replace(/-/g, '')}`;
      frame.name = frameName; frame.hidden = true; frame.setAttribute('aria-hidden', 'true');
      form.method = 'POST'; form.action = endpoint; form.target = frameName; form.hidden = true;
      field.type = 'hidden'; field.name = 'packet'; field.value = JSON.stringify(packet); form.append(field);
      const cleanup = () => { window.removeEventListener('message', onMessage); window.clearTimeout(timeout); form.remove(); frame.remove(); };
      const onMessage = event => {
        if (!event.data || event.data.requestId !== packet.requestId) return;
        cleanup(); resolve(event.data.result || {});
      };
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('Google Sheets did not respond. Check the Apps Script deployment and try again.')); }, 30000);
      window.addEventListener('message', onMessage); document.body.append(frame, form); form.submit();
    });
    if (response.status < 200 || response.status >= 300) throw new Error(response.error || `Request failed (${response.status}).`);
    if ((path === '/api/admin/setup' || path === '/api/admin/login') && response.token) sessionStorage.setItem('sp_admin_token', response.token);
    if (path === '/api/admin/logout') sessionStorage.removeItem('sp_admin_token');
    return response;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
  function showError(message) { openModal(`<div class="success"><h2 id="modalTitle">Couldn’t complete that</h2><p>${escapeHtml(message)}</p><button class="pill" data-close-modal>Close</button></div>`); }
  function showNotice(node, message, error = true) { node.textContent = message; node.style.color = error ? '#ba3b20' : '#087c7a'; }
  function safeImage(value) {
    if (typeof value !== 'string' || value.length > 5_000_000) return '';
    if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
    if (/^https:\/\/[a-z0-9.-]+(?::\d+)?\/[a-z0-9_./%?=#&+-]*$/i.test(value)) return value;
    return '';
  }
  function safePaymentLink(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } }
  function money(value) { return `₱${Number(value || 0).toLocaleString('en-PH')}`; }
  function formatTime(minute) {
    const hour24 = Math.floor(minute / 60), hour = hour24 % 12 || 12;
    return `${hour}:${String(minute % 60).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
  }
  function courtHours(court) { const opening = Number.isInteger(Number(court.openingMinute)) ? Number(court.openingMinute) : 300; return { opening: opening, closing: Number.isInteger(Number(court.closingMinute)) ? Number(court.closingMinute) : 1320, dayRateStart: Number.isInteger(Number(court.dayRateStartMinute)) ? Number(court.dayRateStartMinute) : opening, nightRateStart: Number.isInteger(Number(court.nightRateStartMinute)) ? Number(court.nightRateStartMinute) : (Number.isInteger(Number(court.priceChangeMinute)) ? Number(court.priceChangeMinute) : 1020) }; }
  function timeChoicesFor(court) { const hours = courtHours(court), choices = []; for (let start = hours.opening; start + 60 <= hours.closing; start += 60) choices.push({ start, label: formatTime(start) + '–' + formatTime(start + 60) }); return choices; }
  function rateFor(court, minute) { const h = courtHours(court); return Number(minute >= h.dayRateStart && minute < h.nightRateStart ? court.dayRate : court.nightRate); }
  function timeInputValue(minute) { if (minute === 1440) minute = 0; return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'); }
  function timeInputMinute(value, closing) { if (closing && value === '00:00') return 1440; const parts = value.split(':').map(Number); return parts[0] * 60 + parts[1]; }
  function pricingRows(court) { const h = courtHours(court), rows = []; if (h.dayRateStart > h.opening) rows.push(formatTime(h.opening) + ' - ' + formatTime(h.dayRateStart) + ': <strong>' + money(court.nightRate) + '/hr</strong>'); if (Math.min(h.nightRateStart, h.closing) > h.dayRateStart) rows.push(formatTime(h.dayRateStart) + ' - ' + formatTime(Math.min(h.nightRateStart, h.closing)) + ': <strong>' + money(court.dayRate) + '/hr</strong>'); if (h.closing > h.nightRateStart) rows.push(formatTime(h.nightRateStart) + ' - ' + formatTime(h.closing) + ': <strong>' + money(court.nightRate) + '/hr</strong>'); return rows.map(row => '<div>' + row + '</div>').join(''); }

  function renderHero() {
    const images = [settings.heroImage, ...settings.courts.map(court => court.image)].map(safeImage).filter(Boolean);
    const image = $('#heroImage'), placeholder = $('#heroPlaceholder'), controls = $('#heroCarouselControls');
    if (images.length) { image.src = images[0]; image.classList.add('visible'); placeholder.classList.add('hidden'); }
    else { image.removeAttribute('src'); image.classList.remove('visible'); placeholder.classList.remove('hidden'); }
    controls.hidden = true;
  }
  function renderCourts() {
    const grid = $('#courtGrid');
    if (!settings.courts.length) {
      grid.innerHTML = '<div class="empty-state court-empty"><span class="empty-courts-icon">＋</span><h2>No courts listed yet</h2><p>New courts will appear here when the admin adds them.</p></div>';
      return;
    }
    grid.innerHTML = settings.courts.map(court => {
      const photo = safeImage(court.image);
      return `<article class="court-card"><div class="court-cover"><div class="cover-roof"></div><div class="cover-floor"></div><div class="cover-net"></div>${photo ? `<img src="${photo}" alt="${escapeHtml(court.name)} at Sweat Paddle Court">` : ''}<span class="court-badge">Daily · ${formatTime(courtHours(court).opening)}–${formatTime(courtHours(court).closing)}</span><span class="available-badge">Available</span></div><div class="court-body"><div class="court-title-row"><div><h2>${escapeHtml(court.name)}</h2><div class="court-loc">⌖ ${escapeHtml(court.location || 'Sweat Paddle Court')}</div></div><div class="court-price">${money(court.displayPrice || court.dayRate)}<small>/ hour</small></div></div><p class="court-desc">${escapeHtml(court.description || '')}</p><a class="details-link" href="#" data-details="${escapeHtml(court.id)}">See full description →</a><div class="time-pricing"><div class="pricing-head">₱ &nbsp;Time-Based Pricing</div>${pricingRows(court)}</div><div class="court-foot"><span class="pax">♙ &nbsp;Up to ${escapeHtml(court.maxPlayers || 10)} pax</span><button class="book-now" data-book="${escapeHtml(court.id)}">Book Now</button></div></div></article>`;
    }).join('');
    grid.querySelectorAll('[data-book]').forEach(button => button.addEventListener('click', () => openBooking(button.dataset.book)));
    grid.querySelectorAll('[data-details]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault(); const court = settings.courts.find(item => item.id === link.dataset.details); if (!court) return;
      openModal(`<h2 id="modalTitle">${escapeHtml(court.name)}</h2><p>${escapeHtml(court.description || '')}</p><p><b>${escapeHtml(court.location || 'Sweat Paddle Court')}</b> · Up to ${escapeHtml(court.maxPlayers || 10)} players</p><button class="pill" data-close-modal>Close</button>`);
    }));
  }
  function refreshPublic() { renderCourts(); renderHero(); }

  function showPayment(booking, siteSettings = settings) {
    const qr = safeImage(siteSettings.instapayQr), link = safePaymentLink(siteSettings.instapayUrl);
    const configured = Boolean(qr || link);
    const paymentLink = link ? `<a class="pill" style="display:block;text-align:center;text-decoration:none" href="${link}" target="_blank" rel="noopener noreferrer">Open payment link ↗</a>` : '';
    openModal(`<h2 id="modalTitle">Complete your payment</h2><p>Scan the QR code or use the payment link, then send your proof below.</p><div class="payment-card"><div class="payment-reference">${escapeHtml(booking.reference)}</div><div class="summary"><b>${escapeHtml(booking.court)}</b><br>${escapeHtml(booking.date)} · ${escapeHtml(booking.time)} · ${booking.duration} hour${booking.duration === 1 ? '' : 's'}<br>Booked by ${escapeHtml(booking.name)}<br><b>Amount: ${money(booking.amount)}</b></div>${qr ? `<img class="payment-qr" src="${qr}" alt="InstaPay QR code"><a class="payment-qr-download" href="${qr}" download="sweat-paddle-court-payment-qr">Download QR image</a>` : ''}${paymentLink}<p class="payment-help">After paying, upload a screenshot of your payment or enter the payment reference number. The club will verify it before confirming your booking.</p></div><div class="payment-proof-form"><label for="paymentReferenceInput">Payment reference number</label><input id="paymentReferenceInput" type="text" maxlength="120" autocomplete="off" placeholder="Enter the reference from your payment"><label for="paymentReceiptInput">Or upload a payment receipt</label><input id="paymentReceiptInput" type="file" accept="image/png,image/jpeg,image/webp"><p class="payment-help">Provide at least one: a receipt image or a payment reference number.</p><div id="paymentProofMessage" class="payment-help" role="status"></div><button class="pill" id="submitPaymentProof" ${configured ? '' : 'disabled'}>${configured ? 'Submit payment proof' : 'Payment details not set up yet'}</button></div>`);
    $('#submitPaymentProof')?.addEventListener('click', async () => {
      const message = $('#paymentProofMessage'), paymentReference = $('#paymentReferenceInput').value.trim(), file = $('#paymentReceiptInput').files[0];
      if (!paymentReference && (!file || !file.name)) return showNotice(message, 'Upload a receipt image or enter a payment reference number.');
      try {
        const receiptImage = await imageFileData(file);
        await post('/api/bookings/report', { reference: booking.reference, name: booking.name, paymentReference, receiptImage });
        openModal(`<div class="success"><div class="success-icon">🧾</div><h2 id="modalTitle">Payment proof received</h2><p>Your payment proof was sent to the club. They will verify it before confirming your booking.</p><div class="summary payment-receipt"><div class="payment-reference">${escapeHtml(booking.reference)}</div><b>${escapeHtml(booking.court)}</b><br>${escapeHtml(booking.date)} · ${escapeHtml(booking.time)}<br>Booked by ${escapeHtml(booking.name)}<br><b>Amount: ${money(booking.amount)}</b><p class="payment-help">Payment status: Awaiting club verification</p></div><button class="pill" data-close-modal>Done</button></div>`);
      } catch (error) { showNotice(message, error.message); }
    });
  }

  function openBooking(courtId) {
    const court = settings.courts.find(item => item.id === courtId); if (!court) return;
    const bookingDay = bookingClock().dateISO;
    openModal(`<h2 id="modalTitle">Book ${escapeHtml(court.name)}</h2><p>Choose one or more open hours, then enter your name.</p><div class="summary"><b>${escapeHtml(court.name)}</b><br>${escapeHtml(court.location || 'Sweat Paddle Court')}</div><div class="modal-fields"><label>Date<input id="bookingDate" type="date" min="${bookingDay}" value="${bookingDay}" required></label><div><label>Available times · select multiple</label><div class="slots" id="bookingSlots"></div><div id="bookingPendingWarning" class="pending-booking-warning" role="alert" hidden></div></div><label>Your name<input id="bookingName" maxlength="80" required autocomplete="name" placeholder="Name"></label></div><p id="bookingPrice" class="payment-help">Select times to see your total.</p><p id="bookingError" class="payment-help" role="alert"></p><a class="booking-facebook-contact" href="https://www.facebook.com/profile.php?id=61595968972214" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path fill="#fff" d="M13.4 20v-7.1h2.4l.4-2.8h-2.8V8.3c0-.8.2-1.4 1.4-1.4h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.8h2.4V20z"/></svg>Need booking confirmation? Message us on Facebook ↗</a><button class="pill" id="submitBooking">Continue to payment →</button>`);
    const date = $('#bookingDate'), slotBox = $('#bookingSlots'), price = $('#bookingPrice'), error = $('#bookingError'), pendingWarning = $('#bookingPendingWarning'), selected = new Map(); let pending = new Set();
    function updatePendingWarning() { const hasPendingSelection = [...selected.keys()].some(minute => pending.has(minute)); pendingWarning.hidden = !hasPendingSelection; if (hasPendingSelection) pendingWarning.innerHTML = '<svg class="facebook-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path fill="#fff" d="M13.4 20v-7.1h2.4l.4-2.8h-2.8V8.3c0-.8.2-1.4 1.4-1.4h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.8h2.4V20z"/></svg><span>This hour has a payment waiting for club verification. Your request may be voided if the earlier booking is confirmed. Check with the club before paying: <a href="https://www.facebook.com/profile.php?id=61595968972214" target="_blank" rel="noopener noreferrer">Message us on Facebook ↗</a></span>'; }
    async function loadSlots(reset = false) {
      if (reset) { selected.clear(); $('#bookingPendingWarning').hidden = true; } slotBox.textContent = 'Loading availability…';
      try {
        const data = await api(`/api/availability?date=${encodeURIComponent(date.value)}&courtId=${encodeURIComponent(courtId)}`), busy = new Set(data.booked); pending = new Set(data.pending || []);
        slotBox.replaceChildren(); let openCount = 0;
        const now = bookingClock();
        for (const slot of timeChoicesFor(court)) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'slot'; const isPast = date.value === now.dateISO && slot.start < now.minuteOfDay, isBooked = busy.has(slot.start), isPending = pending.has(slot.start) && !isBooked; if (isBooked) { button.classList.add('booked'); button.style.backgroundColor = '#f8652a'; button.style.borderColor = '#f8652a'; button.style.color = '#fff'; button.style.opacity = '1'; } if (isPending) button.classList.add('pending-slot'); button.innerHTML = `<span class="slot-label">${slot.label}${isBooked ? ' · Booked' : isPast ? ' · Past' : ''}</span>${isPending ? '<span class="pending-slot-marker" role="img" aria-label="Pending booking awaiting verification"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M36 12A18 18 0 1 0 41 27" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M31 5h12v12M31 5l12 12M18 17h12M18 31h12M19 17c0 7 10 7 10 14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><small>Pending review</small></span>' : ''}`; button.setAttribute('aria-label', `${slot.label}${isPending ? ' · Pending booking awaiting verification' : isBooked ? ' · Booked' : isPast ? ' · Past' : ''}`); button.disabled = isBooked || isPast;
          if (button.disabled) selected.delete(slot.start);
          else { openCount++; if (selected.has(slot.start)) button.classList.add('selected'); }
          button.addEventListener('click', () => { if (selected.has(slot.start)) { selected.delete(slot.start); button.classList.remove('selected'); } else { selected.set(slot.start, slot.label); button.classList.add('selected'); } updatePrice(); updatePendingWarning(); }); slotBox.append(button);
        }
        if (!openCount) slotBox.textContent = 'No times left for this date.';
        updatePrice(); updatePendingWarning();
      } catch (err) { slotBox.textContent = 'Availability could not load. Please refresh and try again.'; showNotice(error, err.message); }
    }
    function updatePrice() {
      const chosen = [...selected.entries()].sort((a, b) => a[0] - b[0]);
      const total = chosen.reduce((sum, [minute]) => sum + rateFor(court, minute), 0);
      price.textContent = chosen.length ? `${chosen.length} hour${chosen.length === 1 ? '' : 's'} · ${chosen.map(([minute]) => `${formatTime(minute)}–${formatTime(minute + 60)}`).join(', ')} · ${money(total)} total` : 'Select times to see your total.';
    }
    date.addEventListener('change', () => loadSlots(true));
    $('#submitBooking').addEventListener('click', async () => {
      const name = $('#bookingName').value.trim(), times = [...selected.keys()].sort((a, b) => a - b).map(formatTime);
      if (name.length < 2 || !times.length) return showNotice(error, 'Enter your name and choose at least one hour.');
      const button = $('#submitBooking'); button.disabled = true; button.textContent = 'Reserving…';
      try { const data = await post('/api/bookings', { name, courtId, dateISO: date.value, times }); closeModal(); showPayment(data.booking, data.settings); }
      catch (err) { showNotice(error, err.message); button.disabled = false; button.textContent = 'Continue to payment →'; if (err.message.includes('just booked') || err.message.includes('already passed')) await loadSlots(); }
    });
    loadSlots(true);
  }

  function openTrack() {
    openModal(`<h2 id="modalTitle">Track your booking</h2><p>Enter the booking reference and the name used when booking.</p><form id="trackForm" class="modal-fields"><input name="reference" required placeholder="Booking reference"><input name="name" required placeholder="Your name"><button class="pill">Find booking</button><div id="trackResult" class="payment-help" role="status"></div></form>`);
    $('#trackForm').addEventListener('submit', async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget), result = $('#trackResult');
      try { const data = await post('/api/bookings/track', { reference: form.get('reference').trim(), name: form.get('name').trim() }), booking = data.booking; result.textContent = `${booking.court} · ${booking.date} · ${booking.time} · ${booking.status}`; }
      catch (error) { result.textContent = error.message; }
    });
  }
  $('#trackBookingLink').addEventListener('click', event => { event.preventDefault(); openTrack(); });

  function adminLogin() {
    const setup = adminSetupRequired;
    openModal(`<h2 id="modalTitle">${setup ? 'Create the admin account' : 'Admin sign-in'}</h2><p>${setup ? 'Create the first admin account. Enter the ADMIN_SETUP_TOKEN value you saved in Apps Script project settings.' : 'Sign in to manage courts and bookings.'}</p><form id="adminLoginForm" class="modal-fields">${setup ? '<label>One-time setup token<input name="setupToken" minlength="6" required autocomplete="off"></label><label>Admin email<input name="email" type="email" maxlength="254" required autocomplete="email" placeholder="you@example.com"></label>' : '<label>Email<input name="email" type="email" maxlength="254" required autocomplete="username" placeholder="you@example.com"></label>'}<label>Password<input name="password" type="password" minlength="12" maxlength="200" required autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? 'At least 12 characters' : 'Password'}"></label><div class="payment-help" id="adminLoginError" role="alert"></div><button class="pill">${setup ? 'Create admin account' : 'Sign in'}</button></form>`);
    $('#adminLoginForm').addEventListener('submit', async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget), message = $('#adminLoginError');
      const path = setup ? '/api/admin/setup' : '/api/admin/login';
      try { await post(path, { email: form.get('email').trim(), password: form.get('password'), setupToken: form.get('setupToken') }); adminSetupRequired = false; await openAdmin(); }
      catch (error) { showNotice(message, error.message); }
    });
  }
  async function openAdmin() {
    try { const data = await api('/api/admin/me'); adminEmail = data.user.email; await renderAdmin(); }
    catch { const data = await api('/api/public'); adminSetupRequired = data.adminSetupRequired; adminLogin(); }
  }
  function imageFileData(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.name) return resolve('');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 3 * 1024 * 1024) return reject(new Error('Choose a PNG, JPEG, GIF, or WebP image under 3 MB.'));
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read that image.')); reader.readAsDataURL(file);
    });
  }
  function courtForm(court = {}) {
    return `<form class="admin-box courtForm" data-court-id="${escapeHtml(court.id || '')}"><h3>${court.id ? `Edit ${escapeHtml(court.name)}` : 'Add a court'}</h3><div class="admin-grid"><label>Name<input name="name" maxlength="80" required value="${escapeHtml(court.name || '')}" placeholder="Court 1"></label><label>Location / court type<input name="location" maxlength="160" value="${escapeHtml(court.location || '')}" placeholder="Covered court"></label><label>Opens at<input name="openingTime" type="time" step="3600" required value="${timeInputValue(courtHours(court).opening)}"></label><label>Closes at<input name="closingTime" type="time" step="3600" required value="${timeInputValue(courtHours(court).closing)}"><small>Choose 12:00 AM for midnight.</small></label><label>Day rate starts at<input name="dayRateStartTime" type="time" step="3600" required value="${timeInputValue(courtHours(court).dayRateStart)}"></label><label>Day price/hour (₱)<input name="dayRate" type="number" min="1" max="100000" required value="${Number(court.dayRate) || 300}"></label><label>Night rate starts at<input name="nightRateStartTime" type="time" step="3600" required value="${timeInputValue(courtHours(court).nightRateStart)}"></label><label>Night price/hour (₱)<input name="nightRate" type="number" min="1" max="100000" required value="${Number(court.nightRate) || 350}"></label><label>Description<textarea name="description" maxlength="1000" rows="2">${escapeHtml(court.description || '')}</textarea></label><label>Court photo<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label></div><div class="payment-help formMessage" role="status"></div><button class="pill">${court.id ? 'Save court' : 'Add court'}</button></form>`;
  }
  function adminCourtItem(court) {
    const photo = safeImage(court.image);
    return '<div class="admin-court-item" data-court-id="' + escapeHtml(court.id) + '"><article class="admin-court-card"><div class="admin-court-image">' + (photo ? '<img src="' + photo + '" alt="' + escapeHtml(court.name) + ' at Sweat Paddle Court">' : '<div class="admin-court-placeholder" aria-hidden="true"><span>YOUR NEXT RALLY</span><small>SWEAT PADDLE COURT</small></div>') + '</div><div class="admin-court-overlay"><div class="admin-court-title"><strong>' + escapeHtml(court.name) + '</strong><span>' + escapeHtml(court.location || 'Sweat Paddle Court') + '</span></div><div class="admin-court-actions"><button type="button" data-edit-court aria-label="Edit ' + escapeHtml(court.name) + '">Edit</button><button type="button" class="delete" data-delete-court="' + escapeHtml(court.id) + '" data-court-name="' + escapeHtml(court.name) + '" aria-label="Delete ' + escapeHtml(court.name) + '">Delete</button></div></div></article><div class="admin-court-editor" hidden>' + courtForm(court) + '</div></div>';
  }
  async function renderAdmin() {
    const data = await api('/api/admin/dashboard'); settings = data.settings; adminEmail = data.user.email;
    const courtItems = settings.courts.map(adminCourtItem).join('');
    const adminBookings = data.bookings.filter(booking => /^cancel/i.test(booking.status || '') || booking.paymentReference || booking.hasReceipt);
    const pendingBookings = adminBookings.filter(booking => !/^cancel/i.test(booking.status || '') && booking.status !== 'Paid');
    const paidBookings = adminBookings.filter(booking => booking.status === 'Paid');
    const cancelledBookings = adminBookings.filter(booking => /^cancel/i.test(booking.status || ''));
    function bookingTable(bookings) {
      if (!bookings.length) return '<div class="empty-state">No bookings in this section.</div>';
      return `<div style="overflow:auto"><table class="admin-bookings"><thead><tr><th>Ref / Client</th><th>Session</th><th>Amount</th><th>Status</th><th>Payment proof</th><th>Actions</th></tr></thead><tbody>${bookings.map(booking => `<tr><td><b>${escapeHtml(booking.reference)}</b><br>${escapeHtml(booking.name)}</td><td>${escapeHtml(booking.date)}<br>${escapeHtml(booking.time)} · ${escapeHtml(booking.court)}</td><td>${money(booking.amount)}</td><td><span class="status ${booking.status === 'Paid' ? 'paid' : ''}">${escapeHtml(booking.status)}</span></td><td>${booking.paymentReference ? `<b>Ref: ${escapeHtml(booking.paymentReference)}</b>` : ''}${booking.hasReceipt ? `${booking.paymentReference ? '<br>' : ''}<button data-payment-proof="${escapeHtml(booking.reference)}">View receipt image</button>` : (!booking.paymentReference ? 'No proof submitted' : '')}</td><td>${booking.status === 'Paid' || /^cancel/i.test(booking.status || '') ? '' : `<button data-paid="${escapeHtml(booking.reference)}">${booking.hasReceipt || booking.paymentReference ? 'Mark paid' : 'Cancel · no proof'}</button>`}<button data-remove-booking="${escapeHtml(booking.reference)}">Remove</button>${booking.status === 'Paid' ? `<button data-receipt="${escapeHtml(booking.reference)}">Receipt</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    const bookingSections = [
      ['Pending', pendingBookings],
      ['Paid', paidBookings],
      ['Cancelled', cancelledBookings]
    ].map(([label, bookings]) => `<section class="admin-booking-section"><h4>${label} (${bookings.length})</h4>${bookingTable(bookings)}</section>`).join('');
    openModal(`<h2 id="modalTitle">Admin dashboard</h2><p>Signed in as <b>${escapeHtml(adminEmail)}</b> · <button id="adminLogout" type="button">Sign out</button></p><div class="admin-box court-manager"><div class="admin-court-head"><h3>Courts</h3></div><div id="addCourtPanel" hidden>${courtForm()}</div><div id="courtEditorPanel" class="court-editor-top" hidden></div><div class="admin-court-grid">${courtItems || '<div class="empty-state">No courts yet.</div>'}<button class="admin-add-court" id="addCourtToggle" type="button" aria-label="Add a court" aria-expanded="false"><span class="admin-add-court-icon">+</span><span>Add a court</span></button></div></div><div class="admin-grid"><div class="admin-box"><h3>Payment and homepage settings</h3><label for="adminPayLink">HTTPS payment link</label><input id="adminPayLink" type="url" placeholder="https://…" value="${escapeHtml(settings.instapayUrl || '')}"><label for="adminQr">InstaPay QR (PNG, JPEG or WebP; 3 MB max)</label><input id="adminQr" type="file" accept="image/png,image/jpeg,image/webp"><label for="adminHeroImage">Homepage photo (optional)</label><input id="adminHeroImage" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><div id="settingsMessage" class="payment-help" role="status"></div><button class="pill" id="saveSettings">Save settings</button></div><div class="admin-box"><h3>Change admin account</h3><label for="newAdminEmail">Email</label><input id="newAdminEmail" type="email" maxlength="254" value="${escapeHtml(adminEmail)}"><label for="currentAdminPassword">Current password</label><input id="currentAdminPassword" type="password" autocomplete="current-password"><label for="newAdminPassword">New password (leave empty to keep it)</label><input id="newAdminPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password"><div id="passwordMessage" class="payment-help" role="status"></div><button class="pill" id="saveAccount">Update account</button></div></div><div class="admin-box"><h3>Bookings (${adminBookings.length})</h3><div id="bookingAdminNotice" class="payment-help" role="status"></div>${bookingSections}</div>`, true);
    $('#adminLogout').addEventListener('click', async () => { try { await post('/api/admin/logout', {}); } finally { closeModal(); } });
    const addCourtToggle = $('#addCourtToggle'), addCourtPanel = $('#addCourtPanel'), courtEditorPanel = $('#courtEditorPanel');
    function restoreCourtEditor() {
      const editor = courtEditorPanel.firstElementChild;
      if (!editor) return;
      const courtId = courtEditorPanel.dataset.courtId;
      const item = Array.from(modalContent.querySelectorAll('.admin-court-item')).find(node => node.dataset.courtId === courtId);
      editor.hidden = true;
      if (item) item.append(editor);
      courtEditorPanel.hidden = true;
      delete courtEditorPanel.dataset.courtId;
    }
    addCourtToggle.addEventListener('click', () => {
      const open = addCourtPanel.hidden;
      restoreCourtEditor();
      addCourtPanel.hidden = !open;
      addCourtToggle.setAttribute('aria-expanded', String(open));
      addCourtToggle.setAttribute('aria-label', open ? 'Close add court form' : 'Add a court');
      addCourtToggle.querySelector('.admin-add-court-icon').textContent = open ? '×' : '+';
      if (open) addCourtPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    modalContent.querySelectorAll('[data-edit-court]').forEach(button => button.addEventListener('click', () => {
      const item = button.closest('.admin-court-item'), courtId = item.dataset.courtId;
      addCourtPanel.hidden = true;
      addCourtToggle.querySelector('.admin-add-court-icon').textContent = '+';
      addCourtToggle.setAttribute('aria-label', 'Add a court');
      addCourtToggle.setAttribute('aria-expanded', 'false');
      if (courtEditorPanel.dataset.courtId === courtId && courtEditorPanel.firstElementChild) {
        courtEditorPanel.hidden = !courtEditorPanel.hidden;
        return;
      }
      restoreCourtEditor();
      const panel = item.querySelector('.admin-court-editor');
      if (!panel) return;
      panel.hidden = false;
      courtEditorPanel.append(panel);
      courtEditorPanel.dataset.courtId = courtId;
      courtEditorPanel.hidden = false;
      panel.querySelector('input[name="name"]').focus();
      courtEditorPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    modalContent.querySelectorAll('.courtForm').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault(); const message = $('.formMessage', form), values = new FormData(form), id = form.dataset.courtId, saveButton = form.querySelector('button[type="submit"]') || form.querySelector('.pill');
      const court = { name: values.get('name'), location: values.get('location'), openingMinute: timeInputMinute(values.get('openingTime')), closingMinute: timeInputMinute(values.get('closingTime'), true), dayRateStartMinute: timeInputMinute(values.get('dayRateStartTime')), nightRateStartMinute: timeInputMinute(values.get('nightRateStartTime')), dayRate: Number(values.get('dayRate')), nightRate: Number(values.get('nightRate')), displayPrice: Number(values.get('dayRate')), description: values.get('description') };
      const hours = courtHours(court); if (court.dayRateStartMinute < hours.opening || court.nightRateStartMinute <= court.dayRateStartMinute || court.nightRateStartMinute >= hours.closing) return showNotice(message, 'Set the day rate at or after opening, and the night rate after the day rate but before closing.');
      if (id) { courtEditorPanel.hidden = true; saveButton.disabled = true; saveButton.textContent = 'Saving…'; }
      try {
        const image = await imageFileData(values.get('image'));
        if (image) court.image = image;
        if (id) {
          const result = await patch(`/api/admin/courts/${encodeURIComponent(id)}`, court);
          const existing = settings.courts.find(item => item.id === id) || {};
          const savedFromApi = (result.settings && result.settings.courts.find(item => item.id === id)) || {};
          const saved = { ...existing, ...court, ...savedFromApi, ...(image ? { image } : {}) };
          if (!saved.image && existing.image) saved.image = existing.image;
          settings.courts = settings.courts.map(item => item.id === id ? saved : item);
          refreshPublic();
          const item = Array.from(modalContent.querySelectorAll('.admin-court-item')).find(node => node.dataset.courtId === id);
          if (item) {
            $('.admin-court-title strong', item).textContent = saved.name;
            $('.admin-court-title span', item).textContent = saved.location || 'Sweat Paddle Court';
            if (image) $('.admin-court-image', item).innerHTML = '<img src="' + safeImage(image) + '" alt="' + escapeHtml(saved.name) + ' at Sweat Paddle Court">';
          }
          courtEditorPanel.hidden = true;
          return;
        }
        const result = await post('/api/admin/courts', court);
        const refreshed = await api('/api/admin/dashboard'); settings = refreshed.settings; refreshPublic(); await renderAdmin();
      } catch (error) { if (id) { courtEditorPanel.hidden = false; saveButton.disabled = false; saveButton.textContent = 'Save court'; } showNotice(message, error.message); }
    }));
    modalContent.querySelectorAll('[data-delete-court]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.deleteCourt;
      if (!window.confirm(`Delete ${button.dataset.courtName}? This will remove it from the public court list.`)) return;
      try { const result = await api(`/api/admin/courts/${encodeURIComponent(id)}`, { method: 'DELETE' }); settings = result.settings; refreshPublic(); await renderAdmin(); } catch (error) { showError(error.message); }
    }));
    $('#saveSettings').addEventListener('click', async () => {
      const message = $('#settingsMessage');
      try {
        const body = { instapayUrl: $('#adminPayLink').value.trim() };
        const qr = await imageFileData($('#adminQr').files[0]), hero = await imageFileData($('#adminHeroImage').files[0]);
        if (qr) body.instapayQr = qr; if (hero) body.heroImage = hero;
        const result = await patch('/api/admin/settings', body); settings = result.settings; refreshPublic(); showNotice(message, 'Settings saved.', false);
      } catch (error) { showNotice(message, error.message); }
    });
    $('#saveAccount').addEventListener('click', async () => {
      const message = $('#passwordMessage');
      try {
        const result = await patch('/api/admin/password', { email: $('#newAdminEmail').value.trim(), currentPassword: $('#currentAdminPassword').value, newPassword: $('#newAdminPassword').value });
        adminEmail = result.user.email; showNotice(message, 'Admin account updated.', false); await renderAdmin();
      } catch (error) { showNotice(message, error.message); }
    });
    modalContent.querySelectorAll('[data-paid]').forEach(button => button.addEventListener('click', async () => { try { const result = await patch(`/api/admin/bookings/${encodeURIComponent(button.dataset.paid)}`, { status: 'Paid' }); await renderAdmin(); if (result.cancelled) showNotice($('#bookingAdminNotice'), result.message, false); } catch (error) { showError(error.message); } }));
    modalContent.querySelectorAll('[data-remove-booking]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/admin/bookings/${encodeURIComponent(button.dataset.removeBooking)}`, { method: 'DELETE' }); await renderAdmin(); } catch (error) { showError(error.message); } }));
    modalContent.querySelectorAll('[data-payment-proof]').forEach(button => button.addEventListener('click', async () => { try { const proof = await post('/api/admin/bookings/proof', { reference: button.dataset.paymentProof }); const proofImage = safeImage(proof.receiptImage); openModal(`<h2 id="modalTitle">Payment proof</h2><p>Booking ${escapeHtml(button.dataset.paymentProof)}</p>${proof.paymentReference ? `<div class="payment-reference">Payment reference: ${escapeHtml(proof.paymentReference)}</div>` : ''}${proofImage ? `<img class="admin-proof-image" src="${proofImage}" alt="Customer payment receipt"><a class="payment-qr-download" href="${proofImage}" download="payment-receipt-${encodeURIComponent(button.dataset.paymentProof)}">Download receipt image</a>` : '<p>No receipt image was uploaded.</p>'}<button class="pill" data-close-modal>Close</button>`, true); } catch (error) { showError(error.message); } }));
    modalContent.querySelectorAll('[data-receipt]').forEach(button => button.addEventListener('click', () => printReceipt(data.bookings.find(item => item.reference === button.dataset.receipt))));
  }
  function printReceipt(booking) {
    if (!booking) return;
    let receipt = $('#receiptPrint'); if (!receipt) { receipt = document.createElement('section'); receipt.id = 'receiptPrint'; document.body.append(receipt); }
    receipt.innerHTML = `<h1>Sweat Paddle Court</h1><h2>Booking payment receipt</h2><hr><p><b>Receipt / Booking reference:</b> ${escapeHtml(booking.reference)}</p><p><b>Received from:</b> ${escapeHtml(booking.name)}</p><p><b>Court:</b> ${escapeHtml(booking.court)}</p><p><b>Session:</b> ${escapeHtml(booking.date)} · ${escapeHtml(booking.time)}</p><p><b>Amount received:</b> ${money(booking.amount)}</p><p><b>Payment status:</b> PAID · verified by the club</p><p><b>Verified:</b> ${booking.paidAt ? escapeHtml(new Date(booking.paidAt).toLocaleString('en-PH')) : ''}</p>`;
    window.print();
  }
  $('#adminOpen').addEventListener('click', () => openAdmin().catch(error => showError(error.message)));
  $('#showVenueMap').addEventListener('click', () => {
    const frame = document.createElement('iframe'); frame.className = 'venue-map-frame'; frame.title = 'Map to Sweat Paddle Court in Talisay City'; frame.loading = 'lazy'; frame.referrerPolicy = 'no-referrer-when-downgrade'; frame.src = 'https://www.google.com/maps?q=10.263861,123.816417&output=embed'; $('#mapStage').prepend(frame); $('#showVenueMap').hidden = true; $('#mapDirections').hidden = false;
  });
  async function start() {
    try { const data = await api('/api/public'); settings = data.settings; adminSetupRequired = data.adminSetupRequired; refreshPublic(); }
    catch (error) { $('#courtGrid').innerHTML = `<div class="empty-state court-empty"><h2>Booking service unavailable</h2><p>${escapeHtml(error.message)} Start the Node server and open its website address.</p></div>`; }
    const loader = $('#siteLoader');
    if (loader) { loader.classList.add('is-done'); window.setTimeout(() => loader.remove(), 650); }
  }
  start();
})();

