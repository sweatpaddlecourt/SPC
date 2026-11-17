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
  const DEFAULT_SITE_SETTINGS = { courts: [], instapayUrl: '', instapayQr: '', heroImage: '', heroImages: [], contactPhones: ['0927 535 8196', '0908 907 8224', '0933 536 8205'], contactEmail: 'maryjeandagondon@gmail.com', contactName: 'Sweat Paddle Court', contactAddress: 'San Antonio, Brgy. Linao, Talisay City, Cebu', businessHours: 'Open daily' };
  function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const heroImages = Array.isArray(source.heroImages) ? source.heroImages.filter(image => typeof image === 'string' && image.trim()).slice(0, 10) : (typeof source.heroImage === 'string' && source.heroImage ? [source.heroImage] : []);
    return { ...DEFAULT_SITE_SETTINGS, ...source, heroImages, courts: Array.isArray(source.courts) ? source.courts : [], contactPhones: Array.isArray(source.contactPhones) ? source.contactPhones.filter(phone => typeof phone === 'string' && phone.trim()).slice(0, 10) : DEFAULT_SITE_SETTINGS.contactPhones.slice() };
  }
  let settings = normalizeSettings();
  let adminSetupRequired = true;
  let adminEmail = '';
  let adminDashboardData = null;
  let adminBookingSearchQuery = '';
  let adminBookingsPollTimer = null, bookingAvailabilityPollTimer = null;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function openModal(html, admin = false) {
    if (bookingAvailabilityPollTimer) { window.clearInterval(bookingAvailabilityPollTimer); bookingAvailabilityPollTimer = null; }
    if (!admin && adminBookingsPollTimer) { window.clearInterval(adminBookingsPollTimer); adminBookingsPollTimer = null; }
    modalContent.innerHTML = html;
    const box = $('.modal', modal);
    box.classList.toggle('admin-modal', admin);
    modal.classList.add('open');
  }
  function closeModal() { modal.classList.remove('open'); if (adminBookingsPollTimer) { window.clearInterval(adminBookingsPollTimer); adminBookingsPollTimer = null; } if (bookingAvailabilityPollTimer) { window.clearInterval(bookingAvailabilityPollTimer); bookingAvailabilityPollTimer = null; } }
  $('#close').addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-close-modal]')) closeModal(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const receiptClose = $('#adminReceiptPreview [data-receipt-close]');
    if (receiptClose) { receiptClose.click(); event.preventDefault(); return; }
    closeModal();
  });

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
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('The booking service took too long to respond. Check your connection and try again.')); }, Math.max(1000, Number(options.timeoutMs) || 30000));
      window.addEventListener('message', onMessage); document.body.append(frame, form); form.submit();
    });
    if (response.status < 200 || response.status >= 300) { const error = new Error(response.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    if ((path === '/api/admin/setup' || path === '/api/admin/login') && response.token) sessionStorage.setItem('sp_admin_token', response.token);
    if (path === '/api/admin/logout') sessionStorage.removeItem('sp_admin_token');
    return response;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
  function showError(message) { openModal(`<div class="success"><h2 id="modalTitle">Couldn’t complete that</h2><p>${escapeHtml(message)}</p><button class="pill" data-close-modal>Close</button></div>`); }
  function showNotice(node, message, error = true) { node.textContent = message; node.style.color = error ? '#ba3b20' : '#087c7a'; }
  function actionLoadingTitle(successText) {
    const value = String(successText || '').toLowerCase();
    if (value.includes('photo')) return 'Uploading and saving home page photos…';
    if (value.includes('phone')) return 'Saving phone numbers…';
    if (value.includes('email')) return 'Saving email address…';
    if (value.includes('setting')) return 'Uploading and saving settings…';
    return 'Saving your changes…';
  }
  function showActionPopup(loadingTitle, loadingText) {
    $('#adminActionPopup')?.remove();
    const layer = document.createElement('div');
    layer.className = 'admin-action-backdrop';
    layer.id = 'adminActionPopup';
    const startedAt = Date.now();
    const pause = duration => new Promise(resolve => window.setTimeout(resolve, duration));
    layer.innerHTML = '<section class="admin-action-dialog" role="status" aria-live="polite"><span class="admin-action-icon is-loading"><span class="admin-action-spinner" aria-hidden="true"></span></span><h2></h2><p></p></section>';
    layer.querySelector('h2').textContent = loadingTitle;
    layer.querySelector('p').textContent = loadingText;
    document.body.append(layer);
    return {
      async complete(title, detail) {
        const minimumLoading = Math.max(0, 350 - (Date.now() - startedAt));
        if (minimumLoading) await pause(minimumLoading);
        if (!layer.isConnected) return;
        const icon = layer.querySelector('.admin-action-icon');
        icon.classList.remove('is-loading'); icon.classList.add('is-success'); icon.innerHTML = '<span aria-hidden="true">✓</span>';
        layer.querySelector('h2').textContent = title;
        layer.querySelector('p').textContent = detail;
        await pause(900);
        layer.remove();
      },
      dismiss() { layer.remove(); }
    };
  }
  function showActionConfirmation(title, detail) {
    $("#adminActionPopup")?.remove();
    const layer = document.createElement("div");
    layer.className = "admin-action-backdrop";
    layer.id = "adminActionPopup";
    layer.innerHTML = '<section class="admin-action-dialog admin-action-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="adminDeleteTitle" aria-describedby="adminDeleteDetail"><span class="admin-action-icon is-warning" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></span><h2 id="adminDeleteTitle"></h2><p id="adminDeleteDetail"></p><div class="admin-action-buttons"><button type="button" class="admin-action-cancel">Keep booking</button><button type="button" class="admin-action-delete">Delete booking</button></div></section>';
    layer.querySelector("#adminDeleteTitle").textContent = title;
    layer.querySelector("#adminDeleteDetail").textContent = detail;
    document.body.append(layer);
    return new Promise(resolve => {
      let settled = false;
      const finish = confirmed => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown, true);
        layer.remove();
        resolve(confirmed);
      };
      const onKeyDown = event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
      };
      document.addEventListener("keydown", onKeyDown, true);
      layer.addEventListener("click", event => { if (event.target === layer) finish(false); });
      layer.querySelector(".admin-action-cancel").addEventListener("click", () => finish(false));
      layer.querySelector(".admin-action-delete").addEventListener("click", () => finish(true));
      layer.querySelector(".admin-action-cancel").focus();
    });
  }
  function safeImage(value) {
    if (typeof value !== 'string' || value.length > 5_000_000) return '';
    if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
    if (/^https:\/\/[a-z0-9.-]+(?::\d+)?\/[a-z0-9_./%?=#&+-]*$/i.test(value)) return value;
    return '';
  }
  function safePaymentLink(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } }
  function money(value) { return `₱${Number(value || 0).toLocaleString('en-PH')}`; }
  function formatTime(minute) {
    const minuteOfDay = ((minute % 1440) + 1440) % 1440, hour24 = Math.floor(minuteOfDay / 60), hour = hour24 % 12 || 12;
    return `${hour}:${String(minuteOfDay % 60).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
  }
  function courtHours(court) { const opening = Number.isInteger(Number(court.openingMinute)) ? Number(court.openingMinute) : 300; return { opening: opening, closing: Number.isInteger(Number(court.closingMinute)) ? Number(court.closingMinute) : 1320, dayRateStart: Number.isInteger(Number(court.dayRateStartMinute)) ? Number(court.dayRateStartMinute) : opening, nightRateStart: Number.isInteger(Number(court.nightRateStartMinute)) ? Number(court.nightRateStartMinute) : (Number.isInteger(Number(court.priceChangeMinute)) ? Number(court.priceChangeMinute) : 1020) }; }
  function timeChoicesFor(court) { const hours = courtHours(court), choices = []; for (let start = hours.opening; start + 60 <= hours.closing; start += 60) choices.push({ start, label: formatTime(start) + '–' + formatTime(start + 60) }); return choices; }
  function rateFor(court, minute) { const h = courtHours(court); return Number(minute >= h.dayRateStart && minute < h.nightRateStart ? court.dayRate : court.nightRate); }
  function timeInputValue(minute) { minute = ((minute % 1440) + 1440) % 1440; return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'); }
  function timeInputMinute(value, closing) { if (closing && value === '00:00') return 1440; const parts = value.split(':').map(Number); return parts[0] * 60 + parts[1]; }
  function pricingRows(court) { const h = courtHours(court), rows = []; if (h.dayRateStart > h.opening) rows.push(formatTime(h.opening) + ' - ' + formatTime(h.dayRateStart) + ': <strong>' + money(court.nightRate) + '/hr</strong>'); if (Math.min(h.nightRateStart, h.closing) > h.dayRateStart) rows.push(formatTime(h.dayRateStart) + ' - ' + formatTime(Math.min(h.nightRateStart, h.closing)) + ': <strong>' + money(court.dayRate) + '/hr</strong>'); if (h.closing > h.nightRateStart) rows.push(formatTime(h.nightRateStart) + ' - ' + formatTime(h.closing) + ': <strong>' + money(court.nightRate) + '/hr</strong>'); return rows.map(row => '<div>' + row + '</div>').join(''); }

  let heroSlideTimer = null;
  function renderHero() {
    const configured = Array.isArray(settings.heroImages) ? settings.heroImages : [];
    const legacy = !configured.length && settings.heroImage ? [settings.heroImage] : [];
    const images = [...new Set([...configured, ...legacy, ...settings.courts.map(court => court.image)].map(safeImage).filter(Boolean))];
    const image = $('#heroImage'), nextImage = $('#heroImageNext'), placeholder = $('#heroPlaceholder'), controls = $('#heroCarouselControls'), dots = $('#heroCarouselDots');
    if (heroSlideTimer) { window.clearInterval(heroSlideTimer); heroSlideTimer = null; }
    if (!images.length) {
      image.removeAttribute('src'); image.classList.remove('visible'); nextImage.removeAttribute('src'); nextImage.classList.remove('visible');
      placeholder.classList.remove('hidden'); controls.hidden = true; dots.replaceChildren(); return;
    }
    placeholder.classList.add('hidden'); image.classList.add('visible'); nextImage.removeAttribute('src'); nextImage.classList.remove('visible');
    let active = 0;
    function showSlide(index) {
      active = (index + images.length) % images.length;
      image.src = images[active]; image.alt = 'Sweat Paddle Court photo ' + (active + 1);
      dots.querySelectorAll('[data-slide]').forEach(button => {
        const selected = Number(button.dataset.slide) === active;
        button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
      });
    }
    dots.innerHTML = images.map((_, index) => '<button class="hero-carousel-dot' + (index === 0 ? ' active' : '') + '" type="button" data-slide="' + index + '" aria-label="Show photo ' + (index + 1) + '" aria-pressed="' + String(index === 0) + '"></button>').join('');
    dots.querySelectorAll('[data-slide]').forEach(button => button.addEventListener('click', () => showSlide(Number(button.dataset.slide))));
    $('#heroPrev').onclick = () => showSlide(active - 1);
    $('#heroNext').onclick = () => showSlide(active + 1);
    controls.hidden = images.length < 2;
    showSlide(0);
    if (images.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) heroSlideTimer = window.setInterval(() => showSlide(active + 1), 5500);
  }
  function renderCourts() {
    const grid = $('#courtGrid');
    if (!settings.courts.length) {
      grid.innerHTML = '<div class="empty-state court-empty"><span class="empty-courts-icon">＋</span><h2>No courts listed yet</h2><p>New courts will appear here when the admin adds them.</p></div>';
      return;
    }
    grid.innerHTML = settings.courts.map(court => {
      const photo = safeImage(court.image);
      return `<article class="court-card"><div class="court-cover"><div class="cover-roof"></div><div class="cover-floor"></div><div class="cover-net"></div>${photo ? `<img src="${photo}" alt="${escapeHtml(court.name)} at Sweat Paddle Court" loading="lazy" decoding="async">` : ''}<span class="court-badge">Daily · ${formatTime(courtHours(court).opening)}–${formatTime(courtHours(court).closing)}</span><span class="available-badge">Available</span></div><div class="court-body"><div class="court-title-row"><div><h2>${escapeHtml(court.name)}</h2><div class="court-loc"><svg class="location-pin-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-7.2 8-13a8 8 0 1 0-16 0c0 5.8 8 13 8 13Z"/><circle cx="12" cy="9" r="2.7"/></svg>${escapeHtml(court.location || 'Sweat Paddle Court')}</div></div><div class="court-price">${money(court.displayPrice || court.dayRate)}<small>/ hour</small></div></div><p class="court-desc">${escapeHtml(court.description || '')}</p><a class="details-link" href="#" data-details="${escapeHtml(court.id)}">See full description →</a><div class="time-pricing"><div class="pricing-head">₱ &nbsp;Time-Based Pricing</div>${pricingRows(court)}</div><div class="court-foot"><button class="book-now" data-book="${escapeHtml(court.id)}">Book Now</button></div></div></article>`;
    }).join('');
    grid.querySelectorAll('[data-book]').forEach(button => button.addEventListener('click', () => openBooking(button.dataset.book)));
    grid.querySelectorAll('[data-details]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault(); const court = settings.courts.find(item => item.id === link.dataset.details); if (!court) return;
      openModal(`<h2 id="modalTitle">${escapeHtml(court.name)}</h2><p>${escapeHtml(court.description || '')}</p><p><b>${escapeHtml(court.location || 'Sweat Paddle Court')}</b> · Up to ${escapeHtml(court.maxPlayers || 10)} players</p><button class="pill" data-close-modal>Close</button>`);
    }));
  }
  function renderContact() {
    const phones = Array.isArray(settings.contactPhones) ? settings.contactPhones.filter(Boolean).slice(0, 10) : [];
    const phoneRow = $('#contactPhoneRow'), phoneList = $('#contactPhones');
    phoneRow.hidden = !phones.length; phoneList.replaceChildren(...phones.map(phone => {
      const link = document.createElement('a'); link.href = `tel:${phone.replace(/[^\d+]/g, '')}`; link.textContent = phone; return link;
    }));
    const email = String(settings.contactEmail || ''); $('#contactEmailRow').hidden = !email;
    const emailLink = $('#contactEmail'); emailLink.textContent = email; emailLink.href = email ? `mailto:${email}` : '';
    $('#contactVenueName').textContent = settings.contactName || 'Sweat Paddle Court';
    $('#contactAddress').textContent = settings.contactAddress || '';
    $('#contactLocationRow').hidden = !settings.contactAddress;
    $('#businessHours').textContent = settings.businessHours || 'Open daily';
  }
  function refreshPublic() { renderCourts(); renderHero(); renderContact(); }
  const PUBLIC_CACHE_KEY = 'sp_public_settings_cache_v1';
  function readPublicCache() {
    try { const cached = JSON.parse(localStorage.getItem(PUBLIC_CACHE_KEY) || 'null'); if (cached?.settings && Array.isArray(cached.settings.courts)) return cached; } catch {}
    return null;
  }
  function savePublicCache(data) {
    try {
      const cachedSettings = { ...data.settings, heroImage: String(data.settings.heroImage || '').startsWith('data:') ? '' : data.settings.heroImage, heroImages: (data.settings.heroImages || []).map(image => String(image || '').startsWith('data:') ? '' : image).filter(Boolean), courts: (data.settings.courts || []).map(court => ({ ...court, image: String(court.image || '').startsWith('data:') ? '' : court.image })) };
      localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify({ settings: cachedSettings, adminSetupRequired: data.adminSetupRequired }));
    } catch {}
  }
  function showPublicUnavailable(error) {
    const message = error?.message || 'The live booking service could not be reached.';
    $('#courtGrid').innerHTML = `<div class="empty-state court-empty"><span class="empty-courts-icon">↻</span><h2>Booking is taking longer than usual</h2><p>${escapeHtml(message)} Please check your connection and try again.</p><button class="pill" id="retryPublicData" type="button">Try again</button></div>`;
  }

  function showPayment(booking, siteSettings = settings) {
    const qr = safeImage(siteSettings.instapayQr), link = safePaymentLink(siteSettings.instapayUrl);
    const configured = Boolean(qr || link);
    const paymentLink = link ? `<a class="pill" style="display:block;text-align:center;text-decoration:none" href="${link}" target="_blank" rel="noopener noreferrer">Open payment link ↗</a>` : '';
    openModal(`<h2 id="modalTitle">Complete your payment</h2><p>Scan the QR code or use the payment link, then send your proof below.</p><div class="payment-card"><div class="payment-reference">${escapeHtml(booking.reference)}</div><div class="summary"><b>${escapeHtml(booking.court)}</b><br>${escapeHtml(booking.date)} · ${escapeHtml(booking.time)} · ${booking.duration} hour${booking.duration === 1 ? '' : 's'}<br>Booked by ${escapeHtml(booking.name)}<br><b>Amount: ${money(booking.amount)}</b></div>${qr ? `<img class="payment-qr" src="${qr}" alt="InstaPay QR code"><a class="payment-qr-download" href="${qr}" download="sweat-paddle-court-payment-qr">Download QR image</a>` : ''}${paymentLink}<p class="payment-help">After paying, upload a screenshot of your payment or enter the payment reference number. The club will verify it before confirming your booking.</p></div><div class="payment-proof-form"><label for="paymentReferenceInput">Payment reference number</label><input id="paymentReferenceInput" type="text" maxlength="120" autocomplete="off" placeholder="Enter the reference from your payment"><label for="paymentReceiptInput">Or upload a payment receipt</label><input id="paymentReceiptInput" type="file" accept="image/png,image/jpeg,image/webp"><p class="payment-help">Provide at least one: a receipt image or a payment reference number.</p><div id="paymentProofMessage" class="payment-help" role="status"></div><button class="pill" id="submitPaymentProof" ${configured ? '' : 'disabled'}>${configured ? 'Submit payment proof' : 'Payment details not set up yet'}</button></div>`);
    $('#submitPaymentProof')?.addEventListener('click', async () => {
      const message = $('#paymentProofMessage'), paymentReference = $('#paymentReferenceInput').value.trim(), file = $('#paymentReceiptInput').files[0];
      if (!paymentReference && (!file || !file.name)) return showNotice(message, 'Upload a receipt image or enter a payment reference number.');
      const action = showActionPopup('Uploading payment proof…', 'Sending your payment reference and receipt to the club.');
      try {
        const receiptImage = await imageFileData(file);
        await post('/api/bookings/report', { reference: booking.reference, name: booking.name, paymentReference, receiptImage });
        await action.complete('Payment proof received', 'The club will verify it before confirming your booking.');
        openModal(`<div class="success"><div class="success-icon">🧾</div><h2 id="modalTitle">Payment proof received</h2><p>Your payment proof was sent to the club. They will verify it before confirming your booking.</p><div class="summary payment-receipt"><div class="payment-reference">${escapeHtml(booking.reference)}</div><b>${escapeHtml(booking.court)}</b><br>${escapeHtml(booking.date)} · ${escapeHtml(booking.time)}<br>Booked by ${escapeHtml(booking.name)}<br><b>Amount: ${money(booking.amount)}</b><p class="payment-help">Payment status: Awaiting club verification</p></div><button class="pill" data-close-modal>Done</button></div>`);
      } catch (error) { action.dismiss(); showNotice(message, error.message); }
    });
  }

  function openBooking(courtId) {
    const court = settings.courts.find(item => item.id === courtId); if (!court) return;
    const bookingDay = bookingClock().dateISO;
    openModal(`<h2 id="modalTitle">Book ${escapeHtml(court.name)}</h2><p>Choose one or more open hours, then enter your name.</p><div class="summary"><b>${escapeHtml(court.name)}</b><br>${escapeHtml(court.location || 'Sweat Paddle Court')}</div><div class="modal-fields"><label>Date<input id="bookingDate" type="date" min="${bookingDay}" value="${bookingDay}" required></label><div><label>Available times · select multiple</label><div class="slots" id="bookingSlots"></div><div id="bookingPendingWarning" class="pending-booking-warning" role="alert" hidden></div></div><label>Your name<input id="bookingName" maxlength="80" required autocomplete="name" placeholder="Name"></label></div><p id="bookingPrice" class="payment-help">Select times to see your total.</p><p id="bookingError" class="payment-help" role="alert"></p><a class="booking-facebook-contact" href="https://www.facebook.com/profile.php?id=61595968972214" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path fill="#fff" d="M13.4 20v-7.1h2.4l.4-2.8h-2.8V8.3c0-.8.2-1.4 1.4-1.4h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.8h2.4V20z"/></svg>Need booking confirmation? Message us on Facebook ↗</a><button class="pill" id="submitBooking">Continue to payment →</button>`);
    const date = $('#bookingDate'), slotBox = $('#bookingSlots'), price = $('#bookingPrice'), error = $('#bookingError'), pendingWarning = $('#bookingPendingWarning'), selected = new Map(); let pending = new Set();
    function updatePendingWarning() { const hasPendingSelection = [...selected.keys()].some(minute => pending.has(minute)); pendingWarning.hidden = !hasPendingSelection; if (hasPendingSelection) pendingWarning.innerHTML = '<svg class="facebook-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path fill="#fff" d="M13.4 20v-7.1h2.4l.4-2.8h-2.8V8.3c0-.8.2-1.4 1.4-1.4h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.8h2.4V20z"/></svg><span>This hour has a payment waiting for club verification. Your request may be voided if the earlier booking is confirmed. Check with the club before paying: <a href="https://www.facebook.com/profile.php?id=61595968972214" target="_blank" rel="noopener noreferrer">Message us on Facebook ↗</a></span>'; }
    let availabilityLoadInProgress = false, availabilityRefreshQueued = false;
    async function loadSlots(reset = false) {
      if (reset) { selected.clear(); pendingWarning.hidden = true; slotBox.textContent = 'Loading availability…'; }
      if (availabilityLoadInProgress) { availabilityRefreshQueued = true; return; }
      availabilityLoadInProgress = true;
      const requestedDate = date.value;
      const hasExistingSlots = slotBox.childElementCount > 0;
      if (!hasExistingSlots) slotBox.textContent = 'Loading availability…';
      try {
        const data = await api(`/api/availability?date=${encodeURIComponent(requestedDate)}&courtId=${encodeURIComponent(courtId)}`), busy = new Set(data.booked); pending = new Set(data.pending || []);
        if (date.value !== requestedDate || !modal.classList.contains('open')) return;
        slotBox.replaceChildren(); let openCount = 0;
        const now = bookingClock();
        for (const slot of timeChoicesFor(court)) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'slot'; const isPast = requestedDate === now.dateISO && slot.start < now.minuteOfDay, isBooked = busy.has(slot.start), isPending = pending.has(slot.start) && !isBooked; if (isBooked) { button.classList.add('booked'); button.style.backgroundColor = '#f8652a'; button.style.borderColor = '#f8652a'; button.style.color = '#fff'; button.style.opacity = '1'; } if (isPending) button.classList.add('pending-slot'); button.innerHTML = `<span class="slot-label">${slot.label}${isBooked ? ' · Booked' : isPast ? ' · Past' : ''}</span>${isPending ? '<span class="pending-slot-marker" role="img" aria-label="Pending booking awaiting verification"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M36 12A18 18 0 1 0 41 27" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M31 5h12v12M31 5l12 12M18 17h12M18 31h12M19 17c0 7 10 7 10 14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><small>Pending review</small></span>' : ''}`; button.setAttribute('aria-label', `${slot.label}${isPending ? ' · Pending booking awaiting verification' : isBooked ? ' · Booked' : isPast ? ' · Past' : ''}`); button.disabled = isBooked || isPast;
          if (button.disabled) selected.delete(slot.start);
          else { openCount++; if (selected.has(slot.start)) button.classList.add('selected'); }
          button.setAttribute('aria-pressed', selected.has(slot.start) ? 'true' : 'false'); if (selected.has(slot.start)) { button.style.backgroundColor = '#dff3e8'; button.style.borderColor = '#078e8d'; button.style.color = '#075b59'; button.style.boxShadow = '0 0 0 2px #078e8d1c'; } button.addEventListener('click', () => { const isSelected = selected.has(slot.start); if (isSelected) selected.delete(slot.start); else selected.set(slot.start, slot.label); button.classList.toggle('selected', !isSelected); button.setAttribute('aria-pressed', !isSelected ? 'true' : 'false'); button.style.backgroundColor = !isSelected ? '#dff3e8' : '#fff'; button.style.borderColor = !isSelected ? '#078e8d' : '#e4e9de'; button.style.color = !isSelected ? '#075b59' : '#315547'; button.style.boxShadow = !isSelected ? '0 0 0 2px #078e8d1c' : 'none'; updatePrice(); updatePendingWarning(); }); slotBox.append(button);
        }
        if (!openCount) slotBox.textContent = 'No times left for this date.';
        updatePrice(); updatePendingWarning();
      } catch (err) {
        if (!hasExistingSlots) { slotBox.textContent = 'Availability could not load. Please refresh and try again.'; showNotice(error, err.message); }
      } finally {
        availabilityLoadInProgress = false;
        if (availabilityRefreshQueued && modal.classList.contains('open') && $('#bookingSlots')) { availabilityRefreshQueued = false; loadSlots(); }
        else availabilityRefreshQueued = false;
      }
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
      const action = showActionPopup('Saving your booking…', 'Please wait while your booking request is recorded.');
      try { const data = await post('/api/bookings', { name, courtId, dateISO: date.value, times }); await action.complete('Booking request saved', 'Your payment details are ready.'); closeModal(); showPayment(data.booking, data.settings); }
      catch (err) { action.dismiss(); showNotice(error, err.message); button.disabled = false; button.textContent = 'Continue to payment →'; if (err.message.includes('just booked') || err.message.includes('already passed')) await loadSlots(); }
    });
    loadSlots(true);
    bookingAvailabilityPollTimer = window.setInterval(() => { if (modal.classList.contains('open') && $('#bookingSlots')) loadSlots(); }, 10000);
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

  function bindPasswordToggles(root) {
    root.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      const showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      button.textContent = showing ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', String(showing));
      button.setAttribute('aria-label', `${showing ? 'Hide' : 'Show'} password`);
    }));
  }
  function adminLogin() {
    const setup = adminSetupRequired;
    openModal(`<h2 id="modalTitle">${setup ? 'Create the admin account' : 'Admin sign-in'}</h2><p>${setup ? 'Create the first admin account. Enter the ADMIN_SETUP_TOKEN value you saved in Apps Script project settings.' : 'Sign in to manage courts and bookings.'}</p><form id="adminLoginForm" class="modal-fields">${setup ? '<label>One-time setup token<input name="setupToken" minlength="6" required autocomplete="off"></label><label>Admin email<input name="email" type="email" maxlength="254" required autocomplete="email" placeholder="you@example.com"></label>' : '<label>Email<input name="email" type="email" maxlength="254" required autocomplete="username" placeholder="you@example.com"></label>'}<label>Password<div class="password-control"><input name="password" type="password" minlength="12" maxlength="200" required autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? 'At least 12 characters' : 'Password'}"><button class="password-toggle" type="button" data-password-toggle aria-pressed="false">Show</button></div></label><div class="payment-help" id="adminLoginError" role="alert"></div><button class="pill">${setup ? 'Create admin account' : 'Sign in'}</button></form>`);
    bindPasswordToggles(modalContent);
    $('#adminLoginForm').addEventListener('submit', async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget), message = $('#adminLoginError');
      const path = setup ? '/api/admin/setup' : '/api/admin/login';
      try { await post(path, { email: form.get('email').trim(), password: form.get('password'), setupToken: form.get('setupToken') }); adminSetupRequired = false; await openAdmin(); }
      catch (error) { showNotice(message, error.message); }
    });
  }
  async function openAdmin() {
    openModal('<h2 id="modalTitle">Admin dashboard</h2><p>Opening your admin panel…</p><div class="empty-state" role="status">Loading admin data…</div>', true);
    try {
      const data = await api('/api/admin/me'); adminEmail = data.user.email; await renderAdmin();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        try { const data = await api('/api/public'); adminSetupRequired = data.adminSetupRequired; adminLogin(); }
        catch (loadError) { showAdminLoadError(loadError.message); }
      } else showAdminLoadError(error.message);
    }
  }
  function showAdminLoadError(message) {
    openModal(`<h2 id="modalTitle">Admin dashboard</h2><p>We couldn’t load the admin data.</p><p class="payment-help" role="alert">${escapeHtml(message)}</p><button class="pill" id="adminRetry">Try again</button>`, true);
    $('#adminRetry').addEventListener('click', openAdmin);
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
    return '<div class="admin-court-item" data-court-id="' + escapeHtml(court.id) + '"><article class="admin-court-card"><div class="admin-court-image">' + (photo ? '<img src="' + photo + '" alt="' + escapeHtml(court.name) + ' at Sweat Paddle Court" loading="lazy" decoding="async">' : '<div class="admin-court-placeholder" aria-hidden="true"><span>YOUR NEXT RALLY</span><small>SWEAT PADDLE COURT</small></div>') + '</div><div class="admin-court-overlay"><div class="admin-court-title"><strong>' + escapeHtml(court.name) + '</strong><span>' + escapeHtml(court.location || 'Sweat Paddle Court') + '</span></div><div class="admin-court-actions"><button type="button" data-edit-court aria-label="Edit ' + escapeHtml(court.name) + '">Edit</button><button type="button" class="delete" data-delete-court="' + escapeHtml(court.id) + '" data-court-name="' + escapeHtml(court.name) + '" aria-label="Delete ' + escapeHtml(court.name) + '">Delete</button></div></div></article><div class="admin-court-editor" hidden>' + courtForm(court) + '</div></div>';
  }
  async function renderAdmin(options = {}) {
    if (adminBookingsPollTimer) { window.clearInterval(adminBookingsPollTimer); adminBookingsPollTimer = null; }
    const activeTab = options.activeTab || modalContent.querySelector('[data-booking-tab].active')?.dataset.bookingTab || 'pending';
    const data = options.useCache && adminDashboardData ? adminDashboardData : await api('/api/admin/dashboard');
    adminDashboardData = data; settings = normalizeSettings(data.settings); adminEmail = data.user.email;
    const courtItems = settings.courts.map(adminCourtItem).join('');
    let adminBookings = Array.isArray(data.bookings) ? data.bookings : [];
    function hasBookingProof(booking) { return Boolean(String(booking.paymentReference || '').trim() || booking.hasReceipt); }
    let pendingBookings = adminBookings.filter(booking => !/^cancel/i.test(booking.status || '') && booking.status !== 'Paid' && hasBookingProof(booking));
    let paidBookings = adminBookings.filter(booking => booking.status === 'Paid');
    let cancelledBookings = adminBookings.filter(booking => /^cancel/i.test(booking.status || ''));
    function bookingTable(bookings) {
      const query = adminBookingSearchQuery.trim().toLocaleLowerCase();
      const visibleBookings = query ? bookings.filter(booking => [booking.name, booking.reference].some(value => String(value || '').toLocaleLowerCase().includes(query))) : bookings;
      if (!visibleBookings.length) return '<div class="empty-state">' + (query ? 'No bookings match “' + escapeHtml(adminBookingSearchQuery.trim()) + '”.' : 'No bookings in this section.') + '</div>';
      return `<div style="overflow:auto"><table class="admin-bookings"><thead><tr><th>Ref / Client</th><th>Session</th><th>Amount</th><th>Status</th><th>Payment proof</th><th>Actions</th></tr></thead><tbody>${visibleBookings.map(booking => `<tr><td><strong class="admin-booking-client">${escapeHtml(booking.name)}</strong><span class="admin-booking-reference">${escapeHtml(booking.reference)}</span></td><td>${escapeHtml(booking.date)}<br>${escapeHtml(booking.time)} · ${escapeHtml(booking.court)}</td><td>${money(booking.amount)}</td><td><span class="status ${booking.status === 'Paid' ? 'paid' : ''}">${escapeHtml(booking.status)}</span></td><td>${booking.paymentReference ? `<b>Ref: ${escapeHtml(booking.paymentReference)}</b>` : ''}${booking.hasReceipt ? `${booking.paymentReference ? '<br>' : ''}<button data-payment-proof="${escapeHtml(booking.reference)}">View receipt image</button>` : (!booking.paymentReference ? 'No proof submitted' : '')}</td><td>${booking.status === 'Paid' || /^cancel/i.test(booking.status || '') ? '' : `<button data-paid="${escapeHtml(booking.reference)}">${booking.hasReceipt || booking.paymentReference ? 'Mark paid' : 'Cancel · no proof'}</button>`}${!/^cancel/i.test(booking.status || '') ? `<button data-cancel-booking="${escapeHtml(booking.reference)}">Cancel</button>` : ''}${booking.status === 'Paid' ? `<button data-receipt="${escapeHtml(booking.reference)}">Receipt</button>` : ''}${/^cancel/i.test(booking.status || '') ? `<button type="button" class="delete-booking" data-delete-booking="${escapeHtml(booking.reference)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    let bookingSectionData = [
      ['pending', 'Pending', pendingBookings],
      ['paid', 'Paid', paidBookings],
      ['cancelled', 'Cancelled', cancelledBookings]
    ];
    const bookingTabs = bookingSectionData.map(([id, label, bookings]) => { const active = id === activeTab; return `<button type="button" class="admin-booking-tab${active ? ' active' : ''}" data-booking-tab="${id}" aria-pressed="${active}">${label}<span>${bookings.length}</span></button>`; }).join('');
    const bookingSections = bookingSectionData.map(([id, label, bookings]) => `<section class="admin-booking-section" data-booking-section="${id}"${id === activeTab ? '' : ' hidden'}><h4>${label} (${bookings.length})</h4>${bookingTable(bookings)}</section>`).join('');
    function applyLiveBookings(bookings) {
      adminBookings = Array.isArray(bookings) ? bookings : [];
      pendingBookings = adminBookings.filter(booking => !/^cancel/i.test(booking.status || '') && booking.status !== 'Paid' && hasBookingProof(booking));
      paidBookings = adminBookings.filter(booking => booking.status === 'Paid');
      cancelledBookings = adminBookings.filter(booking => /^cancel/i.test(booking.status || ''));
      bookingSectionData = [['pending', 'Pending', pendingBookings], ['paid', 'Paid', paidBookings], ['cancelled', 'Cancelled', cancelledBookings]];
      const heading = $('#adminBookingsHeading');
      if (heading) heading.textContent = 'Bookings (' + adminBookings.length + ')';
      bookingSectionData.forEach(([id, label, items]) => {
        const tab = modalContent.querySelector('[data-booking-tab="' + id + '"]');
        const count = tab && tab.querySelector('span');
        if (count) count.textContent = String(items.length);
        const section = modalContent.querySelector('[data-booking-section="' + id + '"]');
        if (section) section.innerHTML = '<h4>' + label + ' (' + items.length + ')</h4>' + bookingTable(items);
      });
      bindBookingActions();
    }
    openModal(`<h2 id="modalTitle">Admin dashboard</h2><p>Signed in as <b>${escapeHtml(adminEmail)}</b> · <button id="adminLogout" type="button">Sign out</button></p><div class="admin-box homepage-settings-launcher"><div><h3>Home page</h3><p>Manage the photos shown on the home page.</p></div><button class="pill" id="homePageSettings" type="button">Home Page Photos</button></div><div class="admin-box court-manager"><div class="admin-court-head"><h3>Courts</h3></div><div id="addCourtPanel" hidden>${courtForm()}</div><div id="courtEditorPanel" class="court-editor-top" hidden></div><div class="admin-court-grid">${courtItems || '<div class="empty-state">No courts yet.</div>'}<button class="admin-add-court" id="addCourtToggle" type="button" aria-label="Add a court" aria-expanded="false"><svg class="admin-add-court-icon" viewBox="0 0 320 320" role="img" aria-label="Add a court"><circle cx="160" cy="160" r="150" fill="#009499"/><path d="M160 82v156M82 160h156" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round"/></svg></button></div></div><div class="admin-grid"><div class="admin-box"><h3>Payment settings</h3><label for="adminPayLink">HTTPS payment link</label><input id="adminPayLink" type="url" placeholder="https://…" value="${escapeHtml(settings.instapayUrl || '')}"><label for="adminQr">InstaPay QR (PNG, JPEG or WebP; 3 MB max)</label><input id="adminQr" type="file" accept="image/png,image/jpeg,image/webp"><div id="settingsMessage" class="payment-help" role="status"></div><button class="pill" id="saveSettings">Save settings</button></div><div class="admin-box"><h3>Change admin account</h3><label for="newAdminEmail">Email</label><input id="newAdminEmail" type="email" maxlength="254" value="${escapeHtml(adminEmail)}"><label for="currentAdminPassword">Current password</label><div class="password-control"><input id="currentAdminPassword" type="password" autocomplete="current-password"><button class="password-toggle" type="button" data-password-toggle aria-pressed="false">Show</button></div><label for="newAdminPassword">New password (leave empty to keep it)</label><div class="password-control"><input id="newAdminPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password"><button class="password-toggle" type="button" data-password-toggle aria-pressed="false">Show</button></div><div id="passwordMessage" class="payment-help" role="status"></div><button class="pill" id="saveAccount">Update account</button></div></div><div class="admin-box" id="adminBookingsPanel"><div class="admin-booking-heading"><h3 id="adminBookingsHeading">Bookings (${adminBookings.length})</h3><span class="admin-booking-live" id="adminBookingsLiveStatus" role="status">Live · updates every 10 seconds</span></div><div id="bookingAdminNotice" class="payment-help" role="status"></div><label class="admin-booking-search">Search bookings<input id="bookingNameSearch" type="search" maxlength="100" autocomplete="off" placeholder="Search by customer name" aria-label="Search bookings by customer name or reference" value="${escapeHtml(adminBookingSearchQuery)}"></label><div class="admin-booking-tabs" role="group" aria-label="Filter bookings by status">${bookingTabs}</div>${bookingSections}</div><div class="admin-box contact-settings-manager"><h3>Contact information</h3><p>Update the phone numbers and email address customers use to reach the club.</p><div class="contact-settings-actions"><button class="pill" id="phoneSettings" type="button">Phone numbers settings</button><button class="pill" id="emailSettings" type="button">Email address settings</button></div></div>`, true);
    modalContent.querySelectorAll('[data-booking-tab]').forEach(button => button.addEventListener('click', () => {
      const selectedTab = button.dataset.bookingTab;
      modalContent.querySelectorAll('[data-booking-tab]').forEach(tab => { const active = tab.dataset.bookingTab === selectedTab; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
      modalContent.querySelectorAll('[data-booking-section]').forEach(section => { section.hidden = section.dataset.bookingSection !== selectedTab; });
    }));
    $('#bookingNameSearch').addEventListener('input', event => {
      adminBookingSearchQuery = event.currentTarget.value;
      bookingSectionData.forEach(([id, label, bookings]) => {
        const section = modalContent.querySelector('[data-booking-section="' + id + '"]');
        section.innerHTML = '<h4>' + label + ' (' + bookings.length + ')</h4>' + bookingTable(bookings);
      });
      bindBookingActions();
    });
    bindPasswordToggles(modalContent);
    const adminModal = $('.modal.admin-modal', modal);
    async function runAdminSave(button, message, successText, save) {
      if (!button || button.disabled) return false;
      const pageX = window.scrollX, pageY = window.scrollY, modalTop = adminModal?.scrollTop || 0;
      const original = button.innerHTML;
      const action = showActionPopup(actionLoadingTitle(successText), 'Please wait while the server saves your changes.');
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      button.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span>Saving…';
      adminModal?.classList.add('is-saving');
      document.documentElement.classList.add('admin-saving');
      try {
        await save();
        showNotice(message, successText, false);
        await action.complete(successText.replace(/[.!]$/, ''), 'Your changes were saved successfully.');
        return true;
      } catch (error) {
        action.dismiss();
        showNotice(message, error.message);
        return false;
      } finally {
        button.innerHTML = original; button.disabled = false; button.removeAttribute('aria-busy');
        adminModal?.classList.remove('is-saving');
        document.documentElement.classList.remove('admin-saving');
        if (adminModal) adminModal.scrollTop = modalTop;
        window.scrollTo(pageX, pageY);
      }
    }
    function openHomePageSettings() {
      $('#homePageSettingsPopup')?.remove();
      const layer = document.createElement('div');
      layer.className = 'homepage-settings-backdrop'; layer.id = 'homePageSettingsPopup';
      layer.innerHTML = '<section class="homepage-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="homePagePopupTitle"><header><div><h3 id="homePagePopupTitle">Home page</h3><p>Choose several photos for the home page slideshow. Add up to 10 images, each under 3 MB.</p></div><button type="button" class="contact-popup-close" data-home-popup-close aria-label="Close">×</button></header><div id="homepagePhotoGallery" class="homepage-photo-gallery"></div><input id="homePagePhotoUpload" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><p id="homePageSettingsMessage" class="payment-help" role="status"></p><div class="contact-popup-actions"><button type="button" class="contact-popup-secondary" data-home-popup-close>Cancel</button><button type="button" class="pill" id="saveHomePagePhotos">Save photos</button></div></section>';
      modal.append(layer);
      layer.addEventListener('click', event => {
        if (event.target === layer || event.target.closest('[data-home-popup-close]')) layer.remove();
      });
      const gallery = $('#homepagePhotoGallery', layer), upload = $('#homePagePhotoUpload', layer), message = $('#homePageSettingsMessage', layer);
      let photos = (Array.isArray(settings.heroImages) ? settings.heroImages : []).slice(0, 10);
      function renderPhotos() {
        gallery.replaceChildren();
        photos.forEach((source, index) => {
          const card = document.createElement('div'); card.className = 'homepage-photo-card';
          const photo = document.createElement('img'); photo.src = safeImage(source) || ''; photo.alt = 'Home page photo ' + (index + 1); photo.loading = 'lazy';
          const actions = document.createElement('div'); actions.className = 'homepage-photo-actions';
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'homepage-photo-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove home page photo ' + (index + 1));
          remove.addEventListener('click', () => { photos.splice(index, 1); renderPhotos(); });
          actions.append(remove); card.append(photo, actions); gallery.append(card);
        });
        const add = document.createElement('button'); add.type = 'button'; add.className = 'homepage-photo-add';
        add.disabled = photos.length >= 10; add.setAttribute('aria-label', 'Add a home page photo');
        add.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="56" fill="currentColor"/><path d="M60 31v58M31 60h58" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round"/></svg><span>Add photo</span>';
        add.addEventListener('click', () => upload.click()); gallery.append(add);
      }
      renderPhotos();
      upload.addEventListener('change', async () => {
        const files = Array.from(upload.files || []);
        if (photos.length + files.length > 10) { showNotice(message, 'Home page supports up to 10 photos.'); upload.value = ''; return; }
        if (!files.length) return;
        const action = showActionPopup('Preparing home page photos…', 'Getting your selected photos ready to save.');
        try {
          const selected = await Promise.all(files.map(imageFileData));
          photos.push(...selected.filter(Boolean)); renderPhotos();
          await action.complete('Photos ready', 'Save to publish the selected home page photos.');
        } catch (error) { action.dismiss(); showNotice(message, error.message); }
        upload.value = '';
      });
      $('#saveHomePagePhotos', layer).addEventListener('click', async event => {
        await runAdminSave(event.currentTarget, message, 'Home page photos saved.', async () => {
          const result = await patch('/api/admin/settings', { heroImages: photos });
          const saved = Array.isArray(result.settings?.heroImages) ? result.settings.heroImages : null;
          if (!saved || saved.length !== photos.length || saved.some((photo, index) => photo !== photos[index])) {
            throw new Error('Home page photos need the latest Apps Script code. Update Code.gs in Apps Script and redeploy the web app.');
          }
          settings = normalizeSettings(result.settings); adminDashboardData.settings = settings;
          savePublicCache({ settings, adminSetupRequired }); refreshPublic();
        });
      });
    }
    function openContactSettings(kind) {
      $('#contactSettingsPopup')?.remove();
      const phonesMode = kind === 'phones';
      const layer = document.createElement('div');
      layer.className = 'contact-settings-backdrop'; layer.id = 'contactSettingsPopup';
      layer.innerHTML = phonesMode
        ? '<section class="contact-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="contactPopupTitle"><header><div><h3 id="contactPopupTitle">Phone numbers</h3><p>Add, edit, or remove the numbers customers can call.</p></div><button type="button" class="contact-popup-close" data-popup-close aria-label="Close">×</button></header><div id="phoneSettingsRows" class="phone-settings-rows"></div><button type="button" class="contact-popup-secondary" id="addPhoneNumber">+ Add phone number</button><p id="contactPopupMessage" class="payment-help" role="status"></p><div class="contact-popup-actions"><button type="button" class="contact-popup-secondary" data-popup-close>Cancel</button><button type="button" class="pill" id="savePhoneNumbers">Save phone numbers</button></div></section>'
        : '<section class="contact-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="contactPopupTitle"><header><div><h3 id="contactPopupTitle">Email address</h3><p>Update or remove the email address customers use to contact the club.</p></div><button type="button" class="contact-popup-close" data-popup-close aria-label="Close">×</button></header><label for="contactEmailSettingInput">Email address</label><input id="contactEmailSettingInput" type="email" maxlength="254" autocomplete="email" placeholder="name@example.com"><button type="button" class="contact-popup-secondary remove-email" id="removeContactEmail">Remove email address</button><p id="contactPopupMessage" class="payment-help" role="status"></p><div class="contact-popup-actions"><button type="button" class="contact-popup-secondary" data-popup-close>Cancel</button><button type="button" class="pill" id="saveContactEmail">Save email address</button></div></section>';
      modal.append(layer);
      layer.addEventListener('click', event => {
        if (event.target === layer || event.target.closest('[data-popup-close]')) layer.remove();
      });
      const message = $('#contactPopupMessage', layer);
      if (phonesMode) {
        const list = $('#phoneSettingsRows', layer), add = $('#addPhoneNumber', layer);
        function currentValues() { return Array.from(list.querySelectorAll('input[data-phone]'), input => input.value); }
        function renderRows(values) {
          list.replaceChildren();
          values.slice(0, 10).forEach((value, index) => {
            const row = document.createElement('div'); row.className = 'phone-settings-row';
            const label = document.createElement('label'); label.textContent = 'Phone number ' + (index + 1);
            const input = document.createElement('input'); input.type = 'tel'; input.inputMode = 'tel'; input.maxLength = 40; input.value = value; input.placeholder = 'e.g. 0927 535 8196'; input.setAttribute('aria-label', 'Phone number ' + (index + 1)); input.dataset.phone = 'true';
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'contact-popup-secondary remove-phone'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove phone number ' + (index + 1));
            remove.addEventListener('click', () => renderRows(currentValues().filter((_, rowIndex) => rowIndex !== index)));
            row.append(label, input, remove); list.append(row);
          });
          add.disabled = values.length >= 10;
        }
        renderRows(Array.isArray(settings.contactPhones) ? settings.contactPhones.slice(0, 10) : []);
        add.addEventListener('click', () => renderRows([...currentValues(), '']));
        $('#savePhoneNumbers', layer).addEventListener('click', async event => {
          const phones = currentValues().map(value => value.trim()).filter(Boolean);
          const invalid = phones.some(phone => !/^\+?[0-9]{7,15}$/.test(phone.replace(/[\s()-]/g, '')));
          if (invalid) { showNotice(message, 'Enter valid phone numbers or remove the incomplete entry.'); return; }
          await runAdminSave(event.currentTarget, message, 'Phone numbers saved.', async () => {
            const result = await patch('/api/admin/settings', { contactPhones: phones });
            const saved = Array.isArray(result.settings?.contactPhones) ? result.settings.contactPhones : null;
            if (!saved || saved.join('|') !== phones.join('|')) throw new Error('The contact editor needs the latest Apps Script code. Update Code.gs in Apps Script and redeploy the web app.');
            settings = normalizeSettings(result.settings); adminDashboardData.settings = settings;
            savePublicCache({ settings, adminSetupRequired }); refreshPublic();
          });
        });
      } else {
        const input = $('#contactEmailSettingInput', layer); input.value = String(settings.contactEmail || '');
        $('#removeContactEmail', layer).addEventListener('click', () => { input.value = ''; input.focus(); });
        $('#saveContactEmail', layer).addEventListener('click', async event => {
          const email = input.value.trim();
          if (email && !input.checkValidity()) { showNotice(message, 'Enter a valid email address or remove it.'); input.focus(); return; }
          await runAdminSave(event.currentTarget, message, 'Email address saved.', async () => {
            const result = await patch('/api/admin/settings', { contactEmail: email });
            if (result.settings?.contactEmail !== email) throw new Error('The contact editor needs the latest Apps Script code. Update Code.gs in Apps Script and redeploy the web app.');
            settings = normalizeSettings(result.settings); adminDashboardData.settings = settings;
            savePublicCache({ settings, adminSetupRequired }); refreshPublic();
          });
        });
      }
    }
    $('#homePageSettings').addEventListener('click', openHomePageSettings);
    $('#phoneSettings').addEventListener('click', () => openContactSettings('phones'));
    $('#emailSettings').addEventListener('click', () => openContactSettings('email'));
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
      const openingMinute = timeInputMinute(values.get('openingTime'));
      let closingMinute = timeInputMinute(values.get('closingTime'), true);
      const closingIsDawn = closingMinute >= 60 && closingMinute <= 240;
      if (closingIsDawn || closingMinute <= openingMinute) closingMinute += 1440;
      const overnight = closingMinute >= 1440;
      const rateStart = field => { const minute = timeInputMinute(values.get(field)); return overnight && minute < openingMinute ? minute + 1440 : minute; };
      const court = { name: values.get('name'), location: values.get('location'), openingMinute, closingMinute, dayRateStartMinute: rateStart('dayRateStartTime'), nightRateStartMinute: rateStart('nightRateStartTime'), dayRate: Number(values.get('dayRate')), nightRate: Number(values.get('nightRate')), displayPrice: Number(values.get('dayRate')), description: values.get('description') };
      const hours = courtHours(court); if (court.dayRateStartMinute < hours.opening || court.dayRateStartMinute >= hours.closing || court.nightRateStartMinute <= court.dayRateStartMinute) return showNotice(message, 'Set the day rate at or after opening, and the night rate after the day rate. If the court closes before the night rate starts, only the day rate will apply.');
      const hasPhoto = Boolean(values.get('image')?.name);
      const action = showActionPopup(id ? (hasPhoto ? 'Uploading and saving court…' : 'Saving court…') : (hasPhoto ? 'Uploading and adding court…' : 'Adding court…'), 'Please wait while the court details are saved.');
      if (id) { courtEditorPanel.hidden = true; saveButton.disabled = true; }
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
          await action.complete('Court updated', 'Your court changes were saved.');
          return;
        }
        const result = await post('/api/admin/courts', court);
        const refreshed = await api('/api/admin/dashboard'); settings = normalizeSettings(refreshed.settings); refreshPublic(); await renderAdmin();
        await action.complete('Court added', 'Your new court is ready on the site.');
      } catch (error) { action.dismiss(); if (id) { courtEditorPanel.hidden = false; saveButton.disabled = false; saveButton.textContent = 'Save court'; } showNotice(message, error.message); }
    }));
    modalContent.querySelectorAll('[data-delete-court]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.deleteCourt;
      if (!window.confirm(`Delete ${button.dataset.courtName}? This will remove it from the public court list.`)) return;
      const action = showActionPopup('Deleting court…', 'Removing this court from the public booking page.');
      try {
        const result = await api(`/api/admin/courts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        settings = normalizeSettings(result.settings); refreshPublic(); await renderAdmin();
        await action.complete('Court deleted', 'The court was removed from the site.');
      } catch (error) { action.dismiss(); showError(error.message); }
    }));
    $('#saveSettings').addEventListener('click', async event => {
      const message = $('#settingsMessage');
      await runAdminSave(event.currentTarget, message, 'Settings saved.', async () => {
        const body = { instapayUrl: $('#adminPayLink').value.trim() };
        const qr = await imageFileData($('#adminQr').files[0]);
        if (qr) body.instapayQr = qr;
        const result = await patch('/api/admin/settings', body);
        settings = normalizeSettings(result.settings); adminDashboardData.settings = settings;
        savePublicCache({ settings, adminSetupRequired }); refreshPublic();
      });
    });
    $('#saveAccount').addEventListener('click', async () => {
      const action = showActionPopup('Updating admin account…', 'Please wait while your account changes are saved.');
      try {
        const result = await patch('/api/admin/password', { email: $('#newAdminEmail').value.trim(), currentPassword: $('#currentAdminPassword').value, newPassword: $('#newAdminPassword').value });
        adminEmail = result.user.email; await renderAdmin();
        showNotice($('#passwordMessage'), 'Admin account updated.', false);
        await action.complete('Account updated', 'Your admin account changes were saved.');
      } catch (error) { action.dismiss(); showNotice($('#passwordMessage'), error.message); }
    });
    async function saveBookingStatus(reference, status, tab) {
      const booking = adminDashboardData?.bookings.find(item => item.reference === reference);
      if (!booking) { showNotice($('#bookingAdminNotice'), 'Booking data is unavailable. Reload the admin panel and try again.'); return; }
      const previousStatus = booking.status;
      const action = showActionPopup(status === 'Paid' ? 'Marking payment as paid…' : 'Cancelling booking…', 'Please wait for the server to confirm this change.');
      booking.status = status;
      await renderAdmin({ useCache: true, activeTab: tab });
      try {
        const result = await patch('/api/admin/bookings/' + encodeURIComponent(reference), { status });
        try {
          adminDashboardData = await api('/api/admin/dashboard');
          await renderAdmin({ useCache: true, activeTab: tab });
        } catch (refreshError) {
          showNotice($('#bookingAdminNotice'), 'Saved successfully. The latest data could not refresh: ' + refreshError.message);
          await action.complete(result.cancelled || status === 'Cancelled' ? 'Booking cancelled' : 'Payment marked paid', 'The server saved the change, but the booking list could not refresh.');
          return;
        }
        if (result.message) showNotice($('#bookingAdminNotice'), result.message, false);
        const wasCancelled = result.cancelled || status === 'Cancelled';
        await action.complete(wasCancelled ? 'Booking cancelled' : 'Payment marked paid', result.cancelled ? (result.message || 'The booking was cancelled.') : status === 'Cancelled' ? 'The booking was cancelled.' : 'The payment was marked as paid.');
      } catch (error) {
        booking.status = previousStatus;
        await renderAdmin({ useCache: true, activeTab: /^cancel/i.test(previousStatus || '') ? 'cancelled' : previousStatus === 'Paid' ? 'paid' : 'pending' });
        action.dismiss();
        showNotice($('#bookingAdminNotice'), error.message);
      }
    }
    function bindBookingActions() {
    modalContent.querySelectorAll('[data-delete-booking]').forEach(button => button.addEventListener('click', async () => {
      const reference = button.dataset.deleteBooking;
      const booking = adminDashboardData?.bookings.find(item => item.reference === reference);
      if (!booking || !/^cancel/i.test(booking.status || '')) return;
      const confirmed = await showActionConfirmation('Delete cancelled booking?', 'This permanently removes the booking and its stored payment proof.');
      if (!confirmed) return;
      button.disabled = true;
      const action = showActionPopup('Deleting cancelled booking…', 'Removing the booking and its stored payment proof.');
      try {
        await api('/api/admin/bookings/' + encodeURIComponent(reference), { method: 'DELETE' });
        adminDashboardData = await api('/api/admin/dashboard');
        await renderAdmin({ useCache: true, activeTab: 'cancelled' });
        showNotice($('#bookingAdminNotice'), 'Cancelled booking and payment proof deleted.', false);
        await action.complete('Booking deleted', 'The cancelled booking and its payment proof were removed.');
      } catch (error) {
        action.dismiss();
        if (button.isConnected) button.disabled = false;
        showNotice($('#bookingAdminNotice'), error.message);
      }
    }));
    modalContent.querySelectorAll('[data-paid]').forEach(button => button.addEventListener('click', () => saveBookingStatus(button.dataset.paid, 'Paid', 'paid')));
    modalContent.querySelectorAll('[data-cancel-booking]').forEach(button => button.addEventListener('click', () => saveBookingStatus(button.dataset.cancelBooking, 'Cancelled', button.closest('[data-booking-section]')?.dataset.bookingSection || 'pending')));
    modalContent.querySelectorAll('[data-payment-proof]').forEach(button => button.addEventListener('click', async () => {
      $('#adminReceiptPreview')?.remove();
      const reference = button.dataset.paymentProof;
      const layer = document.createElement('div');
      layer.className = 'admin-receipt-backdrop';
      layer.id = 'adminReceiptPreview';
      layer.innerHTML = '<section class="admin-receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="adminReceiptTitle"><header><h2 id="adminReceiptTitle">Payment proof</h2><button type="button" class="contact-popup-close" data-receipt-close aria-label="Close receipt preview">×</button></header><div class="admin-receipt-loading" role="status"><span class="admin-receipt-spinner" aria-hidden="true"></span><strong>Loading receipt…</strong><span>Please wait while the receipt image is retrieved.</span></div><div class="admin-receipt-content"></div></section>';
      modal.append(layer);
      const closePreview = () => { layer.remove(); if (button.isConnected) button.focus(); };
      layer.addEventListener('click', event => {
        if (event.target === layer || event.target.closest('[data-receipt-close]')) closePreview();
      });
      const loading = $('.admin-receipt-loading', layer), content = $('.admin-receipt-content', layer);
      const referenceLabel = document.createElement('p');
      referenceLabel.textContent = 'Booking ' + reference;
      content.append(referenceLabel);
      const requestedButton = button;
      requestedButton.setAttribute('aria-busy', 'true');
      try {
        const proof = await post('/api/admin/bookings/proof', { reference });
        if (!layer.isConnected) return;
        const proofImage = safeImage(proof.receiptImage);
        if (proof.paymentReference) {
          const paymentReference = document.createElement('div');
          paymentReference.className = 'payment-reference';
          paymentReference.textContent = 'Payment reference: ' + proof.paymentReference;
          content.append(paymentReference);
        }
        if (proofImage) {
          const image = document.createElement('img');
          image.className = 'admin-proof-image';
          image.alt = 'Customer payment receipt';
          const download = document.createElement('a');
          download.className = 'payment-qr-download';
          download.textContent = 'Download receipt image';
          download.href = proofImage;
          download.download = 'payment-receipt-' + encodeURIComponent(reference);
          await new Promise(resolve => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
            image.src = proofImage;
            if (image.complete) resolve();
          });
          if (!layer.isConnected) return;
          loading.hidden = true;
          if (image.naturalWidth) content.append(image, download);
          else {
            const failedImage = document.createElement('p');
            failedImage.className = 'payment-help';
            failedImage.textContent = 'The receipt image could not be displayed.';
            content.append(failedImage);
          }
        } else {
          loading.hidden = true;
          const noImage = document.createElement('p');
          noImage.textContent = 'No receipt image was uploaded.';
          content.append(noImage);
        }
      } catch (error) {
        if (!layer.isConnected) return;
        loading.hidden = true;
        const failure = document.createElement('p');
        failure.className = 'payment-help';
        failure.setAttribute('role', 'alert');
        failure.textContent = 'Could not load the payment proof. ' + error.message;
        content.append(failure);
      } finally {
        requestedButton.removeAttribute('aria-busy');
      }
      $('[data-receipt-close]', layer)?.focus();
    }));
    modalContent.querySelectorAll('[data-receipt]').forEach(button => button.addEventListener('click', () => printReceipt(data.bookings.find(item => item.reference === button.dataset.receipt))));
    }
    bindBookingActions();
    let bookingRefreshInProgress = false;
    async function refreshAdminBookings() {
      if (bookingRefreshInProgress || !modal.classList.contains('open') || !$('.modal.admin-modal', modal)) return;
      bookingRefreshInProgress = true;
      try {
        const latest = await api('/api/admin/dashboard');
        if (!modal.classList.contains('open') || !$('.modal.admin-modal', modal)) return;
        adminDashboardData = Object.assign({}, adminDashboardData || {}, { bookings: latest.bookings || [] });
        applyLiveBookings(latest.bookings || []);
        const liveStatus = $('#adminBookingsLiveStatus');
        if (liveStatus) liveStatus.textContent = 'Live · updates every 10 seconds';
      } catch (error) {
        const liveStatus = $('#adminBookingsLiveStatus');
        if (liveStatus) liveStatus.textContent = 'Live · reconnecting';
      } finally {
        bookingRefreshInProgress = false;
      }
    }
    adminBookingsPollTimer = window.setInterval(refreshAdminBookings, 10000);
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
  let publicContentReady = false, introFinished = false, introCheckScheduled = false;
  const introStartedAt = Date.now();
  function finishIntro() {
    if (introFinished) return; introFinished = true;
    const loader = $('#siteLoader');
    if (loader) { loader.classList.add('is-done'); window.setTimeout(() => { loader.remove(); document.documentElement.classList.remove('site-loading'); }, 650); }
    else document.documentElement.classList.remove('site-loading');
  }
  function checkIntroReadiness() {
    if (introFinished) return;
    const elapsed = Date.now() - introStartedAt, images = Array.from(document.images);
    images.forEach(image => { if (image.loading === 'lazy') image.loading = 'eager'; });
    const allImagesLoaded = images.every(image => image.complete);
    if ((publicContentReady && allImagesLoaded && elapsed >= 1600) || elapsed >= 8500) { finishIntro(); return; }
    if (!introCheckScheduled) { introCheckScheduled = true; window.setTimeout(() => { introCheckScheduled = false; checkIntroReadiness(); }, 100); }
  }
  async function loadPublicSettings() {
    const retry = $('#retryPublicData'); if (retry) { retry.disabled = true; retry.textContent = 'Connecting…'; }
    try {
      const data = await api('/api/public', { timeoutMs: 40000 });
      settings = normalizeSettings(data.settings); adminSetupRequired = data.adminSetupRequired; savePublicCache({ ...data, settings }); refreshPublic();
    } catch (error) {
      if (!settings.courts.length) showPublicUnavailable(error);
      else {
        let notice = $('#publicRefreshNotice');
        if (!notice) { notice = document.createElement('p'); notice.id = 'publicRefreshNotice'; notice.className = 'payment-help'; $('#courtGrid').before(notice); }
        notice.textContent = 'Showing saved court details. Live booking could not connect; availability will be checked when you book.';
      }
    } finally { publicContentReady = true; checkIntroReadiness(); }
  }
  $('#courtGrid').addEventListener('click', event => { if (event.target.closest('#retryPublicData')) loadPublicSettings(); });
  function start() {
    const cached = readPublicCache();
    if (cached) { settings = normalizeSettings(cached.settings); adminSetupRequired = cached.adminSetupRequired; refreshPublic(); publicContentReady = true; }
    else $('#courtGrid').innerHTML = '<div class="empty-state court-empty"><span class="empty-courts-icon">…</span><h2>Loading courts</h2><p>Getting the latest court hours and prices.</p></div>';
    checkIntroReadiness();
    loadPublicSettings();
  }
  start();
})();

