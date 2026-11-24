'use strict';
// End-to-end API tests. Run with:  npm test
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studenthub-test-'));
process.env.ADMIN_PASSWORD = 'AdminPass123';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (body !== undefined && !(body instanceof Buffer)) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (body instanceof Buffer) init.body = body;
    const res = await fetch(base + url, init);
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}, h) { return this.req('POST', u, b, h); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u, {}); }
}
const student = (n) => ({ name: `Test Student ${n}`, studentId: `STU${n}`, email: `s${n}@example.com`, department: 'CSE', year: '3rd Year', password: 'password123' });

test('serves the frontend and health check', async () => {
  const c = new Client();
  const html = await c.get('/');
  assert.equal(html.status, 200);
  assert.match(html.data.toString(), /StudentHub/);
  assert.equal((await c.get('/app.js')).status, 200);
  assert.equal((await c.get('/healthz')).data.ok, true);
  assert.equal((await c.get('/../server.js')).status, 404);
  assert.equal((await c.get('/%2e%2e/server.js')).status, 404);
});

test('API requires authentication', async () => {
  const c = new Client();
  for (const u of ['/api/notes', '/api/me', '/api/dashboard', '/api/questions', '/api/search?q=java']) assert.equal((await c.get(u)).status, 401, u);
});

test('registration validation and duplicates', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/register', { ...student(1), password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...student(1), email: 'nope' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...student(1), department: 'Magic' })).status, 400);
  const ok = await c.post('/api/auth/register', student(1));
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.email, 's1@example.com');
  assert.equal(ok.data.user.password_hash, undefined);
  const dupEmail = await new Client().post('/api/auth/register', { ...student(2), email: 'S1@Example.com' });
  assert.equal(dupEmail.status, 409);
  const dupId = await new Client().post('/api/auth/register', { ...student(2), studentId: 'stu1' });
  assert.equal(dupId.status, 409);
  assert.equal((await c.get('/api/me')).data.user.name, 'Test Student 1'); // auto-login
});

test('login, logout, wrong password, admin gate', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { email: 's1@example.com', password: 'wrong' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'ghost@example.com', password: 'x' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123', admin: true })).status, 403);
  assert.equal((await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  await c.post('/api/auth/logout');
  c.cookie = c.cookie; // cookie cleared by server => new request without valid session
  const stale = new Client(); stale.cookie = c.cookie;
  assert.equal((await new Client().get('/api/me')).status, 401);
});

test('logout invalidates the session server-side', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const saved = c.cookie;
  await c.post('/api/auth/logout');
  const replay = new Client(); replay.cookie = saved;
  assert.equal((await replay.get('/api/me')).status, 401);
});

test('students cannot use admin endpoints', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  assert.equal((await c.post('/api/admin/notes', { title: 'Hack' })).status, 403);
  assert.equal((await c.get('/api/admin/users')).status, 403);
  assert.equal((await c.get('/api/admin/stats')).status, 403);
});

