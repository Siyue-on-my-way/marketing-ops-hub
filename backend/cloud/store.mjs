// store.mjs — maitian-cloud 存储：SQLite 元数据 + 文件落盘 data/materials/<yyyy-mm>/<id>/
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
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
  key_hash TEXT PRIMARY KEY,          -- sha256(key)，明文 key 不落库
  created_at TEXT NOT NULL,
  expires_at TEXT                     -- NULL=长期；轮换后旧 key 7 天双活
);
`;

export const ALLOWED_TAGS = ['common', 'xhs', 'douyin', 'tiktok', 'yt', 'bili', 'x', 'xianyu'];
export const PLATFORMS = ALLOWED_TAGS.filter((t) => t !== 'common'); // 知识包/策略热更只认七平台

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'cloud.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);
  return {
    db,
    materialsDir: join(dataDir, 'materials'),
    knowledgeDir: join(dataDir, 'knowledge'),          // 回路②：知识包热更分发（versions/ 同级归档）
    secretFile: join(dataDir, '.sign_secret'),
  };
}

export function ensureKey(db, workspaceKey) {
  if (!workspaceKey) return;
  db.prepare('INSERT OR IGNORE INTO keys(key_hash, created_at) VALUES(?,?)')
    .run(sha256(workspaceKey), new Date().toISOString());
}

export function keyValid(db, key) {
  if (!key) return false;
  const row = db.prepare('SELECT expires_at FROM keys WHERE key_hash=?').get(sha256(key));
  if (!row) return false;
  if (!row.expires_at) return true;
  return Date.parse(row.expires_at) > Date.now();
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
