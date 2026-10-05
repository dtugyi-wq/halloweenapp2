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
const HELP_COST = +process.env.HELP_COST || 5;      // egy segítségkérés ára (pont)
const HELP_COOLDOWN = 20000;                        // két kérés között min. ennyi ms
// Biztonság
const DATA_KEY = process.env.DATA_KEY ? crypto.scryptSync(process.env.DATA_KEY, 'halloween-pt-v1', 32) : null; // a feltöltött fájlok AES-256-GCM titkosításához
const COOKIE_SECURE = !!process.env.COOKIE_SECURE;                                                           // 1: a süti csak HTTPS-en megy
if (!DATA_KEY) console.warn('FIGYELEM: a DATA_KEY nincs beállítva, a feltöltött fájlok titkosítatlanul tárolódnak.');

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
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS help_requests(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, task INTEGER NOT NULL, created_at INTEGER NOT NULL, handled_at INTEGER, reply TEXT);
CREATE INDEX IF NOT EXISTS idx_help_user ON help_requests(user_id);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER, user TEXT, action TEXT, detail TEXT, ip TEXT);`);
for (const sql of ['ALTER TABLE users ADD COLUMN last_seen INTEGER', 'ALTER TABLE users ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN note TEXT', 'ALTER TABLE files ADD COLUMN enc INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(sql); } catch (e) { /* már létezik */ }
}

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
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const clientIp = req => String(req.ip || '').replace('::ffff:', '');
const audit = (user, action, detail = '', ip = '') => {
  try {
    db.prepare('INSERT INTO audit(at,user,action,detail,ip) VALUES(?,?,?,?,?)').run(Date.now(), String(user), action, String(detail).slice(0, 200), ip);
    if (Math.random() < 0.02) db.prepare('DELETE FROM audit WHERE id < (SELECT MAX(id)-2000 FROM audit)').run();
  } catch (e) {}
};
const encBuf = b => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv); const d = Buffer.concat([c.update(b), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]); };
const decBuf = b => { const d = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };

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
  if (!u.last_seen || Date.now() - u.last_seen > 5000) db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), u.id);
  req.u = u; next();
};
const teacher = (req, res, next) => req.u.role === 'teacher' ? next() : res.status(403).json({ error: 'Nincs jogosultság' });

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);   // reverse proxy (HTTPS) mögött állítsd be
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (COOKIE_SECURE || req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
const pub = path.join(__dirname, 'public');
app.use(express.static(pub));
app.use('/public', express.static(pub));   // /public/media/scare.mp4 is működjön

const userFails = new Map();
app.post('/api/login', (req, res) => {
  const ip = clientIp(req), now = Date.now();
  const { username = '', password = '' } = req.body || {};
  const un = String(username).trim().toLowerCase().slice(0, 64);
  const f = failMap.get(ip), g = userFails.get(un);
  if ((f && f.n >= 10 && now - f.t < 300000) || (g && g.n >= 5 && now - g.t < 300000)) {
    audit(un, 'login-blocked', '', ip);
    return res.status(429).json({ error: 'Túl sok próbálkozás, várj pár percet.' });
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(un);
  let ok = false;
  if (u) { try { ok = crypto.timingSafeEqual(Buffer.from(hashPw(String(password), u.salt), 'hex'), Buffer.from(u.hash, 'hex')); } catch (e) {} }
  if (!ok) {
    failMap.set(ip, { n: (f && now - f.t < 300000 ? f.n : 0) + 1, t: now });
    userFails.set(un, { n: (g && now - g.t < 300000 ? g.n : 0) + 1, t: now });
    audit(un, 'login-fail', '', ip);
    return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó' });
  }
  failMap.delete(ip); userFails.delete(un);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, now + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${(COOKIE_SECURE || req.secure) ? '; Secure' : ''}`);
  audit(un, 'login', '', ip);
  res.json({ ok: true });
});
app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.u.id);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true });
});

