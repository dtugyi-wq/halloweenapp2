// Hálózati verseny / feladatfelügyelő – backend (Node 18+, Express, MariaDB/MySQL)
const express = require('express');
const mysql = require('mysql2/promise');
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
const STUDENT_IDLE_MS = Math.max(30000, +process.env.STUDENT_IDLE_MS || 4 * 60000);     // ha ennyi ideig nincs életjel (lap bezárva/összeomlott), a munkamenet automatikusan lezár
const REQUIRE_SHARE = process.env.REQUIRE_SHARE === '0' ? false : true;   // alapértelmezetten kötelező; REQUIRE_SHARE=0 kikapcsolja
const HELP_COST = +process.env.HELP_COST || 5;      // egy segítségkérés ára (pont)
const HELP_COOLDOWN = 20000;                        // két kérés között min. ennyi ms
// Biztonság
const DATA_KEY = process.env.DATA_KEY ? crypto.scryptSync(process.env.DATA_KEY, 'netlab-v1', 32) : null; // a feltöltött fájlok AES-256-GCM titkosításához
const COOKIE_SECURE = !!process.env.COOKIE_SECURE;                                                           // 1: a süti csak HTTPS-en megy
if (!DATA_KEY) console.warn('FIGYELEM: a DATA_KEY nincs beállítva, a feltöltött fájlok titkosítatlanul tárolódnak.');

/* ---------- adatbázis (MariaDB/MySQL, mysql2/promise) ---------- */
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: +process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'netlab',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'netlab',
  charset: 'utf8mb4_unicode_ci',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: false
});
async function qGet(sql, params = []) { const [rows] = await pool.query(sql, params); return rows[0]; }
async function qAll(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; }
async function qRun(sql, params = []) { const [result] = await pool.query(sql, params); return result; }
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);   // async route-handler hibái -> Express hibakezelő

async function initSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users(
      id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(64) UNIQUE NOT NULL, name VARCHAR(200), \`role\` VARCHAR(16) NOT NULL DEFAULT 'student',
      salt VARCHAR(64) NOT NULL, hash VARCHAR(255) NOT NULL, start_at BIGINT, end_at BIGINT,
      solved INT NOT NULL DEFAULT 0, expired_seen TINYINT NOT NULL DEFAULT 0, last_wrong BIGINT NOT NULL DEFAULT 0,
      last_seen BIGINT, wrong_count INT NOT NULL DEFAULT 0, note TEXT, away_count INT NOT NULL DEFAULT 0, away_ms BIGINT NOT NULL DEFAULT 0,
      shot_req TINYINT NOT NULL DEFAULT 0, share_on TINYINT NOT NULL DEFAULT 0, score_adj INT NOT NULL DEFAULT 0,
      coins INT NOT NULL DEFAULT 10, paused_at BIGINT
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS sessions(token VARCHAR(64) PRIMARY KEY, user_id INT NOT NULL, expires BIGINT NOT NULL) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS files(
      id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, filename VARCHAR(255) NOT NULL, size INT NOT NULL,
      data LONGBLOB NOT NULL, uploaded_at BIGINT NOT NULL, hash VARCHAR(64), enc TINYINT NOT NULL DEFAULT 0,
      INDEX idx_files_user(user_id)
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS settings(k VARCHAR(64) PRIMARY KEY, v TEXT) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS help_requests(id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, task INT NOT NULL, created_at BIGINT NOT NULL, handled_at BIGINT, reply TEXT, INDEX idx_help_user(user_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS help_messages(id INT PRIMARY KEY AUTO_INCREMENT, request_id INT NOT NULL, sender VARCHAR(16) NOT NULL, text TEXT NOT NULL, at BIGINT NOT NULL, INDEX idx_hm_req(request_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS shared_files(id INT PRIMARY KEY AUTO_INCREMENT, filename VARCHAR(255) NOT NULL, size INT NOT NULL, data LONGBLOB NOT NULL, enc TINYINT NOT NULL DEFAULT 0, task INT, uploaded_at BIGINT NOT NULL) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS progress(id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, solved INT NOT NULL, at BIGINT NOT NULL, INDEX idx_prog_user(user_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS away_log(id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, start_at BIGINT NOT NULL, dur BIGINT NOT NULL, INDEX idx_away_user(user_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS point_adj(id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, delta INT NOT NULL, reason VARCHAR(300), at BIGINT NOT NULL, INDEX idx_padj_user(user_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS bonus_math(user_id INT NOT NULL, qid VARCHAR(40) NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(user_id,qid)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS bonus_essay(user_id INT PRIMARY KEY, text TEXT NOT NULL, submitted_at BIGINT NOT NULL, score INT, feedback TEXT, graded_at BIGINT) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS wheel_spins(user_id INT NOT NULL, milestone INT NOT NULL, prize INT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(user_id,milestone)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS puzzle_assign(user_id INT NOT NULL, gate INT NOT NULL, qid INT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(user_id,gate)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS bet_log(user_id INT NOT NULL, task INT NOT NULL, stake INT NOT NULL, win TINYINT NOT NULL, payout INT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(user_id,task)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS hint_buys(user_id INT NOT NULL, task INT NOT NULL, hint TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(user_id,task)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS addr_buys(user_id INT PRIMARY KEY, at BIGINT NOT NULL) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS shots(id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, at BIGINT NOT NULL, data LONGBLOB NOT NULL, enc TINYINT NOT NULL DEFAULT 0, INDEX idx_shots_user(user_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS audit(id INT PRIMARY KEY AUTO_INCREMENT, at BIGINT, username VARCHAR(100), action VARCHAR(100), detail VARCHAR(500), ip VARCHAR(64)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS tasks(id INT PRIMARY KEY AUTO_INCREMENT, ord INT NOT NULL, title VARCHAR(200) NOT NULL, pts VARCHAR(60) NOT NULL DEFAULT '',
      items TEXT NOT NULL, olt VARCHAR(200), ol TEXT NOT NULL, note TEXT) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS student_groups(id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80) NOT NULL, created_at BIGINT NOT NULL) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS group_members(group_id INT NOT NULL, user_id INT NOT NULL, PRIMARY KEY(group_id,user_id), INDEX idx_gm_user(user_id)) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS topology(id INT PRIMARY KEY, filename VARCHAR(255), mime VARCHAR(100), data LONGBLOB, uploaded_at BIGINT) CHARACTER SET utf8mb4`
  ];
  for (const sql of stmts) await pool.query(sql);
}

