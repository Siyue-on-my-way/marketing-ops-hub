// server.mjs — maitian-cloud：素材库 API + 用户门户（ACCESS-SPEC v1.2，D5 v4）。
// 零第三方依赖（node:http + node:sqlite + node:crypto，Node ≥22.5）。
//
// 门户（浏览器，密码会话，只读 + 管理页）：
//   GET  /                              门户单页（未登录=登录/注册；已登录=素材台/密钥/邀请/成员）
//   POST /webapi/register               {username,password,invite_code?} 注册（invite 空=建 workspace 为 owner；有=加入）
//   POST /webapi/login                  {username,password}
//   GET  /webapi/me                     会话自省（门户刷新恢复登录态）
//   POST /webapi/logout | /webapi/password {old,new}
//   GET  /webapi/materials?q&platform&limit&offset      本租户素材（只读）
//   GET  /webapi/materials/:id/file     302 → /v1/files 签名下载
//   GET/POST /webapi/me/keys, DELETE /webapi/me/keys/:id  我的 API 密钥管理（新建明文仅显示一次）
//   GET/POST /webapi/me/invite          邀请链接（/?invite=code）
//   GET /webapi/members, DELETE /webapi/members/:userId   成员（owner 移除→其密钥全部失效）
//
// CLI 密钥通道（Bearer 设备密钥；密钥继承用户的租户）：
//   /v1/materials(+claim/release/used/download) /v1/journal /v1/knowledge(+versions) /v1/whoami /v1/endpoints /v1/ping
//   兼容：旧共享 workspace_key（keys 表）映射 default 租户，行为不变。
//
// 安全边界（D5 v4）：密码会话只能看与管理；所有写端点（上传/claim/used）只认密钥。
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  openStore, ensureKey, findKey, touchKey, sha256, hashPassword, verifyPassword,
  saveMaterialFile, ALLOWED_TAGS, PLATFORMS, pruneVersions,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAITIAN_DATA_DIR || join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const CLAIM_TTL_MIN = 30;
const SIGN_TTL_SEC = 86400;   // 签名 URL 1 天
const SESSION_TTL_MS = 7 * 86400000;

const store = openStore(DATA_DIR);
ensureKey(store.db, process.env.MAITIAN_WORKSPACE_KEY); // 旧共享 key 兼容（default 租户）

function signSecret() {
  if (process.env.MAITIAN_WEB_SECRET) return process.env.MAITIAN_WEB_SECRET;
  if (process.env.MAITIAN_SIGN_SECRET) return process.env.MAITIAN_SIGN_SECRET;
  if (existsSync(store.secretFile)) return readFileSync(store.secretFile, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(store.secretFile, s);
  return s;
}

function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
function readBody(req, limitMB = 500) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limitMB * 1024 * 1024) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const delim = Buffer.from(boundary);
  const parts = []; let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const next = buf.indexOf(delim, idx + delim.length);
    if (next === -1) break;
    let part = buf.subarray(idx + delim.length, next);
    if (part[0] === 13 && part[1] === 10) part = part.subarray(2);
    if (part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const nameM = /name="([^"]*)"/.exec(headerText);
      const fileM = /filename="([^"]*)"/.exec(headerText);
      parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : undefined, body: part.subarray(headerEnd + 4) });
    }
    idx = next;
  }
  return parts;
}
function findMaterial(id) { return store.db.prepare('SELECT * FROM materials WHERE id=?').get(id); }
const nowIso = () => new Date().toISOString();

