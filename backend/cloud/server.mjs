// server.mjs — maitian-cloud：素材库 API（规格 §4.1）。
// 零第三方依赖（node:http + node:sqlite，Node ≥22.5）；鉴权 = Bearer workspace_key（key 即全部权限，D5 取舍）。
// API：
//   POST /v1/materials                multipart: file + meta(JSON)   -> {id, status:"ready", dedup?}
//   GET  /v1/materials?platform&status&limit -> {items:[{id,title,type,tags,size,created_at,used_on,sha256}]}
//   POST /v1/materials/:id/claim      {device}  -> {ok, holder?, expires_at?}   占用锁 30 分钟（幂等）
//   POST /v1/materials/:id/release    -> {ok}
//   POST /v1/materials/:id/used       {platform, account_id, url?} -> {ok}
//   GET  /v1/materials/:id/download   -> 302 签名 URL（1 天有效）-> /v1/files/:id?exp&sig
//   POST /v1/journal                  {device, action, account_id?, detail, ts} -> {ok}
//   POST /v1/keys/rotate              (旧 key 调用) -> {new_key, old_expires_at}  新旧 7 天双活
//   GET  /v1/knowledge?platform       -> {ok, json, version, updated_at}   知识包热更（回路②）
//   PUT  /v1/knowledge/:platform      {json, base_version} -> {ok, version}  乐观锁；冲突 409
//   GET  /v1/knowledge/versions/:platform -> {ok, versions[]}  云端版本归档列表
//   GET  /v1/ping                     存活探测（免鉴权）
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openStore, ensureKey, keyValid, sha256, saveMaterialFile, ALLOWED_TAGS, PLATFORMS, pruneVersions } from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAITIAN_DATA_DIR || join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const CLAIM_TTL_MIN = 30;
const SIGN_TTL_SEC = 86400; // 签名 URL 1 天

const store = openStore(DATA_DIR);
ensureKey(store.db, process.env.MAITIAN_WORKSPACE_KEY);

function signSecret() {
  if (process.env.MAITIAN_SIGN_SECRET) return process.env.MAITIAN_SIGN_SECRET;
  if (existsSync(store.secretFile)) return readFileSync(store.secretFile, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(store.secretFile, s);
  return s;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limitMB = 500) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMB * 1024 * 1024) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 最小 multipart/form-data 解析（零依赖） */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const delim = Buffer.from(boundary);
  const parts = [];
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const next = buf.indexOf(delim, idx + delim.length);
    if (next === -1) break;
    let part = buf.subarray(idx + delim.length, next);
    if (part[0] === 13 && part[1] === 10) part = part.subarray(2);
    if (part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + 4);
      const nameM = /name="([^"]*)"/.exec(headerText);
      const fileM = /filename="([^"]*)"/.exec(headerText);
      parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : undefined, body });
    }
    idx = next;
  }
  return parts;
}