/* ---------- segédek ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
async function addUser(username, password, name, role = 'student') {
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    await qRun('INSERT INTO users(username,name,`role`,salt,hash) VALUES(?,?,?,?,?)', [username, name || username, role, salt, hashPw(password, salt)]);
    return true;
  } catch (e) { return false; }
}
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/* ---------- feladatok (adatbázisból, a tanár szerkesztheti) ---------- */
async function seedTasksIfEmpty() {
  const row = await qGet('SELECT COUNT(*) c FROM tasks');
  if (row.c > 0) return;
  let i = 0;
  for (const t of (content.tasks || [])) {
    await qRun('INSERT INTO tasks(ord,title,pts,items,olt,ol,note) VALUES(?,?,?,?,?,?,?)',
      [i, t.title || '', t.pts || '', JSON.stringify(t.items || []), t.olt || '', JSON.stringify(t.ol || []), t.note || '']);
    i++;
  }
}
const rowToTask = r => ({ id: r.id, ord: r.ord, title: r.title, pts: r.pts, items: JSON.parse(r.items || '[]'), olt: r.olt || '', ol: JSON.parse(r.ol || '[]'), note: r.note || '' });
async function getTasks() { const rows = await qAll('SELECT * FROM tasks ORDER BY ord, id'); return rows.map(rowToTask); }
async function getTotal() { const r = await qGet('SELECT COUNT(*) c FROM tasks'); return r.c; }
function pickQuestion(gate, usedIds) {
  const topicMatch = QPOOL.filter(q => q.topic === gate + 1 && !usedIds.includes(q.id));
  const anyUnused = QPOOL.filter(q => !usedIds.includes(q.id));
  const pool2 = topicMatch.length ? topicMatch : (anyUnused.length ? anyUnused : QPOOL);
  return pool2[Math.floor(Math.random() * pool2.length)];
}
async function getAssignedPuzzle(u) {
  const gate = u.solved;
  let a = await qGet('SELECT qid FROM puzzle_assign WHERE user_id=? AND gate=?', [u.id, gate]);
  if (!a) {
    const usedRows = await qAll('SELECT qid FROM puzzle_assign WHERE user_id=?', [u.id]);
    const used = usedRows.map(x => x.qid);
    const q = pickQuestion(gate, used);
    if (!q) return null;
    await qRun('INSERT INTO puzzle_assign(user_id,gate,qid,at) VALUES(?,?,?,?)', [u.id, gate, q.id, Date.now()]);
    a = { qid: q.id };
  }
  const q = QPOOL.find(x => x.id === a.qid);
  return q ? { q: q.q, options: q.options } : null;   // a helyes válasz indexét SOHA nem küldjük el
}
const BONUS_MATH = content.bonusMath || [];
const QPOOL = content.quizPool || [];   // 200+ halozati feleletvalasztos kerdes, feladatonkent (topic) cimkezve
const BONUS_ESSAY = content.bonusEssay || null;
const WHEEL_MILESTONES = [3, 6, 8];   // ennyi fő feladat megoldása után jár egy-egy ingyenes pörgetés
const WHEEL_PRIZES = [[40,0],[25,2],[15,5],[10,10],[7,15],[3,25]];   // [súly, pont] – csak nyeremény, veszteség soha
const HINTS = content.hints || {};
const COIN_START = +process.env.COIN_START || 10;     // csak erre a mellékjátékra költhető induló egyenleg
const BET_STAKE = +process.env.BET_STAKE || 5;         // tét fogadásonként (az induló egyenleg fele – szándékosan drága)
const BET_WIN_CHANCE = +process.env.BET_WIN_CHANCE || 0.3;  // nyerési esély (nehezített, nem 50/50)
const COIN_CAP = +process.env.COIN_CAP || 25;          // az érmeegyenleg soha nem mehet e fölé
const HINT_COST = +process.env.HINT_COST || 4;         // egy hint ára érmében
const ADDR_PRICE = +process.env.ADDR_PRICE || 15;      // a címzési tábla ára VALÓDI pontban – ebbe bele lehet menni mínuszba
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const pktHeuristic = size => size < 2000 ? { label: 'Gyanúsan kicsi (lehet, hogy üres vagy az alap fájl)', cls: 'warn' }
  : size < 20000 ? { label: 'Kicsi fájl – egyszerű topológia is lehet', cls: '' }
  : size < 300000 ? { label: 'Közepes méret – valószínűleg tartalmaz munkát', cls: 'ok' }
  : { label: 'Nagy fájl – komplex topológiának tűnik', cls: 'ok' };
