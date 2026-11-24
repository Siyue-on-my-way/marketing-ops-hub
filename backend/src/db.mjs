// db.mjs — SQLite 打开与 DDL（规格 §4.2 原文 DDL + 运行必需的少量附加表）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DDL = `
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,            -- xhs/douyin/tiktok/yt/bili/x/xianyu
  display_name TEXT NOT NULL,
  ego_space_id TEXT UNIQUE NOT NULL, -- 长期 task space
  owner_device TEXT,
  status TEXT DEFAULT 'cold',        -- cold(冷启动)/active/paused/banned_watch
  daily_quota TEXT NOT NULL,         -- JSON {post,like,comment,dm}
  trust_score REAL DEFAULT 0.5,
  risk_events INT DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS materials_cache(       -- 云素材本地缓存登记（云不可达时降级用）
  cloud_id TEXT PRIMARY KEY, local_path TEXT, sha256 TEXT, meta TEXT, cached_at TEXT
);
CREATE TABLE IF NOT EXISTS posts(
  id TEXT PRIMARY KEY,
  material_cloud_id TEXT, account_id TEXT REFERENCES accounts(id),
  platform TEXT,
  adapted_payload TEXT NOT NULL,     -- JSON {title, text, tags[], cover_path?, local_media_path}
  status TEXT NOT NULL DEFAULT 'planned',
  -- planned→filling→filled(待人审)→published→confirmed / failed / skipped(no_login|quota|risk)
  scheduled_at TEXT, filled_at TEXT, published_at TEXT,
  published_url TEXT, shot_filled TEXT, shot_published TEXT, error TEXT,
  UNIQUE(material_cloud_id, account_id, platform)   -- 红线 6 防重
);
CREATE TABLE IF NOT EXISTS engagements(
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  kind TEXT NOT NULL,                -- like/comment/follow/topic_reply/friend_dm
  target TEXT NOT NULL,              -- 目标链接/用户 id/话题页
  draft TEXT NOT NULL,               -- AI 草拟内容（点赞类为空）
  status TEXT DEFAULT 'drafted',     -- drafted→approved→executed / rejected / skipped(risk)
  approved_at TEXT, executed_at TEXT, shot TEXT, error TEXT,
  created_at TEXT,                   -- 附加列（规格 DDL 之外）：approve batch:today 需要
  UNIQUE(account_id, kind, target)   -- 同账号同目标去重（私聊每会话 1 条上限由此强制）
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, account_id TEXT,
  action TEXT, url TEXT, detail TEXT, shot TEXT
);
CREATE TABLE IF NOT EXISTS metrics(               -- 发布后采集（复盘用）
  post_id TEXT REFERENCES posts(id), day INT,     -- 发布后第 N 天
  views INT, likes INT, comments INT, shares INT, followers_delta INT,
  collected_at TEXT, PRIMARY KEY(post_id, day)
);
-- 以下为运行必需的附加表（规格 §7.6 云降级/补传 与 §4.2 kv 状态恢复）
CREATE TABLE IF NOT EXISTS kv(                    -- 状态机断点/登录态缓存等
  k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS journal_outbox(        -- 云不可达时 journal 本地缓存补传
  id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT, sent_at TEXT
);
-- 自进化（EVOLUTION-SPEC §4.1）：proposals 是唯一进化入口——AI 只能提提案，人审 approve 后
-- hub 才写 L2 配置（策略库/知识包/配额收紧）；直接改配置文件不走提案不生效（铁律）。
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- strategy|knowledge|quota|engage
  platform TEXT,                     -- 平台维度提案（quota 可为空，用 account_id 定位）
  account_id TEXT,                   -- quota 提案的目标账号
  payload TEXT NOT NULL,             -- JSON：提案内容（结构按规格 §4.1–§4.4）
  basis TEXT,                        -- knowledge 提案依据：dom_snapshot|screenshot（缺 → hub 拒绝入库）
  status TEXT DEFAULT 'drafted',     -- drafted→approved|rejected（applied 即 approved 且已落地）
  created_at TEXT, decided_at TEXT, applied_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_posts_status_sched ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_eng_status ON engagements(status);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(DDL);
  // 轻量迁移：已有库补列（红线1 v2：auto_publish 自动发布开关）
  const acctCols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  if (!acctCols.includes('auto_publish')) db.exec('ALTER TABLE accounts ADD COLUMN auto_publish INTEGER DEFAULT 0');
  // 自进化回路④：账号级配额覆盖（EVOLUTION-SPEC §4.4；hub 代码强制 ≤ 基线 clamp，只许收紧）
  if (!acctCols.includes('quota_override')) db.exec("ALTER TABLE accounts ADD COLUMN quota_override TEXT");
  return db;
}

export function kvGet(db, k, dflt = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k=?').get(k);
  return row ? JSON.parse(row.v) : dflt;
}
export function kvSet(db, k, v) {
  db.prepare(
    'INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at'
  ).run(k, JSON.stringify(v), new Date().toISOString());
}
