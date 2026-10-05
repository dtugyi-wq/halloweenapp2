// Halloween Packet Tracer verseny – backend (Node 18+, Express, SQLite)
const express = require('express');
const { DatabaseSync } = require('node:sqlite');   // beépített SQLite (Node 22.5+), nem kell fordítás
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const content = require('./content.json');

const PORT = +process.env.PORT || 3000;
const DUR = (+process.env.DURATION_MIN || 160) * 60000;   // visszaszámlálás hossza
const SCARE_CHANCE = 0.4;                                  // videó esélye rejtvény után
const GRACE = 5 * 60000;                                   // feltöltés még ennyivel a lejárat után is lehetséges
const MAX_MB = +process.env.MAX_MB || 30;                  // max .pkt méret
const MAX_FILES = 20;                                      // max fájl / felhasználó (a régebbiek törlődnek)
const SESSION_MS = 12 * 3600000;

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'halloween.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'student',
  salt TEXT NOT NULL, hash TEXT NOT NULL, start_at INTEGER, end_at INTEGER,
  solved INTEGER NOT NULL DEFAULT 0, expired_seen INTEGER NOT NULL DEFAULT 0, last_wrong INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
  data BLOB NOT NULL, uploaded_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);`);

/* ---------- segédek ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function addUser(username, password, name, role = 'student') {
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    db.prepare('INSERT INTO users(username,name,role,salt,hash) VALUES(?,?,?,?,?)')
      .run(username, name || username, role, salt, hashPw(password, salt));
    return true;
  } catch (e) { return false; }
}
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const total = content.tasks.length;

// tanári fiók létrehozása az első indításkor
if (!db.prepare("SELECT 1 FROM users WHERE role='teacher'").get()) {
  const u = (process.env.TEACHER_USER || 'tanar').toLowerCase();
  const p = process.env.TEACHER_PASS || crypto.randomBytes(6).toString('hex');
  addUser(u, p, 'Tanár', 'teacher');
  console.log(`\n=== Tanári fiók létrehozva ===\n  felhasználó: ${u}\n  jelszó:      ${p}\n(Jegyezd fel, ez nem jelenik meg újra.)\n`);
}

/* ---------- auth ---------- */
const failMap = new Map(); // ip -> {n, t}
const auth = (req, res, next) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const u = m && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(m[1], Date.now());
  if (!u) return res.status(401).json({ error: 'Nincs bejelentkezve' });
  req.u = u; next();
};
const teacher = (req, res, next) => req.u.role === 'teacher' ? next() : res.status(403).json({ error: 'Nincs jogosultság' });

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);   // reverse proxy (HTTPS) mögött állítsd be
app.use(express.json({ limit: '100kb' }));
const pub = path.join(__dirname, 'public');
app.use(express.static(pub));
app.use('/public', express.static(pub));   // /public/media/scare.mp4 is működjön

app.post('/api/login', (req, res) => {
  const ip = req.ip, f = failMap.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 300000) return res.status(429).json({ error: 'Túl sok próbálkozás, várj pár percet.' });
  const { username = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim().toLowerCase());
  let ok = false;
  if (u) { try { ok = crypto.timingSafeEqual(Buffer.from(hashPw(String(password), u.salt), 'hex'), Buffer.from(u.hash, 'hex')); } catch (e) {} }
  if (!ok) { failMap.set(ip, { n: (f && Date.now() - f.t < 300000 ? f.n : 0) + 1, t: Date.now() }); return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó' }); }
  failMap.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.u.id);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true });
});

/* ---------- diák ---------- */
function stateOf(u) {
  const files = db.prepare('SELECT id,filename,size,uploaded_at FROM files WHERE user_id=? ORDER BY id DESC').all(u.id);
  const running = u.start_at && !u.end_at;
  return {
    user: { username: u.username, name: u.name, role: u.role }, now: Date.now(), durationMs: DUR,
    start: u.start_at, end: u.end_at, solved: u.solved, total, expiredSeen: !!u.expired_seen,
    tasks: content.tasks.slice(0, u.solved),                       // csak a feloldott feladatok mennek ki
    puzzle: running && u.solved < total ? { q: content.puzzles[u.solved].q } : null,
    files
  };
}
const fresh = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const student = (req, res, next) => req.u.role === 'student' ? next() : res.status(403).json({ error: 'Csak diákoknak' });
const expired = u => u.start_at && Date.now() > u.start_at + DUR;

app.get('/api/state', auth, (req, res) => res.json(stateOf(req.u)));
app.post('/api/start', auth, student, (req, res) => {
  if (!req.u.start_at) db.prepare('UPDATE users SET start_at=? WHERE id=?').run(Date.now(), req.u.id);
  res.json(stateOf(fresh(req.u.id)));
});
app.post('/api/puzzle', auth, student, (req, res) => {
  const u = req.u;
  if (!u.start_at || u.end_at || u.solved >= total) return res.status(400).json({ error: 'Most nincs aktív rejtvény' });
  if (expired(u)) return res.status(403).json({ error: 'Lejárt az idő' });
  const wait = Math.ceil((u.last_wrong + 8000 - Date.now()) / 1000);
  if (wait > 0) return res.status(429).json({ error: 'Várj még', wait });
  if (norm((req.body || {}).answer || '') === content.puzzles[u.solved].a) {
    db.prepare('UPDATE users SET solved=solved+1 WHERE id=? AND solved=?').run(u.id, u.solved);
    return res.json({ ok: true, scare: Math.random() < SCARE_CHANCE });
  }
  db.prepare('UPDATE users SET last_wrong=? WHERE id=?').run(Date.now(), u.id);
  res.json({ ok: false, wait: 8 });
});
app.post('/api/finish', auth, student, (req, res) => {
  if (req.u.start_at && !req.u.end_at && req.u.solved >= total) db.prepare('UPDATE users SET end_at=? WHERE id=?').run(Date.now(), req.u.id);
  res.json(stateOf(fresh(req.u.id)));
});
app.post('/api/ack-expired', auth, student, (req, res) => {
  if (expired(req.u)) db.prepare('UPDATE users SET expired_seen=1 WHERE id=?').run(req.u.id);
  res.json({ ok: true });
});

/* ---------- .pkt feltöltés (adatbázisba, BLOB-ként) ---------- */
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1048576, files: 1 },
  fileFilter: (req, f, cb) => /\.(pkt|pka)$/i.test(f.originalname) ? cb(null, true) : cb(new Error('Csak .pkt vagy .pka fájl tölthető fel.'))
}).single('file');
app.post('/api/upload', auth, student, (req, res) => {
  const u = req.u;
  if (!u.start_at) return res.status(403).json({ error: 'Előbb indítsd el a játékot.' });
  if (!u.end_at && Date.now() > u.start_at + DUR + GRACE) return res.status(403).json({ error: 'Lejárt az idő, a feltöltés lezárult.' });
  uploader(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `A fájl túl nagy (max ${MAX_MB} MB).` : err.message });
    if (!req.file) return res.status(400).json({ error: 'Nincs kiválasztott fájl.' });
    let name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');       // ékezetes fájlnevek
    name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').slice(0, 150);
    db.prepare('INSERT INTO files(user_id,filename,size,data,uploaded_at) VALUES(?,?,?,?,?)').run(u.id, name, req.file.size, req.file.buffer, Date.now());
    db.prepare('DELETE FROM files WHERE user_id=? AND id NOT IN (SELECT id FROM files WHERE user_id=? ORDER BY id DESC LIMIT ?)').run(u.id, u.id, MAX_FILES);
    res.json({ ok: true });
  });
});
app.get('/api/files/:id', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(+req.params.id);
  if (!f || (f.user_id !== req.u.id && req.u.role !== 'teacher')) return res.status(404).json({ error: 'Nincs ilyen fájl' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.send(Buffer.from(f.data));
});

/* ---------- tanári felület ---------- */
app.get('/api/admin/overview', auth, teacher, (req, res) => {
  const users = db.prepare("SELECT id,username,name,start_at,end_at,solved FROM users WHERE role='student' ORDER BY username").all();
  const files = db.prepare('SELECT id,user_id,filename,size,uploaded_at FROM files ORDER BY id DESC').all();
  res.json({ now: Date.now(), durationMs: DUR, total, users: users.map(u => ({ ...u, files: files.filter(f => f.user_id === u.id) })) });
});
app.post('/api/admin/users', auth, teacher, (req, res) => {
  let created = 0; const skipped = [];
  String((req.body || {}).text || '').split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
    const [un, pw, ...nm] = l.split(';').map(s => s.trim());
    const username = (un || '').toLowerCase();
    if (/^[a-z0-9._-]{2,32}$/.test(username) && pw && pw.length >= 4 && addUser(username, pw, nm.join(';'))) created++; else skipped.push(l.split(';')[0]);
  });
  res.json({ created, skipped });
});
app.post('/api/admin/reset', auth, teacher, (req, res) => {
  db.prepare("UPDATE users SET start_at=NULL,end_at=NULL,solved=0,expired_seen=0,last_wrong=0 WHERE id=? AND role='student'").run(+(req.body || {}).id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Halloween szerver: http://localhost:${PORT}`));