// FONTOS: a .pkt Packet Tracer saját, tömörített bináris formátuma, nem olvasható szövegként, ezért itt csak méret és egyezés (hash) alapú, tájékoztató jellegű becslés készül – ez nem helyettesíti a tanári ellenőrzést.
const clientIp = req => String(req.ip || '').replace('::ffff:', '');
async function audit(user, action, detail = '', ip = '') {
  try {
    await qRun('INSERT INTO audit(at,username,action,detail,ip) VALUES(?,?,?,?,?)', [Date.now(), String(user), action, String(detail).slice(0, 200), ip]);
    if (Math.random() < 0.02) await qRun('DELETE FROM audit WHERE id < (SELECT m FROM (SELECT MAX(id)-2000 AS m FROM audit) x)');
  } catch (e) {}
}
async function wipeActivity(id) {
  await Promise.all([
    qRun("DELETE FROM bonus_math WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM bonus_essay WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM wheel_spins WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM puzzle_assign WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM help_messages WHERE request_id IN (SELECT id FROM help_requests WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student'))", [id])
  ]);   // a help_messages-t a help_requests előtt kell törölni (hivatkozási sorrend)
  await qRun("DELETE FROM help_requests WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]);
  await Promise.all([
    qRun("DELETE FROM progress WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM shots WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM away_log WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM point_adj WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM bet_log WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM hint_buys WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id]),
    qRun("DELETE FROM addr_buys WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [id])
  ]);
  await qRun('UPDATE users SET coins=? WHERE id=?', [COIN_START, id]);
}
async function getAddrForce() { const r = await qGet("SELECT v FROM settings WHERE k='addr_force'"); return r ? r.v === '1' : false; }

/* ---------- csoportmunka ---------- */
async function getGroups() {
  const gs = await qAll('SELECT id,name,created_at FROM student_groups ORDER BY id');
  const mem = await qAll('SELECT gm.group_id AS group_id, u.id AS id, u.username AS username, u.name AS name FROM group_members gm JOIN users u ON u.id=gm.user_id ORDER BY u.username');
  return gs.map(g => ({ ...g, members: mem.filter(m => m.group_id === g.id).map(m => ({ id: m.id, username: m.username, name: m.name })) }));
}
async function groupOf(userId) {
  const g = await qGet('SELECT g.id AS id, g.name AS name FROM student_groups g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=?', [userId]);
  if (!g) return null;
  const members = await qAll('SELECT u.username AS username, u.name AS name FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? AND u.id<>? ORDER BY u.username', [g.id, userId]);
  return { id: g.id, name: g.name, members };
}

/* ---------- topológia (a tanár feltölthet egy saját térképet a beépített helyett) ---------- */
async function getTopology() { return (await qGet('SELECT filename,mime,uploaded_at FROM topology WHERE id=1')) || null; }
const DEFAULT_SHOT_MS = +process.env.SHOT_INTERVAL_MS || 30000;
async function getShotMs() {
  const r = await qGet("SELECT v FROM settings WHERE k='shot_interval_ms'");
  const n = r ? +r.v : DEFAULT_SHOT_MS;
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 300000) : DEFAULT_SHOT_MS;
}
const cleanName = n => path.basename(Buffer.from(String(n), 'latin1').toString('utf8').replace(/\\/g, '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').slice(0, 150);
const encBuf = b => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv); const d = Buffer.concat([c.update(b), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]); };
const decBuf = b => { const d = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };

/* ---------- auth ---------- */
const failMap = new Map(); // ip -> {n, t}
const auth = ah(async (req, res, next) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  let u = null;
  if (m) u = await qGet('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', [m[1], Date.now()]);
  if (!u) return res.status(401).json({ error: 'Nincs bejelentkezve' });
  if (u.role === 'student' && u.last_seen && Date.now() - u.last_seen > STUDENT_IDLE_MS) {
    await qRun('DELETE FROM sessions WHERE token=?', [m[1]]);
    await audit(u.username, 'idle-logout', '', clientIp(req));
    return res.status(401).json({ error: 'A munkamenet hosszabb inaktivitás (bezárt böngésző) után lezárult. Jelentkezz be újra.', reason: 'idle' });
  }
  if (!u.last_seen || Date.now() - u.last_seen > 5000) await qRun('UPDATE users SET last_seen=? WHERE id=?', [Date.now(), u.id]);
  req.u = u; next();
});
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
app.post('/api/login', ah(async (req, res) => {
  const ip = clientIp(req), now = Date.now();
  const { username = '', password = '' } = req.body || {};
  const un = String(username).trim().toLowerCase().slice(0, 64);
  const f = failMap.get(ip), g = userFails.get(un);
  if ((f && f.n >= 10 && now - f.t < 300000) || (g && g.n >= 5 && now - g.t < 300000)) {
    await audit(un, 'login-blocked', '', ip);
    return res.status(429).json({ error: 'Túl sok próbálkozás, várj pár percet.' });
  }
  const u = await qGet('SELECT * FROM users WHERE username=?', [un]);
  let ok = false;
  if (u) { try { ok = crypto.timingSafeEqual(Buffer.from(hashPw(String(password), u.salt), 'hex'), Buffer.from(u.hash, 'hex')); } catch (e) {} }
  if (!ok) {
    failMap.set(ip, { n: (f && now - f.t < 300000 ? f.n : 0) + 1, t: now });
    userFails.set(un, { n: (g && now - g.t < 300000 ? g.n : 0) + 1, t: now });
    await audit(un, 'login-fail', '', ip);
    return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó' });
  }
  failMap.delete(ip); userFails.delete(un);
  await qRun('DELETE FROM sessions WHERE expires<?', [now]);
  if (u.role === 'student') {
    const actives = await qAll('SELECT token FROM sessions WHERE user_id=? AND expires>? ORDER BY expires ASC', [u.id, now]);
    if (actives.length >= STUDENT_SESSION_LIMIT) {
      const toDrop = actives.slice(0, actives.length - STUDENT_SESSION_LIMIT + 1);
      await Promise.all(toDrop.map(x => qRun('DELETE FROM sessions WHERE token=?', [x.token])));
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  await qRun('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', [token, u.id, now + SESSION_MS]);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${(COOKIE_SECURE || req.secure) ? '; Secure' : ''}`);
  await audit(un, 'login', '', ip);
  res.json({ ok: true });
}));
app.post('/api/close', ah(async (req, res) => {           // sendBeacon hívja böngészőbezáráskor/elnavigáláskor; nincs válasz-feldolgozás a kliensen
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) {
    const u = await qGet('SELECT u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', [m[1]]);
    await qRun('DELETE FROM sessions WHERE token=?', [m[1]]);
    if (u) await audit(u.username, 'browser-close', '', clientIp(req));
  }
  res.status(204).end();
}));
app.post('/api/logout', auth, ah(async (req, res) => {
  await qRun('DELETE FROM sessions WHERE user_id=?', [req.u.id]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true });
}));

/* ---------- diák ---------- */
async function getAnn() { const r = await qGet("SELECT v FROM settings WHERE k='announce'"); return r ? JSON.parse(r.v) : null; }
async function msgsOf(sql, params) {
  const rows = await qAll(sql, params);
  return rows.map(m => ({ from: m.sender, text: m.text, at: m.at, request_id: m.request_id }));
}
async function helpOf(uid) {
  const hs = await qAll('SELECT id,task,created_at,handled_at FROM help_requests WHERE user_id=? ORDER BY id', [uid]);
  const ms = await msgsOf('SELECT request_id,sender,text,at FROM help_messages WHERE request_id IN (SELECT id FROM help_requests WHERE user_id=?) ORDER BY id', [uid]);
  return hs.map(h => ({ ...h, msgs: ms.filter(m => m.request_id === h.id).map(m => ({ from: m.from, text: m.text, at: m.at })) }));
}
async function allHelp() {
  const hs = await qAll('SELECT id,user_id,task,created_at,handled_at FROM help_requests ORDER BY id DESC LIMIT 300');
  const ms = await qAll('SELECT request_id,sender,text,at FROM help_messages WHERE request_id IN (SELECT id FROM help_requests ORDER BY id DESC LIMIT 300) ORDER BY id');
  return hs.map(h => ({ ...h, msgs: ms.filter(m => m.request_id === h.id).map(m => ({ from: m.sender, text: m.text, at: m.at })) }));
}
async function stateOf(u) {
  const files = await qAll('SELECT id,filename,size,uploaded_at FROM files WHERE user_id=? ORDER BY id DESC', [u.id]);
  const running = u.start_at && !u.end_at;
  const total = await getTotal();
  const tasksAll = await getTasks();
  const puzzle = running && u.solved < total ? await getAssignedPuzzle(u) : null;
  const topologyImg = !!(await getTopology());
  const group = await groupOf(u.id);
  const progress = await qAll('SELECT solved,at FROM progress WHERE user_id=? ORDER BY id', [u.id]);
  const bonusMath = [];
  for (const q of BONUS_MATH) {
    const solvedRow = await qGet('SELECT 1 FROM bonus_math WHERE user_id=? AND qid=?', [u.id, q.id]);
    bonusMath.push({ id: q.id, q: q.q, pts: q.pts, solved: !!solvedRow });
  }
  let bonusEssay = null;
  if (BONUS_ESSAY) {
    const mine = await qGet('SELECT text,submitted_at,score,feedback,graded_at FROM bonus_essay WHERE user_id=?', [u.id]);
    bonusEssay = { q: BONUS_ESSAY.q, maxPts: BONUS_ESSAY.maxPts, mine: mine || null };
  }
  const doneSpins = await qAll('SELECT milestone,prize,at FROM wheel_spins WHERE user_id=? ORDER BY milestone', [u.id]);
  const doneMs = doneSpins.map(x => x.milestone);
  const wheel = { available: WHEEL_MILESTONES.filter(m => u.solved >= m && !doneMs.includes(m)), history: doneSpins };
  const bets = await qAll('SELECT task,stake,win,payout,at FROM bet_log WHERE user_id=? ORDER BY task', [u.id]);
  const hints = await qAll('SELECT task,hint,at FROM hint_buys WHERE user_id=? ORDER BY task', [u.id]);
  const addrBoughtRow = await qGet('SELECT 1 FROM addr_buys WHERE user_id=?', [u.id]);
  const addrForce = await getAddrForce();
  const shotIntervalMs = await getShotMs();
  const help = await helpOf(u.id);
  const ann = await getAnn();
  const shared = u.start_at ? await qAll('SELECT id,filename,size,task,uploaded_at FROM shared_files WHERE task IS NULL OR task<=? ORDER BY id DESC', [u.solved]) : [];
  const adjustments = await qAll('SELECT delta,reason,at FROM point_adj WHERE user_id=? ORDER BY id DESC', [u.id]);
  return {
    user: { username: u.username, name: u.name, role: u.role }, now: Date.now(), durationMs: DUR,
    start: u.start_at, end: u.end_at, solved: u.solved, total, expiredSeen: !!u.expired_seen,
    tasks: tasksAll.slice(0, u.solved),                       // csak a feloldott feladatok mennek ki
    puzzle, topologyImg, group,
    files, announce: ann, note: u.note || null, wrong: u.wrong_count || 0,
    paused: !!u.paused_at, pausedRemaining: u.paused_at ? (u.start_at + DUR - u.paused_at) : null,
    progress,
    bonusMath, bonusEssay, wheel,
    coins: u.coins, betStake: BET_STAKE, hintCost: HINT_COST,
    bets, hints,
    addrBought: !!addrBoughtRow, addrForce, addrPrice: ADDR_PRICE,
    shotIntervalMs,
    help, helpCost: HELP_COST, shotReq: !!u.shot_req, requireShare: REQUIRE_SHARE,
    shared,
    scoreAdj: u.score_adj || 0, adjustments
  };
}
async function fresh(id) { return qGet('SELECT * FROM users WHERE id=?', [id]); }
const student = (req, res, next) => req.u.role === 'student' ? next() : res.status(403).json({ error: 'Csak diákoknak' });
const expired = u => u.start_at && Date.now() > u.start_at + DUR;
const isPaused = u => !!u.paused_at;
const PAUSE_ERR = { error: 'Az órát a tanár szüneteltette. Várj, amíg folytatja.' };

app.get('/api/state', auth, ah(async (req, res) => res.json(await stateOf(req.u))));
app.post('/api/start', auth, student, ah(async (req, res) => {
  if (!req.u.start_at) {
    await qRun('UPDATE users SET start_at=? WHERE id=?', [Date.now(), req.u.id]);
    await qRun('INSERT INTO progress(user_id,solved,at) VALUES(?,?,?)', [req.u.id, 0, Date.now()]);
  }
  res.json(await stateOf(await fresh(req.u.id)));
}));
app.post('/api/puzzle', auth, student, ah(async (req, res) => {
  const u = req.u;
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  const total = await getTotal();
  if (!u.start_at || u.end_at || u.solved >= total) return res.status(400).json({ error: 'Most nincs aktív rejtvény' });
  if (expired(u)) return res.status(403).json({ error: 'Lejárt az idő' });
  const wait = Math.ceil((u.last_wrong + 8000 - Date.now()) / 1000);
  if (wait > 0) return res.status(429).json({ error: 'Várj még', wait });
  const gate = u.solved;
  const a = await qGet('SELECT qid FROM puzzle_assign WHERE user_id=? AND gate=?', [u.id, gate]);
  const qdef = a ? QPOOL.find(x => x.id === a.qid) : null;
  const optionIndex = Math.floor(+((req.body || {}).optionIndex));
  if (qdef && Number.isInteger(optionIndex) && optionIndex === qdef.correct) {
    await qRun('UPDATE users SET solved=solved+1 WHERE id=? AND solved=?', [u.id, u.solved]);
    await qRun('INSERT INTO progress(user_id,solved,at) VALUES(?,?,?)', [u.id, u.solved + 1, Date.now()]);
    return res.json({ ok: true, scare: Math.random() < SCARE_CHANCE });
  }
  await qRun('UPDATE users SET last_wrong=?, wrong_count=wrong_count+1 WHERE id=?', [Date.now(), u.id]);
  res.json({ ok: false, wait: 8 });
}));
app.post('/api/help', auth, student, ah(async (req, res) => {          // segítségkérés egy feladathoz (HELP_COST pontért)
  const u = req.u, task = (req.body || {}).task;
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem kérhetsz segítséget.' });
  if (!Number.isInteger(task) || task < 1 || task > u.solved) return res.status(400).json({ error: 'Ehhez a feladathoz nem kérhetsz segítséget.' });
  if (await qGet('SELECT 1 FROM help_requests WHERE user_id=? AND task=? AND handled_at IS NULL', [u.id, task])) return res.status(409).json({ error: 'Ehhez a feladathoz már van nyitott kérésed.' });
  const last = await qGet('SELECT MAX(created_at) AS t FROM help_requests WHERE user_id=?', [u.id]);
  if (last && last.t && Date.now() - last.t < HELP_COOLDOWN) return res.status(429).json({ error: 'Várj egy kicsit a következő kérés előtt.' });
  await qRun('INSERT INTO help_requests(user_id,task,created_at) VALUES(?,?,?)', [u.id, task, Date.now()]);
  await audit(u.username, 'help', 'feladat ' + task, clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/bonus-math', auth, student, ah(async (req, res) => {
  const u = req.u, qid = String((req.body || {}).qid || '');
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  const qdef = BONUS_MATH.find(x => x.id === qid);
  if (!u.start_at || u.end_at || expired(u) || !qdef) return res.status(400).json({ error: 'Ez most nem elérhető.' });
  if (await qGet('SELECT 1 FROM bonus_math WHERE user_id=? AND qid=?', [u.id, qid])) return res.status(409).json({ error: 'Ezt már megoldottad.' });
  if (sha(norm(String((req.body || {}).answer || ''))) !== qdef.a) return res.status(400).json({ error: 'Nem jó a válasz.' });
  await qRun('INSERT INTO bonus_math(user_id,qid,at) VALUES(?,?,?)', [u.id, qid, Date.now()]);
  await qRun('UPDATE users SET score_adj=score_adj+? WHERE id=?', [qdef.pts, u.id]);
  await qRun('INSERT INTO point_adj(user_id,delta,reason,at) VALUES(?,?,?,?)', [u.id, qdef.pts, 'Bónusz matek megoldva: ' + qdef.id, Date.now()]);
  await audit(u.username, 'bonus-math', qdef.id, clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/bonus-essay', auth, student, ah(async (req, res) => {
  const u = req.u, text = String((req.body || {}).text || '').trim().slice(0, 4000);
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  if (!BONUS_ESSAY) return res.status(400).json({ error: 'Nincs ilyen feladat.' });
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem küldhetsz be szöveget.' });
  if (!text) return res.status(400).json({ error: 'Üres a beküldés.' });
  const ex = await qGet('SELECT graded_at FROM bonus_essay WHERE user_id=?', [u.id]);
  if (ex && ex.graded_at) return res.status(409).json({ error: 'Ezt már kiértékelte a tanár, nem módosítható.' });
  await qRun('INSERT INTO bonus_essay(user_id,text,submitted_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE text=VALUES(text), submitted_at=VALUES(submitted_at)', [u.id, text, Date.now()]);
  await audit(u.username, 'bonus-essay-submit', '', clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/wheel', auth, student, ah(async (req, res) => {
  const u = req.u, ms = Math.floor(+((req.body || {}).milestone));
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem pörgethetsz.' });
  if (!WHEEL_MILESTONES.includes(ms) || u.solved < ms) return res.status(400).json({ error: 'Ehhez még nem jutottál el.' });
  if (await qGet('SELECT 1 FROM wheel_spins WHERE user_id=? AND milestone=?', [u.id, ms])) return res.status(409).json({ error: 'Ezt a pörgetést már elhasználtad.' });
  let r = Math.random() * 100, prize = 0;
  for (const [w, p] of WHEEL_PRIZES) { if (r < w) { prize = p; break; } r -= w; }
  await qRun('INSERT INTO wheel_spins(user_id,milestone,prize,at) VALUES(?,?,?,?)', [u.id, ms, prize, Date.now()]);
  if (prize) {
    await qRun('UPDATE users SET score_adj=score_adj+? WHERE id=?', [prize, u.id]);
    await qRun('INSERT INTO point_adj(user_id,delta,reason,at) VALUES(?,?,?,?)', [u.id, prize, 'Sors Kereke – ' + ms + '. feladat után', Date.now()]);
  }
  await audit(u.username, 'wheel', ms + ':' + prize, clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/bet', auth, student, ah(async (req, res) => {
  const u = req.u, task = Math.floor(+((req.body || {}).task));
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem fogadhatsz.' });
  const total = await getTotal();
  if (!Number.isInteger(task) || task < 1 || task > total || u.solved < task) return res.status(400).json({ error: 'Ehhez a feladathoz még nem fogadhatsz.' });
  if (await qGet('SELECT 1 FROM bet_log WHERE user_id=? AND task=?', [u.id, task])) return res.status(409).json({ error: 'Ennél a feladatnál már fogadtál.' });
  if (u.coins < BET_STAKE) return res.status(400).json({ error: 'Nincs elég érméd a fogadáshoz.' });
  const win = Math.random() < BET_WIN_CHANCE, payout = win ? BET_STAKE * 2 : 0;
  let coins = u.coins - BET_STAKE + payout;
  if (coins > COIN_CAP) coins = COIN_CAP;
  if (coins < 0) coins = 0;
  await qRun('UPDATE users SET coins=? WHERE id=?', [coins, u.id]);
  await qRun('INSERT INTO bet_log(user_id,task,stake,win,payout,at) VALUES(?,?,?,?,?,?)', [u.id, task, BET_STAKE, win ? 1 : 0, payout, Date.now()]);
  await audit(u.username, 'bet', task + ':' + (win ? 'nyert' : 'vesztett'), clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/hint', auth, student, ah(async (req, res) => {
  const u = req.u, task = Math.floor(+((req.body || {}).task)), pool2 = HINTS[String(task)];
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem vehetsz hintet.' });
  if (!pool2 || !pool2.length || u.solved < task) return res.status(400).json({ error: 'Ehhez a feladathoz nincs hint, vagy még nem jutottál el odáig.' });
  if (await qGet('SELECT 1 FROM hint_buys WHERE user_id=? AND task=?', [u.id, task])) return res.status(409).json({ error: 'Ehhez a feladathoz már vettél hintet.' });
  if (u.coins < HINT_COST) return res.status(400).json({ error: 'Nincs elég érméd a hinthez.' });
  const hint = pool2[Math.floor(Math.random() * pool2.length)];
  await qRun('UPDATE users SET coins=coins-? WHERE id=?', [HINT_COST, u.id]);
  await qRun('INSERT INTO hint_buys(user_id,task,hint,at) VALUES(?,?,?,?)', [u.id, task, hint, Date.now()]);
  await audit(u.username, 'hint', 'feladat ' + task, clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/addr-buy', auth, student, ah(async (req, res) => {
  const u = req.u;
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  if (!u.start_at || u.end_at || expired(u)) return res.status(403).json({ error: 'Most nem vásárolhatsz.' });
  if (await getAddrForce()) return res.status(400).json({ error: 'A címzési tábla jelenleg mindenki számára ingyenesen elérhető.' });
  if (await qGet('SELECT 1 FROM addr_buys WHERE user_id=?', [u.id])) return res.status(409).json({ error: 'Már megvetted.' });
  await qRun('INSERT INTO addr_buys(user_id,at) VALUES(?,?)', [u.id, Date.now()]);
  await qRun('UPDATE users SET score_adj=score_adj-? WHERE id=?', [ADDR_PRICE, u.id]);
  await qRun('INSERT INTO point_adj(user_id,delta,reason,at) VALUES(?,?,?,?)', [u.id, -ADDR_PRICE, 'Címzési tábla megvásárolva', Date.now()]);
  await audit(u.username, 'addr-buy', '', clientIp(req));
  res.json(await stateOf(await fresh(u.id)));
}));
app.post('/api/finish', auth, student, ah(async (req, res) => {
  if (isPaused(req.u)) return res.status(423).json(PAUSE_ERR);
  const total = await getTotal();
  if (req.u.start_at && !req.u.end_at && req.u.solved >= total) await qRun('UPDATE users SET end_at=? WHERE id=?', [Date.now(), req.u.id]);
  res.json(await stateOf(await fresh(req.u.id)));
}));
app.post('/api/ack-expired', auth, student, ah(async (req, res) => {
  if (expired(req.u)) await qRun('UPDATE users SET expired_seen=1 WHERE id=?', [req.u.id]);
  res.json({ ok: true });
}));

/* ---------- .pkt feltöltés (adatbázisba, BLOB-ként) ---------- */
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1048576, files: 1 },
  fileFilter: (req, f, cb) => /\.(pkt|pka)$/i.test(f.originalname) ? cb(null, true) : cb(new Error('Csak .pkt vagy .pka fájl tölthető fel.'))
}).single('file');
app.post('/api/upload', auth, student, (req, res) => {
  const u = req.u;
  if (isPaused(u)) return res.status(423).json(PAUSE_ERR);
  if (!u.start_at) return res.status(403).json({ error: 'Előbb indítsd el a játékot.' });
  if (!u.end_at && Date.now() > u.start_at + DUR + GRACE) return res.status(403).json({ error: 'Lejárt az idő, a feltöltés lezárult.' });
  uploader(req, res, async err => {
    try {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `A fájl túl nagy (max ${MAX_MB} MB).` : err.message });
      if (!req.file) return res.status(400).json({ error: 'Nincs kiválasztott fájl.' });
      let name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');       // ékezetes fájlnevek
      name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').slice(0, 150);
      const blob = DATA_KEY ? encBuf(req.file.buffer) : req.file.buffer;
      await qRun('INSERT INTO files(user_id,filename,size,data,uploaded_at,enc) VALUES(?,?,?,?,?,?)', [u.id, name, req.file.size, blob, Date.now(), DATA_KEY ? 1 : 0]);
      await audit(u.username, 'upload', name, clientIp(req));
      const keep = await qAll('SELECT id FROM files WHERE user_id=? ORDER BY id DESC LIMIT ?', [u.id, MAX_FILES]);
      const keepIds = keep.map(x => x.id);
      if (keepIds.length) await qRun(`DELETE FROM files WHERE user_id=? AND id NOT IN (${keepIds.map(() => '?').join(',')})`, [u.id, ...keepIds]);
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Szerverhiba' }); }
  });
});
app.get('/api/files/:id', auth, ah(async (req, res) => {
  const f = await qGet('SELECT * FROM files WHERE id=?', [+req.params.id]);
  if (!f || (f.user_id !== req.u.id && req.u.role !== 'teacher')) return res.status(404).json({ error: 'Nincs ilyen fájl' });
  let buf = Buffer.from(f.data);
  if (f.enc) {
    if (!DATA_KEY) return res.status(500).json({ error: 'A fájl titkosított, de a DATA_KEY nincs beállítva.' });
    try { buf = decBuf(buf); } catch (e) { return res.status(500).json({ error: 'A fájl nem fejthető vissza (rossz DATA_KEY?).' }); }
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.send(buf);
}));

/* ---------- tanári felület ---------- */
app.use('/api/admin', (req, res, next) => {   // minden tanári művelet bekerül a naplóba (jelszavak és szövegek nélkül)
  if (req.method === 'POST') res.on('finish', () => {
    if (res.statusCode < 400 && req.u) { const b = req.body || {}; audit(req.u.username, 'admin:' + req.path.slice(1), JSON.stringify({ id: b.id, minutes: b.minutes, solved: b.solved }), clientIp(req)); }
  });
  next();
});
app.post('/api/admin/note', auth, teacher, ah(async (req, res) => {          // egyéni megjegyzés/feladat egy diáknak
  const t = String((req.body || {}).text || '').trim().slice(0, 1000);
  await qRun("UPDATE users SET note=? WHERE id=? AND `role`='student'", [t || null, +((req.body || {}).id)]);
  res.json({ ok: true });
}));
app.get('/api/admin/audit', auth, teacher, ah(async (req, res) => res.json(await qAll('SELECT at,username AS user,action,detail,ip FROM audit ORDER BY id DESC LIMIT 100'))));
app.get('/api/admin/overview', auth, teacher, ah(async (req, res) => {
  const users = await qAll(`SELECT id,username,name,start_at AS start,end_at AS end,solved,wrong_count AS wrong,last_seen,note,away_count,away_ms,share_on,paused_at,score_adj,
    (SELECT id FROM shots WHERE user_id=users.id ORDER BY id DESC LIMIT 1) AS shot_id,
    (SELECT at FROM shots WHERE user_id=users.id ORDER BY id DESC LIMIT 1) AS shot_at,
    (SELECT MAX(at) FROM progress WHERE user_id=users.id) AS since
    FROM users WHERE \`role\`='student' ORDER BY username`);
  const files = await qAll('SELECT id,user_id,filename,size,uploaded_at,hash FROM files ORDER BY id DESC');
  const dupHash = {}; files.forEach(f => { if (f.hash) (dupHash[f.hash] = dupHash[f.hash] || []).push(f); });
  const dup = {}; Object.values(dupHash).filter(g => g.length > 1).forEach(g => g.forEach(f => { dup[f.id] = g.filter(x => x.id !== f.id).map(x => ({ user_id: x.user_id, filename: x.filename })); }));
  const usersById = Object.fromEntries(users.map(u => [u.id, u]));
  const total = await getTotal(), tasks = await getTasks(), groups = await getGroups(), topo = await getTopology();
  const bonusEssays = BONUS_ESSAY ? await qAll('SELECT user_id,text,submitted_at,score,feedback,graded_at FROM bonus_essay ORDER BY submitted_at DESC') : [];
  const bonusMathSolved = await qAll('SELECT user_id,qid,at FROM bonus_math');
  const wheelSpins = await qAll('SELECT user_id,milestone,prize,at FROM wheel_spins');
  const bets = await qAll('SELECT user_id,task,stake,win,payout,at FROM bet_log');
  const hintBuys = await qAll('SELECT user_id,task,at FROM hint_buys');
  const addrBuys = await qAll('SELECT user_id,at FROM addr_buys');
  const addrForce = await getAddrForce(), shotIntervalMs = await getShotMs();
  const adjustments = await qAll('SELECT user_id,delta,reason,at FROM point_adj ORDER BY id DESC LIMIT 300');
  const helpAll = await allHelp();
  const progress = await qAll('SELECT user_id,solved,at FROM progress ORDER BY id');
  const shared = await qAll('SELECT id,filename,size,task,uploaded_at FROM shared_files ORDER BY id DESC');
  res.json({ now: Date.now(), durationMs: DUR, total, helpCost: HELP_COST, taskTitles: tasks.map(t => t.title),
    groups, topologyImg: !!topo,
    help: helpAll, progress, shared,
    bonusEssays, bonusMathSolved, bonusMathDefs: BONUS_MATH.map(q => ({ id: q.id, pts: q.pts })), essayMaxPts: BONUS_ESSAY ? BONUS_ESSAY.maxPts : 0,
    wheelSpins, bets, hintBuys,
    addrBuys, addrForce, addrPrice: ADDR_PRICE, shotIntervalMs,
    adjustments,
    users: users.map(u => ({ ...u, files: files.filter(f => f.user_id === u.id).map(f => ({ ...f, dupWith: (dup[f.id] || null) ? dup[f.id].map(x => ({ ...x, username: usersById[x.user_id] ? usersById[x.user_id].username : '?' })) : null })) })) });
}));
app.post('/api/admin/users', auth, teacher, ah(async (req, res) => {
  let created = 0; const skipped = [];
  for (const l of String((req.body || {}).text || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const [un, pw, ...nm] = l.split(';').map(s => s.trim());
    const username = (un || '').toLowerCase();
    if (/^[a-z0-9._-]{2,32}$/.test(username) && pw && pw.length >= 4 && await addUser(username, pw, nm.join(';'))) created++; else skipped.push(l.split(';')[0]);
  }
  res.json({ created, skipped });
}));
app.post('/api/admin/reset', auth, teacher, ah(async (req, res) => {
  await qRun("UPDATE users SET start_at=NULL,end_at=NULL,solved=0,expired_seen=0,last_wrong=0,wrong_count=0,away_count=0,away_ms=0,shot_req=0,share_on=0 WHERE id=? AND `role`='student'", [+(req.body || {}).id]);
  await wipeActivity(+(req.body || {}).id);
  res.json({ ok: true });
}));

const uid = req => +((req.body || {}).id);
app.post('/api/admin/time', auth, teacher, ah(async (req, res) => {          // idő hozzáadása/elvétele (percben)
  const m = Math.max(-240, Math.min(240, +(req.body || {}).minutes || 0));
  await qRun("UPDATE users SET start_at=start_at+? WHERE id=? AND `role`='student' AND start_at IS NOT NULL AND end_at IS NULL", [m * 60000, uid(req)]);
  res.json({ ok: true });
}));
app.post('/api/admin/solved', auth, teacher, ah(async (req, res) => {        // feladat átugrása / visszalépés
  const total = await getTotal();
  const s = Math.max(0, Math.min(total, Math.floor(+(req.body || {}).solved || 0)));
  const u = await qGet("SELECT start_at FROM users WHERE id=? AND `role`='student'", [uid(req)]);
  if (!u) return res.status(404).json({ error: 'Nincs ilyen diák.' });
  const startAt = u.start_at || (s > 0 ? Date.now() : null);        // ha még nem indult, az ugrással elindul az órája
  await qRun('UPDATE users SET solved=?, start_at=?, end_at=CASE WHEN ?<? THEN NULL ELSE end_at END WHERE id=?', [s, startAt, s, total, uid(req)]);
  await qRun('INSERT INTO progress(user_id,solved,at) VALUES(?,?,?)', [uid(req), s, Date.now()]);
  res.json({ ok: true });
}));
app.post('/api/admin/password', auth, teacher, ah(async (req, res) => {
  const p = String((req.body || {}).password || '');
  if (p.length < 4) return res.status(400).json({ error: 'A jelszó legalább 4 karakter legyen.' });
  const salt = crypto.randomBytes(16).toString('hex');
  await qRun("UPDATE users SET salt=?, hash=? WHERE id=? AND `role`='student'", [salt, hashPw(p, salt), uid(req)]);
  await qRun('DELETE FROM sessions WHERE user_id=?', [uid(req)]);
  res.json({ ok: true });
}));
app.post('/api/admin/delete', auth, teacher, ah(async (req, res) => {
  await wipeActivity(uid(req));
  await qRun("DELETE FROM files WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [uid(req)]);
  await qRun("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=? AND `role`='student')", [uid(req)]);
  await qRun('DELETE FROM group_members WHERE user_id=?', [uid(req)]);
  await qRun("DELETE FROM users WHERE id=? AND `role`='student'", [uid(req)]);
  res.json({ ok: true });
}));
app.post('/api/admin/pause', auth, teacher, ah(async (req, res) => {
  await qRun("UPDATE users SET paused_at=? WHERE id=? AND `role`='student' AND start_at IS NOT NULL AND end_at IS NULL AND paused_at IS NULL", [Date.now(), +((req.body || {}).id)]);
  res.json({ ok: true });
}));
app.post('/api/admin/resume', auth, teacher, ah(async (req, res) => {
  const id = +((req.body || {}).id), u = await qGet("SELECT paused_at FROM users WHERE id=? AND `role`='student'", [id]);
  if (u && u.paused_at) await qRun('UPDATE users SET start_at=start_at+?, paused_at=NULL WHERE id=?', [Date.now() - u.paused_at, id]);
  res.json({ ok: true });
}));
app.post('/api/admin/pause-all', auth, teacher, ah(async (req, res) => {
  await qRun("UPDATE users SET paused_at=? WHERE `role`='student' AND start_at IS NOT NULL AND end_at IS NULL AND paused_at IS NULL", [Date.now()]);
  res.json({ ok: true });
}));
app.post('/api/admin/resume-all', auth, teacher, ah(async (req, res) => {
  const now = Date.now();
  const rows = await qAll("SELECT id,paused_at FROM users WHERE `role`='student' AND paused_at IS NOT NULL");
  await Promise.all(rows.map(u => qRun('UPDATE users SET start_at=start_at+?, paused_at=NULL WHERE id=?', [now - u.paused_at, u.id])));
  res.json({ ok: true });
}));
app.post('/api/admin/start-all', auth, teacher, ah(async (req, res) => {     // egyszerre indítás mindenkinek
  await qRun("UPDATE users SET start_at=? WHERE `role`='student' AND start_at IS NULL", [Date.now()]);
  res.json({ ok: true });
}));
app.post('/api/admin/announce', auth, teacher, ah(async (req, res) => {      // üzenet a diákoknak
  const t = String((req.body || {}).text || '').trim().slice(0, 300);
  if (t) await qRun('REPLACE INTO settings(k,v) VALUES(?,?)', ['announce', JSON.stringify({ text: t, at: Date.now() })]);
  else await qRun("DELETE FROM settings WHERE k='announce'");
  res.json({ ok: true });
}));
app.post('/api/admin/help-message', auth, teacher, ah(async (req, res) => {   // tanári üzenet a segítség-chatben
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Üres üzenet' });
  const h = await qGet('SELECT id FROM help_requests WHERE id=? AND handled_at IS NULL', [+b.id]);
  if (!h) return res.status(404).json({ error: 'A beszélgetés már le van zárva.' });
  await qRun('INSERT INTO help_messages(request_id,sender,text,at) VALUES(?,?,?,?)', [h.id, 'teacher', text, Date.now()]);
  res.json({ ok: true });
}));
app.post('/api/admin/shot-interval', auth, teacher, ah(async (req, res) => {
  const sec = Math.max(1, Math.min(300, Math.floor(+(req.body || {}).seconds) || 30));
  await qRun("REPLACE INTO settings(k,v) VALUES('shot_interval_ms',?)", [String(sec * 1000)]);
  res.json({ ok: true });
}));
app.post('/api/admin/addr-force', auth, teacher, ah(async (req, res) => {
  await qRun("REPLACE INTO settings(k,v) VALUES('addr_force',?)", [(req.body || {}).on ? '1' : '0']);
  await audit(req.u.username, 'addr-force', (req.body || {}).on ? 'on' : 'off', clientIp(req));
  res.json({ ok: true });
}));

/* ---------- feladatszerkesztő (tanár állítja össze a feladatokat, nem fix content.json) ---------- */
const cleanItems = a => (Array.isArray(a) ? a : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 60);
app.get('/api/admin/tasks', auth, teacher, ah(async (req, res) => res.json(await getTasks())));
app.post('/api/admin/tasks', auth, teacher, ah(async (req, res) => {           // új feladat létrehozása
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'A feladatnak legyen címe.' });
  const pts = String(b.pts || '').trim().slice(0, 60);
  const items = cleanItems(b.items), olt = String(b.olt || '').trim().slice(0, 200), ol = cleanItems(b.ol);
  const note = String(b.note || '').trim().slice(0, 2000);
  const maxOrdRow = await qGet('SELECT COALESCE(MAX(ord),-1) m FROM tasks');
  const r = await qRun('INSERT INTO tasks(ord,title,pts,items,olt,ol,note) VALUES(?,?,?,?,?,?,?)',
    [maxOrdRow.m + 1, title, pts, JSON.stringify(items), olt, JSON.stringify(ol), note]);
  await audit(req.u.username, 'task-add', title, clientIp(req));
  res.json({ ok: true, id: r.insertId });
}));
app.post('/api/admin/tasks/update', auth, teacher, ah(async (req, res) => {
  const b = req.body || {}, id = Math.floor(+b.id);
  if (!(await qGet('SELECT 1 FROM tasks WHERE id=?', [id]))) return res.status(404).json({ error: 'Nincs ilyen feladat.' });
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'A feladatnak legyen címe.' });
  const pts = String(b.pts || '').trim().slice(0, 60);
  const items = cleanItems(b.items), olt = String(b.olt || '').trim().slice(0, 200), ol = cleanItems(b.ol);
  const note = String(b.note || '').trim().slice(0, 2000);
  await qRun('UPDATE tasks SET title=?,pts=?,items=?,olt=?,ol=?,note=? WHERE id=?',
    [title, pts, JSON.stringify(items), olt, JSON.stringify(ol), note, id]);
  await audit(req.u.username, 'task-edit', title, clientIp(req));
  res.json({ ok: true });
}));
app.post('/api/admin/tasks/delete', auth, teacher, ah(async (req, res) => {
  const id = Math.floor(+(req.body || {}).id);
  await qRun('DELETE FROM tasks WHERE id=?', [id]);
  await audit(req.u.username, 'task-delete', String(id), clientIp(req));
  res.json({ ok: true });
}));
app.post('/api/admin/tasks/reorder', auth, teacher, ah(async (req, res) => {     // sorrend mentése (az admin UI fel/le gombjai után)
  const ids = Array.isArray((req.body || {}).order) ? (req.body || {}).order.map(x => Math.floor(+x)) : [];
  const existing = await qAll('SELECT id FROM tasks');
  const valid = new Set(existing.map(x => x.id));
  let i = 0;
  for (const id of ids) { if (valid.has(id)) await qRun('UPDATE tasks SET ord=? WHERE id=?', [i, id]); i++; }
  res.json({ ok: true });
}));

