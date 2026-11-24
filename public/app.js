'use strict';
/* =====================================================================
   StudentHub frontend — vanilla JS single-page app (hash routing)
===================================================================== */
const DEPARTMENTS = ['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil'];
const YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEMESTERS = Array.from({ length: 8 }, (_, i) => `Semester ${i + 1}`);

const state = { user: null, filters: {}, cache: {}, adminTab: 'overview', adminRes: 'notes', routeToken: 0, notifTimer: null };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');

/* ------------------------------------------------------------ utilities */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const tagList = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);
const tagsHtml = (arr) => `<div class="tags">${arr.filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;

function parseTs(ts) { return new Date(String(ts).replace(' ', 'T') + 'Z'); }
function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - parseTs(ts)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return parseTs(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}
function daysUntil(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(d + 'T00:00:00') - today) / 86400000);
}
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}
const initials = (n) => (String(n).split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'U');

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, init); } catch { throw new Error('Cannot reach the server. Check your connection.'); }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; showAuth('Your session has expired. Please log in again.'); }
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

/* ------------------------------------------------------------ modal */
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
function openModal({ title, html, submitLabel = 'Save', onSubmit, wide = false, noSubmit = false }) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button></div>
    <form id="modalForm" novalidate>
      <div class="form-error" id="modalError" hidden></div>
      ${html}
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close-modal">${noSubmit ? 'Close' : 'Cancel'}</button>
        ${noSubmit ? '' : `<button type="submit" class="btn">${esc(submitLabel)}</button>`}
      </div>
    </form></div>`;
  m.hidden = false;
  const form = $('#modalForm');
  const first = form.querySelector('input,textarea,select');
  if (first) first.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#modalError');
    err.hidden = true;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = form.querySelector('button[type=submit]');
    try { await busy(btn, () => onSubmit(new FormData(form), form)); closeModal(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}
const confirmModal = (title, message, label, onYes) =>
  openModal({ title, html: `<p>${esc(message)}</p>`, submitLabel: label, onSubmit: onYes });

/* ------------------------------------------------------------ auth */
function fillSelect(id, values) {
  const el = $(id);
  for (const v of values) el.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`);
}
function switchAuth(id) {
  $$('.auth-form').forEach((f) => f.classList.toggle('active', f.id === id));
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.auth === id));
  $('#authError').hidden = true;
}
function showAuth(message) {
  state.user = null;
  clearInterval(state.notifTimer);
  $('#authOverlay').hidden = false;
  document.body.classList.add('locked');
  view.innerHTML = '';
  closeModal();
  const e = $('#authError');
  if (message) { e.textContent = message; e.hidden = false; } else e.hidden = true;
}
function enter(user) {
  state.user = user;
  $('#authOverlay').hidden = true;
  document.body.classList.remove('locked');
  updateProfileChips();
  $$('.admin-only').forEach((el) => { el.hidden = user.role !== 'admin'; });
  if (!location.hash || location.hash === '#') location.hash = '#/dashboard';
  route();
  loadNotifications();
  clearInterval(state.notifTimer);
  state.notifTimer = setInterval(loadNotifications, 60000);
}
function updateProfileChips() {
  const u = state.user;
  $('#profileName').textContent = u.name;
  $('#profileRole').textContent = u.role === 'admin' ? 'Administrator' : `${u.department} • ${u.year}`;
  $('#avatar').textContent = initials(u.name);
}
async function submitAuth(form, path, payload) {
  const err = $('#authError');
  err.hidden = true;
  const btn = form.querySelector('button[type=submit]');
  try {
    const { user } = await busy(btn, () => api(path, { method: 'POST', body: payload }));
    form.reset();
    enter(user);
    toast(user.role === 'admin' ? 'Admin login successful' : `Welcome, ${user.name.split(' ')[0]}!`);
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  location.hash = '';
  showAuth();
  switchAuth('studentLogin');
  toast('Logged out successfully');
}

/* ------------------------------------------------------------ theme / sidebar */
function applyTheme(dark) { document.body.classList.toggle('dark', dark); }
function initTheme() { try { applyTheme(localStorage.getItem('theme') === 'dark'); } catch { /* storage blocked */ } }
function toggleTheme() {
  const dark = !document.body.classList.contains('dark');
  applyTheme(dark);
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  toast(dark ? 'Dark mode enabled' : 'Light mode enabled');
}
function setSidebar(open) { $('#sidebar').classList.toggle('open', open); $('#scrim').classList.toggle('show', open); }

/* ------------------------------------------------------------ notifications */
async function loadNotifications() {
  try {
    const { items, unread } = await api('/notifications');
    state.notifs = items;
    const b = $('#bellBadge');
    b.textContent = unread > 9 ? '9+' : unread;
    b.hidden = !unread;
  } catch { /* ignore */ }
}
async function toggleBell() {
  const panel = $('#notifPanel');
  if (!panel.hidden) { panel.hidden = true; return; }
  await loadNotifications();
  const items = state.notifs || [];
  panel.innerHTML = `<h4>Notifications</h4>` + (items.length
    ? items.map((n) => `<a class="notif-item ${n.unread ? 'unread' : ''}" href="#/${n.type === 'event' ? 'events' : 'announcements'}">
        <strong>${n.type === 'event' ? '📅' : '📢'} ${esc(n.title)}</strong><small>${n.type === 'event' ? 'New event' : 'Announcement'} • ${timeAgo(n.created_at)}</small></a>`).join('')
    : '<div class="notif-item">No notifications yet</div>');
  panel.hidden = false;
  if ($('#bellBadge').hidden === false) {
    try { await api('/notifications/seen', { method: 'POST', body: {} }); $('#bellBadge').hidden = true; } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------ cards */
const iconFor = (m) => {
  const t = (m.subject + ' ' + m.title).toLowerCase();
  if (/java/.test(t)) return '☕';
  if (/machine|ai\b/.test(t)) return '🤖';
  if (/network/.test(t)) return '🌐';
  if (/electr|signal|circuit/.test(t)) return '⚡';
  if (/math/.test(t)) return '➗';
  return m.kind === 'paper' ? '📝' : '📄';
};

function materialCard(m) {
  const meta = m.kind === 'paper'
    ? [m.department, m.year, m.semester, m.exam_year && `Exam ${m.exam_year}`]
    : [m.department, m.year, m.semester, ...tagList(m.tags)];
  return `<div class="item">
    <div class="item-icon">${iconFor(m)}</div>
    <h3>${esc(m.title)}</h3>
    <p>${esc(m.description || m.subject)}</p>
    ${tagsHtml([...new Set(meta)])}
    <div class="item-foot">
      <button class="btn" data-action="download" data-id="${m.id}">${m.kind === 'paper' ? '⬇ Download Paper' : '⬇ Download'}</button>
      <small>${m.downloads} download${m.downloads === 1 ? '' : 's'}${m.size ? ' • ' + fmtSize(m.size) : ''}</small>
    </div></div>`;
}

const STATUS_CLASS = { Submitted: '', 'Under Review': 'amber', Shortlisted: 'green', Selected: 'green', Rejected: 'red' };
const statusPill = (s) => `<span class="pill ${STATUS_CLASS[s] || ''}">${esc(s)}</span>`;

function deadlineInfo(d) {
  if (!d) return { text: '', closed: false };
  const n = daysUntil(d);
  if (n < 0) return { text: `Closed ${fmtDate(d)}`, closed: true };
  if (n === 0) return { text: 'Closes today', closed: false };
  return { text: `${n} day${n === 1 ? '' : 's'} left • ${fmtDate(d)}`, closed: false };
}

function oppCard(o) {
  const dl = deadlineInfo(o.deadline);
  const meta = [o.location, o.duration, o.stipend].filter(Boolean).join(' • ');
  let action;
  if (o.my_status) {
    action = `${statusPill(o.my_status)} <button class="btn ghost small" data-action="withdraw" data-id="${o.my_application_id}">Withdraw</button>`;
  } else if (dl.closed) {
    action = '<span class="pill gray">Applications closed</span>';
  } else {
    action = `<button class="btn" data-action="apply" data-id="${o.id}">${o.kind === 'job' ? 'Apply' : 'Apply Now'}</button>
      ${o.apply_url ? `<a class="btn ghost" href="${esc(o.apply_url)}" target="_blank" rel="noopener noreferrer">Official page ↗</a>` : ''}`;
  }
  return `<div class="item">
    <div class="company-line"><div class="company-logo">${esc((o.company || o.title)[0].toUpperCase())}</div>
      <div><h4 style="font-size:13px">${esc(o.company)}</h4><small class="muted">${esc(meta)}</small></div></div>
    <h3>${esc(o.title)}</h3>
    ${o.description ? `<p>${esc(o.description)}</p>` : ''}
    ${tagsHtml(tagList(o.tags))}
    <div class="item-foot"><div class="row-actions">${action}</div>${dl.text ? `<small>${esc(dl.text)}</small>` : ''}</div>
  </div>`;
}

function eventCard(e) {
  const past = daysUntil(e.event_date) < 0;
  const action = past ? '<span class="pill gray">Event ended</span>'
    : e.registered ? `<span class="pill green">✓ Registered</span> <button class="btn ghost small" data-action="event-unreg" data-id="${e.id}">Cancel</button>`
      : `<button class="btn" data-action="event-reg" data-id="${e.id}">Register</button>`;
  return `<div class="item">
    <div class="event-date">${fmtDate(e.event_date)}${e.location ? ' • ' + esc(e.location) : ''}</div>
    <h3>${esc(e.title)}</h3>
    <p>${esc(e.description)}</p>
    <div class="item-foot"><div class="row-actions">${action}</div>
      <small>${e.registrations} registered</small></div></div>`;
}

const noticeCard = (a) => `<div class="notice"><div class="meta"><h3>${esc(a.title)}</h3><span>${timeAgo(a.created_at)}</span></div><p>${esc(a.body)}</p></div>`;
const emptyState = (icon, text) => `<div class="empty"><div class="big">${icon}</div>${esc(text)}</div>`;

/* ------------------------------------------------------------ list pages */
const LISTS = {
  notes: { title: '📚 Study Notes', sub: 'Find notes and study materials.', filters: ['q', 'department', 'year', 'semester'], card: materialCard, empty: ['📭', 'No notes match your filters.'] },
  papers: { title: '📝 Previous Question Papers', sub: 'Practice with previous examination papers.', filters: ['q', 'department', 'year', 'semester'], card: materialCard, empty: ['📭', 'No question papers match your filters.'] },
  internships: { title: '💼 Internships', sub: 'Discover internships and gain industry experience.', filters: ['q'], card: oppCard, empty: ['💼', 'No internships found.'] },
  jobs: { title: '💻 Fresher Jobs', sub: 'Find entry-level jobs and start your career.', filters: ['q'], card: oppCard, empty: ['💻', 'No jobs found.'] },
  announcements: { title: '📢 Announcements', sub: 'Important college and student updates.', filters: ['q'], card: noticeCard, wrap: 'card', empty: ['📢', 'No announcements yet.'] },
  events: { title: '📅 Events', sub: 'Workshops, seminars, hackathons and college events.', filters: ['q'], card: eventCard, empty: ['📅', 'No events found.'] },
};

function filterBar(page) {
  const f = state.filters[page] || {};
  const cfg = LISTS[page];
  const sel = (key, label, opts) => `<select data-filter="${key}" aria-label="${label}"><option value="">${label}</option>${opts.map((o) => `<option ${f[key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  return `<div class="filter">
    <input type="search" data-filter="q" placeholder="Search ${page}…" value="${esc(f.q || '')}" aria-label="Search">
    ${cfg.filters.includes('department') ? sel('department', 'All Departments', DEPARTMENTS) : ''}
    ${cfg.filters.includes('year') ? sel('year', 'All Years', YEARS) : ''}
    ${cfg.filters.includes('semester') ? sel('semester', 'All Semesters', SEMESTERS) : ''}
  </div>`;
}

async function loadList(page) {
  const cfg = LISTS[page];
  const box = $('#results');
  if (!box) return;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filters[page] || {})) if (v) params.set(k, v);
  try {
    const { items } = await api(`/${page}?${params}`);
    if (!$('#results')) return;
    state.cache[page] = items;
    box.innerHTML = items.length ? items.map(cfg.card).join('') : emptyState(...cfg.empty);
  } catch (ex) { box.innerHTML = emptyState('⚠️', ex.message); }
}

function listPage(page, query) {
  const cfg = LISTS[page];
  if (query.get('q')) state.filters[page] = { ...(state.filters[page] || {}), q: query.get('q') };
  return {
    html: `<div class="page-title"><h1>${cfg.title}</h1><p>${cfg.sub}</p></div>${filterBar(page)}
      <div id="results" class="${cfg.wrap || 'grid'}"><div class="loading">Loading…</div></div>`,
    after: () => loadList(page),
  };
}

/* ------------------------------------------------------------ dashboard */
async function dashboardPage() {
  const d = await api('/dashboard');
  const u = state.user;
  const s = d.stats;
  const stat = (n, label, icon, href) => `<a class="stat-card link" href="${href}"><div><h3>${n}</h3><p>${label}</p></div><div class="stat-icon">${icon}</div></a>`;
  const noteRow = (m) => `<div class="note"><div class="file-icon">📄</div>
    <div class="note-info"><h4>${esc(m.title)}</h4><p>${esc([m.department, m.year, m.size ? fmtSize(m.size) : 'PDF'].filter(Boolean).join(' • '))}</p></div>
    <button class="download-btn" data-action="download" data-id="${m.id}">Download</button></div>`;
  const miniOpp = (o) => `<div class="internship"><div class="company"><div class="company-logo">${esc((o.company || 'T')[0].toUpperCase())}</div>
    <div><h4>${esc(o.company)}</h4><p>${esc([o.location, o.duration].filter(Boolean).join(' • '))}</p></div></div>
    <h3>${esc(o.title)}</h3>${tagsHtml(tagList(o.tags))}
    ${o.my_status ? `<div style="margin-top:11px">${statusPill(o.my_status)}</div>` : `<button class="apply" data-action="apply" data-id="${o.id}">Apply Now</button>`}</div>`;
  state.cache.internships = d.internships;
  return `<div class="welcome"><h1>${greeting()}, ${esc(u.name.split(' ')[0])}! 👋</h1>
      <p>${u.role === 'admin' ? 'Welcome to the StudentHub administration area.' : 'Your one-stop platform for college, learning and career opportunities.'}</p></div>
    <div class="stats">
      ${stat(s.notes, 'Study Materials', '📚', '#/notes')}
      ${stat(s.internships + s.jobs, 'Internships & Jobs', '💼', '#/internships')}
      ${stat(s.papers, 'Question Papers', '📝', '#/papers')}
      ${stat(s.events, 'Upcoming Events', '📅', '#/events')}
    </div>
    <div class="section-grid">
      <div class="card"><div class="card-header"><h2>📚 Recent Notes</h2><a class="view-all" href="#/notes">View All →</a></div>
        ${d.notes.map(noteRow).join('') || '<p class="muted">No notes yet.</p>'}</div>
      <div class="card"><div class="card-header"><h2>💼 Internships</h2><a class="view-all" href="#/internships">View All →</a></div>
        ${d.internships.map(miniOpp).join('') || '<p class="muted">No internships yet.</p>'}</div>
    </div>
    <div class="section-grid">
      <div class="card"><div class="card-header"><h2>📢 Latest Announcements</h2><a class="view-all" href="#/announcements">View All →</a></div>
        ${d.announcements.map((a) => `<div class="announcement"><div class="announcement-icon">📢</div><div><h4>${esc(a.title)}</h4><p>${esc(a.body.slice(0, 90))}${a.body.length > 90 ? '…' : ''}</p></div></div>`).join('') || '<p class="muted">Nothing new.</p>'}</div>
      <div class="card"><div class="card-header"><h2>📌 My Activity</h2><a class="view-all" href="#/activity">Open →</a></div>
        <div class="announcement"><div class="announcement-icon">💼</div><div><h4>${d.applications} application${d.applications === 1 ? '' : 's'}</h4><p>Internships &amp; jobs you applied for</p></div></div>
        <div class="announcement"><div class="announcement-icon">🎟️</div><div><h4>${d.registrations} event registration${d.registrations === 1 ? '' : 's'}</h4><p>Workshops and seminars you joined</p></div></div>
      </div>
    </div>
    <div class="card"><div class="card-header"><h2>🎯 Upcoming Events</h2><a class="view-all" href="#/events">View Calendar →</a></div>
      <div class="events">${d.events.map((e) => `<div class="event"><div class="event-date">${fmtDate(e.event_date)}</div><h3>${esc(e.title)}</h3><p>${esc(e.description)}</p></div>`).join('') || '<p class="muted">No upcoming events.</p>'}</div></div>`;
}

/* ------------------------------------------------------------ community */
async function communityPage(arg) {
  if (arg) return questionPage(arg);
  return {
    html: `<div class="page-title"><h1>🤝 Student Community</h1><p>Ask questions, share knowledge and help other students.</p></div>
      <form class="question-box" id="questionForm"><h3>Ask the Student Community</h3>
        <input name="title" placeholder="What do you want to ask?" required minlength="5" maxlength="200" aria-label="Question">
        <textarea name="body" placeholder="Add more details (optional)" maxlength="4000" aria-label="Details"></textarea>
        <input name="tags" placeholder="Tags, comma separated (optional)" maxlength="200" aria-label="Tags">
        <button class="btn" type="submit">Post Question</button></form>
      <div class="filter"><input type="search" data-filter="q" placeholder="Search questions…" value="${esc((state.filters.community || {}).q || '')}" aria-label="Search questions"></div>
      <div class="grid" id="results"><div class="loading">Loading…</div></div>`,
    after: loadQuestions,
  };
}
function questionCard(q) {
  return `<div class="item"><div class="item-icon">❓</div>
    <h3><a href="#/community/${q.id}">${esc(q.title)}</a></h3>
    <p>Asked by ${esc(q.author_name)} • ${timeAgo(q.created_at)}</p>
    ${tagsHtml(tagList(q.tags))}
    <div class="item-foot"><a class="btn" href="#/community/${q.id}">View Discussion</a>
      <small>${q.answers} answer${q.answers === 1 ? '' : 's'}</small></div></div>`;
}
async function loadQuestions() {
  const box = $('#results'); if (!box) return;
  const q = (state.filters.community || {}).q || '';
  try {
    const { items } = await api('/questions?q=' + encodeURIComponent(q));
    if (!$('#results')) return;
    box.innerHTML = items.length ? items.map(questionCard).join('') : emptyState('🤔', q ? 'No questions match your search.' : 'No questions yet — ask the first one!');
  } catch (ex) { box.innerHTML = emptyState('⚠️', ex.message); }
}
async function questionPage(id) {
  const { question: q, answers } = await api(`/questions/${encodeURIComponent(id)}`);
  const canDelete = (o) => o.mine || state.user.role === 'admin';
  return `<a class="back" href="#/community">← Back to community</a>
    <div class="card"><div class="card-header"><h2>${esc(q.title)}</h2>
      ${canDelete(q) ? `<button class="btn danger small" data-action="del-question" data-id="${q.id}">Delete</button>` : ''}</div>
      <small class="muted">Asked by ${esc(q.author_name)} • ${timeAgo(q.created_at)}</small>
      ${q.body ? `<div class="q-body">${esc(q.body)}</div>` : ''}${tagsHtml(tagList(q.tags))}</div>
    <div class="card" style="margin-top:20px"><div class="card-header"><h2>${answers.length} Answer${answers.length === 1 ? '' : 's'}</h2></div>
      ${answers.map((a) => `<div class="answer"><div class="by">${esc(a.author_name)} • ${timeAgo(a.created_at)}</div><p>${esc(a.body)}</p>
        ${canDelete(a) ? `<button class="btn ghost small" data-action="del-answer" data-id="${a.id}" data-q="${q.id}">Delete</button>` : ''}</div>`).join('') || '<p class="muted">No answers yet. Be the first to help!</p>'}
      <form id="answerForm" data-id="${q.id}" style="margin-top:18px"><div class="form-group"><label for="ansBody">Your answer</label>
        <textarea id="ansBody" name="body" required minlength="2" maxlength="4000" placeholder="Share what you know…"></textarea></div>
        <button class="btn" type="submit">Post Answer</button></form></div>`;
}

/* ------------------------------------------------------------ activity & profile */
async function activityPage() {
  const [apps, evs, qs] = await Promise.all([api('/me/applications'), api('/me/events'), api('/me/questions')]);
  return `<div class="page-title"><h1>📌 My Activity</h1><p>Everything you have applied for, joined or asked.</p></div>
    <div class="card" style="margin-bottom:20px"><div class="card-header"><h2>💼 My Applications</h2></div>
      ${apps.items.length ? `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Type</th><th>Applied</th><th>Status</th><th></th></tr></thead><tbody>
        ${apps.items.map((a) => `<tr><td><strong>${esc(a.title)}</strong><small>${esc(a.company)}${a.location ? ' • ' + esc(a.location) : ''}</small></td>
          <td>${a.kind === 'job' ? 'Job' : 'Internship'}</td><td>${timeAgo(a.created_at)}</td><td>${statusPill(a.status)}</td>
          <td><button class="btn ghost small" data-action="withdraw" data-id="${a.id}" data-refresh="1">Withdraw</button></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">You have not applied anywhere yet. Browse <a href="#/internships" class="view-all">internships</a> or <a href="#/jobs" class="view-all">jobs</a>.</p>'}</div>
    <div class="two-col">
      <div class="card"><div class="card-header"><h2>🎟️ My Events</h2></div>
        ${evs.items.map((e) => `<div class="announcement"><div class="announcement-icon">📅</div><div style="flex:1"><h4>${esc(e.title)}</h4><p>${fmtDate(e.event_date)}${e.location ? ' • ' + esc(e.location) : ''}</p></div>
          ${daysUntil(e.event_date) >= 0 ? `<button class="btn ghost small" data-action="event-unreg" data-id="${e.id}" data-refresh="1">Cancel</button>` : '<span class="pill gray">Ended</span>'}</div>`).join('') || '<p class="muted">No event registrations.</p>'}</div>
      <div class="card"><div class="card-header"><h2>❓ My Questions</h2></div>
        ${qs.items.map((q) => `<div class="announcement"><div class="announcement-icon">❓</div><div><h4><a href="#/community/${q.id}">${esc(q.title)}</a></h4><p>${q.answers} answer${q.answers === 1 ? '' : 's'} • ${timeAgo(q.created_at)}</p></div></div>`).join('') || '<p class="muted">You have not asked anything yet.</p>'}</div>
    </div>`;
}

function profilePage() {
  const u = state.user;
  const opts = (list, cur) => list.map((o) => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('');
  return `<div class="page-title"><h1>👤 My Profile</h1><p>Manage your account details.</p></div>
    <div class="two-col">
      <form class="card" id="profileForm"><div class="card-header"><h2>Details</h2>${u.role === 'admin' ? '<span class="pill red">Admin</span>' : '<span class="pill">Student</span>'}</div>
        <dl class="kv" style="margin-bottom:16px"><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Student ID</dt><dd>${esc(u.studentId || '—')}</dd></dl>
        <div class="form-group"><label>Full name</label><input name="name" value="${esc(u.name)}" required minlength="2" maxlength="80"></div>
        <div class="form-row"><div class="form-group"><label>Department</label><select name="department">${opts(DEPARTMENTS, u.department)}</select></div>
          <div class="form-group"><label>Year</label><select name="year">${opts(YEARS, u.year)}</select></div></div>
        <div class="form-error" hidden></div><button class="btn" type="submit">Save changes</button></form>
      <form class="card" id="passwordForm"><div class="card-header"><h2>Change password</h2></div>
        <div class="form-group"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required></div>
        <div class="form-group"><label>New password</label><input type="password" name="next" autocomplete="new-password" minlength="8" required><div class="form-hint">At least 8 characters. You will stay logged in here; other devices are logged out.</div></div>
        <div class="form-error" hidden></div><button class="btn" type="submit">Update password</button></form>
    </div>`;
}

/* ------------------------------------------------------------ search */
async function searchPage(_, query) {
  const q = (query.get('q') || '').trim();
  $('#globalSearch').value = q;
  if (q.length < 2) return `<div class="page-title"><h1>🔍 Search</h1><p>Type at least 2 characters.</p></div>`;
  const { results } = await api('/search?q=' + encodeURIComponent(q));
  const groups = [
    ['notes', '📚 Notes', (r) => [r.title, `${r.department} • ${r.year}`, '#/notes', r.title]],
    ['papers', '📝 Question Papers', (r) => [r.title, `${r.department} • ${r.year}`, '#/papers', r.title]],
    ['internships', '💼 Internships', (r) => [r.title, r.company, '#/internships', r.title]],
    ['jobs', '💻 Jobs', (r) => [r.title, r.company, '#/jobs', r.title]],
    ['announcements', '📢 Announcements', (r) => [r.title, timeAgo(r.created_at), '#/announcements', r.title]],
    ['events', '📅 Events', (r) => [r.title, fmtDate(r.event_date), '#/events', r.title]],
    ['questions', '🤝 Community', (r) => [r.title, r.author_name, `#/community/${r.id}`, '']],
  ];
  let total = 0;
  const html = groups.map(([key, label, map]) => {
    const rows = results[key] || [];
    total += rows.length;
    if (!rows.length) return '';
    return `<div class="result-group"><h2>${label}</h2>${rows.map((r) => {
      const [title, sub, href, pre] = map(r);
      return `<a class="result-row" href="${href}" data-action="goto-result" data-page="${key}" data-q="${esc(pre)}"><span>${esc(title)}</span><small>${esc(sub)}</small></a>`;
    }).join('')}</div>`;
  }).join('');
  return `<div class="page-title"><h1>🔍 Results for “${esc(q)}”</h1><p>${total} result${total === 1 ? '' : 's'} found.</p></div>${html || emptyState('🔎', 'No matching results found.')}`;
}

/* ------------------------------------------------------------ admin */
const opt = (list) => ['', 'All', ...list];
const ADMIN = {
  notes: {
    label: 'Notes', one: 'Note', file: true,
    fields: [
      { n: 'title', l: 'Title', req: 1 }, { n: 'subject', l: 'Subject' },
      { n: 'department', l: 'Department', t: 'select', o: opt(DEPARTMENTS) }, { n: 'year', l: 'Year', t: 'select', o: opt(YEARS) },
      { n: 'semester', l: 'Semester', t: 'select', o: opt(SEMESTERS) }, { n: 'tags', l: 'Tags (comma separated)' },
      { n: 'description', l: 'Description', t: 'textarea', full: 1 },
    ],
    cols: [['Title', (r) => `<strong>${esc(r.title)}</strong><small>${esc(r.subject)}</small>`], ['Dept / Year', (r) => esc([r.department, r.year].filter(Boolean).join(' • '))], ['File', (r) => r.has_file ? `${esc(r.file_name)}<small>${fmtSize(r.size)}</small>` : '<span class="muted">placeholder</span>'], ['Downloads', (r) => r.downloads]],
  },
  papers: {
    label: 'Question Papers', one: 'Question Paper', file: true,
    fields: [
      { n: 'title', l: 'Title', req: 1 }, { n: 'subject', l: 'Subject' },
      { n: 'department', l: 'Department', t: 'select', o: opt(DEPARTMENTS) }, { n: 'year', l: 'Year', t: 'select', o: opt(YEARS) },
      { n: 'semester', l: 'Semester', t: 'select', o: opt(SEMESTERS) }, { n: 'exam_year', l: 'Exam year (e.g. 2025)' },
      { n: 'description', l: 'Description', t: 'textarea', full: 1 }, { n: 'tags', l: 'Tags (comma separated)' },
    ],
    cols: [['Title', (r) => `<strong>${esc(r.title)}</strong><small>${esc(r.subject)}</small>`], ['Dept / Year', (r) => esc([r.department, r.year, r.semester].filter(Boolean).join(' • '))], ['Exam', (r) => esc(r.exam_year)], ['File', (r) => r.has_file ? esc(r.file_name) : '<span class="muted">placeholder</span>'], ['Downloads', (r) => r.downloads]],
  },
  internships: {
    label: 'Internships', one: 'Internship',
    fields: [
      { n: 'title', l: 'Title', req: 1 }, { n: 'company', l: 'Company', req: 1 }, { n: 'location', l: 'Location' }, { n: 'duration', l: 'Duration (e.g. 3 Months)' },
      { n: 'stipend', l: 'Stipend' }, { n: 'deadline', l: 'Deadline', t: 'date' }, { n: 'tags', l: 'Skills (comma separated)' }, { n: 'apply_url', l: 'Official apply link', t: 'url' },
      { n: 'description', l: 'Description', t: 'textarea', full: 1 },
    ],
    cols: [['Role', (r) => `<strong>${esc(r.title)}</strong><small>${esc(r.company)}</small>`], ['Location', (r) => esc(r.location)], ['Deadline', (r) => esc(fmtDate(r.deadline))], ['Applicants', (r) => r.applicants]],
  },
  jobs: {
    label: 'Jobs', one: 'Job',
    fields: [
      { n: 'title', l: 'Title', req: 1 }, { n: 'company', l: 'Company', req: 1 }, { n: 'location', l: 'Location' }, { n: 'duration', l: 'Type (e.g. Full Time)' },
      { n: 'stipend', l: 'Salary' }, { n: 'deadline', l: 'Deadline', t: 'date' }, { n: 'tags', l: 'Skills (comma separated)' }, { n: 'apply_url', l: 'Official apply link', t: 'url' },
      { n: 'description', l: 'Description', t: 'textarea', full: 1 },
    ],
    cols: [['Role', (r) => `<strong>${esc(r.title)}</strong><small>${esc(r.company)}</small>`], ['Location', (r) => esc(r.location)], ['Deadline', (r) => esc(fmtDate(r.deadline))], ['Applicants', (r) => r.applicants]],
  },
  announcements: {
    label: 'Announcements', one: 'Announcement',
    fields: [{ n: 'title', l: 'Title', req: 1, full: 1 }, { n: 'body', l: 'Message', t: 'textarea', full: 1 }],
    cols: [['Title', (r) => `<strong>${esc(r.title)}</strong><small>${esc((r.body || '').slice(0, 80))}</small>`], ['Posted', (r) => timeAgo(r.created_at)]],
  },
  events: {
    label: 'Events', one: 'Event',
    fields: [{ n: 'title', l: 'Title', req: 1 }, { n: 'event_date', l: 'Date', t: 'date', req: 1 }, { n: 'location', l: 'Location' }, { n: 'description', l: 'Description', t: 'textarea', full: 1 }],
    cols: [['Event', (r) => `<strong>${esc(r.title)}</strong><small>${esc(r.location)}</small>`], ['Date', (r) => esc(fmtDate(r.event_date))], ['Registered', (r) => `${r.registrations} <button class="btn ghost small" data-action="admin-regs" data-id="${r.id}">View</button>`]],
  },
};

function adminShell(inner) {
  const tabs = [['overview', 'Overview'], ['content', 'Content'], ['users', 'Users'], ['applications', 'Applications']];
  return `<div class="page-title"><h1>🛠️ Admin Panel</h1><p>Manage content, students and applications.</p></div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${state.adminTab === k ? 'active' : ''}" data-action="admin-tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="adminBody">${inner}</div>`;
}
async function adminBody() {
  switch (state.adminTab) {
    case 'content': return adminContent();
    case 'users': return adminUsers();
    case 'applications': return adminApplications();
    default: return adminOverview();
  }
}
async function adminPage() {
  if (state.user.role !== 'admin') { location.hash = '#/dashboard'; return ''; }
  return adminShell(await adminBody());
}
async function refreshAdmin() {
  if (!$('#adminBody')) return;
  const html = await adminBody();
  const body = $('#adminBody');
  if (body) body.innerHTML = html;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.adminTab));
}

async function adminOverview() {
  const [s, apps] = await Promise.all([api('/admin/stats'), api('/admin/applications')]);
  const card = (n, l, i) => `<div class="stat-card"><div><h3>${n}</h3><p>${l}</p></div><div class="stat-icon">${i}</div></div>`;
  const max = Math.max(1, ...s.topMaterials.map((m) => m.downloads));
  return `<div class="stats">${card(s.students, 'Students', '🎓')}${card(s.applications, 'Applications', '💼')}${card(s.pending, 'Awaiting review', '⏳')}${card(s.downloads, 'Total downloads', '⬇️')}</div>
    <div class="stats">${card(s.registrations, 'Event registrations', '🎟️')}${card(s.questions, 'Community questions', '🤝')}${card(s.content.notes + s.content.papers, 'Materials', '📚')}${card(s.content.internships + s.content.jobs, 'Openings', '💻')}</div>
    <div class="two-col">
      <div class="card"><div class="card-header"><h2>🔥 Most downloaded</h2></div>
        ${s.topMaterials.map((m) => `<div class="chart-bar"><span class="l" title="${esc(m.title)}">${esc(m.title)}</span><i style="width:${Math.round((m.downloads / max) * 100)}%"></i><span>${m.downloads}</span></div>`).join('') || '<p class="muted">No data yet.</p>'}</div>
      <div class="card"><div class="card-header"><h2>🆕 Recent applications</h2><button class="view-all" style="border:0;background:none" data-action="admin-tab" data-tab="applications">View all →</button></div>
        ${apps.items.slice(0, 5).map((a) => `<div class="announcement"><div class="announcement-icon">💼</div><div><h4>${esc(a.name)} → ${esc(a.title)}</h4><p>${esc(a.company)} • ${timeAgo(a.created_at)} • ${esc(a.status)}</p></div></div>`).join('') || '<p class="muted">No applications yet.</p>'}</div>
    </div>`;
}

async function adminContent() {
  const key = state.adminRes;
  const cfg = ADMIN[key];
  const { items } = await api(`/${key}`);
  state.cache['admin-' + key] = items;
  return `<div class="tabs">${Object.entries(ADMIN).map(([k, c]) => `<button class="tab ${k === key ? 'active' : ''}" data-action="admin-res" data-res="${k}">${c.label}</button>`).join('')}</div>
    <div class="page-head" style="margin-bottom:14px"><p class="muted">${items.length} ${cfg.label.toLowerCase()}</p><button class="btn" style="margin-top:0" data-action="admin-add" data-res="${key}">+ Add ${cfg.one}</button></div>
    ${items.length ? `<div class="table-wrap"><table><thead><tr>${cfg.cols.map((c) => `<th>${c[0]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${items.map((r) => `<tr>${cfg.cols.map((c) => `<td>${c[1](r)}</td>`).join('')}<td><div class="row-actions">
        <button class="btn ghost small" data-action="admin-edit" data-res="${key}" data-id="${r.id}">Edit</button>
        <button class="btn danger small" data-action="admin-del" data-res="${key}" data-id="${r.id}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`
    : emptyState('🗂️', `No ${cfg.label.toLowerCase()} yet. Add the first one.`)}`;
}

function adminFormHtml(cfg, row = {}) {
  const field = (f) => {
    const v = row[f.n] ?? '';
    let input;
    if (f.t === 'select') input = `<select name="${f.n}">${f.o.map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${o === '' ? '— not specified —' : o === 'All' ? 'All (everyone)' : esc(o)}</option>`).join('')}</select>`;
    else if (f.t === 'textarea') input = `<textarea name="${f.n}">${esc(v)}</textarea>`;
    else input = `<input name="${f.n}" type="${f.t || 'text'}" value="${esc(v)}" ${f.req ? 'required' : ''}>`;
    return `<div class="form-group" ${f.full ? 'style="grid-column:1/-1"' : ''}><label>${f.l}${f.req ? ' *' : ''}</label>${input}</div>`;
  };
  const file = cfg.file ? `<div class="form-group"><label>File (PDF, DOC, PPT, ZIP, image — max 15 MB)</label>
    <input type="file" name="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.zip,.png,.jpg,.jpeg">
    ${row.has_file ? `<div class="form-hint">Current file: ${esc(row.file_name)} (${fmtSize(row.size)}). Choose a new file to replace it.</div>` : '<div class="form-hint">No file attached — students get a placeholder PDF until you upload one.</div>'}</div>` : '';
  return `<div class="form-row">${cfg.fields.map(field).join('')}</div>${file}`;
}

async function uploadFile(id, file) {
  if (file.size > 15 * 1024 * 1024) throw new Error('File is larger than 15 MB');
  const res = await fetch(`/api/admin/materials/${id}/file`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }, body: file,
  });
  if (!res.ok) { let m = 'Upload failed'; try { m = (await res.json()).error || m; } catch { /* */ } throw new Error(m); }
}