function findMaterial(id) {
  return store.db.prepare('SELECT * FROM materials WHERE id=?').get(id);
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    // ---- 免鉴权 ----
    if (p === '/v1/ping') return json(res, 200, { ok: true, name: 'maitian-cloud', now: new Date().toISOString() });

    // 签名文件流：免 Bearer（由 HMAC 签名 + 有效期保护；302 的意义就是 key 不下传）
    let mf;
    if ((mf = p.match(/^\/v1\/files\/([^/]+)$/)) && req.method === 'GET') {
      const row = findMaterial(mf[1]);
      const exp = Number(u.searchParams.get('exp') || 0);
      const sig = u.searchParams.get('sig') || '';
      const want = createHmac('sha256', signSecret()).update(`${mf[1]}.${exp}`).digest('hex');
      if (!row || exp < Date.now() || sig !== want) return json(res, 403, { ok: false, error: 'BAD_SIGNATURE_OR_EXPIRED' });
      const yyyyMm = row.created_at.slice(0, 7);
      const materialDir = join(store.materialsDir, yyyyMm, row.id);
      if (!existsSync(materialDir)) return json(res, 404, { ok: false, error: 'file missing on disk' });
      const fname = readdirSync(materialDir)[0];
      const file = join(materialDir, fname);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': statSync(file).size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
      return res.end(readFileSync(file));
    }

    // ---- 鉴权（key 即全部权限）----
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!auth || !keyValid(store.db, auth[1])) {
      return json(res, 401, { ok: false, error: 'UNAUTHORIZED: 无效或过期的 workspace_key' });
    }

    let m;
    if (p === '/v1/materials' && req.method === 'POST') {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers['content-type']);
      if (!parts) return json(res, 400, { ok: false, error: '需要 multipart/form-data（file + meta）' });
      const filePart = parts.find((x) => x.filename !== undefined);
      const metaPart = parts.find((x) => x.name === 'meta');
      if (!filePart || !metaPart) return json(res, 400, { ok: false, error: '缺少 file 或 meta 部分' });
      let meta;
      try { meta = JSON.parse(metaPart.body.toString('utf8')); } catch { return json(res, 400, { ok: false, error: 'meta 不是合法 JSON' }); }
      if (!meta.title || !['video', 'image', 'text'].includes(meta.type)) {
        return json(res, 400, { ok: false, error: 'meta.title 必填，meta.type ∈ video|image|text' });
      }
      const tags = Array.isArray(meta.platform_tags) ? meta.platform_tags : [];
      if (!tags.length || tags.some((t) => !ALLOWED_TAGS.includes(t))) {
        return json(res, 400, { ok: false, error: 'platform_tags ⊆ ' + ALLOWED_TAGS.join(',') + ' 且至少 1 个' });
      }
      const hash = sha256(filePart.body);
      const dup = store.db.prepare('SELECT id FROM materials WHERE sha256=?').get(hash);
      if (dup) return json(res, 200, { id: dup.id, status: 'ready', dedup: true });
      const id = 'm' + randomBytes(6).toString('hex');
      saveMaterialFile(store, id, filePart.filename, filePart.body);
      store.db.prepare(
        `INSERT INTO materials(id, title, type, platform_tags, note, source, size, sha256, status, created_at)
         VALUES(?,?,?,?,?,?,?,?, 'ready', ?)`
      ).run(id, String(meta.title), meta.type, JSON.stringify(tags), meta.note || null, meta.source || null, filePart.body.length, hash, new Date().toISOString());
      return json(res, 200, { id, status: 'ready' });
    }

    if (p === '/v1/materials' && req.method === 'GET') {
      const platform = u.searchParams.get('platform');
      const limit = Math.min(100, Number(u.searchParams.get('limit') || 20));
      let rows = store.db.prepare(`SELECT * FROM materials WHERE status='ready' ORDER BY created_at DESC LIMIT ?`).all(limit);
      if (platform) {
        rows = rows.filter((r) => {
          const tags = JSON.parse(r.platform_tags);
          return tags.includes('common') || tags.includes(platform); // common = 全平台候选
        });
      }
      return json(res, 200, {
        ok: true,
        items: rows.map((r) => ({
          id: r.id, title: r.title, type: r.type, tags: JSON.parse(r.platform_tags),
          size: r.size, sha256: r.sha256, created_at: r.created_at, used_on: JSON.parse(r.used_on || '[]'),
          claimed_by: r.claimed_by, claimed_until: r.claimed_until,
        })),
      });
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/claim$/)) && req.method === 'POST') {
      const row = findMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const device = body.device;
      if (!device) return json(res, 400, { ok: false, error: '缺少 device' });
      const now = Date.now();
      const until = row.claimed_until ? Date.parse(row.claimed_until) : 0;
      if (row.claimed_by && until > now && row.claimed_by !== device) {
        return json(res, 409, { ok: false, holder: row.claimed_by, expires_at: row.claimed_until, error: 'CLAIMED_BY_OTHER' });
      }
      const expires = new Date(now + CLAIM_TTL_MIN * 60000).toISOString();
      store.db.prepare('UPDATE materials SET claimed_by=?, claimed_until=? WHERE id=?').run(device, expires, m[1]);
      return json(res, 200, { ok: true, holder: device, expires_at: expires }); // 幂等：同人重入刷新 TTL
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/release$/)) && req.method === 'POST') {
      await readBody(req);
      store.db.prepare('UPDATE materials SET claimed_by=NULL, claimed_until=NULL WHERE id=?').run(m[1]);
      return json(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/used$/)) && req.method === 'POST') {
      const row = findMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.platform) return json(res, 400, { ok: false, error: '缺少 platform' });
      const usedOn = JSON.parse(row.used_on || '[]');
      usedOn.push({ platform: body.platform, account_id: body.account_id || null, url: body.url || null, ts: new Date().toISOString() });
      store.db.prepare('UPDATE materials SET used_on=? WHERE id=?').run(JSON.stringify(usedOn), m[1]);
      return json(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/v1\/materials\/([^/]+)\/download$/)) && req.method === 'GET') {
      const row = findMaterial(m[1]);
      if (!row) return json(res, 404, { ok: false, error: 'material not found' });
      // 302 → 签名 URL（1 天有效）：签名只覆盖 id+exp，不携带 key；/v1/files 免鉴权
      const exp = Date.now() + SIGN_TTL_SEC * 1000;
      const sig = createHmac('sha256', signSecret()).update(`${row.id}.${exp}`).digest('hex');
      res.writeHead(302, { location: `/v1/files/${row.id}?exp=${exp}&sig=${sig}` });
      return res.end();
    }

    if (p === '/v1/journal' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      store.db.prepare('INSERT INTO journals(device, action, account_id, detail, ts) VALUES(?,?,?,?,?)')
        .run(body.device || null, body.action || null, body.account_id || null, typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || {}), body.ts || new Date().toISOString());
      return json(res, 200, { ok: true });
    }

    // ---- 知识包热更（回路②，EVOLUTION-SPEC §4.2）：GET 拉取 / PUT 上传（乐观锁，冲突 409）----
    if (p === '/v1/knowledge' && req.method === 'GET') {
      const platform = u.searchParams.get('platform');
      if (!platform || !PLATFORMS.includes(platform)) return json(res, 400, { ok: false, error: 'platform 必填且 ∈ ' + PLATFORMS.join(',') });
      const file = join(store.knowledgeDir, platform + '.json');
      if (!existsSync(file)) return json(res, 404, { ok: false, error: 'knowledge_not_found: ' + platform + '（尚未有任何设备推送过）' });
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return json(res, 200, { ok: true, json: j, version: j.version, updated_at: j.updated_at || null });
    }

    if ((m = p.match(/^\/v1\/knowledge\/([a-z]+)$/)) && req.method === 'PUT') {
      const platform = m[1];
      if (!PLATFORMS.includes(platform)) return json(res, 400, { ok: false, error: 'platform ∈ ' + PLATFORMS.join(',') });
      let body;
      try { body = JSON.parse((await readBody(req, 5)).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); }
      const j = body.json;
      if (!j || typeof j !== 'object' || Array.isArray(j) || j.platform !== platform) {
        return json(res, 400, { ok: false, error: 'body.json 必须是知识包对象且 json.platform=' + platform });
      }
      const bv = Number(body.base_version);
      if (!Number.isInteger(bv) || bv < 0) return json(res, 400, { ok: false, error: 'body.base_version 必须是非负整数（乐观锁）' });
      if (j.version !== bv + 1) return json(res, 400, { ok: false, error: `json.version 必须等于 base_version+1（${bv}+1=${bv + 1}）` });
      const file = join(store.knowledgeDir, platform + '.json');
      let cur = null;
      if (existsSync(file)) {
        cur = JSON.parse(readFileSync(file, 'utf8'));
        if (cur.version !== bv) return json(res, 409, { ok: false, error: `VERSION_CONFLICT: 云端当前 v${cur.version}，base_version=${bv}——先 GET 合并再推` });
      }
      mkdirSync(store.knowledgeDir, { recursive: true });
      if (cur) { // 覆盖前归档（保留最近 10 版，§6.2）
        const vdir = join(store.knowledgeDir, 'versions');
        mkdirSync(vdir, { recursive: true });
        writeFileSync(join(vdir, `${platform}-v${cur.version}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(cur, null, 2));
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

    if (p === '/v1/keys/rotate' && req.method === 'POST') {
      const oldHash = sha256(auth[1]);
      const newRow = store.db.prepare('SELECT expires_at FROM keys WHERE key_hash=? AND (expires_at IS NULL OR expires_at>?)').get(oldHash, new Date().toISOString());
      if (!newRow) return json(res, 401, { ok: false, error: '当前 key 已失效，无法轮换' });
      const newKey = 'mtk_' + randomBytes(24).toString('hex');
      const oldExpires = new Date(Date.now() + 7 * 86400000).toISOString(); // 新旧 7 天双活
      store.db.prepare('INSERT INTO keys(key_hash, created_at) VALUES(?,?)').run(sha256(newKey), new Date().toISOString());
      store.db.prepare('UPDATE keys SET expires_at=? WHERE key_hash=?').run(oldExpires, oldHash);
      return json(res, 200, { new_key: newKey, old_expires_at: oldExpires, note: '请通过 MAITIAN_WORKSPACE_KEY 注入各设备；明文 key 不落库不进 git' });
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[maitian-cloud] listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  if (!process.env.MAITIAN_WORKSPACE_KEY) {
    console.warn('[maitian-cloud] 警告：未设置 MAITIAN_WORKSPACE_KEY，所有鉴权请求将 401');
  }
});