/* ---------- csoportmunka (a tanár osztja be, kivel van egy csapatban) ---------- */
app.get('/api/admin/groups', auth, teacher, ah(async (req, res) => res.json(await getGroups())));
app.post('/api/admin/groups', auth, teacher, ah(async (req, res) => {           // új csoport
  const name = String((req.body || {}).name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Adj nevet a csoportnak.' });
  const r = await qRun('INSERT INTO student_groups(name,created_at) VALUES(?,?)', [name, Date.now()]);
  await audit(req.u.username, 'group-add', name, clientIp(req));
  res.json({ ok: true, id: r.insertId });
}));
app.post('/api/admin/groups/rename', auth, teacher, ah(async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Adj nevet a csoportnak.' });
  await qRun('UPDATE student_groups SET name=? WHERE id=?', [name, Math.floor(+b.id)]);
  res.json({ ok: true });
}));
app.post('/api/admin/groups/delete', auth, teacher, ah(async (req, res) => {
  const id = Math.floor(+(req.body || {}).id);
  await qRun('DELETE FROM group_members WHERE group_id=?', [id]);
  await qRun('DELETE FROM student_groups WHERE id=?', [id]);
  await audit(req.u.username, 'group-delete', String(id), clientIp(req));
  res.json({ ok: true });
}));
app.post('/api/admin/groups/set-members', auth, teacher, ah(async (req, res) => {  // teljes tagság felülírása (egy diák egyszerre csak egy csoportban van)
  const b = req.body || {}, gid = Math.floor(+b.id);
  if (!(await qGet('SELECT 1 FROM student_groups WHERE id=?', [gid]))) return res.status(404).json({ error: 'Nincs ilyen csoport.' });
  const ids = Array.isArray(b.userIds) ? b.userIds.map(x => Math.floor(+x)).filter(Boolean) : [];
  const validRows = await qAll("SELECT id FROM users WHERE `role`='student'");
  const valid = validRows.map(x => x.id);
  const ok = ids.filter(id => valid.includes(id));
  await Promise.all(ok.map(uid2 => qRun('DELETE FROM group_members WHERE user_id=? AND group_id<>?', [uid2, gid])));  // kivétel minden más csoportból
  await qRun('DELETE FROM group_members WHERE group_id=?', [gid]);
  await Promise.all(ok.map(uid2 => qRun('INSERT IGNORE INTO group_members(group_id,user_id) VALUES(?,?)', [gid, uid2])));
  await audit(req.u.username, 'group-members', gid + ':' + ok.length, clientIp(req));
  res.json({ ok: true });
}));

