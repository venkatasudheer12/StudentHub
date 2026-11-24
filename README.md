# StudentHub — Student & Admin Portal

A complete full-stack version of your StudentHub front-end: real accounts, a database,
an admin panel, file uploads, applications, events, community Q&A and search.

* **Backend:** Node.js (built-in `http` + built-in `node:sqlite`) — **zero npm dependencies**
* **Frontend:** vanilla HTML/CSS/JS single-page app (your original design, now data-driven)
* **Needs:** Node.js **22.5 or newer** (`node -v`)

## Run locally

```bash
cd studenthub
npm start            # → http://localhost:3000
```

On first start the database is created in `./data/` and filled with sample content.
The default admin (development only) is:

| | |
|---|---|
| Email | `admin@studenthub.com` |
| Password | `admin123` |

Change it by creating a `.env` file (see `.env.example`) **before the first start**, or
log in and reset it from *Admin → Users → Reset password* / *Profile → Change password*.

Other commands: `npm run dev` (auto-restart on change), `npm test` (19 API tests).

## What works

**Students**
- Register / login / logout (server-side sessions, scrypt-hashed passwords), stays logged in 14 days
- Dashboard with live stats, recent notes, internships, announcements, upcoming events
- Notes & question papers: search + department/year/semester filters, real downloads (with download counters)
- Internships & jobs: apply with a note, see status (Submitted → Under Review → Shortlisted → Selected/Rejected), withdraw, deadline countdown
- Events: register / cancel, attendee counts
- Community: ask questions, answer, delete your own, search
- Global search across everything, notification bell for new announcements/events
- My Activity (applications, events, questions), Profile editing, change password
- Dark mode, fully responsive (mobile menu)

**Admins** (Admin Panel in the sidebar)
- Overview: totals, most-downloaded materials, recent applications
- Content: add / edit / delete notes, papers, internships, jobs, announcements, events; **upload real files** (PDF, DOC(X), PPT(X), TXT, ZIP, PNG/JPG up to 15 MB) to notes and papers
- Users: promote/demote admins, reset passwords, delete accounts
- Applications: review all applicants and change their status (students see it immediately)
- Event registrations: see who signed up; moderate community posts (delete any question/answer)

Seeded notes/papers have no file yet, so students receive a small placeholder PDF until an admin uploads the real one.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database + uploads. **Must be on persistent storage in production** |
| `ADMIN_EMAIL` | `admin@studenthub.com` | Admin created on first start |
| `ADMIN_PASSWORD` | `admin123` in dev; random in production | If `NODE_ENV=production` and unset, a random password is printed in the server log |
| `NODE_ENV` | – | Set to `production` when deployed |

## Deploy online

The app is one Node process plus one folder of data (`DATA_DIR`). Any host that can run
Node 22 or Docker works. **Whatever you choose, attach a persistent volume at `DATA_DIR`,
otherwise accounts and uploads vanish when the container restarts.**

### Option A — Render (easiest, has a free tier)
1. Push this folder to a GitHub repository:
   ```bash
   git init && git add . && git commit -m "StudentHub" 
   git branch -M main && git remote add origin https://github.com/<you>/studenthub.git && git push -u origin main
   ```
2. On https://render.com → **New → Blueprint** → select the repo. `render.yaml` configures everything.
3. Open the service → **Environment** → copy the generated `ADMIN_PASSWORD`. Visit your `https://studenthub-xxxx.onrender.com` URL.

The free plan has **no persistent disk** (data resets on restart/redeploy; the free service also sleeps when idle).
For a real deployment choose the *Starter* plan and un-comment the `disk:` block in `render.yaml`.

### Option B — Fly.io (free allowance + persistent volume)
Edit the app name in `fly.toml`, then:
```bash
fly launch --copy-config --no-deploy
fly volumes create studenthub_data --size 1
fly secrets set ADMIN_PASSWORD='choose-a-strong-one'
fly deploy
```

### Option C — Docker anywhere (VPS, Railway, Koyeb, …)
```bash
docker build -t studenthub .
docker run -d -p 80:3000 -v studenthub-data:/data -e ADMIN_PASSWORD='choose-a-strong-one' studenthub
```
Put it behind HTTPS (the host's proxy, Caddy, nginx…). The server sets `Secure` cookies automatically
when it sees `X-Forwarded-Proto: https`.

## Project layout

```
server.js        HTTP server, routing, auth, all API endpoints
db.js            SQLite schema + sample data
pdf.js           tiny PDF generator for placeholder downloads
public/          index.html, styles.css, app.js (the SPA)
tests/           API test suite (node --test)
Dockerfile, render.yaml, fly.toml   deployment
```

## Security notes
Passwords are hashed with scrypt; sessions are random tokens stored hashed, in HttpOnly SameSite cookies;
cross-origin writes are rejected; failed logins are rate-limited; uploads are extension-whitelisted and stored
outside the web root; all dynamic text is HTML-escaped; a strict Content-Security-Policy is set.
Before going public you may also want: e-mail verification / password reset by e-mail, and a backup of `DATA_DIR`.
