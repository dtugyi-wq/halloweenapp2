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
const STUDENT_SESSION_LIMIT = Math.max(1, +process.env.STUDENT_SESSION_LIMIT || 1);   // hány eszközről lehet egyszerre bejelentkezve egy diák
const REQUIRE_SHARE = process.env.REQUIRE_SHARE === '0' ? false : true;   // alapértelmezetten kötelező; REQUIRE_SHARE=0 kikapcsolja
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
CREATE TABLE IF NOT EXISTS help_messages(id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hm_req ON help_messages(request_id);
CREATE TABLE IF NOT EXISTS shared_files(id INTEGER PRIMARY KEY, filename TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, enc INTEGER NOT NULL DEFAULT 0, task INTEGER, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS progress(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, solved INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_prog_user ON progress(user_id);
CREATE TABLE IF NOT EXISTS away_log(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, start_at INTEGER NOT NULL, dur INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_away_user ON away_log(user_id);
CREATE TABLE IF NOT EXISTS point_adj(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_padj_user ON point_adj(user_id);
CREATE TABLE IF NOT EXISTS bonus_math(user_id INTEGER NOT NULL, qid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id,qid));
CREATE TABLE IF NOT EXISTS bonus_essay(user_id INTEGER PRIMARY KEY, text TEXT NOT NULL, submitted_at INTEGER NOT NULL, score INTEGER, feedback TEXT, graded_at INTEGER);
CREATE TABLE IF NOT EXISTS shots(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL, data BLOB NOT NULL, enc INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_shots_user ON shots(user_id);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER, user TEXT, action TEXT, detail TEXT, ip TEXT);`);
for (const sql of ['ALTER TABLE users ADD COLUMN last_seen INTEGER', 'ALTER TABLE users ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN note TEXT', 'ALTER TABLE users ADD COLUMN away_count INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN away_ms INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN shot_req INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN share_on INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN score_adj INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE files ADD COLUMN hash TEXT', 'ALTER TABLE files ADD COLUMN enc INTEGER NOT NULL DEFAULT 0']) {
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
const BONUS_MATH = content.bonusMath || [];
const BONUS_ESSAY = content.bonusEssay || null;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const pktHeuristic = size => size < 2000 ? { label: 'Gyanúsan kicsi (lehet, hogy üres vagy az alap fájl)', cls: 'warn' }
  : size < 20000 ? { label: 'Kicsi fájl – egyszerű topológia is lehet', cls: '' }
  : size < 300000 ? { label: 'Közepes méret – valószínűleg tartalmaz munkát', cls: 'ok' }
  : { label: 'Nagy fájl – komplex topológiának tűnik', cls: 'ok' };
// FONTOS: a .pkt Packet Tracer saját, tömörített bináris formátuma, nem olvasható szövegként, ezért itt csak méret és egyezés (hash) alapú, tájékoztató jellegű becslés készül – ez nem helyettesíti a tanári ellenőrzést.
const clientIp = req => String(req.ip || '').replace('::ffff:', '');
const audit = (user, action, detail = '', ip = '') => {
  try {
    db.prepare('INSERT INTO audit(at,user,action,detail,ip) VALUES(?,?,?,?,?)').run(Date.now(), String(user), action, String(detail).slice(0, 200), ip);
    if (Math.random() < 0.02) db.prepare('DELETE FROM audit WHERE id < (SELECT MAX(id)-2000 FROM audit)').run();
  } catch (e) {}
};
const wipeActivity = id => {
  db.prepare("DELETE FROM bonus_math WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);
  db.prepare("DELETE FROM bonus_essay WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);   // egy diák tevékenységi adatainak törlése (reset / törlés)
  db.prepare("DELETE FROM help_messages WHERE request_id IN (SELECT id FROM help_requests WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student'))").run(id);
  db.prepare("DELETE FROM help_requests WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);
  db.prepare("DELETE FROM progress WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);
  db.prepare("DELETE FROM shots WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);
  db.prepare("DELETE FROM away_log WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);
  db.prepare("DELETE FROM point_adj WHERE user_id IN (SELECT id FROM users WHERE id=? AND role='student')").run(id);
};
const cleanName = n => path.basename(Buffer.from(String(n), 'latin1').toString('utf8').replace(/\\/g, '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').slice(0, 150);
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
const jsonSmall = express.json({ limit: '100kb' });
app.use((req, res, next) => req.path === '/api/shot' ? next() : jsonSmall(req, res, next));   // a képernyőkép útvonal saját, nagyobb limitet kap
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
  db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
  if (u.role === 'student') {
    const actives = db.prepare('SELECT token FROM sessions WHERE user_id=? AND expires>? ORDER BY expires ASC').all(u.id, now);
    if (actives.length >= STUDENT_SESSION_LIMIT) actives.slice(0, actives.length - STUDENT_SESSION_LIMIT + 1).forEach(x => db.prepare('DELETE FROM sessions WHERE token=?').run(x.token));
  }
  const token = crypto.randomBytes(32).toString('hex');
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
const msgsOf = (sql, id) => db.prepare(sql).all(id).map(m => ({ from: m.sender, text: m.text, at: m.at, request_id: m.request_id }));
function helpOf(uid) {
  const hs = db.prepare('SELECT id,task,created_at,handled_at FROM help_requests WHERE user_id=? ORDER BY id').all(uid);
  const ms = msgsOf('SELECT request_id,sender,text,at FROM help_messages WHERE request_id IN (SELECT id FROM help_requests WHERE user_id=?) ORDER BY id', uid);
  return hs.map(h => ({ ...h, msgs: ms.filter(m => m.request_id === h.id).map(m => ({ from: m.from, text: m.text, at: m.at })) }));
}
const allHelp = () => {
  const hs = db.prepare('SELECT id,user_id,task,created_at,handled_at FROM help_requests ORDER BY id DESC LIMIT 300').all();
  const ms = db.prepare('SELECT request_id,sender,text,at FROM help_messages WHERE request_id IN (SELECT id FROM help_requests ORDER BY id DESC LIMIT 300) ORDER BY id').all();
  return hs.map(h => ({ ...h, msgs: ms.filter(m => m.request_id === h.id).map(m => ({ from: m.sender, text: m.text, at: m.at })) }));
};
function stateOf(u) {
  const files = db.prepare('SELECT id,filename,size,uploaded_at FROM files WHERE user_id=? ORDER BY id DESC').all(u.id);
  const running = u.start_at && !u.end_at;
  return {
    user: { username: u.username, name: u.name, role: u.role }, now: Date.now(), durationMs: DUR,
    start: u.start_at, end: u.end_at, solved: u.solved, total, expiredSeen: !!u.expired_seen,
    tasks: content.tasks.slice(0, u.solved),                       // csak a feloldott feladatok mennek ki
    puzzle: running && u.solved < total ? { q: content.puzzles[u.solved].q } : null,
    files, announce: getAnn(), note: u.note || null, wrong: u.wrong_count || 0,
    progress: db.prepare('SELECT solved,at FROM progress WHERE user_id=? ORDER BY id').all(u.id),
    bonusMath: BONUS_MATH.map(q => ({ id: q.id, q: q.q, pts: q.pts, solved: !!db.prepare('SELECT 1 FROM bonus_math WHERE user_id=? AND qid=?').get(u.id, q.id) })),
    bonusEssay: BONUS_ESSAY ? { q: BONUS_ESSAY.q, maxPts: BONUS_ESSAY.maxPts, mine: db.prepare('SELECT text,submitted_at,score,feedback,graded_at FROM bonus_essay WHERE user_id=?').get(u.id) || null } : null,
    help: helpOf(u.id), helpCost: HELP_COST, shotReq: !!u.shot_req, requireShare: REQUIRE_SHARE,
    shared: u.start_at ? db.prepare('SELECT id,filename,size,task,uploaded_at FROM shared_files WHERE task IS NULL OR task<=? ORDER BY id DESC').all(u.solved) : [],
    scoreAdj: u.score_adj || 0, adjustments: db.prepare('SELECT delta,reason,at FROM point_adj WHERE user_id=? ORDER BY id DESC').all(u.id)
  };
}
const fresh = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const student = (req, res, next) => req.u.role === 'student' ? next() : res.status(403).json({ error: 'Csak diákoknak' });
const expired = u => u.start_at && Date.now() > u.start_at + DUR;

app.get('/api/state', auth, (req, res) => res.json(stateOf(req.u)));
app.post('/api/start', auth, student, (req, res) => {
  if (!req.u.start_at) { db.prepare('UPDATE users SET start_at=? WHERE id=?').run(Date.now(), req.u.id); db.prepare('INSERT INTO progress(user_id,solved,at) VALUES(?,?,?)').run(req.u.id, 0, Date.now()); }
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
    db.prepare('INSERT INTO progress(user_id,solved,at) VALUES(?,?,?)').run(u.id, u.solved + 1, Date.now());
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
app.post('/api/bonus-math', auth, student, (req, res) => {
  const u = req.u, qid = String((req.body || {}).qid || '');
  const qdef = BONUS_MATH.find(x => x.id === qid);
  if (!u.start_at || u.end_at || expired(u) || !qdef) return res.status(400).json({ error: 'Ez most nem elérhető.' });
  if (db.prepare('SELECT 1 FROM bonus_math WHERE user_id=? AND qid=?').get(u.id, qid)) return res.status(409).json({ error: 'Ezt már megoldottad.' });
  if (sha(norm(String((req.body || {}).answer || ''))) !== qdef.a) return res.status(400).json({ error: 'Nem jó a válasz.' });
  db.prepare('INSERT INTO bonus_math(user_id,qid,at) VALUES(?,?,?)').run(u.id, qid, Date.now());
  db.prepare('UPDATE users SET score_adj=score_adj+? WHERE id=?').run(qdef.pts, u.id);
  db.prepare('INSERT INTO point_adj(user_id,delta,reason,at) VALUES(?,?,?,?)').run(u.id, qdef.pts, 'Bónusz matek megoldva: ' + qdef.id, Date.now());
  audit(u.username, 'bonus-math', qdef.id, clientIp(req));
  res.json(stateOf(fresh(u.id)));
});
app.post('/api/bonus-essay', auth, student, (req, res) => {
  const u = req.u, text = String((req.body || {}).text || '').trim().slice(0, 4000);
  if (!BONUS_ESSAY) return res.status(400).json({ error: 'Nincs ilyen feladat.' });
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem küldhetsz be szöveget.' });
  if (!text) return res.status(400).json({ error: 'Üres a beküldés.' });
  const ex = db.prepare('SELECT graded_at FROM bonus_essay WHERE user_id=?').get(u.id);
  if (ex && ex.graded_at) return res.status(409).json({ error: 'Ezt már kiértékelte a tanár, nem módosítható.' });
  db.prepare('INSERT INTO bonus_essay(user_id,text,submitted_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET text=excluded.text, submitted_at=excluded.submitted_at').run(u.id, text, Date.now());
  audit(u.username, 'bonus-essay-submit', '', clientIp(req));
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
  const users = db.prepare(`SELECT id,username,name,start_at AS start,end_at AS "end",solved,wrong_count AS wrong,last_seen,note,away_count,away_ms,share_on,score_adj,
    (SELECT id FROM shots WHERE user_id=users.id ORDER BY id DESC LIMIT 1) AS shot_id,
    (SELECT at FROM shots WHERE user_id=users.id ORDER BY id DESC LIMIT 1) AS shot_at,
    (SELECT MAX(at) FROM progress WHERE user_id=users.id) AS since
    FROM users WHERE role='student' ORDER BY username`).all();
  const files = db.prepare('SELECT id,user_id,filename,size,uploaded_at,hash FROM files ORDER BY id DESC').all();
  const dupHash = {}; files.forEach(f => { if (f.hash) (dupHash[f.hash] = dupHash[f.hash] || []).push(f); });
  const dup = {}; Object.values(dupHash).filter(g => g.length > 1).forEach(g => g.forEach(f => { dup[f.id] = g.filter(x => x.id !== f.id).map(x => ({ user_id: x.user_id, filename: x.filename })); }));
  const usersById = Object.fromEntries(users.map(u => [u.id, u]));
  res.json({ now: Date.now(), durationMs: DUR, total, helpCost: HELP_COST, taskTitles: content.tasks.map(t => t.title),
    help: allHelp(), progress: db.prepare('SELECT user_id,solved,at FROM progress ORDER BY id').all(),
    shared: db.prepare('SELECT id,filename,size,task,uploaded_at FROM shared_files ORDER BY id DESC').all(),
    bonusEssays: BONUS_ESSAY ? db.prepare('SELECT user_id,text,submitted_at,score,feedback,graded_at FROM bonus_essay ORDER BY submitted_at DESC').all() : [],
    bonusMathSolved: db.prepare('SELECT user_id,qid,at FROM bonus_math').all(), bonusMathDefs: BONUS_MATH.map(q => ({ id: q.id, pts: q.pts })), essayMaxPts: BONUS_ESSAY ? BONUS_ESSAY.maxPts : 0,
    adjustments: db.prepare('SELECT user_id,delta,reason,at FROM point_adj ORDER BY id DESC LIMIT 300').all(),
    users: users.map(u => ({ ...u, files: files.filter(f => f.user_id === u.id).map(f => ({ ...f, dupWith: (dup[f.id] || null) ? dup[f.id].map(x => ({ ...x, username: usersById[x.user_id] ? usersById[x.user_id].username : '?' })) : null })) })) });
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
  db.prepare("UPDATE users SET start_at=NULL,end_at=NULL,solved=0,expired_seen=0,last_wrong=0,wrong_count=0,away_count=0,away_ms=0,shot_req=0,share_on=0 WHERE id=? AND role='student'").run(+(req.body || {}).id);
  wipeActivity(+(req.body || {}).id);
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
  db.prepare('INSERT INTO progress(user_id,solved,at) VALUES(?,?,?)').run(uid(req), s, Date.now());
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
  wipeActivity(uid(req));
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
app.post('/api/admin/help-message', auth, teacher, (req, res) => {   // tanári üzenet a segítség-chatben
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Üres üzenet' });
  const h = db.prepare('SELECT id FROM help_requests WHERE id=? AND handled_at IS NULL').get(+b.id);
  if (!h) return res.status(404).json({ error: 'A beszélgetés már le van zárva.' });
  db.prepare('INSERT INTO help_messages(request_id,sender,text,at) VALUES(?,?,?,?)').run(h.id, 'teacher', text, Date.now());
  res.json({ ok: true });
});
app.post('/api/admin/grade-essay', auth, teacher, (req, res) => {
  const b = req.body || {}, id = Math.floor(+b.id), max = BONUS_ESSAY ? BONUS_ESSAY.maxPts : 100;
  const score = Math.max(0, Math.min(max, Math.floor(+b.score) || 0)), feedback = String(b.feedback || '').trim().slice(0, 1000);
  const row = db.prepare('SELECT score FROM bonus_essay WHERE user_id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Nincs beküldött szöveg ettől a diáktól.' });
  if (row.score !== null) db.prepare('UPDATE users SET score_adj=score_adj-? WHERE id=?').run(row.score, id);
  db.prepare('UPDATE bonus_essay SET score=?, feedback=?, graded_at=? WHERE user_id=?').run(score, feedback || null, Date.now(), id);
  db.prepare('UPDATE users SET score_adj=score_adj+? WHERE id=?').run(score, id);
  audit(req.u.username, 'grade-essay', id + ': ' + score, clientIp(req));
  res.json({ ok: true });
});
app.post('/api/admin/help-close', auth, teacher, (req, res) => {        // lezárás: a diák újra kérhet (újabb HELP_COST pontért)
  db.prepare('UPDATE help_requests SET handled_at=? WHERE id=? AND handled_at IS NULL').run(Date.now(), +((req.body || {}).id));
  res.json({ ok: true });
});
app.get('/api/announce', auth, (req, res) => res.json(getAnn() || {}));

app.post('/api/help/message', auth, student, (req, res) => {        // diák üzenete a nyitott segítség-chatben
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Üres üzenet' });
  const h = db.prepare('SELECT id FROM help_requests WHERE id=? AND user_id=? AND handled_at IS NULL').get(+b.id, req.u.id);
  if (!h) return res.status(404).json({ error: 'Ez a beszélgetés már le van zárva.' });
  if (db.prepare('SELECT COUNT(*) AS c FROM help_messages WHERE request_id=?').get(h.id).c >= 200) return res.status(429).json({ error: 'Túl sok üzenet ebben a beszélgetésben.' });
  db.prepare('INSERT INTO help_messages(request_id,sender,text,at) VALUES(?,?,?,?)').run(h.id, 'student', text, Date.now());
  res.json(stateOf(fresh(req.u.id)));
});

/* ---------- megosztott (tanári) fájlok: a diákok ezeket töltik le ---------- */
const sendBlob = (res, f) => {
  let buf = Buffer.from(f.data);
  if (f.enc) {
    if (!DATA_KEY) return res.status(500).json({ error: 'A fájl titkosított, de a DATA_KEY nincs beállítva.' });
    try { buf = decBuf(buf); } catch (e) { return res.status(500).json({ error: 'A fájl nem fejthető vissza (rossz DATA_KEY?).' }); }
  }
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  if (f.filename) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
};
const sharedUp = multer({
  storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1048576, files: 1 },
  fileFilter: (req, f, cb) => /\.(pkt|pka|zip)$/i.test(f.originalname) ? cb(null, true) : cb(new Error('Csak .pkt, .pka vagy .zip fájl tölthető fel.'))
}).single('file');
app.post('/api/admin/shared', auth, teacher, (req, res) => {
  sharedUp(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `A fájl túl nagy (max ${MAX_MB} MB).` : err.message });
    if (!req.file) return res.status(400).json({ error: 'Nincs kiválasztott fájl.' });
    const t = Math.floor(+(req.body || {}).task), task = t >= 1 && t <= total ? t : null;
    const name = cleanName(req.file.originalname), blob = DATA_KEY ? encBuf(req.file.buffer) : req.file.buffer;
    db.prepare('INSERT INTO shared_files(filename,size,data,enc,task,uploaded_at) VALUES(?,?,?,?,?,?)').run(name, req.file.size, blob, DATA_KEY ? 1 : 0, task, Date.now());
    audit(req.u.username, 'shared-upload', name + (task ? ' (feladat ' + task + ')' : ''), clientIp(req));
    res.json({ ok: true });
  });
});
app.post('/api/admin/shared-delete', auth, teacher, (req, res) => {
  db.prepare('DELETE FROM shared_files WHERE id=?').run(+((req.body || {}).id)); res.json({ ok: true });
});
app.get('/api/shared/:id', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM shared_files WHERE id=?').get(+req.params.id);
  if (!f) return res.status(404).json({ error: 'Nincs ilyen fájl' });
  if (req.u.role !== 'teacher' && (!req.u.start_at || (f.task && f.task > req.u.solved))) return res.status(403).json({ error: 'Ez a fájl még nem érhető el.' });
  sendBlob(res, f);
});

/* ---------- megfigyelés (átlátható, a diák beleegyezésével): oldalelhagyás + képernyőmegosztás ---------- */
app.post('/api/away', auth, student, (req, res) => {                   // a diák visszatért az oldalra (ms = ennyi ideig volt máshol a lap tudta szerint)
  const ms = Math.floor(+((req.body || {}).ms)), now = Date.now();
  if (req.u.start_at && !req.u.end_at && ms > 0) {
    const capped = Math.min(ms, 3600000);
    db.prepare('UPDATE users SET away_count=away_count+1, away_ms=away_ms+? WHERE id=?').run(capped, req.u.id);
    db.prepare('INSERT INTO away_log(user_id,start_at,dur) VALUES(?,?,?)').run(req.u.id, now - capped, capped);
    db.prepare('DELETE FROM away_log WHERE user_id=? AND id NOT IN (SELECT id FROM away_log WHERE user_id=? ORDER BY id DESC LIMIT 300)').run(req.u.id, req.u.id);
  }
  res.json({ ok: true });
});
app.post('/api/share-state', auth, student, (req, res) => {
  db.prepare('UPDATE users SET share_on=? WHERE id=?').run((req.body || {}).on ? 1 : 0, req.u.id); res.json({ ok: true });
});
app.post('/api/shot', auth, student, express.json({ limit: '700kb' }), (req, res) => {   // a diák böngészője által készített (megosztott képernyő) pillanatkép
  const u = req.u;
  if (!u.start_at || u.end_at) return res.status(403).json({ error: 'Most nem fogadunk képet.' });
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String((req.body || {}).img || ''));
  if (!m) return res.status(400).json({ error: 'Hibás kép' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 500000 || buf[0] !== 0xFF || buf[1] !== 0xD8) return res.status(400).json({ error: 'Hibás kép' });
  const last = db.prepare('SELECT MAX(at) AS t FROM shots WHERE user_id=?').get(u.id);
  if (last && last.t && Date.now() - last.t < 4000) return res.json({ ok: true, skipped: true });
  db.prepare('INSERT INTO shots(user_id,at,data,enc) VALUES(?,?,?,?)').run(u.id, Date.now(), DATA_KEY ? encBuf(buf) : buf, DATA_KEY ? 1 : 0);
  db.prepare('DELETE FROM shots WHERE user_id=? AND id NOT IN (SELECT id FROM shots WHERE user_id=? ORDER BY id DESC LIMIT 8)').run(u.id, u.id);
  db.prepare('UPDATE users SET shot_req=0, share_on=1 WHERE id=?').run(u.id);
  res.json({ ok: true });
});
app.post('/api/admin/shot-request', auth, teacher, (req, res) => {    // a tanár azonnali képet kér (csak aktív megosztásnál érkezik meg)
  db.prepare("UPDATE users SET shot_req=1 WHERE id=? AND role='student'").run(+((req.body || {}).id)); res.json({ ok: true });
});
app.get('/api/admin/shots/:id', auth, teacher, (req, res) => res.json(db.prepare('SELECT id,at FROM shots WHERE user_id=? ORDER BY id DESC').all(+req.params.id)));
app.get('/api/admin/away/:id', auth, teacher, (req, res) => res.json(db.prepare('SELECT start_at,dur FROM away_log WHERE user_id=? ORDER BY id').all(+req.params.id)));
app.post('/api/admin/points', auth, teacher, (req, res) => {           // nyílt, indoklással járó pontmódosítás (pl. más eszköz/segítség észlelése)
  const b = req.body || {}, id = Math.floor(+b.id), delta = Math.max(-100, Math.min(100, Math.floor(+b.delta) || 0));
  const reason = String(b.reason || '').trim().slice(0, 300);
  if (!delta) return res.status(400).json({ error: 'Adj meg egy nullától eltérő pontértéket.' });
  const u = db.prepare("SELECT id FROM users WHERE id=? AND role='student'").get(id);
  if (!u) return res.status(404).json({ error: 'Nincs ilyen diák.' });
  db.prepare('UPDATE users SET score_adj=score_adj+? WHERE id=?').run(delta, id);
  db.prepare('INSERT INTO point_adj(user_id,delta,reason,at) VALUES(?,?,?,?)').run(id, delta, reason || null, Date.now());
  audit(req.u.username, 'points', `${delta>0?'+':''}${delta} pont – ${id} – ${reason}`, clientIp(req));
  res.json({ ok: true });
});
app.get('/api/shot-img/:id', auth, teacher, (req, res) => {
  const f = db.prepare('SELECT data,enc FROM shots WHERE id=?').get(+req.params.id);
  if (!f) return res.status(404).end();
  sendBlob(res, { data: f.data, enc: f.enc, mime: 'image/jpeg' });
});

app.use((err, req, res, next) => {                                   // hibakezelő: nincs stack trace a kliensnek
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Hibás kérés' });
  console.error(err); res.status(500).json({ error: 'Szerverhiba' });
});

app.listen(PORT, () => console.log(`Halloween szerver: http://localhost:${PORT}`));