/* ---------- topológia feltöltése (saját térkép a beépített SVG helyett) ---------- */
const topoUp = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 8 * 1048576, files: 1 },
  fileFilter: (req, f, cb) => /\.(png|jpe?g|svg|webp)$/i.test(f.originalname) ? cb(null, true) : cb(new Error('Csak PNG, JPG, WEBP vagy SVG kép tölthető fel.'))
}).single('file');
const TOPO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
app.post('/api/admin/topology', auth, teacher, (req, res) => {
  topoUp(req, res, async err => {
    try {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A kép túl nagy (max 8 MB).' : err.message });
      if (!req.file) return res.status(400).json({ error: 'Nincs kiválasztott kép.' });
      const name = cleanName(req.file.originalname), ext = path.extname(name).toLowerCase();
      const mime = TOPO_MIME[ext] || 'application/octet-stream';
      await qRun('REPLACE INTO topology(id,filename,mime,data,uploaded_at) VALUES(1,?,?,?,?)', [name, mime, req.file.buffer, Date.now()]);
      await audit(req.u.username, 'topology-upload', name, clientIp(req));
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Szerverhiba' }); }
  });
});
app.post('/api/admin/topology-clear', auth, teacher, ah(async (req, res) => {    // visszaállás a beépített, generált térképre
  await qRun('DELETE FROM topology WHERE id=1');
  await audit(req.u.username, 'topology-clear', '', clientIp(req));
  res.json({ ok: true });
}));
app.get('/api/topology/image', auth, ah(async (req, res) => {
  const f = await qGet('SELECT mime,data,uploaded_at FROM topology WHERE id=1');
  if (!f) return res.status(404).json({ error: 'Nincs feltöltött térkép.' });
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(f.data));
}));
app.post('/api/admin/grade-essay', auth, teacher, ah(async (req, res) => {
  const b = req.body || {}, id = Math.floor(+b.id), max = BONUS_ESSAY ? BONUS_ESSAY.maxPts : 100;
  const score = Math.max(0, Math.min(max, Math.floor(+b.score) || 0)), feedback = String(b.feedback || '').trim().slice(0, 1000);
  const row = await qGet('SELECT score FROM bonus_essay WHERE user_id=?', [id]);
  if (!row) return res.status(404).json({ error: 'Nincs beküldött szöveg ettől a diáktól.' });
  if (row.score !== null) await qRun('UPDATE users SET score_adj=score_adj-? WHERE id=?', [row.score, id]);
  await qRun('UPDATE bonus_essay SET score=?, feedback=?, graded_at=? WHERE user_id=?', [score, feedback || null, Date.now(), id]);
  await qRun('UPDATE users SET score_adj=score_adj+? WHERE id=?', [score, id]);
  await audit(req.u.username, 'grade-essay', id + ': ' + score, clientIp(req));
  res.json({ ok: true });
}));
app.post('/api/admin/help-close', auth, teacher, ah(async (req, res) => {        // lezárás: a diák újra kérhet (újabb HELP_COST pontért)
  await qRun('UPDATE help_requests SET handled_at=? WHERE id=? AND handled_at IS NULL', [Date.now(), +((req.body || {}).id)]);
  res.json({ ok: true });
}));
app.get('/api/announce', auth, ah(async (req, res) => res.json((await getAnn()) || {})));