function adminEditor(key, row) {
  const cfg = ADMIN[key];
  const editing = Boolean(row);
  openModal({
    title: `${editing ? 'Edit' : 'Add'} ${cfg.one}`, wide: true, html: adminFormHtml(cfg, row || {}),
    submitLabel: editing ? 'Save changes' : `Add ${cfg.one}`,
    onSubmit: async (fd) => {
      const body = {};
      for (const f of cfg.fields) body[f.n] = String(fd.get(f.n) ?? '');
      const res = editing ? await api(`/admin/${key}/${row.id}`, { method: 'PUT', body }) : await api(`/admin/${key}`, { method: 'POST', body });
      const file = fd.get('file');
      if (cfg.file && file && file.size) await uploadFile(editing ? row.id : res.id, file);
      toast(`${cfg.one} ${editing ? 'updated' : 'added'}`);
      refreshAdmin();
    },
  });
}

async function adminUsers() {
  const { items } = await api('/admin/users');
  return `<p class="muted" style="margin-bottom:12px">${items.length} account${items.length === 1 ? '' : 's'}</p>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Student ID</th><th>Dept / Year</th><th>Role</th><th>Activity</th><th>Joined</th><th></th></tr></thead><tbody>
    ${items.map((u) => {
      const me = u.id === state.user.id;
      return `<tr><td><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></td><td>${esc(u.student_id || '—')}</td>
        <td>${esc([u.department, u.year].filter(Boolean).join(' • '))}</td>
        <td>${u.role === 'admin' ? '<span class="pill red">Admin</span>' : '<span class="pill">Student</span>'}</td>
        <td>${u.applications} apps • ${u.questions} Qs</td><td>${timeAgo(u.created_at)}</td>
        <td><div class="row-actions">
          ${me ? '<span class="muted">You</span>' : `
          <button class="btn ghost small" data-action="admin-role" data-id="${u.id}" data-role="${u.role === 'admin' ? 'student' : 'admin'}" data-name="${esc(u.name)}">${u.role === 'admin' ? 'Make student' : 'Make admin'}</button>
          <button class="btn ghost small" data-action="admin-pw" data-id="${u.id}" data-name="${esc(u.name)}">Reset password</button>
          <button class="btn danger small" data-action="admin-user-del" data-id="${u.id}" data-name="${esc(u.name)}">Delete</button>`}
        </div></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

async function adminApplications() {
  const { items, statuses } = await api('/admin/applications');
  if (!items.length) return emptyState('📭', 'No applications yet.');
  return `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Applied for</th><th>Note</th><th>Date</th><th>Status</th></tr></thead><tbody>
    ${items.map((a) => `<tr><td><strong>${esc(a.name)}</strong><small>${esc(a.student_id || '')} • ${esc(a.department)} ${esc(a.year)}<br>${esc(a.email)}</small></td>
      <td><strong>${esc(a.title)}</strong><small>${esc(a.company)} • ${a.kind === 'job' ? 'Job' : 'Internship'}</small></td>
      <td style="max-width:240px">${a.note ? esc(a.note) : '<span class="muted">—</span>'}</td><td>${timeAgo(a.created_at)}</td>
      <td><select data-action-change="app-status" data-id="${a.id}">${statuses.map((s) => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`;
}

/* ------------------------------------------------------------ router */
const PAGES = {
  dashboard: dashboardPage,
  notes: (_, q) => listPage('notes', q), papers: (_, q) => listPage('papers', q),
  internships: (_, q) => listPage('internships', q), jobs: (_, q) => listPage('jobs', q),
  announcements: (_, q) => listPage('announcements', q), events: (_, q) => listPage('events', q),
  community: communityPage, activity: activityPage, profile: profilePage, search: searchPage, admin: adminPage,
};

async function route() {
  if (!state.user) return;
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [pageRaw, arg] = path.split('/');
  const page = PAGES[pageRaw] ? pageRaw : 'dashboard';
  const token = ++state.routeToken;
  $$('.nav-link[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  if (page !== 'search') $('#globalSearch').value = '';
  setSidebar(false);
  $('#notifPanel').hidden = true;
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    let out = await PAGES[page](arg, new URLSearchParams(qs || ''));
    if (token !== state.routeToken) return;
    if (typeof out === 'string') out = { html: out };
    view.innerHTML = out.html;
    window.scrollTo(0, 0);
    if (out.after) await out.after();
  } catch (ex) {
    if (token !== state.routeToken) return;
    view.innerHTML = emptyState('⚠️', ex.message);
  }
}

/* ------------------------------------------------------------ actions */
async function downloadMaterial(id, btn) {
  await busy(btn, async () => {
    const res = await fetch(`/api/materials/${id}/download`, { credentials: 'same-origin' });
    if (!res.ok) { let m = 'Download failed'; try { m = (await res.json()).error || m; } catch { /* */ } throw new Error(m); }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? decodeURIComponent(m[1]) : 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Download started');
  });
  const page = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (page === 'notes' || page === 'papers') loadList(page);
}

function reloadCurrent() { route(); }

const actions = {
  theme: () => toggleTheme(),
  logout: () => logout(),
  'toggle-sidebar': () => setSidebar(!$('#sidebar').classList.contains('open')),
  'close-sidebar': () => setSidebar(false),
  'close-modal': () => closeModal(),
  bell: () => toggleBell(),
  download: (el) => downloadMaterial(el.dataset.id, el).catch((e) => toast(e.message)),

  apply: (el) => {
    const id = el.dataset.id;
    const o = [...(state.cache.internships || []), ...(state.cache.jobs || [])].find((x) => String(x.id) === id);
    openModal({
      title: `Apply: ${o ? o.title : 'Opportunity'}`, submitLabel: 'Submit application',
      html: `<p class="muted" style="margin-bottom:14px">${o ? esc(o.company) : ''} — your name, email, department and year are shared with the placement team.</p>
        <div class="form-group"><label>Note to recruiter (optional)</label><textarea name="note" maxlength="1000" placeholder="Why are you a good fit? Add a link to your resume or portfolio."></textarea></div>`,
      onSubmit: async (fd) => { await api(`/opportunities/${id}/apply`, { method: 'POST', body: { note: fd.get('note') } }); toast('Application submitted!'); reloadCurrent(); },
    });
  },
  withdraw: (el) => confirmModal('Withdraw application', 'Are you sure you want to withdraw this application?', 'Withdraw',
    async () => { await api(`/applications/${el.dataset.id}`, { method: 'DELETE', body: {} }); toast('Application withdrawn'); reloadCurrent(); }),
  'event-reg': async (el) => { try { await busy(el, () => api(`/events/${el.dataset.id}/register`, { method: 'POST', body: {} })); toast('Registered for event'); reloadCurrent(); } catch (e) { toast(e.message); } },
  'event-unreg': async (el) => { try { await busy(el, () => api(`/events/${el.dataset.id}/register`, { method: 'DELETE', body: {} })); toast('Registration cancelled'); reloadCurrent(); } catch (e) { toast(e.message); } },

  'del-question': (el) => confirmModal('Delete question', 'This will delete the question and all of its answers.', 'Delete',
    async () => { await api(`/questions/${el.dataset.id}`, { method: 'DELETE', body: {} }); toast('Question deleted'); location.hash = '#/community'; }),
  'del-answer': (el) => confirmModal('Delete answer', 'Delete this answer?', 'Delete',
    async () => { await api(`/answers/${el.dataset.id}`, { method: 'DELETE', body: {} }); toast('Answer deleted'); reloadCurrent(); }),
  'goto-result': (el) => {
    const { page, q } = el.dataset;
    if (LISTS[page]) state.filters[page] = { q };
  },

  'admin-tab': (el) => { state.adminTab = el.dataset.tab; refreshAdmin(); },
  'admin-res': (el) => { state.adminRes = el.dataset.res; refreshAdmin(); },
  'admin-add': (el) => adminEditor(el.dataset.res, null),
  'admin-edit': (el) => {
    const row = (state.cache['admin-' + el.dataset.res] || []).find((r) => String(r.id) === el.dataset.id);
    if (row) adminEditor(el.dataset.res, row);
  },
  'admin-del': (el) => {
    const { res, id } = el.dataset;
    confirmModal(`Delete ${ADMIN[res].one.toLowerCase()}`, 'This permanently removes it, along with related applications, registrations and files.', 'Delete',
      async () => { await api(`/admin/${res}/${id}`, { method: 'DELETE', body: {} }); toast('Deleted'); refreshAdmin(); });
  },
  'admin-regs': async (el) => {
    try {
      const { items } = await api(`/admin/events/${el.dataset.id}/registrations`);
      openModal({ title: `Registrations (${items.length})`, wide: true, noSubmit: true, onSubmit: async () => {},
        html: items.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>ID</th><th>Dept / Year</th><th>Email</th></tr></thead><tbody>${items.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.student_id || '')}</td><td>${esc(r.department)} ${esc(r.year)}</td><td>${esc(r.email)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No one has registered yet.</p>' });
    } catch (e) { toast(e.message); }
  },
  'admin-role': (el) => confirmModal('Change role', `Make ${el.dataset.name} ${el.dataset.role === 'admin' ? 'an administrator' : 'a regular student'}?`, 'Confirm',
    async () => { await api(`/admin/users/${el.dataset.id}`, { method: 'PUT', body: { role: el.dataset.role } }); toast('Role updated'); refreshAdmin(); }),
  'admin-pw': (el) => openModal({ title: `Reset password — ${el.dataset.name}`, submitLabel: 'Reset password',
    html: '<div class="form-group"><label>New password</label><input type="text" name="password" minlength="8" required autocomplete="off"><div class="form-hint">At least 8 characters. The user is logged out everywhere.</div></div>',
    onSubmit: async (fd) => { await api(`/admin/users/${el.dataset.id}`, { method: 'PUT', body: { password: fd.get('password') } }); toast('Password reset'); } }),
  'admin-user-del': (el) => confirmModal('Delete account', `Permanently delete ${el.dataset.name} and their applications and registrations?`, 'Delete',
    async () => { await api(`/admin/users/${el.dataset.id}`, { method: 'DELETE', body: {} }); toast('Account deleted'); refreshAdmin(); }),
};

/* ------------------------------------------------------------ events wiring */
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-auth]');
  if (tab) { switchAuth(tab.dataset.auth); return; }
  const nav = e.target.closest('.nav-link[data-nav]');
  if (nav) { delete state.filters[nav.dataset.nav]; if (location.hash === nav.getAttribute('href')) route(); }
  const el = e.target.closest('[data-action]');
  if (el) {
    const fn = actions[el.dataset.action];
    if (fn) { if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault(); fn(el, e); }
  }
  if (!e.target.closest('.notif-wrap')) $('#notifPanel').hidden = true;
  if (e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); $('#notifPanel').hidden = true; setSidebar(false); }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-filter]')) return onFilter(el);
  if (el.dataset.actionChange === 'app-status') {
    try { await api(`/admin/applications/${el.dataset.id}`, { method: 'PUT', body: { status: el.value } }); toast(`Status set to ${el.value}`); }
    catch (ex) { toast(ex.message); refreshAdmin(); }
  }
});
document.addEventListener('input', (e) => { if (e.target.matches('[data-filter]') && e.target.type === 'search') onFilter(e.target); });

let filterTimer;
function onFilter(el) {
  const page = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  state.filters[page] = { ...(state.filters[page] || {}), [el.dataset.filter]: el.value };
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => (page === 'community' ? loadQuestions() : loadList(page)), 250);
}

window.addEventListener('hashchange', route);

function showFormError(form, msg) {
  const box = form.querySelector('.form-error');
  box.textContent = msg; box.hidden = !msg;
}

document.addEventListener('submit', async (e) => {
  const f = e.target;
  const data = () => Object.fromEntries(new FormData(f));
  switch (f.id) {
    case 'studentLogin': e.preventDefault(); return submitAuth(f, '/auth/login', data());
    case 'adminLogin': e.preventDefault(); return submitAuth(f, '/auth/login', { ...data(), admin: true });
    case 'register': e.preventDefault(); return submitAuth(f, '/auth/register', data());
    case 'searchForm': {
      e.preventDefault();
      const q = $('#globalSearch').value.trim();
      if (q) location.hash = '#/search?q=' + encodeURIComponent(q);
      return;
    }
    case 'questionForm': {
      e.preventDefault();
      try {
        const { id } = await busy(f.querySelector('button'), () => api('/questions', { method: 'POST', body: data() }));
        toast('Question posted successfully!');
        location.hash = '#/community/' + id;
      } catch (ex) { toast(ex.message); }
      return;
    }
    case 'answerForm': {
      e.preventDefault();
      try {
        await busy(f.querySelector('button'), () => api(`/questions/${f.dataset.id}/answers`, { method: 'POST', body: data() }));
        toast('Answer posted'); reloadCurrent();
      } catch (ex) { toast(ex.message); }
      return;
    }
    case 'profileForm': {
      e.preventDefault();
      try {
        const { user } = await busy(f.querySelector('button'), () => api('/me', { method: 'PUT', body: data() }));
        state.user = user; updateProfileChips(); showFormError(f, ''); toast('Profile updated');
      } catch (ex) { showFormError(f, ex.message); }
      return;
    }
    case 'passwordForm': {
      e.preventDefault();
      try {
        await busy(f.querySelector('button'), () => api('/me/password', { method: 'POST', body: data() }));
        f.reset(); showFormError(f, ''); toast('Password updated');
      } catch (ex) { showFormError(f, ex.message); }
    }
  }
});

let searchTimer;
$('#globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (q.length >= 2) location.hash = '#/search?q=' + encodeURIComponent(q);
    else if (!q && location.hash.startsWith('#/search')) location.hash = '#/dashboard';
  }, 400);
});

/* ------------------------------------------------------------ boot */
(async function boot() {
  fillSelect('#registerDepartment', DEPARTMENTS);
  fillSelect('#registerYear', YEARS);
  initTheme();
  try {
    const { user } = await api('/me');
    enter(user);
  } catch { showAuth(); }
  document.body.classList.remove('booting');
})();