test('cross-origin writes are blocked (CSRF)', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const r = await c.req('POST', '/api/questions', { title: 'Evil question' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('content lists, filters and search', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const all = (await c.get('/api/notes')).data.items;
  assert.ok(all.length >= 10);
  const ece = (await c.get('/api/notes?department=ECE')).data.items;
  assert.ok(ece.length > 0 && ece.every((n) => ['ECE', 'All', ''].includes(n.department)));
  const q = (await c.get('/api/notes?q=java')).data.items;
  assert.ok(q.some((n) => /java/i.test(n.title)));
  assert.ok((await c.get('/api/papers')).data.items.every((p) => p.kind === 'paper'));
  assert.ok((await c.get('/api/internships')).data.items.every((p) => p.kind === 'internship'));
  assert.ok((await c.get('/api/jobs')).data.items.every((p) => p.kind === 'job'));
  assert.ok((await c.get('/api/announcements')).data.items.length >= 4);
  const ev = (await c.get('/api/events')).data.items;
  assert.ok(ev.length >= 4);
  const s = (await c.get('/api/search?q=java')).data.results;
  assert.ok(s.notes.length && s.internships.length);
  // SQL-ish input must not break anything
  assert.equal((await c.get("/api/notes?q=" + encodeURIComponent("' OR 1=1 --"))).status, 200);
  const dash = (await c.get('/api/dashboard')).data;
  assert.ok(dash.stats.notes >= 10 && dash.notes.length === 4);
});

test('download counts and serves a PDF placeholder', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const first = (await c.get('/api/notes')).data.items[0];
  const r = await c.get(`/api/materials/${first.id}/download`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.data.subarray(0, 5).toString(), '%PDF-');
  const after = (await c.get('/api/notes')).data.items.find((n) => n.id === first.id);
  assert.equal(after.downloads, first.downloads + 1);
  assert.equal((await c.get('/api/materials/99999/download')).status, 404);
});

test('apply to internship, duplicates, withdraw', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const opp = (await c.get('/api/internships')).data.items[0];
  assert.equal((await c.post(`/api/opportunities/${opp.id}/apply`, { note: 'Keen to learn' })).status, 201);
  assert.equal((await c.post(`/api/opportunities/${opp.id}/apply`, {})).status, 409);
  const mine = (await c.get('/api/me/applications')).data.items;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'Submitted');
  const listed = (await c.get('/api/internships')).data.items.find((o) => o.id === opp.id);
  assert.equal(listed.my_status, 'Submitted');
  assert.equal((await c.del(`/api/applications/${mine[0].id}`)).status, 200);
  assert.equal((await c.get('/api/me/applications')).data.items.length, 0);
});

test('cannot apply after deadline', async () => {
  const admin = new Client();
  await admin.post('/api/auth/login', { email: 'admin@studenthub.com', password: 'AdminPass123', admin: true });
  const created = await admin.post('/api/admin/jobs', { title: 'Expired Job', company: 'OldCo', deadline: '2020-01-01' });
  assert.equal(created.status, 201);
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  assert.equal((await c.post(`/api/opportunities/${created.data.id}/apply`, {})).status, 400);
});

test('event registration flow', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const ev = (await c.get('/api/events')).data.items[0];
  assert.equal((await c.post(`/api/events/${ev.id}/register`)).status, 200);
  assert.equal((await c.post(`/api/events/${ev.id}/register`)).status, 200); // idempotent
  const after = (await c.get('/api/events')).data.items.find((e) => e.id === ev.id);
  assert.equal(after.registered, 1);
  assert.equal(after.registrations, ev.registrations + 1);
  assert.equal((await c.get('/api/me/events')).data.items.length, 1);
  assert.equal((await c.del(`/api/events/${ev.id}/register`)).status, 200);
  assert.equal((await c.get('/api/me/events')).data.items.length, 0);
});

test('community: ask, answer, permissions, delete', async () => {
  const a = new Client(); await a.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const b = new Client(); assert.equal((await b.post('/api/auth/register', student(3))).status, 201);
  assert.equal((await a.post('/api/questions', { title: 'hi' })).status, 400);
  const q = await a.post('/api/questions', { title: 'How do indexes work?', body: 'B-tree?', tags: 'DBMS, SQL' });
  assert.equal(q.status, 201);
  assert.equal((await b.post(`/api/questions/${q.data.id}/answers`, { body: 'Yes, mostly B-trees.' })).status, 201);
  const detail = (await a.get(`/api/questions/${q.data.id}`)).data;
  assert.equal(detail.answers.length, 1);
  assert.equal(detail.question.mine, true);
  assert.equal(detail.answers[0].mine, false);
  assert.equal((await b.del(`/api/questions/${q.data.id}`)).status, 403);
  assert.equal((await a.del(`/api/answers/${detail.answers[0].id}`)).status, 403);
  assert.equal((await b.del(`/api/answers/${detail.answers[0].id}`)).status, 200);
  const list = (await a.get('/api/questions?q=indexes')).data.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].tags, 'DBMS,SQL');
  assert.equal((await a.del(`/api/questions/${q.data.id}`)).status, 200);
  assert.equal((await a.get(`/api/questions/${q.data.id}`)).status, 404);
});