app.post('/api/help/message', auth, student, ah(async (req, res) => {        // diák üzenete a nyitott segítség-chatben
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Üres üzenet' });
  const h = await qGet('SELECT id FROM help_requests WHERE id=? AND user_id=? AND handled_at IS NULL', [+b.id, req.u.id]);
  if (!h) return res.status(404).json({ error: 'Ez a beszélgetés már le van zárva.' });
  const cnt = await qGet('SELECT COUNT(*) AS c FROM help_messages WHERE request_id=?', [h.id]);
  if (cnt.c >= 200) return res.status(429).json({ error: 'Túl sok üzenet ebben a beszélgetésben.' });
  await qRun('INSERT INTO help_messages(request_id,sender,text,at) VALUES(?,?,?,?)', [h.id, 'student', text, Date.now()]);
  res.json(await stateOf(await fresh(req.u.id)));
}));

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
  sharedUp(req, res, async err => {
    try {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `A fájl túl nagy (max ${MAX_MB} MB).` : err.message });
      if (!req.file) return res.status(400).json({ error: 'Nincs kiválasztott fájl.' });
      const total = await getTotal();
      const t = Math.floor(+(req.body || {}).task), task = t >= 1 && t <= total ? t : null;
      const name = cleanName(req.file.originalname), blob = DATA_KEY ? encBuf(req.file.buffer) : req.file.buffer;
      await qRun('INSERT INTO shared_files(filename,size,data,enc,task,uploaded_at) VALUES(?,?,?,?,?,?)', [name, req.file.size, blob, DATA_KEY ? 1 : 0, task, Date.now()]);
      await audit(req.u.username, 'shared-upload', name + (task ? ' (feladat ' + task + ')' : ''), clientIp(req));
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Szerverhiba' }); }
  });
});
app.post('/api/admin/shared-delete', auth, teacher, ah(async (req, res) => {
  await qRun('DELETE FROM shared_files WHERE id=?', [+((req.body || {}).id)]); res.json({ ok: true });
}));
app.get('/api/shared/:id', auth, ah(async (req, res) => {
  const f = await qGet('SELECT * FROM shared_files WHERE id=?', [+req.params.id]);
  if (!f) return res.status(404).json({ error: 'Nincs ilyen fájl' });
  if (req.u.role !== 'teacher' && (!req.u.start_at || (f.task && f.task > req.u.solved))) return res.status(403).json({ error: 'Ez a fájl még nem érhető el.' });
  sendBlob(res, f);
}));

