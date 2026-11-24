'use strict';
/**
 * StudentHub server — zero npm dependencies.
 * Node >= 22.5 (uses the built-in node:sqlite module).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- tiny .env loader (local convenience; real env vars always win)
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* ignore */ }

const { db, UPLOAD_DIR } = require('./db');
const { makePdf } = require('./pdf');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 14;
const MAX_UPLOAD = 15 * 1024 * 1024;

const DEPTS = ['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil'];
const YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEMS = Array.from({ length: 8 }, (_, i) => `Semester ${i + 1}`);
const STATUSES = ['Submitted', 'Under Review', 'Shortlisted', 'Selected', 'Rejected'];
const UPLOAD_EXT = {
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

// ------------------------------------------------------------ resources
const MAXLEN = {
  title: 200, description: 4000, body: 4000, department: 30, year: 30, semester: 30,
  subject: 120, tags: 300, exam_year: 4, company: 120, location: 120, duration: 60,
  stipend: 60, event_date: 10, deadline: 10, apply_url: 300,
};
const MAT_FIELDS = ['title', 'subject', 'department', 'year', 'semester', 'description', 'tags'];
const RES = {
  notes: { table: 'materials', kind: 'note', fields: MAT_FIELDS, filters: ['department', 'year', 'semester'],
    search: ['title', 'description', 'subject', 'tags'], order: 'created_at DESC, id DESC' },
  papers: { table: 'materials', kind: 'paper', fields: [...MAT_FIELDS, 'exam_year'], filters: ['department', 'year', 'semester'],
    search: ['title', 'description', 'subject', 'tags', 'exam_year'], order: 'exam_year DESC, id DESC' },
  internships: { table: 'opportunities', kind: 'internship',
    fields: ['title', 'company', 'location', 'duration', 'stipend', 'description', 'tags', 'deadline', 'apply_url'],
    filters: [], search: ['title', 'company', 'location', 'description', 'tags'], order: 'id DESC' },
  jobs: { table: 'opportunities', kind: 'job',
    fields: ['title', 'company', 'location', 'duration', 'stipend', 'description', 'tags', 'deadline', 'apply_url'],
    filters: [], search: ['title', 'company', 'location', 'description', 'tags'], order: 'id DESC' },
  announcements: { table: 'announcements', fields: ['title', 'body'], filters: [],
    search: ['title', 'body'], order: 'created_at DESC, id DESC' },
  events: { table: 'events', fields: ['title', 'description', 'event_date', 'location'], filters: [],
    search: ['title', 'description', 'location'],
    order: "(event_date < date('now')) ASC, CASE WHEN event_date >= date('now') THEN event_date END ASC, event_date DESC" },
};

function selectFor(name, uid) {
  switch (RES[name].table) {
    case 'materials':
      return { sql: `SELECT id,kind,title,description,department,year,semester,subject,tags,exam_year,file_name,size,downloads,created_at,
        (file_path IS NOT NULL) AS has_file FROM materials`, args: [] };
    case 'opportunities':
      return { sql: `SELECT o.*,
        (SELECT status FROM applications a WHERE a.opportunity_id=o.id AND a.user_id=?) AS my_status,
        (SELECT id FROM applications a WHERE a.opportunity_id=o.id AND a.user_id=?) AS my_application_id,
        (SELECT COUNT(*) FROM applications a WHERE a.opportunity_id=o.id) AS applicants FROM opportunities o`, args: [uid, uid] };
    case 'events':
      return { sql: `SELECT e.*,
        (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id=e.id) AS registrations,
        EXISTS(SELECT 1 FROM event_registrations r WHERE r.event_id=e.id AND r.user_id=?) AS registered FROM events e`, args: [uid] };
    default:
      return { sql: 'SELECT * FROM announcements', args: [] };
  }
}

function likePattern(q) { return '%' + String(q).replace(/[%_\\]/g, '').trim() + '%'; }

function listResource(name, query, uid, limit = 300) {
  const r = RES[name];
  const { sql, args } = selectFor(name, uid);
  const where = [];
  if (r.kind) { where.push('kind=?'); args.push(r.kind); }
  for (const f of r.filters) {
    const v = query[f];
    if (v) { where.push(`(${f}=? OR ${f}='' OR ${f}='All')`); args.push(v); }
  }
  if (query.q && String(query.q).trim()) {
    const like = likePattern(query.q);
    where.push('(' + r.search.map((f) => `${f} LIKE ?`).join(' OR ') + ')');
    for (let i = 0; i < r.search.length; i++) args.push(like);
  }
  const full = `${sql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${r.order} LIMIT ${limit}`;
  return db.prepare(full).all(...args);
}

// ------------------------------------------------------------ helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error();
    return v;
  } catch { throw bad('Invalid JSON body'); }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const isSecure = (req) => Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); throw new HttpError(429, 'Too many attempts. Please try again later.'); }
  arr.push(now);
  hits.set(key, arr);
}
// failed-login throttle: only failures count; success clears the per-account counter
function failCount(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, arr);
  return arr.length;
}
function recordFail(key) { const arr = hits.get(key) || []; arr.push(Date.now()); hits.set(key, arr); }
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---- passwords & sessions
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 86400;
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(sha(token), userId, Date.now() + maxAge * 1000);
  const cookie = `sh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
}
function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', `sh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sh_session;
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token), Date.now());
  return row || null;
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()), 3600e3).unref();
db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, studentId: u.student_id,
  department: u.department, year: u.year, role: u.role,
});

