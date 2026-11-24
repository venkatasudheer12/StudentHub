'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'studenthub.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  student_id TEXT COLLATE NOCASE UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  department TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  notif_seen TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('note','paper')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  semester TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  exam_year TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  file_path TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('internship','job')),
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  stipend TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  apply_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'Submitted',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS event_registrations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, event_id)
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_materials_kind ON materials(kind);
CREATE INDEX IF NOT EXISTS idx_opps_kind ON opportunities(kind);
CREATE INDEX IF NOT EXISTS idx_answers_q ON answers(question_id);
`);

// ---------------------------------------------------------------- seed data
function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM materials').get().n > 0) return;

  const mat = db.prepare(`INSERT INTO materials
    (kind,title,description,department,year,semester,subject,tags,exam_year,downloads,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now', ?))`);
  const notes = [
    ['Data Structures', 'Complete Unit 1 to Unit 5 study material.', 'CSE', '3rd Year', 'Semester 5', 'Data Structures', 'DSA,PDF', 42, '-1 days'],
    ['Database Management Systems', 'DBMS concepts, SQL and normalization notes.', 'CSE', '3rd Year', 'Semester 5', 'DBMS', 'DBMS,SQL', 37, '-2 days'],
    ['Operating Systems', 'Processes, memory management and scheduling.', 'CSE', '3rd Year', 'Semester 6', 'Operating Systems', 'OS', 29, '-3 days'],
    ['Computer Networks', 'Networking fundamentals and protocols.', 'CSE', '3rd Year', 'Semester 6', 'Computer Networks', 'Networks', 25, '-4 days'],
    ['Java Programming', 'Core Java and Object Oriented Programming.', 'CSE', '2nd Year', 'Semester 3', 'Java', 'Java,OOP', 51, '-6 days'],
    ['Machine Learning', 'Introduction to ML algorithms and concepts.', 'CSE', '4th Year', 'Semester 7', 'Machine Learning', 'AI,ML', 33, '-7 days'],
    ['Engineering Mathematics I', 'Calculus, matrices and differential equations.', 'All', '1st Year', 'Semester 1', 'Mathematics', 'Maths', 60, '-9 days'],
    ['Digital Electronics', 'Logic gates, flip-flops, counters and registers.', 'ECE', '2nd Year', 'Semester 3', 'Digital Electronics', 'Electronics', 18, '-10 days'],
    ['Signals and Systems', 'Fourier and Laplace transforms with solved examples.', 'ECE', '3rd Year', 'Semester 5', 'Signals', 'Signals', 14, '-11 days'],
    ['Electrical Circuit Theory', 'Network theorems, AC analysis and resonance.', 'EEE', '2nd Year', 'Semester 3', 'Circuits', 'Circuits', 12, '-12 days'],
    ['Engineering Thermodynamics', 'Laws of thermodynamics, cycles and entropy.', 'Mechanical', '2nd Year', 'Semester 4', 'Thermodynamics', 'Thermo', 9, '-13 days'],
    ['Structural Analysis', 'Beams, trusses and influence lines.', 'Civil', '3rd Year', 'Semester 5', 'Structures', 'Civil', 7, '-14 days'],
  ];
  for (const n of notes) mat.run('note', n[0], n[1], n[2], n[3], n[4], n[5], n[6], '', n[7], n[8]);

  const papers = [
    ['Data Structures', 'CSE', '1st Year', 'Semester 1', '2025', 'DSA'],
    ['DBMS', 'CSE', '2nd Year', 'Semester 3', '2025', 'DBMS'],
    ['Operating Systems', 'CSE', '3rd Year', 'Semester 5', '2025', 'OS'],
    ['Computer Networks', 'CSE', '3rd Year', 'Semester 6', '2025', 'Networks'],
    ['Digital Electronics', 'ECE', '2nd Year', 'Semester 3', '2024', 'Electronics'],
    ['Engineering Mathematics I', 'All', '1st Year', 'Semester 1', '2024', 'Maths'],
  ];
  for (const p of papers) {
    mat.run('paper', `${p[0]} - Semester Examination`, `Semester Examination • ${p[4]}`, p[1], p[2], p[3], p[0], p[5], p[4], 10, '-5 days');
  }

  const opp = db.prepare(`INSERT INTO opportunities
    (kind,title,company,location,duration,stipend,description,tags,deadline,created_at)
    VALUES (?,?,?,?,?,?,?,?,date('now', ?),datetime('now', ?))`);
  opp.run('internship', 'Java Developer Intern', 'Tech Solutions', 'Remote', '3 Months', '₹15,000/month', 'Work on REST services with the backend team.', 'Java,Spring Boot,MySQL', '+20 days', '-1 days');
  opp.run('internship', 'Frontend Developer Intern', 'WebWorks', 'Remote', '6 Months', '₹12,000/month', 'Build responsive UI components.', 'HTML,CSS,JavaScript', '+25 days', '-2 days');
  opp.run('internship', 'AI / ML Intern', 'AI Labs', 'Hyderabad', '4 Months', '₹20,000/month', 'Train and evaluate machine learning models.', 'Python,Machine Learning', '+30 days', '-3 days');
  opp.run('internship', 'Data Analyst Intern', 'DataCorp', 'Bangalore', '3 Months', '₹18,000/month', 'Dashboards and SQL analytics.', 'Python,SQL', '+15 days', '-4 days');
  opp.run('job', 'Java Developer', 'Software Solutions', 'Hyderabad', 'Full Time', '₹4.5 LPA', 'Entry-level backend role for fresh graduates.', 'Java,Spring,SQL', '+30 days', '-1 days');
  opp.run('job', 'Frontend Developer', 'Digital Technologies', 'Bangalore', 'Full Time', '₹5 LPA', 'Build modern web apps with React.', 'React,JavaScript', '+28 days', '-2 days');
  opp.run('job', 'Python Developer', 'Tech Innovations', 'Chennai', 'Full Time', '₹4.8 LPA', 'Django services and automation.', 'Python,Django', '+35 days', '-3 days');

  const ann = db.prepare("INSERT INTO announcements (title,body,created_at) VALUES (?,?,datetime('now', ?))");
  ann.run('Semester Examination Schedule Released', 'The university has released the semester examination schedule. Students are advised to check the examination dates.', '-1 days');
  ann.run('Campus Placement Drive', 'Registration is now open for the upcoming campus placement drive.', '-2 days');
  ann.run('Hackathon Registration Started', 'Students can register for the upcoming college hackathon.', '-3 days');
  ann.run('Scholarship Applications', 'Eligible students can submit scholarship applications before the deadline.', '-5 days');

  const ev = db.prepare("INSERT INTO events (title,description,event_date,location,created_at) VALUES (?,?,date('now', ?),?,datetime('now', ?))");
  ev.run('Web Development Workshop', 'Learn modern frontend and backend development from industry professionals.', '+7 days', 'Seminar Hall A', '-4 days');
  ev.run('AI & ML Seminar', 'Explore artificial intelligence, machine learning and career opportunities.', '+14 days', 'Auditorium', '-5 days');
  ev.run('College Hackathon', 'Build innovative solutions and compete with other student teams.', '+21 days', 'Innovation Lab', '-6 days');
  ev.run('Campus Placement Drive', 'Meet recruiters and explore career opportunities.', '+30 days', 'Placement Cell', '-7 days');

  const q = db.prepare("INSERT INTO questions (author_name,title,body,tags,created_at) VALUES (?,?,?,?,datetime('now', ?))");
  q.run('Rahul • CSE 3rd Year', 'Where can I find DBMS notes?', 'Looking for good DBMS notes covering normalization and transactions.', 'DBMS,Notes', '-1 days');
  q.run('Priya • CSE 2nd Year', 'Best way to learn Java?', 'I am starting Java this semester. Any resources or study plan?', 'Java,Programming', '-2 days');
  q.run('Kiran • ECE 4th Year', 'How to prepare for placements?', 'What should I focus on in the last 6 months before campus drives?', 'Placements,Career', '-3 days');
}

seed();

module.exports = { db, DATA_DIR, UPLOAD_DIR };