/* ---------- megfigyelés (átlátható, a diák beleegyezésével): oldalelhagyás + képernyőmegosztás ---------- */
app.post('/api/away', auth, student, ah(async (req, res) => {                   // a diák visszatért az oldalra (ms = ennyi ideig volt máshol a lap tudta szerint)
  const ms = Math.floor(+((req.body || {}).ms)), now = Date.now();
  if (req.u.start_at && !req.u.end_at && ms > 0) {
    const capped = Math.min(ms, 3600000);
    await qRun('UPDATE users SET away_count=away_count+1, away_ms=away_ms+? WHERE id=?', [capped, req.u.id]);
    await qRun('INSERT INTO away_log(user_id,start_at,dur) VALUES(?,?,?)', [req.u.id, now - capped, capped]);
    const keep = await qAll('SELECT id FROM away_log WHERE user_id=? ORDER BY id DESC LIMIT 300', [req.u.id]);
    const keepIds = keep.map(x => x.id);
    if (keepIds.length) await qRun(`DELETE FROM away_log WHERE user_id=? AND id NOT IN (${keepIds.map(() => '?').join(',')})`, [req.u.id, ...keepIds]);
  }
  res.json({ ok: true });
}));
app.post('/api/share-state', auth, student, ah(async (req, res) => {
  await qRun('UPDATE users SET share_on=? WHERE id=?', [(req.body || {}).on ? 1 : 0, req.u.id]); res.json({ ok: true });
}));
app.post('/api/shot', auth, student, express.json({ limit: '700kb' }), ah(async (req, res) => {   // a diák böngészője által készített (megosztott képernyő) pillanatkép
  const u = req.u;
  if (!u.start_at || u.end_at) return res.status(403).json({ error: 'Most nem fogadunk képet.' });
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String((req.body || {}).img || ''));
  if (!m) return res.status(400).json({ error: 'Hibás kép' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 500000 || buf[0] !== 0xFF || buf[1] !== 0xD8) return res.status(400).json({ error: 'Hibás kép' });
  const shotMs = await getShotMs();
  const minGap = Math.max(500, shotMs - 1000);   // kis tűréssel a kliens-szerver óraeltérés miatt
  const last = await qGet('SELECT MAX(at) AS t FROM shots WHERE user_id=?', [u.id]);
  if (last && last.t && Date.now() - last.t < minGap) return res.json({ ok: true, skipped: true });
  await qRun('INSERT INTO shots(user_id,at,data,enc) VALUES(?,?,?,?)', [u.id, Date.now(), DATA_KEY ? encBuf(buf) : buf, DATA_KEY ? 1 : 0]);
  const keep = await qAll('SELECT id FROM shots WHERE user_id=? ORDER BY id DESC LIMIT 8', [u.id]);
  const keepIds = keep.map(x => x.id);
  if (keepIds.length) await qRun(`DELETE FROM shots WHERE user_id=? AND id NOT IN (${keepIds.map(() => '?').join(',')})`, [u.id, ...keepIds]);
  await qRun('UPDATE users SET shot_req=0, share_on=1 WHERE id=?', [u.id]);
  res.json({ ok: true });
}));
app.post('/api/admin/shot-request', auth, teacher, ah(async (req, res) => {    // a tanár azonnali képet kér (csak aktív megosztásnál érkezik meg)
  await qRun("UPDATE users SET shot_req=1 WHERE id=? AND `role`='student'", [+((req.body || {}).id)]); res.json({ ok: true });
}));
app.get('/api/admin/shots/:id', auth, teacher, ah(async (req, res) => res.json(await qAll('SELECT id,at FROM shots WHERE user_id=? ORDER BY id DESC', [+req.params.id]))));
app.get('/api/admin/away/:id', auth, teacher, ah(async (req, res) => res.json(await qAll('SELECT start_at,dur FROM away_log WHERE user_id=? ORDER BY id', [+req.params.id]))));
app.post('/api/admin/points', auth, teacher, ah(async (req, res) => {           // nyílt, indoklással járó pontmódosítás (pl. más eszköz/segítség észlelése)
  const b = req.body || {}, id = Math.floor(+b.id), delta = Math.max(-100, Math.min(100, Math.floor(+b.delta) || 0));
  const reason = String(b.reason || '').trim().slice(0, 300);
  if (!delta) return res.status(400).json({ error: 'Adj meg egy nullától eltérő pontértéket.' });
  const u = await qGet("SELECT id FROM users WHERE id=? AND `role`='student'", [id]);
  if (!u) return res.status(404).json({ error: 'Nincs ilyen diák.' });
  await qRun('UPDATE users SET score_adj=score_adj+? WHERE id=?', [delta, id]);
  await qRun('INSERT INTO point_adj(user_id,delta,reason,at) VALUES(?,?,?,?)', [id, delta, reason || null, Date.now()]);
  await audit(req.u.username, 'points', `${delta>0?'+':''}${delta} pont – ${id} – ${reason}`, clientIp(req));
  res.json({ ok: true });
}));
app.get('/api/shot-img/:id', auth, teacher, ah(async (req, res) => {
  const f = await qGet('SELECT data,enc FROM shots WHERE id=?', [+req.params.id]);
  if (!f) return res.status(404).end();
  sendBlob(res, { data: f.data, enc: f.enc, mime: 'image/jpeg' });
}));

app.use((err, req, res, next) => {                                   // hibakezelő: nincs stack trace a kliensnek
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Hibás kérés' });
  console.error(err); res.status(500).json({ error: 'Szerverhiba' });
});

async function main() {
  await initSchema();
  await seedTasksIfEmpty();
  // tanári fiók létrehozása az első indításkor
  if (!(await qGet("SELECT 1 FROM users WHERE `role`='teacher'"))) {
    const u = (process.env.TEACHER_USER || 'tanar').toLowerCase();
    const p = process.env.TEACHER_PASS || crypto.randomBytes(6).toString('hex');
    await addUser(u, p, 'Tanár', 'teacher');
    console.log(`\n=== Tanári fiók létrehozva ===\n  felhasználó: ${u}\n  jelszó:      ${p}\n(Jegyezd fel, ez nem jelenik meg újra.)\n`);
  }
  app.listen(PORT, () => console.log(`Szerver fut: http://localhost:${PORT}`));
}
main().catch(e => { console.error('Indítási hiba (adatbázis-kapcsolat?):', e); process.exit(1); });