// ---- validation
function str(v, field, { min = 0, max = 200, required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(`${field} is required`);
  if (s && s.length < min) throw bad(`${field} must be at least ${min} characters`);
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
  return s;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const normTags = (t) => String(t).split(',').map((x) => x.trim()).filter(Boolean).join(',');

function cleanFields(name, body, partial) {
  const r = RES[name];
  const out = {};
  for (const f of r.fields) {
    if (partial && body[f] === undefined) continue;
    let v = str(body[f], f, { max: MAXLEN[f] || 200 });
    if (f === 'tags') v = normTags(v);
    if (f === 'department' && v && v !== 'All' && !DEPTS.includes(v)) throw bad('Invalid department');
    if (f === 'year' && v && v !== 'All' && !YEARS.includes(v)) throw bad('Invalid year');
    if (f === 'semester' && v && v !== 'All' && !SEMS.includes(v)) throw bad('Invalid semester');
    if ((f === 'deadline' || f === 'event_date') && v && !DATE_RE.test(v)) throw bad(`${f} must be YYYY-MM-DD`);
    if (f === 'apply_url' && v && !/^https?:\/\//i.test(v)) throw bad('Apply URL must start with http:// or https://');
    if (f === 'exam_year' && v && !/^\d{4}$/.test(v)) throw bad('Exam year must be a 4-digit year');
    out[f] = v;
  }
  if (!partial || out.title !== undefined) { if (!out.title || out.title.length < 2) throw bad('Title is required'); }
  if (name === 'events' && (!partial || out.event_date !== undefined) && !out.event_date) throw bad('Event date is required');
  return out;
}

// ------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, handler, auth = 'user') => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};
const intParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Not found'); return n; };

// ---- auth
route('POST', '/api/auth/register', async ({ req, res, body }) => {
  rateLimit('reg:' + clientIp(req), 10, 3600e3);
  const name = str(body.name, 'Name', { min: 2, max: 80, required: true });
  const studentId = str(body.studentId, 'Student ID', { min: 2, max: 30, required: true });
  if (!/^[A-Za-z0-9_-]+$/.test(studentId)) throw bad('Student ID may only contain letters, numbers, - and _');
  const email = str(body.email, 'Email', { max: 120, required: true }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address');
  if (!DEPTS.includes(body.department)) throw bad('Select a department');
  if (!YEARS.includes(body.year)) throw bad('Select a year');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  if (password.length > 200) throw bad('Password is too long');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists');
  if (db.prepare('SELECT 1 FROM users WHERE student_id=?').get(studentId)) throw new HttpError(409, 'This Student ID is already registered');
  const info = db.prepare(`INSERT INTO users (name,student_id,email,department,year,password_hash) VALUES (?,?,?,?,?,?)`)
    .run(name, studentId, email, body.department, body.year, hashPassword(password));
  createSession(res, req, Number(info.lastInsertRowid));
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  sendJson(res, 201, { user: publicUser(user) });
}, 'none');

route('POST', '/api/auth/login', async ({ req, res, body }) => {
  const email = str(body.email, 'Email', { max: 120 }).toLowerCase();
  const ipKey = 'loginfail:ip:' + clientIp(req);
  const acctKey = 'loginfail:acct:' + email;
  const WINDOW = 600e3;
  if (failCount(ipKey, WINDOW) >= 20 || failCount(acctKey, WINDOW) >= 8) {
    throw new HttpError(429, 'Too many failed attempts. Please try again in a few minutes.');
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  // verify against a dummy hash when user is missing to keep timing similar
  const ok = user ? verifyPassword(password, user.password_hash) : (hashPassword('x'), false);
  if (!user || !ok) { recordFail(ipKey); recordFail(acctKey); throw new HttpError(401, 'Invalid email or password'); }
  if (body.admin && user.role !== 'admin') throw new HttpError(403, 'This account does not have admin access');
  hits.delete(acctKey);
  createSession(res, req, user.id);
  sendJson(res, 200, { user: publicUser(user) });
}, 'none');

route('POST', '/api/auth/logout', ({ req, res, user }) => {
  if (user) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash);
  clearSessionCookie(res, req);
  sendJson(res, 200, { ok: true });
}, 'none');

route('GET', '/api/me', ({ res, user }) => sendJson(res, 200, { user: publicUser(user) }));

route('PUT', '/api/me', ({ res, user, body }) => {
  const name = str(body.name, 'Name', { min: 2, max: 80, required: true });
  if (!DEPTS.includes(body.department)) throw bad('Select a department');
  if (!YEARS.includes(body.year)) throw bad('Select a year');
  db.prepare('UPDATE users SET name=?, department=?, year=? WHERE id=?').run(name, body.department, body.year, user.id);
  sendJson(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
});

route('POST', '/api/me/password', ({ req, res, user, body }) => {
  rateLimit('pw:' + user.id, 10, 600e3);
  if (!verifyPassword(String(body.current || ''), user.password_hash)) throw bad('Current password is incorrect');
  const next = String(body.next || '');
  if (next.length < 8 || next.length > 200) throw bad('New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(next), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, user.token_hash);
  sendJson(res, 200, { ok: true });
});

// ---- dashboard / stats
function stats() {
  const c = (sql) => db.prepare(sql).get().n;
  return {
    notes: c("SELECT COUNT(*) n FROM materials WHERE kind='note'"),
    papers: c("SELECT COUNT(*) n FROM materials WHERE kind='paper'"),
    internships: c("SELECT COUNT(*) n FROM opportunities WHERE kind='internship'"),
    jobs: c("SELECT COUNT(*) n FROM opportunities WHERE kind='job'"),
    events: c("SELECT COUNT(*) n FROM events WHERE event_date >= date('now')"),
    members: c("SELECT COUNT(*) n FROM users WHERE role='student'"),
  };
}
route('GET', '/api/dashboard', ({ res, user }) => {
  sendJson(res, 200, {
    stats: stats(),
    notes: listResource('notes', {}, user.id, 4),
    internships: listResource('internships', {}, user.id, 2),
    announcements: listResource('announcements', {}, user.id, 3),
    events: listResource('events', {}, user.id, 3).filter((e) => e.event_date >= new Date().toISOString().slice(0, 10)),
    applications: db.prepare('SELECT COUNT(*) n FROM applications WHERE user_id=?').get(user.id).n,
    registrations: db.prepare('SELECT COUNT(*) n FROM event_registrations WHERE user_id=?').get(user.id).n,
  });
});

// ---- content lists
for (const name of Object.keys(RES)) {
  route('GET', `/api/${name}`, ({ res, user, query }) => sendJson(res, 200, { items: listResource(name, query, user.id) }));
}

// ---- materials download
route('GET', '/api/materials/:id/download', ({ res, params }) => {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(intParam(params.id));
  if (!m) throw new HttpError(404, 'Not found');
  db.prepare('UPDATE materials SET downloads=downloads+1 WHERE id=?').run(m.id);
  const base = m.title.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'material';
  if (m.file_path) {
    const full = path.join(UPLOAD_DIR, path.basename(m.file_path));
    if (fs.existsSync(full)) {
      const ext = path.extname(full).toLowerCase();
      const fname = m.file_name || base + ext;
      res.writeHead(200, {
        'Content-Type': UPLOAD_EXT[ext] || 'application/octet-stream',
        'Content-Length': fs.statSync(full).size,
        'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Cache-Control': 'private, no-store',
      });
      return fs.createReadStream(full).pipe(res);
    }
  }
  const pdf = makePdf(m.title, [
    m.description || '',
    [m.department, m.year, m.semester, m.exam_year].filter(Boolean).join('  |  '),
    'This is a placeholder document. An administrator can attach the real file to this item from the Admin panel (Content > edit > file).',
  ]);
  res.writeHead(200, {
    'Content-Type': 'application/pdf', 'Content-Length': pdf.length,
    'Content-Disposition': `attachment; filename="${base}.pdf"`, 'Cache-Control': 'private, no-store',
  });
  res.end(pdf);
});

// ---- applications
route('POST', '/api/opportunities/:id/apply', ({ res, user, params, body }) => {
  const id = intParam(params.id);
  const o = db.prepare('SELECT * FROM opportunities WHERE id=?').get(id);
  if (!o) throw new HttpError(404, 'Not found');
  if (o.deadline && o.deadline < new Date().toISOString().slice(0, 10)) throw bad('The application deadline has passed');
  if (db.prepare('SELECT 1 FROM applications WHERE user_id=? AND opportunity_id=?').get(user.id, id)) throw new HttpError(409, 'You have already applied');
  const note = str(body.note, 'Note', { max: 1000 });
  db.prepare('INSERT INTO applications (user_id,opportunity_id,note) VALUES (?,?,?)').run(user.id, id, note);
  sendJson(res, 201, { ok: true });
});
route('DELETE', '/api/applications/:id', ({ res, user, params }) => {
  const info = db.prepare('DELETE FROM applications WHERE id=? AND user_id=?').run(intParam(params.id), user.id);
  if (!info.changes) throw new HttpError(404, 'Not found');
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/me/applications', ({ res, user }) => {
  sendJson(res, 200, { items: db.prepare(`SELECT a.id,a.status,a.note,a.created_at,o.id AS opportunity_id,o.title,o.company,o.kind,o.location
    FROM applications a JOIN opportunities o ON o.id=a.opportunity_id WHERE a.user_id=? ORDER BY a.id DESC`).all(user.id) });
});

// ---- events
route('POST', '/api/events/:id/register', ({ res, user, params }) => {
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(intParam(params.id));
  if (!e) throw new HttpError(404, 'Not found');
  if (e.event_date < new Date().toISOString().slice(0, 10)) throw bad('This event has already ended');
  db.prepare('INSERT OR IGNORE INTO event_registrations (user_id,event_id) VALUES (?,?)').run(user.id, e.id);
  sendJson(res, 200, { ok: true });
});
route('DELETE', '/api/events/:id/register', ({ res, user, params }) => {
  db.prepare('DELETE FROM event_registrations WHERE user_id=? AND event_id=?').run(user.id, intParam(params.id));
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/me/events', ({ res, user }) => {
  sendJson(res, 200, { items: db.prepare(`SELECT e.* FROM event_registrations r JOIN events e ON e.id=r.event_id
    WHERE r.user_id=? ORDER BY e.event_date ASC`).all(user.id) });
});

// ---- community
const authorLabel = (u) => `${u.name} • ${u.role === 'admin' ? 'Admin' : `${u.department} ${u.year}`}`;
route('GET', '/api/questions', ({ res, user, query }) => {
  const args = [];
  let where = '';
  if (query.q && query.q.trim()) {
    const like = likePattern(query.q);
    where = 'WHERE q.title LIKE ? OR q.body LIKE ? OR q.tags LIKE ?';
    args.push(like, like, like);
  }
  const rows = db.prepare(`SELECT q.id,q.title,q.body,q.tags,q.author_name,q.user_id,q.created_at,
    (SELECT COUNT(*) FROM answers a WHERE a.question_id=q.id) AS answers FROM questions q ${where} ORDER BY q.id DESC LIMIT 200`).all(...args);
  sendJson(res, 200, { items: rows.map((r) => ({ ...r, mine: r.user_id === user.id })) });
});
route('POST', '/api/questions', ({ res, user, body }) => {
  rateLimit('q:' + user.id, 20, 3600e3);
  const title = str(body.title, 'Question', { min: 5, max: 200, required: true });
  const text = str(body.body, 'Details', { max: 4000 });
  const tags = normTags(str(body.tags, 'Tags', { max: 200 }));
  const info = db.prepare('INSERT INTO questions (user_id,author_name,title,body,tags) VALUES (?,?,?,?,?)')
    .run(user.id, authorLabel(user), title, text, tags);
  sendJson(res, 201, { id: Number(info.lastInsertRowid) });
});
route('GET', '/api/questions/:id', ({ res, user, params }) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(intParam(params.id));
  if (!q) throw new HttpError(404, 'Question not found');
  const answers = db.prepare('SELECT * FROM answers WHERE question_id=? ORDER BY id ASC').all(q.id);
  sendJson(res, 200, {
    question: { ...q, mine: q.user_id === user.id },
    answers: answers.map((a) => ({ ...a, mine: a.user_id === user.id })),
  });
});
route('POST', '/api/questions/:id/answers', ({ res, user, params, body }) => {
  rateLimit('a:' + user.id, 60, 3600e3);
  const q = db.prepare('SELECT id FROM questions WHERE id=?').get(intParam(params.id));
  if (!q) throw new HttpError(404, 'Question not found');
  const text = str(body.body, 'Answer', { min: 2, max: 4000, required: true });
  db.prepare('INSERT INTO answers (question_id,user_id,author_name,body) VALUES (?,?,?,?)').run(q.id, user.id, authorLabel(user), text);
  sendJson(res, 201, { ok: true });
});
route('DELETE', '/api/questions/:id', ({ res, user, params }) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(intParam(params.id));
  if (!q) throw new HttpError(404, 'Not found');
  if (q.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'You can only delete your own questions');
  db.prepare('DELETE FROM questions WHERE id=?').run(q.id);
  sendJson(res, 200, { ok: true });
});
route('DELETE', '/api/answers/:id', ({ res, user, params }) => {
  const a = db.prepare('SELECT * FROM answers WHERE id=?').get(intParam(params.id));
  if (!a) throw new HttpError(404, 'Not found');
  if (a.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'You can only delete your own answers');
  db.prepare('DELETE FROM answers WHERE id=?').run(a.id);
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/me/questions', ({ res, user }) => {
  sendJson(res, 200, { items: db.prepare(`SELECT q.id,q.title,q.created_at,(SELECT COUNT(*) FROM answers a WHERE a.question_id=q.id) AS answers
    FROM questions q WHERE q.user_id=? ORDER BY q.id DESC`).all(user.id) });
});

// ---- search
route('GET', '/api/search', ({ res, user, query }) => {
  const q = (query.q || '').trim();
  if (q.length < 2) return sendJson(res, 200, { results: {} });
  const results = {};
  for (const name of ['notes', 'papers', 'internships', 'jobs', 'announcements', 'events']) {
    results[name] = listResource(name, { q }, user.id, 8);
  }
  const like = likePattern(q);
  results.questions = db.prepare(`SELECT id,title,author_name,created_at FROM questions
    WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT 8`).all(like, like, like);
  sendJson(res, 200, { results });
});

// ---- notifications
route('GET', '/api/notifications', ({ res, user }) => {
  const items = db.prepare(`SELECT 'announcement' AS type, id, title, created_at FROM announcements
    UNION ALL SELECT 'event', id, title, created_at FROM events ORDER BY created_at DESC LIMIT 8`).all()
    .map((i) => ({ ...i, unread: i.created_at > user.notif_seen }));
  const unread = db.prepare(`SELECT (SELECT COUNT(*) FROM announcements WHERE created_at>?) +
    (SELECT COUNT(*) FROM events WHERE created_at>?) AS n`).get(user.notif_seen, user.notif_seen).n;
  sendJson(res, 200, { items, unread });
});
route('POST', '/api/notifications/seen', ({ res, user }) => {
  db.prepare("UPDATE users SET notif_seen=datetime('now') WHERE id=?").run(user.id);
  sendJson(res, 200, { ok: true });
});

// ================================================================= ADMIN
route('GET', '/api/admin/stats', ({ res }) => {
  const c = (sql) => db.prepare(sql).get().n;
  sendJson(res, 200, {
    students: c("SELECT COUNT(*) n FROM users WHERE role='student'"),
    admins: c("SELECT COUNT(*) n FROM users WHERE role='admin'"),
    applications: c('SELECT COUNT(*) n FROM applications'),
    pending: c("SELECT COUNT(*) n FROM applications WHERE status IN ('Submitted','Under Review')"),
    registrations: c('SELECT COUNT(*) n FROM event_registrations'),
    questions: c('SELECT COUNT(*) n FROM questions'),
    downloads: c('SELECT COALESCE(SUM(downloads),0) n FROM materials'),
    content: stats(),
    topMaterials: db.prepare('SELECT id,title,kind,downloads FROM materials ORDER BY downloads DESC LIMIT 5').all(),
  });
}, 'admin');

for (const name of Object.keys(RES)) {
  const r = RES[name];
  route('POST', `/api/admin/${name}`, ({ res, body }) => {
    const data = cleanFields(name, body, false);
    const cols = Object.keys(data);
    const vals = cols.map((c) => data[c]);
    if (r.kind) { cols.push('kind'); vals.push(r.kind); }
    const info = db.prepare(`INSERT INTO ${r.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    sendJson(res, 201, { id: Number(info.lastInsertRowid) });
  }, 'admin');
  route('PUT', `/api/admin/${name}/:id`, ({ res, params, body }) => {
    const id = intParam(params.id);
    const data = cleanFields(name, body, true);
    const cols = Object.keys(data);
    if (!cols.length) throw bad('Nothing to update');
    const info = db.prepare(`UPDATE ${r.table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?${r.kind ? ' AND kind=?' : ''}`)
      .run(...cols.map((c) => data[c]), id, ...(r.kind ? [r.kind] : []));
    if (!info.changes) throw new HttpError(404, 'Not found');
    sendJson(res, 200, { ok: true });
  }, 'admin');
  route('DELETE', `/api/admin/${name}/:id`, ({ res, params }) => {
    const id = intParam(params.id);
    if (r.table === 'materials') {
      const m = db.prepare('SELECT file_path FROM materials WHERE id=?').get(id);
      if (m?.file_path) fs.rmSync(path.join(UPLOAD_DIR, path.basename(m.file_path)), { force: true });
    }
    const info = db.prepare(`DELETE FROM ${r.table} WHERE id=?${r.kind ? ' AND kind=?' : ''}`).run(id, ...(r.kind ? [r.kind] : []));
    if (!info.changes) throw new HttpError(404, 'Not found');
    sendJson(res, 200, { ok: true });
  }, 'admin');
}

route('POST', '/api/admin/materials/:id/file', async ({ req, res, params }) => {
  const id = intParam(params.id);
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  if (!m) throw new HttpError(404, 'Not found');
  const original = decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[\\/]/g, '_').slice(0, 120);
  const ext = path.extname(original).toLowerCase();
  if (!UPLOAD_EXT[ext]) throw bad(`File type not allowed. Allowed: ${Object.keys(UPLOAD_EXT).join(', ')}`);
  const buf = await readBody(req, MAX_UPLOAD);
  if (!buf.length) throw bad('Empty file');
  const stored = `${id}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  if (m.file_path) fs.rmSync(path.join(UPLOAD_DIR, path.basename(m.file_path)), { force: true });
  db.prepare('UPDATE materials SET file_name=?, file_path=?, size=? WHERE id=?').run(original, stored, buf.length, id);
  sendJson(res, 200, { ok: true, size: buf.length });
}, 'admin');

route('GET', '/api/admin/users', ({ res }) => {
  sendJson(res, 200, { items: db.prepare(`SELECT u.id,u.name,u.student_id,u.email,u.department,u.year,u.role,u.created_at,
    (SELECT COUNT(*) FROM applications a WHERE a.user_id=u.id) AS applications,
    (SELECT COUNT(*) FROM questions q WHERE q.user_id=u.id) AS questions
    FROM users u ORDER BY u.id DESC LIMIT 1000`).all() });
}, 'admin');
route('PUT', '/api/admin/users/:id', ({ res, user, params, body }) => {
  const id = intParam(params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!target) throw new HttpError(404, 'Not found');
  if (body.role !== undefined) {
    if (!['student', 'admin'].includes(body.role)) throw bad('Invalid role');
    if (id === user.id && body.role !== 'admin') throw bad('You cannot remove your own admin access');
    db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role, id);
  }
  if (body.password !== undefined) {
    const pw = String(body.password);
    if (pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(pw), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  sendJson(res, 200, { ok: true });
}, 'admin');
route('DELETE', '/api/admin/users/:id', ({ res, user, params }) => {
  const id = intParam(params.id);
  if (id === user.id) throw bad('You cannot delete your own account');
  const info = db.prepare('DELETE FROM users WHERE id=?').run(id);
  if (!info.changes) throw new HttpError(404, 'Not found');
  sendJson(res, 200, { ok: true });
}, 'admin');

route('GET', '/api/admin/applications', ({ res }) => {
  sendJson(res, 200, { statuses: STATUSES, items: db.prepare(`SELECT a.id,a.status,a.note,a.created_at,
    u.name,u.email,u.student_id,u.department,u.year,o.title,o.company,o.kind
    FROM applications a JOIN users u ON u.id=a.user_id JOIN opportunities o ON o.id=a.opportunity_id
    ORDER BY a.id DESC LIMIT 500`).all() });
}, 'admin');
route('PUT', '/api/admin/applications/:id', ({ res, params, body }) => {
  if (!STATUSES.includes(body.status)) throw bad('Invalid status');
  const info = db.prepare('UPDATE applications SET status=? WHERE id=?').run(body.status, intParam(params.id));
  if (!info.changes) throw new HttpError(404, 'Not found');
  sendJson(res, 200, { ok: true });
}, 'admin');
route('GET', '/api/admin/events/:id/registrations', ({ res, params }) => {
  sendJson(res, 200, { items: db.prepare(`SELECT u.name,u.student_id,u.email,u.department,u.year,r.created_at
    FROM event_registrations r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.created_at`).all(intParam(params.id)) });
}, 'admin');

route('GET', '/healthz', ({ res }) => sendJson(res, 200, { ok: true }), 'none');

// ------------------------------------------------------------ static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(full);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

// ------------------------------------------------------------ server
async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }
    // CSRF guard: browsers always send Origin on cross-site writes
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      let same = false;
      try { same = new URL(req.headers.origin).host === req.headers.host; } catch { /* */ }
      if (!same) throw new HttpError(403, 'Cross-origin request blocked');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const user = currentUser(req);
      if (r.auth !== 'none' && !user) throw new HttpError(401, 'Please log in');
      if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admin access required');
      const ctx = { req, res, params, user, query: Object.fromEntries(u.searchParams) };
      const isUpload = pathname.endsWith('/file');
      ctx.body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isUpload ? await readJson(req) : {};
      return await r.handler(ctx);
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server' });
  }
}

const server = http.createServer(handler);

// ---- seed admin
function ensureAdmin() {
  if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@studenthub.com').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    if (PROD) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
    else password = 'admin123';
  }
  db.prepare("INSERT INTO users (name,student_id,email,department,year,password_hash,role) VALUES ('Administrator','ADMIN',?, 'Administration','Admin',?, 'admin')")
    .run(email, hashPassword(password));
  console.log(`[setup] Admin account created: ${email}${generated ? `  password: ${password}  (set ADMIN_PASSWORD to choose your own)` : PROD ? '' : '  password: admin123  (development default)'}`);
}
ensureAdmin();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`StudentHub running on http://localhost:${PORT}`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server };