/* ---------- diák ---------- */
const getAnn = () => { const r = db.prepare("SELECT v FROM settings WHERE k='announce'").get(); return r ? JSON.parse(r.v) : null; };
function stateOf(u) {
  const files = db.prepare('SELECT id,filename,size,uploaded_at FROM files WHERE user_id=? ORDER BY id DESC').all(u.id);
  const running = u.start_at && !u.end_at;
  return {
    user: { username: u.username, name: u.name, role: u.role }, now: Date.now(), durationMs: DUR,
    start: u.start_at, end: u.end_at, solved: u.solved, total, expiredSeen: !!u.expired_seen,
    tasks: content.tasks.slice(0, u.solved),                       // csak a feloldott feladatok mennek ki
    puzzle: running && u.solved < total ? { q: content.puzzles[u.solved].q } : null,
    files, announce: getAnn(), note: u.note || null,
    help: db.prepare('SELECT task,created_at,handled_at,reply FROM help_requests WHERE user_id=? ORDER BY id').all(u.id), helpCost: HELP_COST
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
  if (sha(norm((req.body || {}).answer || '')) === content.puzzles[u.solved].a) {
    db.prepare('UPDATE users SET solved=solved+1 WHERE id=? AND solved=?').run(u.id, u.solved);
    return res.json({ ok: true, scare: Math.random() < SCARE_CHANCE });
  }
  db.prepare('UPDATE users SET last_wrong=?, wrong_count=wrong_count+1 WHERE id=?').run(Date.now(), u.id);
  res.json({ ok: false, wait: 8 });
});
app.post('/api/help', auth, student, (req, res) => {          // segítségkérés egy feladathoz (HELP_COST pontért)
  const u = req.u, task = (req.body || {}).task;
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem kérhetsz segítséget.' });
  if (!Number.isInteger(task) || task < 1 || task > u.solved) return res.status(400).json({ error: 'Ehhez a feladathoz nem kérhetsz segítséget.' });
  if (db.prepare('SELECT 1 FROM help_requests WHERE user_id=? AND task=? AND handled_at IS NULL').get(u.id, task)) return res.status(409).json({ error: 'Ehhez a feladathoz már van nyitott kérésed.' });
  const last = db.prepare('SELECT MAX(created_at) AS t FROM help_requests WHERE user_id=?').get(u.id);
  if (last && last.t && Date.now() - last.t < HELP_COOLDOWN) return res.status(429).json({ error: 'Várj egy kicsit a következő kérés előtt.' });
  db.prepare('INSERT INTO help_requests(user_id,task,created_at) VALUES(?,?,?)').run(u.id, task, Date.now());
  audit(u.username, 'help', 'feladat ' + task, clientIp(req));
  res.json(stateOf(fresh(u.id)));
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
    const blob = DATA_KEY ? encBuf(req.file.buffer) : req.file.buffer;
    db.prepare('INSERT INTO files(user_id,filename,size,data,uploaded_at,enc) VALUES(?,?,?,?,?,?)').run(u.id, name, req.file.size, blob, Date.now(), DATA_KEY ? 1 : 0);
    audit(u.username, 'upload', name, clientIp(req));
    db.prepare('DELETE FROM files WHERE user_id=? AND id NOT IN (SELECT id FROM files WHERE user_id=? ORDER BY id DESC LIMIT ?)').run(u.id, u.id, MAX_FILES);
    res.json({ ok: true });
  });
});
app.get('/api/files/:id', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(+req.params.id);
  if (!f || (f.user_id !== req.u.id && req.u.role !== 'teacher')) return res.status(404).json({ error: 'Nincs ilyen fájl' });
  let buf = Buffer.from(f.data);
  if (f.enc) {
    if (!DATA_KEY) return res.status(500).json({ error: 'A fájl titkosított, de a DATA_KEY nincs beállítva.' });
    try { buf = decBuf(buf); } catch (e) { return res.status(500).json({ error: 'A fájl nem fejthető vissza (rossz DATA_KEY?).' }); }
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.send(buf);
});

