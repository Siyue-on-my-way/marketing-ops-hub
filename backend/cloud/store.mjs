// store.mjs — maitian-cloud 存储：SQLite 元数据 + 文件落盘 data/materials/<yyyy-mm>/<id>/
// 访问体系（ACCESS-SPEC v1.2）：tenants/users/api_keys/invites 四表 + scrypt 密码 + 租户迁移。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DDL = `
CREATE TABLE IF NOT EXISTS materials(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,                 -- video|image|text
  platform_tags TEXT NOT NULL,        -- JSON array
  note TEXT, source TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT UNIQUE NOT NULL,        -- sha256 去重（同文件返回既有 id）
  status TEXT DEFAULT 'ready',
  created_at TEXT NOT NULL,
  used_on TEXT DEFAULT '[]',          -- JSON array [{platform, account_id, url, ts}]
  claimed_by TEXT, claimed_until TEXT
);
CREATE TABLE IF NOT EXISTS journals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT, action TEXT, account_id TEXT, detail TEXT, ts TEXT
);
CREATE TABLE IF NOT EXISTS keys(
  key_hash TEXT PRIMARY KEY,          -- 旧版共享 workspace_key（兼容期保留，映射 default 租户）
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY,                -- 'default' 或 't'+8hex
  name TEXT NOT NULL,
  owner_user_id TEXT,                 -- 注册创建者 = owner（legacy 租户为 NULL）
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,                -- 'u'+8hex
  tenant_id TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,      -- 3-32 字符
  password_hash TEXT NOT NULL,        -- scrypt: salt$hash
  role TEXT NOT NULL DEFAULT 'member',-- owner|member
  display_name TEXT, created_at TEXT NOT NULL,
  last_login_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys(
  id TEXT PRIMARY KEY,                -- 'k'+8hex
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,                 -- '默认密钥' 等
  key_hash TEXT UNIQUE NOT NULL,
  key_hint TEXT,                      -- 明文前 6 位+'…'，列表展示
  created_at TEXT NOT NULL, last_used_at TEXT,
  expires_at TEXT, revoked_at TEXT, revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,              -- 门户邀请链接用 code
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_count INTEGER DEFAULT 0, max_uses INTEGER DEFAULT 1,
  revoked_at TEXT
);
`;

export const ALLOWED_TAGS = ['common', 'xhs', 'douyin', 'tiktok', 'yt', 'bili', 'x', 'xianyu'];
export const PLATFORMS = ALLOWED_TAGS.filter((t) => t !== 'common'); // 知识包/策略热更只认七平台

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- 密码（零依赖 scrypt；ACCESS-SPEC v1.2 §3.2）----
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}$${scryptSync(String(password), salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, h] = String(stored || '').split('$');
  if (!salt || !h) return false;
  const calc = scryptSync(String(password), salt, 64);
  const expect = Buffer.from(h, 'hex');
  return calc.length === expect.length && timingSafeEqual(calc, expect);
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'cloud.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);
  // 轻量迁移：既有 materials/journals 归入 default 租户
  const ensureCol = (table, col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  };
  ensureCol('materials', 'tenant_id');
  ensureCol('journals', 'tenant_id');
  ensureCol('api_keys', 'key_enc');   // 密钥密文（AES-256-GCM；支持门户「复制/回显」）
  db.prepare(`INSERT OR IGNORE INTO tenants(id, name, owner_user_id, created_at) VALUES('default', '默认团队', NULL, ?)`)
    .run(new Date().toISOString());
  db.prepare(`UPDATE materials SET tenant_id='default' WHERE tenant_id IS NULL`).run();
  db.prepare(`UPDATE journals SET tenant_id='default' WHERE tenant_id IS NULL`).run();
  return {
    db,
    materialsDir: join(dataDir, 'materials'),
    knowledgeDir: join(dataDir, 'knowledge'),          // 回路②：知识包热更分发（versions/ 同级归档）
    secretFile: join(dataDir, '.sign_secret'),
    keySecretFile: join(dataDir, '.key_enc_secret'),   // 密钥回显加密密钥（与签名密钥分离）
  };
}

export function ensureKey(db, workspaceKey) {
  if (!workspaceKey) return;
  db.prepare('INSERT OR IGNORE INTO keys(key_hash, created_at) VALUES(?,?)')
    .run(sha256(workspaceKey), new Date().toISOString());
}

/**
 * /v1 密钥解析（ACCESS-SPEC v1.2 §3.2）：先查用户 api_keys（未吊销未过期），
 * 再回退旧版共享 keys 表（映射 default 租户 admin，兼容期保留）。
 */
export function findKey(db, key) {
  if (!key) return null;
  const hash = sha256(key);
  const now = new Date().toISOString();
  const row = db.prepare(
    `SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`
  ).get(hash, now);
  if (row) return { kind: 'user', id: row.id, user_id: row.user_id, tenant_id: row.tenant_id, name: row.name };
  const legacy = db.prepare(`SELECT expires_at FROM keys WHERE key_hash=?`).get(hash);
  if (legacy && (!legacy.expires_at || Date.parse(legacy.expires_at) > Date.now())) {
    return { kind: 'legacy', id: null, user_id: null, tenant_id: 'default', name: 'legacy-workspace-key' };
  }
  return null;
}

export function touchKey(db, id) {
  if (id) db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(new Date().toISOString(), id);
}

export function saveMaterialFile(store, id, filename, buf) {
  const yyyyMm = new Date().toISOString().slice(0, 7);
  const dir = join(store.materialsDir, yyyyMm, id);
  mkdirSync(dir, { recursive: true });
  const safe = String(filename || 'file.bin').replace(/[\\/\x00-\x1f]/g, '_');
  const file = join(dir, safe);
  writeFileSync(file, buf);
  return file;
}

/** 版本归档清理：只保留最近 keep 版（hub 侧同规则，EVOLUTION-SPEC §6.2） */
export function pruneVersions(dir, keep = 10) {
  try {
    const old = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - keep))) {
      try { rmSync(join(dir, f)); } catch { /* 单个清理失败不阻塞 */ }
    }
  } catch { /* 目录不存在等 */ }
}