// ---- 会话（HMAC 签名 cookie，无状态；logout 用内存黑名单兜底）----
const loggedOut = new Set(); // nonce 黑名单（重启即清，可接受：会话本身 7 天）
function sessionCookie(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', signSecret()).update(body).digest('base64url');
  return `mt_session=${body}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function readSession(req) {
  const m = /(?:^|;\s*)mt_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', signSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now() || loggedOut.has(p.nonce)) return null;
    return p;
  } catch { return null; }
}
function sessionUser(req) {
  const s = readSession(req);
  if (!s) return null;
  const u = store.db.prepare('SELECT * FROM users WHERE id=? AND revoked_at IS NULL').get(s.uid);
  return u || null;
}

// ---- 限流（内存）：每桶 windowMs 内最多 max 次 ----
const buckets = new Map();
function rateLimit(bucketKey, max, windowMs) {
  const nowT = Date.now();
  const b = buckets.get(bucketKey);
  if (!b || b.reset < nowT) { buckets.set(bucketKey, { count: 1, reset: nowT + windowMs }); return true; }
  b.count += 1;
  return b.count <= max;
}

const genId = (p) => p + randomBytes(6).toString('hex');
function createApiKey(db, userId, tenantId, name) {
  const apiKey = 'mtk_' + randomBytes(24).toString('hex');
  const id = genId('k');
  db.prepare('INSERT INTO api_keys(id, user_id, tenant_id, name, key_hash, key_hint, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, userId, tenantId, String(name || '默认密钥').slice(0, 40), sha256(apiKey), apiKey.slice(0, 6) + '…', nowIso());
  return { id, api_key: apiKey };
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString();
  let m;
  try {
    // ---- 免鉴权 ----
    if (p === '/v1/ping') return json(res, 200, { ok: true, name: 'maitian-cloud', now: nowIso() });

    // 门户单页
    if (p === '/' && req.method === 'GET') {
      const html = readFileSync(join(__dirname, 'portal.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      return res.end(html);
    }

    // 签名文件流：免 Bearer（HMAC 签名 + 有效期保护）
    if ((m = p.match(/^\/v1\/files\/([^/]+)$/)) && req.method === 'GET') {
      const row = findMaterial(m[1]);
      const exp = Number(u.searchParams.get('exp') || 0);
      const sig = u.searchParams.get('sig') || '';
      const want = createHmac('sha256', signSecret()).update(`${m[1]}.${exp}`).digest('hex');
      if (!row || exp < Date.now() || sig !== want) return json(res, 403, { ok: false, error: 'BAD_SIGNATURE_OR_EXPIRED' });
      const materialDir = join(store.materialsDir, row.created_at.slice(0, 7), row.id);
      if (!existsSync(materialDir)) return json(res, 404, { ok: false, error: 'file missing on disk' });
      const file = join(materialDir, readdirSync(materialDir)[0]);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(readdirSync(materialDir)[0])}` });
      return res.end(readFileSync(file));
    }

    // ---- Web 门户 API（密码会话；只读 + 管理页，无素材写操作）----
    if (p.startsWith('/webapi/')) {
      // 注册（开放；凭证=邮箱或手机号；密码重复确认由前端+后端双校验；不做邮件/短信验证）
      if (p === '/webapi/register' && req.method === 'POST') {
        if (!rateLimit('reg:' + ip, 10, 60000)) return json(res, 429, { ok: false, error: '注册过于频繁，稍后再试' });
        const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}');
        const account = String(body.account || body.username || '').trim();
        const password = String(body.password || '');
        const password2 = body.password2 != null ? String(body.password2) : password;
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account);
        const isPhone = /^1[3-9]\d{9}$/.test(account);
        if (!isEmail && !isPhone) return json(res, 400, { ok: false, error: '请输入正确的邮箱或手机号' });
        if (password.length < 8) return json(res, 400, { ok: false, error: '密码至少 8 位' });
        if (password !== password2) return json(res, 400, { ok: false, error: '两次输入的密码不一致' });
        if (store.db.prepare('SELECT 1 FROM users WHERE username=?').get(account)) return json(res, 400, { ok: false, error: '该邮箱/手机号已注册' });
        let tenantId, role = 'member';
        const code = body.invite_code ? String(body.invite_code).trim() : '';
        if (code) {
          const inv = store.db.prepare('SELECT * FROM invites WHERE code=?').get(code);
          if (!inv || inv.revoked_at || Date.parse(inv.expires_at) < Date.now() || inv.used_count >= inv.max_uses) {
            return json(res, 400, { ok: false, error: '邀请链接无效或已过期' });
          }
          tenantId = inv.tenant_id;
          store.db.prepare('UPDATE invites SET used_count=used_count+1 WHERE code=?').run(code);
        } else {
          tenantId = genId('t');
          store.db.prepare('INSERT INTO tenants(id, name, owner_user_id, created_at) VALUES(?,?,NULL,?)').run(tenantId, account + ' 的团队', nowIso());
          role = 'owner'; // owner_user_id 在建用户后回填
        }
        const userId = genId('u');
        if (role === 'owner') store.db.prepare('UPDATE tenants SET owner_user_id=? WHERE id=?').run(userId, tenantId);
        store.db.prepare('INSERT INTO users(id, tenant_id, username, password_hash, role, display_name, created_at) VALUES(?,?,?,?,?,?,?)')
          .run(userId, tenantId, account, hashPassword(password), role, account, nowIso());
        const key = createApiKey(store.db, userId, tenantId, '默认密钥');
        const tenant = store.db.prepare('SELECT name FROM tenants WHERE id=?').get(tenantId);
        const session = { uid: userId, tenant: tenantId, exp: Date.now() + SESSION_TTL_MS, nonce: randomBytes(8).toString('hex') };
        return json(res, 200, {
          ok: true, account, username: account, role, tenant_id: tenantId, tenant_name: tenant.name, api_key: key.api_key,
        }, { 'set-cookie': sessionCookie(session) });
      }

      // 登录（凭证=邮箱/手机号；兼容旧字母用户名）
      if (p === '/webapi/login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}');
        const username = String(body.account || body.username || '').trim();
        if (!rateLimit('login:' + ip + ':' + username, 5, 600000)) return json(res, 429, { ok: false, error: '失败次数过多，请 10 分钟后再试' });
        const user = store.db.prepare('SELECT * FROM users WHERE username=? AND revoked_at IS NULL').get(username);
        if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) {
          return json(res, 401, { ok: false, error: '用户名或密码错误' });
        }
        store.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(nowIso(), user.id);
        const tenant = store.db.prepare('SELECT name FROM tenants WHERE id=?').get(user.tenant_id);
        const session = { uid: user.id, tenant: user.tenant_id, exp: Date.now() + SESSION_TTL_MS, nonce: randomBytes(8).toString('hex') };
        return json(res, 200, { ok: true, username: user.username, role: user.role, tenant_id: user.tenant_id, tenant_name: tenant ? tenant.name : '' },
          { 'set-cookie': sessionCookie(session) });
      }

      // 以下 /webapi 需要 cookie 会话
      const wu = sessionUser(req);
      if (!wu) return json(res, 401, { ok: false, error: '未登录或会话已过期' });

      // 会话自省：门户刷新后用它恢复登录态（前端 ME 引导）
      if (p === '/webapi/me' && req.method === 'GET') {
        const tenant = store.db.prepare('SELECT name FROM tenants WHERE id=?').get(wu.tenant_id);
        return json(res, 200, { ok: true, username: wu.username, role: wu.role, tenant_id: wu.tenant_id, tenant_name: tenant ? tenant.name : '' });
      }

      if (p === '/webapi/logout' && req.method === 'POST') {
        const s = readSession(req);
        if (s && s.nonce) loggedOut.add(s.nonce);
        return json(res, 200, { ok: true }, { 'set-cookie': 'mt_session=; Path=/; Max-Age=0' });
      }
      if (p === '/webapi/password' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}');
        if (!verifyPassword(String(body.old || ''), wu.password_hash)) return json(res, 400, { ok: false, error: '旧密码错误' });
        if (String(body.new || '').length < 8) return json(res, 400, { ok: false, error: '新密码至少 8 位' });
        store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(body.new)), wu.id);
        return json(res, 200, { ok: true });
      }
      if (p === '/webapi/materials' && req.method === 'GET') {
        const platform = u.searchParams.get('platform');
        const q = u.searchParams.get('q');
        const limit = Math.min(100, Number(u.searchParams.get('limit') || 50));
        const offset = Math.max(0, Number(u.searchParams.get('offset') || 0));
        let rows = store.db.prepare(`SELECT * FROM materials WHERE status='ready' AND tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(wu.tenant_id, limit, offset);
        if (platform) rows = rows.filter((r) => { const t = JSON.parse(r.platform_tags); return t.includes('common') || t.includes(platform); });
        if (q) rows = rows.filter((r) => r.title.includes(q));
        return json(res, 200, { ok: true, items: rows.map((r) => ({
          id: r.id, title: r.title, type: r.type, tags: JSON.parse(r.platform_tags), size: r.size,
          created_at: r.created_at, used_on: JSON.parse(r.used_on || '[]'), claimed_by: r.claimed_by, claimed_until: r.claimed_until,
        })) });
      }
      if ((m = p.match(/^\/webapi\/materials\/([^/]+)\/file$/)) && req.method === 'GET') {
        const row = findMaterial(m[1]);
        if (!row || row.tenant_id !== wu.tenant_id) return json(res, 404, { ok: false, error: 'material not found' });
        const exp = Date.now() + SIGN_TTL_SEC * 1000;
        const sig = createHmac('sha256', signSecret()).update(`${row.id}.${exp}`).digest('hex');
        res.writeHead(302, { location: `/v1/files/${row.id}?exp=${exp}&sig=${sig}` });
        return res.end();
      }
      if (p === '/webapi/me/keys' && req.method === 'GET') {
        const keys = store.db.prepare('SELECT id, name, key_hint, created_at, last_used_at, expires_at, revoked_at, revoked_reason FROM api_keys WHERE user_id=? ORDER BY created_at').all(wu.id);
        return json(res, 200, { ok: true, keys });
      }
      if (p === '/webapi/me/keys' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}');
        const key = createApiKey(store.db, wu.id, wu.tenant_id, body.name || '未命名密钥');
        const keys = store.db.prepare('SELECT id, name, key_hint, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id=? ORDER BY created_at').all(wu.id);
        return json(res, 200, { ok: true, api_key: key.api_key, keys });
      }
      if ((m = p.match(/^\/webapi\/me\/keys\/([^/]+)$/)) && req.method === 'DELETE') {
        const row = store.db.prepare('SELECT * FROM api_keys WHERE id=? AND user_id=?').get(m[1], wu.id);
        if (!row) return json(res, 404, { ok: false, error: 'key not found' });
        if (row.revoked_at) return json(res, 200, { ok: true });
        const active = store.db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked_at IS NULL').get(wu.id).n;
        if (active <= 1) return json(res, 400, { ok: false, error: '至少保留 1 把有效密钥（可先新建再吊销）' });
        store.db.prepare('UPDATE api_keys SET revoked_at=?, revoked_reason=? WHERE id=?').run(nowIso(), '用户自行吊销', m[1]);
        return json(res, 200, { ok: true });
      }
      if (p === '/webapi/me/invite' && req.method === 'GET') {
        const inv = store.db.prepare(`SELECT * FROM invites WHERE tenant_id=? AND revoked_at IS NULL AND expires_at>? AND used_count<max_uses ORDER BY created_at DESC LIMIT 1`).get(wu.tenant_id, nowIso());
        if (inv) return json(res, 200, { ok: true, invite_code: inv.code, max_uses: inv.max_uses, used_count: inv.used_count, expires_at: inv.expires_at });
        const code = randomBytes(8).toString('hex');
        store.db.prepare('INSERT INTO invites(code, tenant_id, created_by, note, created_at, expires_at, max_uses) VALUES(?,?,?,?,?,?,?)')
          .run(code, wu.tenant_id, wu.id, `由 ${wu.username} 生成`, nowIso(), new Date(Date.now() + 7 * 86400000).toISOString(), 10);
        return json(res, 200, { ok: true, invite_code: code, max_uses: 10, used_count: 0, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() });
      }
      if (p === '/webapi/me/invite' && req.method === 'POST') {
        store.db.prepare('UPDATE invites SET revoked_at=? WHERE tenant_id=? AND revoked_at IS NULL').run(nowIso(), wu.tenant_id);
        const code = randomBytes(8).toString('hex');
        store.db.prepare('INSERT INTO invites(code, tenant_id, created_by, note, created_at, expires_at, max_uses) VALUES(?,?,?,?,?,?,?)')
          .run(code, wu.tenant_id, wu.id, `由 ${wu.username} 重新生成`, nowIso(), new Date(Date.now() + 7 * 86400000).toISOString(), 10);
        return json(res, 200, { ok: true, invite_code: code });
      }
      if (p === '/webapi/members' && req.method === 'GET') {
        const members = store.db.prepare(`SELECT u.id, u.username, u.role, u.created_at,
          (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=u.id AND k.revoked_at IS NULL) AS key_count
          FROM users u WHERE u.tenant_id=? AND u.revoked_at IS NULL ORDER BY u.created_at`).all(wu.tenant_id);
        return json(res, 200, { ok: true, members });
      }
      if ((m = p.match(/^\/webapi\/members\/([^/]+)$/)) && req.method === 'DELETE') {
        if (wu.role !== 'owner') return json(res, 403, { ok: false, error: '仅 workspace 拥有者可移除成员' });
        const target = store.db.prepare('SELECT * FROM users WHERE id=? AND tenant_id=?').get(m[1], wu.tenant_id);
        if (!target) return json(res, 404, { ok: false, error: 'member not found' });
        if (target.id === wu.id) return json(res, 400, { ok: false, error: '不能移除自己' });
        if (target.role === 'owner') return json(res, 400, { ok: false, error: '不能移除拥有者' });
        store.db.prepare('UPDATE users SET revoked_at=? WHERE id=?').run(nowIso(), target.id);
        store.db.prepare('UPDATE api_keys SET revoked_at=?, revoked_reason=? WHERE user_id=? AND revoked_at IS NULL').run(nowIso(), '成员被移除', target.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    // ---- CLI 密钥通道 /v1/*（Bearer 设备密钥；租户=密钥归属）----
    if (p === '/v1/ping') return json(res, 200, { ok: true, name: 'maitian-cloud', now: nowIso() });

    let mk; // 材料 match 复用
    if ((mk = p.match(/^\/v1\/files\/([^/]+)$/)) && req.method === 'GET') { /* 上面已处理，防御性兜底 */ }

    // /v1 鉴权
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const keyInfo = auth ? findKey(store.db, auth[1]) : null;
    if (!keyInfo) return json(res, 401, { ok: false, error: 'UNAUTHORIZED: 无效或已吊销的 API 密钥' });
    touchKey(store.db, keyInfo.id);

    if (p === '/v1/whoami' && req.method === 'GET') {
      const user = keyInfo.user_id ? store.db.prepare('SELECT username, role FROM users WHERE id=?').get(keyInfo.user_id) : null;
      const tenant = store.db.prepare('SELECT name FROM tenants WHERE id=?').get(keyInfo.tenant_id);
      return json(res, 200, { ok: true, tenant_id: keyInfo.tenant_id, tenant_name: tenant ? tenant.name : '', role: keyInfo.kind === 'legacy' ? 'admin' : (user ? user.role : 'member'), user: user ? user.username : 'legacy', key_name: keyInfo.name });
    }

    // 接口发现：CLI 用任意有效密钥查询本服务全部开放端点（自描述目录，随代码同步更新）
    if (p === '/v1/endpoints' && req.method === 'GET') {
      return json(res, 200, {
        ok: true, service: 'maitian-cloud', now: nowIso(),
        channels: {
          cli: {
            auth: 'Authorization: Bearer <api_key>（门户「密钥管理」页新建，或注册时发放的默认密钥）',
            endpoints: [
              { method: 'GET',  path: '/v1/ping',                          desc: '健康检查（免鉴权）' },
              { method: 'GET',  path: '/v1/endpoints',                     desc: '本目录：查询全部开放接口' },
              { method: 'GET',  path: '/v1/whoami',                        desc: '当前密钥归属（租户/角色/密钥名）' },
              { method: 'POST', path: '/v1/materials',                     desc: '上传素材（multipart：file + meta JSON {title,type:video|image|text,platform_tags[],note?,source?}；sha256 去重）' },
              { method: 'GET',  path: '/v1/materials?platform=&limit=',    desc: '素材列表（platform ∈ common,xhs,douyin,tiktok,yt,bili,x,xianyu；含 common）' },
              { method: 'POST', path: '/v1/materials/:id/claim',           desc: '占用锁 {device}（30 分钟自动释放，防两人发同一素材）' },
              { method: 'POST', path: '/v1/materials/:id/release',         desc: '释放占用' },
              { method: 'POST', path: '/v1/materials/:id/used',            desc: '发布成功回写 {platform, account_id?, url?}' },
              { method: 'GET',  path: '/v1/materials/:id/download',        desc: '302 → 签名下载 URL（1 天有效）' },
              { method: 'POST', path: '/v1/journal',                       desc: '跨设备战报 {device, action, account_id?, detail, ts?}' },
              { method: 'GET',  path: '/v1/knowledge?platform=',           desc: '读平台知识包（platform ∈ xhs,douyin,tiktok,yt,bili,x,xianyu）' },
              { method: 'PUT',  path: '/v1/knowledge/:platform',           desc: '热更知识包 {json, base_version}（乐观锁：json.version=base_version+1）' },
              { method: 'GET',  path: '/v1/knowledge/versions/:platform',  desc: '知识包历史版本列表' },
              { method: 'POST', path: '/v1/keys/rotate',                   desc: '旧共享 workspace_key 轮换（仅 legacy key；7 天双活）' },
            ],
          },
          web: {
            auth: 'Cookie mt_session（门户登录/注册后自动携带；HttpOnly，前端无需管理）',
            endpoints: [
              { method: 'POST', path: '/webapi/register',        desc: '注册（account=邮箱/手机号 + password/password2；invite_code? 加入对方 workspace；成功即发默认 API 密钥，明文仅显示一次）' },
              { method: 'POST', path: '/webapi/login',           desc: '登录（下发 7 天会话 cookie）' },
              { method: 'GET',  path: '/webapi/me',              desc: '会话自省（刷新恢复登录态）' },
              { method: 'POST', path: '/webapi/logout',          desc: '退出（作废当前会话）' },
              { method: 'POST', path: '/webapi/password',        desc: '改密 {old, new}' },
              { method: 'GET',  path: '/webapi/materials',       desc: '本租户素材（只读，支持 q/platform/limit/offset）' },
              { method: 'GET',  path: '/webapi/materials/:id/file', desc: '302 → 签名下载' },
              { method: 'GET',  path: '/webapi/me/keys',         desc: '我的 API 密钥列表' },
              { method: 'POST', path: '/webapi/me/keys',         desc: '新建密钥 {name}（明文仅显示一次）' },
              { method: 'DELETE', path: '/webapi/me/keys/:id',   desc: '吊销密钥（至少保留 1 把有效）' },
              { method: 'GET',  path: '/webapi/me/invite',       desc: '获取当前有效邀请链接' },
              { method: 'POST', path: '/webapi/me/invite',       desc: '作废并重新生成邀请链接' },
              { method: 'GET',  path: '/webapi/members',         desc: '成员列表' },
              { method: 'DELETE', path: '/webapi/members/:id',   desc: '移除成员（仅 owner；其密钥全部失效）' },
            ],
          },
        },
      });
    }

    if (p === '/v1/materials' && req.method === 'POST') {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers['content-type']);
      if (!parts) return json(res, 400, { ok: false, error: '需要 multipart/form-data（file + meta）' });
      const filePart = parts.find((x) => x.filename !== undefined);
      const metaPart = parts.find((x) => x.name === 'meta');
      if (!filePart || !metaPart) return json(res, 400, { ok: false, error: '缺少 file 或 meta 部分' });
      let meta;
      try { meta = JSON.parse(metaPart.body.toString('utf8')); } catch { return json(res, 400, { ok: false, error: 'meta 不是合法 JSON' }); }
      if (!meta.title || !['video', 'image', 'text'].includes(meta.type)) return json(res, 400, { ok: false, error: 'meta.title 必填，meta.type ∈ video|image|text' });
      const tags = Array.isArray(meta.platform_tags) ? meta.platform_tags : [];
      if (!tags.length || tags.some((t) => !ALLOWED_TAGS.includes(t))) return json(res, 400, { ok: false, error: 'platform_tags ⊆ ' + ALLOWED_TAGS.join(',') + ' 且至少 1 个' });
      const hash = sha256(filePart.body);
      const dup = store.db.prepare('SELECT id, tenant_id FROM materials WHERE sha256=?').get(hash);
      if (dup && dup.tenant_id === keyInfo.tenant_id) return json(res, 200, { id: dup.id, status: 'ready', dedup: true });
      const id = 'm' + randomBytes(6).toString('hex');
      saveMaterialFile(store, id, filePart.filename, filePart.body);
      store.db.prepare(
        `INSERT INTO materials(id, title, type, platform_tags, note, source, size, sha256, status, created_at, tenant_id)
         VALUES(?,?,?,?,?,?,?,?, 'ready', ?, ?)`
      ).run(id, String(meta.title), meta.type, JSON.stringify(tags), meta.note || null, meta.source || null, filePart.body.length, hash, nowIso(), keyInfo.tenant_id);
      return json(res, 200, { id, status: 'ready' });
    }

    if (p === '/v1/materials' && req.method === 'GET') {
      const platform = u.searchParams.get('platform');
      const limit = Math.min(100, Number(u.searchParams.get('limit') || 20));
      let rows = store.db.prepare(`SELECT * FROM materials WHERE status='ready' AND tenant_id=? ORDER BY created_at DESC LIMIT ?`).all(keyInfo.tenant_id, limit);
      if (platform) rows = rows.filter((r) => { const tags = JSON.parse(r.platform_tags); return tags.includes('common') || tags.includes(platform); });
      return json(res, 200, { ok: true, items: rows.map((r) => ({
        id: r.id, title: r.title, type: r.type, tags: JSON.parse(r.platform_tags), size: r.size, sha256: r.sha256,
        created_at: r.created_at, used_on: JSON.parse(r.used_on || '[]'), claimed_by: r.claimed_by, claimed_until: r.claimed_until,
      })) });
    }

    // 租户归属校验的材料查找
    const findOwnMaterial = (id) => { const r = findMaterial(id); return (r && r.tenant_id === keyInfo.tenant_id) ? r : null; };

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/claim$/)) && req.method === 'POST') {
      const row = findOwnMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.device) return json(res, 400, { ok: false, error: '缺少 device' });
      const until = row.claimed_until ? Date.parse(row.claimed_until) : 0;
      if (row.claimed_by && until > Date.now() && row.claimed_by !== body.device) {
        return json(res, 409, { ok: false, holder: row.claimed_by, expires_at: row.claimed_until, error: 'CLAIMED_BY_OTHER' });
      }
      const expires = new Date(Date.now() + CLAIM_TTL_MIN * 60000).toISOString();
      store.db.prepare('UPDATE materials SET claimed_by=?, claimed_until=? WHERE id=?').run(body.device, expires, m[1]);
      return json(res, 200, { ok: true, holder: body.device, expires_at: expires });
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/release$/)) && req.method === 'POST') {
      await readBody(req);
      const row = findOwnMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      store.db.prepare('UPDATE materials SET claimed_by=NULL, claimed_until=NULL WHERE id=?').run(m[1]);
      return json(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/used$/)) && req.method === 'POST') {
      const row = findOwnMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.platform) return json(res, 400, { ok: false, error: '缺少 platform' });
      const usedOn = JSON.parse(row.used_on || '[]');
      usedOn.push({ platform: body.platform, account_id: body.account_id || null, url: body.url || null, ts: nowIso() });
      store.db.prepare('UPDATE materials SET used_on=? WHERE id=?').run(JSON.stringify(usedOn), m[1]);
      return json(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/download$/)) && req.method === 'GET') {
      const row = findOwnMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      const exp = Date.now() + SIGN_TTL_SEC * 1000;
      const sig = createHmac('sha256', signSecret()).update(`${row.id}.${exp}`).digest('hex');
      res.writeHead(302, { location: `/v1/files/${row.id}?exp=${exp}&sig=${sig}` });
      return res.end();
    }

    if (p === '/v1/journal' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      store.db.prepare('INSERT INTO journals(device, action, account_id, detail, ts, tenant_id) VALUES(?,?,?,?,?,?)')
        .run(body.device || null, body.action || null, body.account_id || null, typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || {}), body.ts || nowIso(), keyInfo.tenant_id);
      return json(res, 200, { ok: true });
    }

    // ---- 知识包热更（回路②；平台级全局共享，任何有效密钥可读写）----
    if (p === '/v1/knowledge' && req.method === 'GET') {
      const platform = u.searchParams.get('platform');
      if (!platform || !PLATFORMS.includes(platform)) return json(res, 400, { ok: false, error: 'platform 必填且 ∈ ' + PLATFORMS.join(',') });
      const file = join(store.knowledgeDir, platform + '.json');
      if (!existsSync(file)) return json(res, 404, { ok: false, error: 'knowledge_not_found: ' + platform });
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return json(res, 200, { ok: true, json: j, version: j.version, updated_at: j.updated_at || null });
    }
    if ((m = p.match(/^\/v1\/knowledge\/([a-z]+)$/)) && req.method === 'PUT') {
      const platform = m[1];
      if (!PLATFORMS.includes(platform)) return json(res, 400, { ok: false, error: 'platform ∈ ' + PLATFORMS.join(',') });
      let body;
      try { body = JSON.parse((await readBody(req, 5)).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); }
      const j = body.json;
      if (!j || typeof j !== 'object' || Array.isArray(j) || j.platform !== platform) return json(res, 400, { ok: false, error: 'body.json 必须是知识包对象且 json.platform=' + platform });
      const bv = Number(body.base_version);
      if (!Number.isInteger(bv) || bv < 0) return json(res, 400, { ok: false, error: 'body.base_version 必须是非负整数（乐观锁）' });
      if (j.version !== bv + 1) return json(res, 400, { ok: false, error: `json.version 必须等于 base_version+1（${bv}+1=${bv + 1}）` });
      const file = join(store.knowledgeDir, platform + '.json');
      let cur = null;
      if (existsSync(file)) {
        cur = JSON.parse(readFileSync(file, 'utf8'));
        if (cur.version !== bv) return json(res, 409, { ok: false, error: `VERSION_CONFLICT: 云端当前 v${cur.version}，base_version=${bv}` });
      }
      mkdirSync(store.knowledgeDir, { recursive: true });
      if (cur) {
        const vdir = join(store.knowledgeDir, 'versions');
        mkdirSync(vdir, { recursive: true });
        writeFileSync(join(vdir, `${platform}-v${cur.version}-${nowIso().replace(/[:.]/g, '-')}.json`), JSON.stringify(cur, null, 2));
        pruneVersions(vdir);
      }
      writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
      return json(res, 200, { ok: true, version: j.version });
    }
    if ((m = p.match(/^\/v1\/knowledge\/versions\/([a-z]+)$/)) && req.method === 'GET') {
      const platform = m[1];
      if (!PLATFORMS.includes(platform)) return json(res, 400, { ok: false, error: 'platform ∈ ' + PLATFORMS.join(',') });
      const vdir = join(store.knowledgeDir, 'versions');
      const versions = existsSync(vdir) ? readdirSync(vdir).filter((f) => f.startsWith(platform + '-v') && f.endsWith('.json')).sort() : [];
      return json(res, 200, { ok: true, platform, versions });
    }

    if (p === '/v1/keys/rotate' && req.method === 'POST' && keyInfo.kind === 'legacy') {
      const oldHash = sha256(auth[1]);
      const newKey = 'mtk_' + randomBytes(24).toString('hex');
      const oldExpires = new Date(Date.now() + 7 * 86400000).toISOString();
      store.db.prepare('INSERT INTO keys(key_hash, created_at) VALUES(?,?)').run(sha256(newKey), nowIso());
      store.db.prepare('UPDATE keys SET expires_at=? WHERE key_hash=?').run(oldExpires, oldHash);
      return json(res, 200, { new_key: newKey, old_expires_at: oldExpires, note: '旧共享 key 轮换（7 天双活）' });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[maitian-cloud] listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  if (!process.env.MAITIAN_WORKSPACE_KEY) console.warn('[maitian-cloud] 提示：未设置 MAITIAN_WORKSPACE_KEY（旧共享 key 兼容入口关闭；用户走门户注册获取 API key）');
});
