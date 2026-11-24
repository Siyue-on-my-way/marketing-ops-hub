// cloud-client.mjs — maitian-cloud 客户端（规格 §4.1 / §7.6）：
//   超时 10s → 退避重试 3 次（1s/2s/4s）→ 降级（素材列表用本地 materials_cache；
//   journal/used 回写进本地 outbox，daemon 定期补传）。
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hostname } from 'node:os';
import { kvGet, kvSet } from './db.mjs';
import { nowIso } from './util.mjs';

const TIMEOUT_MS = 10000;
const RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

export function deviceId(db) {
  let id = kvGet(db, 'device_id');
  if (!id) {
    id = process.env.MAITIAN_DEVICE || hostname() || 'device-' + randomUUID().slice(0, 8);
    kvSet(db, 'device_id', id);
  }
  return id;
}

export function cloudHeaders(key) {
  const h = { 'content-type': 'application/json' };
  if (key) h.authorization = 'Bearer ' + key;
  return h;
}

async function once(cfg, method, path, body, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(cfg.cloud.base_url.replace(/\/$/, '') + path, {
      method,
      headers: cloudHeaders(key),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, json, networkError: false };
  } finally {
    clearTimeout(t);
  }
}

/** 带退避重试的请求；最终失败返回 {ok:false, error, degraded:true}，不抛异常 */
export async function api(cfg, key, method, path, body) {
  if (!cfg.cloud.base_url) return { ok: false, error: 'CLOUD_NOT_CONFIGURED', degraded: true };
  let lastErr = '';
  for (let i = 0; i <= RETRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS[i - 1]));
    try {
      const r = await once(cfg, method, path, body, key);
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, ...r.json };
      if (r.status >= 500) { lastErr = 'HTTP_' + r.status; continue; } // 5xx 重试
      return { ok: false, status: r.status, error: (r.json && (r.json.error || r.json.raw)) || ('HTTP_' + r.status) };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastErr, degraded: true };
}

// ---------- 素材 ----------

export async function listMaterials(db, cfg, key, platform, limit = 20) {
  const r = await api(cfg, key, 'GET', `/v1/materials?platform=${encodeURIComponent(platform)}&status=ready&limit=${limit}`);
  if (r.ok) {
    for (const it of r.items || []) {
      db.prepare('INSERT OR REPLACE INTO materials_cache(cloud_id, local_path, sha256, meta, cached_at) VALUES(?,?,?,?,?)')
        .run(it.id, '', it.sha256 || '', JSON.stringify(it), nowIso());
    }
    return r;
  }
  if (r.degraded) {
    // 降级：本地缓存继续
    const rows = db.prepare('SELECT * FROM materials_cache ORDER BY cached_at DESC LIMIT ?').all(limit);
    return {
      ok: true, degraded: true,
      items: rows.map((row) => { const m = JSON.parse(row.meta || '{}'); return { ...m, id: m.id || row.cloud_id, cached: true }; }),
      warning: '云不可达，使用本地素材缓存: ' + r.error,
    };
  }
  return r;
}

export async function claimMaterial(cfg, key, db, materialId) {
  const r = await api(cfg, key, 'POST', `/v1/materials/${materialId}/claim`, { device: deviceId(db) });
  return r; // {ok, holder?, expires_at?} 409 时 ok:false
}

export async function releaseMaterial(cfg, key, db, materialId) {
  return api(cfg, key, 'POST', `/v1/materials/${materialId}/release`, {});
}

/** 发布成功回写；云不可达 → outbox 补传 */
export async function markUsed(db, cfg, key, materialId, { platform, account_id, url }) {
  const r = await api(cfg, key, 'POST', `/v1/materials/${materialId}/used`, { platform, account_id, url });
  if (!r.ok) {
    db.prepare('INSERT INTO journal_outbox(payload, created_at) VALUES(?,?)')
      .run(JSON.stringify({ kind: 'material_used', material_id: materialId, platform, account_id, url }), nowIso());
  }
  return r;
}

export async function journal(db, cfg, key, { action, account_id, detail }) {
  const payload = { device: deviceId(db), action, account_id: account_id || null, detail, ts: nowIso() };
  const r = await api(cfg, key, 'POST', '/v1/journal', payload);
  if (!r.ok && r.degraded) {
    db.prepare('INSERT INTO journal_outbox(payload, created_at) VALUES(?,?)').run(JSON.stringify(payload), nowIso());
  }
  return r;
}

/** outbox 补传（daemon 周期调用） */
export async function flushOutbox(db, cfg, key) {
  if (!cfg.cloud.base_url) return { flushed: 0, skipped: 'CLOUD_NOT_CONFIGURED' };
  const rows = db.prepare('SELECT * FROM journal_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 50').all();
  let flushed = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    let r;
    if (payload.kind === 'material_used') {
      r = await api(cfg, key, 'POST', `/v1/materials/${payload.material_id}/used`, {
        platform: payload.platform, account_id: payload.account_id, url: payload.url,
      });
    } else {
      r = await api(cfg, key, 'POST', '/v1/journal', payload);
    }
    if (r.ok || (r.status && r.status < 500)) { // 4xx 语义错误不再重试，标记已处理避免死循环
      db.prepare('UPDATE journal_outbox SET sent_at=? WHERE id=?').run(nowIso(), row.id);
      flushed++;
    }
  }
  return { flushed };
}

// ---------- 知识包热更（回路②，EVOLUTION-SPEC §4.2） ----------

/** GET /v1/knowledge?platform → {ok, json, version, updated_at}；404=云端尚无 */
export async function getKnowledge(cfg, key, platform) {
  return api(cfg, key, 'GET', `/v1/knowledge?platform=${encodeURIComponent(platform)}`);
}

/** PUT /v1/knowledge/:platform {json, base_version} 乐观锁；409=VERSION_CONFLICT */
export async function putKnowledge(cfg, key, platform, json, baseVersion) {
  return api(cfg, key, 'PUT', `/v1/knowledge/${encodeURIComponent(platform)}`, { json, base_version: baseVersion });
}

/** 下载素材到本地缓存并登记 materials_cache；返回本地路径 */
export async function downloadMaterial(db, cfg, key, materialId) {
  const cached = db.prepare('SELECT local_path FROM materials_cache WHERE cloud_id=?').get(materialId);
  if (cached && cached.local_path) {
    try { statSync(cached.local_path); return { ok: true, path: cached.local_path, cached: true }; } catch { /* 文件丢了重新下 */ }
  }
  if (!cfg.cloud.base_url) return { ok: false, error: 'CLOUD_NOT_CONFIGURED' };
  // 302 签名 URL：fetch 默认跟随重定向，直接拿文件流
  const dir = join(cfg.paths.cache, 'materials', materialId);
  mkdirSync(dir, { recursive: true });
  const res = await fetch(cfg.cloud.base_url.replace(/\/$/, '') + `/v1/materials/${materialId}/download`, {
    headers: cloudHeaders(key), redirect: 'follow',
  });
  if (!res.ok) return { ok: false, error: 'DOWNLOAD_HTTP_' + res.status };
  const disp = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
  const name = m ? decodeURIComponent(m[1]) : (materialId + '.bin');
  const file = join(dir, basename(name));
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  db.prepare('INSERT OR REPLACE INTO materials_cache(cloud_id, local_path, sha256, meta, cached_at) VALUES(?,?,?,?,?)')
    .run(materialId, file, sha256, '{}', nowIso());
  return { ok: true, path: file, sha256 };
}