test('profile update and password change', async () => {
  const c = new Client(); await c.post('/api/auth/login', { email: 's1@example.com', password: 'password123' });
  const r = await c.put('/api/me', { name: 'Renamed Student', department: 'ECE', year: '4th Year' });
  assert.equal(r.data.user.department, 'ECE');
  assert.equal((await c.put('/api/me', { name: 'X', department: 'ECE', year: '4th Year' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'bad', next: 'newpassword1' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  const fresh = new Client();
  assert.equal((await fresh.post('/api/auth/login', { email: 's1@example.com', password: 'password123' })).status, 401);
  assert.equal((await fresh.post('/api/auth/login', { email: 's1@example.com', password: 'newpassword1' })).status, 200);
});

test('notifications unread count resets', async () => {
  const c = new Client(); await c.post('/api/auth/register', student(4));
  const admin = new Client(); await admin.post('/api/auth/login', { email: 'admin@studenthub.com', password: 'AdminPass123', admin: true });
  await new Promise((r) => setTimeout(r, 1100));
  await admin.post('/api/admin/announcements', { title: 'Fresh news', body: 'Hello' });
  const n = (await c.get('/api/notifications')).data;
  assert.equal(n.unread, 1);
  assert.equal(n.items[0].title, 'Fresh news');
  await c.post('/api/notifications/seen');
  assert.equal((await c.get('/api/notifications')).data.unread, 0);
});

test('admin CRUD for every resource', async () => {
  const admin = new Client();
  assert.equal((await admin.post('/api/auth/login', { email: 'admin@studenthub.com', password: 'wrong', admin: true })).status, 401);
  assert.equal((await admin.post('/api/auth/login', { email: 'admin@studenthub.com', password: 'AdminPass123', admin: true })).status, 200);
  const samples = {
    notes: { title: 'New Note', department: 'CSE', year: '1st Year', semester: 'Semester 1', tags: 'a, b ,c' },
    papers: { title: 'New Paper', exam_year: '2024' },
    internships: { title: 'New Intern', company: 'Acme', deadline: '2099-01-01' },
    jobs: { title: 'New Job', company: 'Acme' },
    announcements: { title: 'Notice', body: 'Body' },
    events: { title: 'New Event', event_date: '2099-05-05' },
  };
  for (const [res, body] of Object.entries(samples)) {
    const made = await admin.post(`/api/admin/${res}`, body);
    assert.equal(made.status, 201, res);
    const id = made.data.id;
    const found = (await admin.get(`/api/${res}`)).data.items.find((i) => i.id === id);
    assert.ok(found, `${res} created`);
    assert.equal((await admin.put(`/api/admin/${res}/${id}`, { title: 'Edited ' + res })).status, 200);
    assert.equal((await admin.get(`/api/${res}`)).data.items.find((i) => i.id === id).title, 'Edited ' + res);
    assert.equal((await admin.del(`/api/admin/${res}/${id}`)).status, 200);
    assert.equal((await admin.get(`/api/${res}`)).data.items.find((i) => i.id === id), undefined);
  }
  // validation
  assert.equal((await admin.post('/api/admin/notes', { title: '' })).status, 400);
  assert.equal((await admin.post('/api/admin/notes', { title: 'x', department: 'Wizardry' })).status, 400);
  assert.equal((await admin.post('/api/admin/events', { title: 'No date' })).status, 400);
  assert.equal((await admin.post('/api/admin/events', { title: 'Bad date', event_date: '05/05/2030' })).status, 400);
  // notes endpoint must not edit papers
  const paper = (await admin.get('/api/papers')).data.items[0];
  assert.equal((await admin.put(`/api/admin/notes/${paper.id}`, { title: 'steal' })).status, 404);
  // tags normalised
  const t = await admin.post('/api/admin/notes', { title: 'Tag test', tags: 'a, b ,c' });
  assert.equal((await admin.get('/api/notes?q=Tag test')).data.items[0].tags, 'a,b,c');
});

test('admin file upload then student download', async () => {
  const admin = new Client(); await admin.post('/api/auth/login', { email: 'admin@studenthub.com', password: 'AdminPass123', admin: true });
  const id = (await admin.post('/api/admin/notes', { title: 'With file' })).data.id;
  const content = Buffer.from('hello real file');
  const up = await admin.post(`/api/admin/materials/${id}/file`, content, { 'X-Filename': encodeURIComponent('my notes.txt') });
  assert.equal(up.status, 200);
  const bad = await admin.post(`/api/admin/materials/${id}/file`, content, { 'X-Filename': 'evil.exe' });
  assert.equal(bad.status, 400);
  const c = new Client(); await c.post('/api/auth/login', { email: 's1@example.com', password: 'newpassword1' });
  const dl = await c.get(`/api/materials/${id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.data.toString(), 'hello real file');
  assert.match(dl.headers.get('content-disposition'), /my_notes\.txt/);
  const item = (await c.get('/api/notes?q=With file')).data.items[0];
  assert.equal(item.has_file, 1);
  await admin.del(`/api/admin/notes/${id}`);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 0);
});

test('admin user, application and stats management', async () => {
  const admin = new Client(); await admin.post('/api/auth/login', { email: 'admin@studenthub.com', password: 'AdminPass123', admin: true });
  const stud = new Client(); await stud.post('/api/auth/login', { email: 's1@example.com', password: 'newpassword1' });
  const opp = (await stud.get('/api/jobs')).data.items.find((j) => !j.my_status && (!j.deadline || j.deadline >= new Date().toISOString().slice(0, 10)));
  await stud.post(`/api/opportunities/${opp.id}/apply`, { note: 'please' });
  const apps = (await admin.get('/api/admin/applications')).data;
  const app = apps.items.find((a) => a.email === 's1@example.com');
  assert.ok(app && app.note === 'please');
  assert.equal((await admin.put(`/api/admin/applications/${app.id}`, { status: 'Bogus' })).status, 400);
  assert.equal((await admin.put(`/api/admin/applications/${app.id}`, { status: 'Shortlisted' })).status, 200);
  assert.equal((await stud.get('/api/me/applications')).data.items[0].status, 'Shortlisted');

  const stats = (await admin.get('/api/admin/stats')).data;
  assert.ok(stats.students >= 3 && stats.applications >= 1);

  const users = (await admin.get('/api/admin/users')).data.items;
  const adminRow = users.find((u) => u.role === 'admin');
  assert.equal((await admin.put(`/api/admin/users/${adminRow.id}`, { role: 'student' })).status, 400);
  assert.equal((await admin.del(`/api/admin/users/${adminRow.id}`)).status, 400);
  const target = users.find((u) => u.email === 's3@example.com');
  assert.equal((await admin.put(`/api/admin/users/${target.id}`, { role: 'admin' })).status, 200);
  assert.equal((await admin.put(`/api/admin/users/${target.id}`, { role: 'student', password: 'resetpass99' })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { email: 's3@example.com', password: 'resetpass99' })).status, 200);
  assert.equal((await admin.del(`/api/admin/users/${target.id}`)).status, 200);
  const evs = (await admin.get('/api/events')).data.items;
  const regs = await admin.get(`/api/admin/events/${evs[0].id}/registrations`);
  assert.equal(regs.status, 200);
});

test('login rate limiting kicks in', async () => {
  const c = new Client();
  let last;
  for (let i = 0; i < 12; i++) last = await c.post('/api/auth/login', { email: 'victim@example.com', password: 'nope' + i });
  assert.equal(last.status, 429);
});