/* ---------- tanári felület ---------- */
app.use('/api/admin', (req, res, next) => {   // minden tanári művelet bekerül a naplóba (jelszavak és szövegek nélkül)
  if (req.method === 'POST') res.on('finish', () => {
    if (res.statusCode < 400 && req.u) { const b = req.body || {}; audit(req.u.username, 'admin:' + req.path.slice(1), JSON.stringify({ id: b.id, minutes: b.minutes, solved: b.solved }), clientIp(req)); }
  });
  next();
});
app.post('/api/admin/note', auth, teacher, (req, res) => {          // egyéni megjegyzés/feladat egy diáknak
  const t = String((req.body || {}).text || '').trim().slice(0, 1000);
  db.prepare("UPDATE users SET note=? WHERE id=? AND role='student'").run(t || null, +((req.body || {}).id));
  res.json({ ok: true });
});
app.get('/api/admin/audit', auth, teacher, (req, res) => res.json(db.prepare('SELECT at,user,action,detail,ip FROM audit ORDER BY id DESC LIMIT 100').all()));
app.get('/api/admin/overview', auth, teacher, (req, res) => {
  const users = db.prepare("SELECT id,username,name,start_at AS start,end_at AS \"end\",solved,wrong_count AS wrong,last_seen,note FROM users WHERE role='student' ORDER BY username").all();
  const files = db.prepare('SELECT id,user_id,filename,size,uploaded_at FROM files ORDER BY id DESC').all();
  res.json({ now: Date.now(), durationMs: DUR, total, helpCost: HELP_COST, taskTitles: content.tasks.map(t => t.title),
    help: db.prepare('SELECT id,user_id,task,created_at,handled_at,reply FROM help_requests ORDER BY id DESC LIMIT 500').all(), users: users.map(u => ({ ...u, files: files.filter(f => f.user_id === u.id) })) });
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
  db.prepare("UPDATE users SET start_at=NULL,end_at=NULL,solved=0,expired_seen=0,last_wrong=0,wrong_count=0 WHERE id=? AND role='student'").run(+(req.body || {}).id);
  db.prepare("DELETE FROM help_requests WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(+(req.body || {}).id);
  res.json({ ok: true });
});

const uid = req => +((req.body || {}).id);
app.post('/api/admin/time', auth, teacher, (req, res) => {          // idő hozzáadása/elvétele (percben)
  const m = Math.max(-240, Math.min(240, +(req.body || {}).minutes || 0));
  db.prepare("UPDATE users SET start_at=start_at+? WHERE id=? AND role='student' AND start_at IS NOT NULL AND end_at IS NULL").run(m * 60000, uid(req));
  res.json({ ok: true });
});
app.post('/api/admin/solved', auth, teacher, (req, res) => {        // feladat átugrása / visszalépés
  const s = Math.max(0, Math.min(total, Math.floor(+(req.body || {}).solved || 0)));
  const u = db.prepare("SELECT start_at FROM users WHERE id=? AND role='student'").get(uid(req));
  if (!u) return res.status(404).json({ error: 'Nincs ilyen diák.' });
  const startAt = u.start_at || (s > 0 ? Date.now() : null);        // ha még nem indult, az ugrással elindul az órája
  db.prepare('UPDATE users SET solved=?, start_at=?, end_at=CASE WHEN ?<? THEN NULL ELSE end_at END WHERE id=?').run(s, startAt, s, total, uid(req));
  res.json({ ok: true });
});
app.post('/api/admin/password', auth, teacher, (req, res) => {
  const p = String((req.body || {}).password || '');
  if (p.length < 4) return res.status(400).json({ error: 'A jelszó legalább 4 karakter legyen.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE users SET salt=?, hash=? WHERE id=? AND role='student'").run(salt, hashPw(p, salt), uid(req));
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid(req));
  res.json({ ok: true });
});
app.post('/api/admin/delete', auth, teacher, (req, res) => {
  db.prepare("DELETE FROM help_requests WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(uid(req));
  db.prepare("DELETE FROM files WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(uid(req));
  db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(uid(req));
  db.prepare("DELETE FROM users WHERE id=? AND role='student'").run(uid(req));
  res.json({ ok: true });
});
app.post('/api/admin/start-all', auth, teacher, (req, res) => {     // egyszerre indítás mindenkinek
  db.prepare("UPDATE users SET start_at=? WHERE role='student' AND start_at IS NULL").run(Date.now());
  res.json({ ok: true });
});
app.post('/api/admin/announce', auth, teacher, (req, res) => {      // üzenet a diákoknak
  const t = String((req.body || {}).text || '').trim().slice(0, 300);
  if (t) db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)').run('announce', JSON.stringify({ text: t, at: Date.now() }));
  else db.prepare("DELETE FROM settings WHERE k='announce'").run();
  res.json({ ok: true });
});
app.post('/api/admin/help-reply', auth, teacher, (req, res) => {   // válasz a segítségkérésre / lezárás
  const b = req.body || {};
  db.prepare('UPDATE help_requests SET handled_at=?, reply=? WHERE id=? AND handled_at IS NULL').run(Date.now(), String(b.reply || '').trim().slice(0, 500) || null, +b.id);
  res.json({ ok: true });
});
app.get('/api/announce', auth, (req, res) => res.json(getAnn() || {}));

app.use((err, req, res, next) => {                                   // hibakezelő: nincs stack trace a kliensnek
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Hibás kérés' });
  console.error(err); res.status(500).json({ error: 'Szerverhiba' });
});

app.listen(PORT, () => console.log(`Halloween szerver: http://localhost:${PORT}`));
