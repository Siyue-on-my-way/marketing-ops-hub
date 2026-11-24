// evolution.mjs — 自进化模块（EVOLUTION-SPEC-v1）：L2 配置版本管理 + proposals 唯一进化入口。
// 铁律（规格 §1.3/§3）：进化只发生在 L2 配置层（策略库/知识包）+ harness 分析器；
//   hub 执行层一行不改（唯一例外：回路④收紧写入，clamp 在 quotaOf/本模块代码强制）；
//   AI 有提案权，人有一票否决权，hub 只认批准后的版本号——直接改 L2 文件不经提案不生效。
// 红线/坑位/防重/配额硬闸是约束条件，不进任何进化回路（本模块禁止受理相关提案）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './util.mjs';
import { PLATFORMS, workspaceKey } from './config.mjs';
import { knowledgePath } from './adapters/registry.mjs';
import * as cloud from './cloud-client.mjs';
import { quotaOf } from './planner.mjs';

const VERSIONS_KEEP = 10; // 规格要求：保留最近 10 版归档

// ---------- 通用：版本化读写（§6.2：任何覆盖写先归档） ----------

function versionsDir(baseDir) {
  return join(baseDir, 'versions');
}

/** 覆盖写前归档：versions/<platform>-v<n>-<ts>.json；只保留最近 VERSIONS_KEEP 版 */
function archiveVersion(baseDir, platform, jsonObj) {
  const vdir = versionsDir(baseDir);
  mkdirSync(vdir, { recursive: true });
  const ts = nowIso().replace(/[:.]/g, '-');
  const file = join(vdir, `${platform}-v${jsonObj.version}-${ts}.json`);
  writeFileSync(file, JSON.stringify(jsonObj, null, 2));
  const old = readdirSync(vdir).filter((f) => f.endsWith('.json')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - VERSIONS_KEEP))) {
    try { rmSync(join(vdir, f)); } catch { /* 归档清理失败不阻塞 */ }
  }
  return file;
}

function writeVersioned(baseDir, platform, jsonObj) {
  mkdirSync(baseDir, { recursive: true });
  const file = join(baseDir, `${platform}.json`);
  if (existsSync(file)) archiveVersion(baseDir, platform, JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(file, JSON.stringify(jsonObj, null, 2) + '\n');
  return file;
}

// ---------- 回路①③：策略库（strategies/<platform>.json） ----------

export function strategyPath(cfg, platform) {
  return join(cfg.paths.strategies, platform + '.json');
}

export function readStrategy(cfg, platform) {
  const f = strategyPath(cfg, platform);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** hub strategy show <platform>：harness 改写文案/选互动目标前的唯一策略读取入口 */
export function strategyShow(cfg, platform) {
  if (!PLATFORMS.includes(platform)) return { ok: false, error: '未知平台: ' + platform + '（可选: ' + PLATFORMS.join(',') + '）' };
  const s = readStrategy(cfg, platform);
  if (!s) return { ok: false, error: '策略库不存在: ' + strategyPath(cfg, platform) };
  return { ok: true, platform, strategy: s, note: '消费路径：AI 改写文案/选互动目标时以本策略为依据，差异表标注「依据策略 v' + s.version + '」' };
}

export function strategyHistory(cfg, platform) {
  const vdir = versionsDir(cfg.paths.strategies);
  if (!existsSync(vdir)) return { ok: true, platform, versions: [] };
  const versions = readdirSync(vdir)
    .filter((f) => f.startsWith(platform + '-v') && f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, path: join(vdir, f) }));
  return { ok: true, platform, current_version: (readStrategy(cfg, platform) || {}).version ?? null, versions };
}

// ---------- 提案校验（hub 代码层强制，不靠提示词） ----------

/** 知识包自愈（§4.2）：仅限字段级修改；steps 流程结构 / cadence / limits 一律禁止（走人工开发） */
const FIELD_LEVEL = /(^|_)(sel|text|texts)$/;
function isFieldLevelPath(path) {
  const segs = String(path).split('.');
  if (!segs.length) return false;
  for (const s of segs) if (s === 'steps' || s === 'cadence' || s === 'limits') return false; // 流程/节奏/硬限制：禁改
  const leaf = segs[segs.length - 1];
  if (['platform', 'version', 'updated_at', 'notes', '_status', 'pages', 'interact', 'login', 'publish', 'verify', 'metrics'].includes(leaf)) return false;
  return FIELD_LEVEL.test(leaf) || leaf === 'risk' || leaf === 'check_texts' || leaf === 'form_ready_text';
}

function deepSet(obj, path, value) {
  const segs = path.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (typeof cur[segs[i]] !== 'object' || cur[segs[i]] === null) return false; // 不发明结构（结构变化=流程变化）
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
  return true;
}

function validateKnowledgePayload(cfg, platform, payload) {
  const cur = readKnowledgeLocal(cfg, platform);
  if (!cur) return { error: '本地知识包不存在: ' + knowledgePath(cfg, platform) };
  if (payload.base_version !== cur.version) {
    return { error: `BASE_VERSION_CONFLICT: 提案基于 v${payload.base_version}，当前知识包已推进到 v${cur.version}——请基于最新版重新生成提案`, code: 409 };
  }
  if (!Array.isArray(payload.changes) || !payload.changes.length) return { error: 'payload.changes 必须是非空数组 [{path, value}]' };
  for (const c of payload.changes) {
    if (!c || typeof c.path !== 'string') return { error: 'changes 元素缺少 path' };
    if (!isFieldLevelPath(c.path)) {
      return { error: `禁止修改「${c.path}」：自愈仅限字段级（*_sel/*_text/check_texts/form_ready_text/risk），steps 流程/cadence/limits 变更走人工开发（规格 §4.2）` };
    }
  }
  return { current: cur };
}

function readKnowledgeLocal(cfg, platform) {
  const f = knowledgePath(cfg, platform);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** 回路④（§4.4）：方向锁死只收紧——new 每个键 ≤ 当前生效值 且 ≤ 基线，hub 代码强制 */
function validateQuotaPayload(db, cfg, accountId, payload) {
  const acct = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!acct) return { error: '账号不存在: ' + accountId };
  if (acct.status !== 'active') {
    // 冷启动/暂停/观察期的配额由红线 10 与风控规则管辖，不进进化回路
    return { error: `账号状态为 ${acct.status}：冷启动/暂停/观察期配额由红线规则管辖，不接受配额提案（红线不进进化回路）` };
  }
  const eff = quotaOf(acct, cfg); // 当前生效配额（含 trust/已有 override）
  const base = JSON.parse(acct.daily_quota || '{}');
  const baseFill = { post: base.post ?? cfg.quota_default.post, like: base.like ?? cfg.quota_default.like, comment: base.comment ?? cfg.quota_default.comment, dm: base.dm ?? cfg.quota_default.dm };
  const neo = payload && payload.new;
  if (!neo || typeof neo !== 'object') return { error: 'payload.new 必须是对象（如 {"like":20,"comment":3}）' };
  const out = {};
  for (const [k, v] of Object.entries(neo)) {
    if (!['post', 'like', 'comment', 'dm'].includes(k)) return { error: '未知配额键: ' + k + '（仅 post/like/comment/dm）' };
    if (!Number.isInteger(v) || v < 0) return { error: `配额 ${k} 必须是非负整数` };
    if (v > eff[k]) return { error: `DIRECTION_REJECTED（回路④只收紧）: ${k} ${v} > 当前生效 ${eff[k]}——进化回路不得提议任何放宽（规格 §4.4），此提案拒绝入库`, code: 422 };
    if (v > baseFill[k]) return { error: `CLAMP（≤基线）: ${k} ${v} > 基线 ${baseFill[k]}——配额覆盖不得超过基线（hub 代码强制）`, code: 422 };
    out[k] = v;
  }
  if (!Object.keys(out).length) return { error: 'payload.new 为空' };
  return { account: acct, effective: eff, baseline: baseFill, newQuota: out };
}

// ---------- 提案队列（唯一进化入口） ----------

const KINDS = ['strategy', 'knowledge', 'quota', 'engage'];

/**
 * hub proposal add：AI（harness）提提案。校验全部在 hub 代码层：
 *  - knowledge：必须带 basis（dom_snapshot|screenshot），无依据直接拒绝入库（§4.2.4）；
 *  - quota：任何放宽方向直接拒绝入库（§4.4）；
 *  - strategy/engage：current_version 乐观锁（提案基于的版本必须仍是当前版本）。
 */
export function proposalAdd(db, cfg, { kind, platform, accountId, payload, basis }) {
  if (!KINDS.includes(kind)) return { ok: false, error: '未知提案类型: ' + kind + '（可选: ' + KINDS.join(',') + '）' };
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload 必须是对象（--payload-file）' };
  let pPlatform = platform || null;
  let pAccount = accountId || null;

  if (kind === 'strategy' || kind === 'engage') {
    if (!pPlatform || !PLATFORMS.includes(pPlatform)) return { ok: false, error: 'strategy/engage 提案需要 --platform（可选: ' + PLATFORMS.join(',') + '）' };
    const cur = readStrategy(cfg, pPlatform);
    if (!cur) return { ok: false, error: '策略库不存在: ' + strategyPath(cfg, pPlatform) };
    const proposed = payload.proposed;
    if (!proposed || typeof proposed !== 'object') return { ok: false, error: 'payload.proposed 必须是完整策略对象（diff 格式：{summary?, current_version, proposed, evidence[]}）' };
    if (proposed.platform && proposed.platform !== pPlatform) return { ok: false, error: 'proposed.platform=' + proposed.platform + ' 与 --platform 不符' };
    if (payload.current_version !== cur.version) {
      return { ok: false, error: `BASE_VERSION_CONFLICT: 提案基于策略 v${payload.current_version}，当前已是 v${cur.version}——请重新生成周分析提案`, code: 409 };
    }
    if (!Array.isArray(payload.evidence) || !payload.evidence.length) {
      return { ok: false, error: 'payload.evidence 必须是非空数组——无数据依据的策略提案不入库（§4.1：每条模式带 evidence）' };
    }
  } else if (kind === 'knowledge') {
    if (!pPlatform || !PLATFORMS.includes(pPlatform)) return { ok: false, error: 'knowledge 提案需要 --platform' };
    if (!['dom_snapshot', 'screenshot'].includes(basis)) {
      return { ok: false, error: '提案必须附依据 --basis dom_snapshot|screenshot（§4.2：无依据的提案 hub 直接拒绝入库）' };
    }
    const v = validateKnowledgePayload(cfg, pPlatform, payload);
    if (v.error) return { ok: false, error: v.error, code: v.code };
  } else if (kind === 'quota') {
    pAccount = accountId || payload.account_id || null;
    if (!pAccount) return { ok: false, error: 'quota 提案需要 --account <account_id>' };
    const v = validateQuotaPayload(db, cfg, pAccount, payload);
    if (v.error) return { ok: false, error: v.error, code: v.code };
    pPlatform = v.account.platform;
  }

  const id = 'pr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.prepare(
    'INSERT INTO proposals(id, kind, platform, account_id, payload, basis, status, created_at) VALUES(?,?,?,?,?,?, \'drafted\', ?)'
  ).run(id, kind, pPlatform, pAccount, JSON.stringify(payload), basis || null, nowIso());
  const auditDetail = { proposal_id: id, kind, platform: pPlatform, basis: basis || null,
    summary: payload.summary || (kind === 'quota' ? '配额收紧提案' : '') };
  db.prepare('INSERT INTO audit_log(ts, account_id, action, url, detail, shot) VALUES(?,?,?,NULL,?,NULL)')
    .run(nowIso(), pAccount, 'proposal_add', JSON.stringify(auditDetail));
  return { ok: true, proposal_id: id, status: 'drafted（待人审：大屏「进化提案」或 hub proposal approve）', kind, platform: pPlatform };
}

export function proposalList(db, cfg, status) {
  let rows;
  if (status) rows = db.prepare('SELECT * FROM proposals WHERE status=? ORDER BY rowid DESC').all(status);
  else rows = db.prepare('SELECT * FROM proposals ORDER BY rowid DESC').all();
  return {
    ok: true,
    proposals: rows.map((r) => ({
      id: r.id, kind: r.kind, platform: r.platform, account_id: r.account_id, basis: r.basis,
      status: r.status, created_at: r.created_at, decided_at: r.decided_at, applied_version: r.applied_version,
      payload: safeJson(r.payload),
    })),
  };
}

export function proposalReject(db, cfg, id) {
  const row = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
  if (!row) return { ok: false, error: 'proposal not found: ' + id };
  if (row.status !== 'drafted') return { ok: false, error: '状态为 ' + row.status + '，仅 drafted 可 reject' };
  db.prepare(`UPDATE proposals SET status='rejected', decided_at=? WHERE id=?`).run(nowIso(), id);
  db.prepare('INSERT INTO audit_log(ts, account_id, action, url, detail, shot) VALUES(?,?,?,NULL,?,NULL)')
    .run(nowIso(), row.account_id, 'proposal_reject', JSON.stringify({ proposal_id: id, kind: row.kind }));
  return { ok: true, id, status: 'rejected' };
}

/** 人审闸门：approve 后 hub 才写 L2（version+1 + 归档）；这是进化产物生效的唯一路径 */
export async function proposalApprove(db, cfg, id) {
  const row = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
  if (!row) return { ok: false, error: 'proposal not found: ' + id };
  if (row.status !== 'drafted') return { ok: false, error: '状态为 ' + row.status + '，仅 drafted 可 approve' };
  const payload = safeJson(row.payload);

  if (row.kind === 'strategy' || row.kind === 'engage') {
    const cur = readStrategy(cfg, row.platform);
    if (!cur) return { ok: false, error: '策略库不存在' };
    if (payload.current_version !== cur.version) {
      return { ok: false, error: `BASE_VERSION_CONFLICT: 当前策略已是 v${cur.version}，提案基于 v${payload.current_version}（已被其他提案推进），请重新提案`, code: 409 };
    }
    const next = { ...payload.proposed, platform: row.platform, version: cur.version + 1, updated_at: nowIso(), source: 'proposal:' + row.id };
    if (next.engage === undefined && cur.engage !== undefined) next.engage = cur.engage; // 防止提案遗漏时静默丢段
    const file = writeVersioned(cfg.paths.strategies, row.platform, next);
    markApplied(db, id, next.version);
    db.prepare('INSERT INTO audit_log(ts, account_id, action, url, detail, shot) VALUES(?,?,?,NULL,?,NULL)')
      .run(nowIso(), row.account_id, 'proposal_applied', JSON.stringify({ proposal_id: id, kind: row.kind, platform: row.platform, version: next.version, file }));
    return { ok: true, id, kind: row.kind, platform: row.platform, version: next.version, file, note: '旧版已归档 strategies/versions/（保留最近 10 版）；回滚=用归档覆盖当前文件' };
  }

  if (row.kind === 'knowledge') {
    if (!['dom_snapshot', 'screenshot'].includes(row.basis)) return { ok: false, error: '提案缺少合法依据（basis），拒绝应用' };
    const v = validateKnowledgePayload(cfg, row.platform, payload);
    if (v.error) return { ok: false, error: v.error, code: v.code };
    const next = JSON.parse(JSON.stringify(v.current));
    for (const c of payload.changes) {
      if (!deepSet(next, c.path, c.value)) return { ok: false, error: '路径父节点缺失（结构变化属流程级，禁止自愈）: ' + c.path };
    }
    next.version = v.current.version + 1;
    next.updated_at = nowIso();
    next._status = '自愈 ' + row.id + '（' + row.basis + ' 依据，字段级 ' + payload.changes.length + ' 处；人审已过）';
    const file = writeVersioned(cfg.paths.knowledge, row.platform, next);
    // 云端热更（§4.2）：推云端，其他设备 sync 拉到；云不可达不阻塞本地生效（台账在返回里如实标注）
    const push = await knowledgePush(db, cfg, row.platform);
    markApplied(db, id, next.version);
    db.prepare('INSERT INTO audit_log(ts, account_id, action, url, detail, shot) VALUES(?,?,?,NULL,?,NULL)')
      .run(nowIso(), row.account_id, 'proposal_applied', JSON.stringify({ proposal_id: id, kind: 'knowledge', platform: row.platform, version: next.version, file, cloud_push: push }));
    return {
      ok: true, id, kind: 'knowledge', platform: row.platform, version: next.version, file,
      cloud_push: push,
      note: push.ok ? '已推云端，其他设备 hub knowledge sync 可拉到' : '本地已生效；云端推送失败（' + (push.error || '') + '）——云恢复后可 hub knowledge push ' + row.platform + ' 重推',
    };
  }

  if (row.kind === 'quota') {
    const v = validateQuotaPayload(db, cfg, row.account_id, payload); // 应用时二次校验方向（双保险，代码强制）
    if (v.error) return { ok: false, error: v.error, code: v.code };
    const prev = v.account.quota_override ? safeJson(v.account.quota_override) : null;
    db.prepare('UPDATE accounts SET quota_override=?, updated_at=? WHERE id=?').run(JSON.stringify(v.newQuota), nowIso(), v.account.id);
    markApplied(db, id, null);
    db.prepare('INSERT INTO audit_log(ts, account_id, action, url, detail, shot) VALUES(?,?,?,NULL,?,NULL)')
      .run(nowIso(), v.account.id, 'quota_override_set', JSON.stringify({
        proposal_id: id, new: v.newQuota, previous_override: prev, effective_before: v.effective,
        baseline: v.baseline, reason: payload.reason || '', note: '回路④：clamp 由 hub 代码强制 ≤ 基线',
      }));
    return {
      ok: true, id, kind: 'quota', account_id: v.account.id, quota_override: v.newQuota,
      effective: quotaOf(db.prepare('SELECT * FROM accounts WHERE id=?').get(v.account.id), cfg),
      note: '配额收紧已写入并审计；解除收紧须人工修改 DB/基线，进化回路无放宽路径',
    };
  }

  return { ok: false, error: '未知提案类型: ' + row.kind };
}

function markApplied(db, id, version) {
  db.prepare(`UPDATE proposals SET status='approved', decided_at=?, applied_version=? WHERE id=?`).run(nowIso(), version, id);
}

function safeJson(s) { try { return JSON.parse(s); } catch { return { raw: s }; } }

// ---------- 回路②：知识包云端热更（GET/PUT /v1/knowledge + sync） ----------

/** 手动/daemon 周期调用：云端 version > 本地 → 归档本地后覆盖（绝不静默丢失） */
export async function knowledgeSync(db, cfg, { platform } = {}) {
  const platforms = platform ? [platform] : PLATFORMS;
  const report = [];
  let pulled = 0;
  for (const pf of platforms) {
    const local = readKnowledgeLocal(cfg, pf);
    const r = await cloud.getKnowledge(cfg, workspaceKey(), pf);
    if (!r.ok) {
      report.push({ platform: pf, action: r.degraded ? 'cloud_unreachable' : 'cloud_missing', local_version: local ? local.version : null, error: r.error });
      continue;
    }
    const cj = r.json;
    if (!cj || typeof cj.version !== 'number') { report.push({ platform: pf, action: 'cloud_payload_invalid' }); continue; }
    const lv = local ? local.version : 0;
    if (cj.version > lv) {
      const file = writeVersioned(cfg.paths.knowledge, pf, cj); // 本地存在则先归档再覆盖
      report.push({ platform: pf, action: 'pulled', local_version: lv, cloud_version: cj.version, file });
      pulled++;
    } else if (cj.version < lv) {
      report.push({ platform: pf, action: 'local_ahead（本地更版且未推送成功，可 hub knowledge push ' + pf + '）', local_version: lv, cloud_version: cj.version });
    } else {
      report.push({ platform: pf, action: 'up_to_date', version: lv });
    }
  }
  return { ok: true, synced: pulled, report, note: '规则：云端 version > 本地才拉取；本地改过未推送时先归档再覆盖（绝不静默丢失）' };
}

/** approve 后推送云端（也可手动补救重推）；乐观锁 base_version=本地 version-1，冲突 409 */
export async function knowledgePush(db, cfg, platform) {
  if (!PLATFORMS.includes(platform)) return { ok: false, error: '未知平台: ' + platform };
  const local = readKnowledgeLocal(cfg, platform);
  if (!local) return { ok: false, error: '本地知识包不存在: ' + knowledgePath(cfg, platform) };
  const r = await cloud.putKnowledge(cfg, workspaceKey(), platform, local, local.version - 1);
  if (r.ok) return { ok: true, version: local.version, note: '云端已更新到 v' + local.version };
  return { ok: false, status: r.status, error: r.error, hint: r.status === 409 ? '云端版本更新（其他设备已推送）——先 hub knowledge sync 合并后再处理' : '云不可达时本地已生效，恢复后重推即可' };
}

export function knowledgeStatus(db, cfg) {
  const out = [];
  for (const pf of PLATFORMS) {
    const local = readKnowledgeLocal(cfg, pf);
    out.push({ platform: pf, local_version: local ? local.version : null, file: knowledgePath(cfg, pf), exists: !!local });
  }
  return { ok: true, knowledge: out, cloud_configured: !!cfg.cloud.base_url };
}

// ---------- 回路③：互动目标学习（反馈采集 = 占位实现，规格 §4.3） ----------

/**
 * 占位：追踪目标页反馈需要「只读 collect 扩展」（round 脚本进目标页读粉丝/互动数），
 * 规格明文本期不实现、不阻塞 E1/E2。提案流程与回路①相同（strategies engage 段）。
 */
export async function collectEngagementFeedback(db, cfg, engagementId) {
  const e = db.prepare('SELECT id, kind, target, status, executed_at FROM engagements WHERE id=?').get(engagementId);
  if (!e) return { ok: false, error: 'engagement not found: ' + engagementId };
  return {
    ok: true, engagement: e, implemented: false,
    placeholder: '回路③反馈采集为占位实现（EVOLUTION-SPEC §4.3）：目标页回访只读采集（粉丝/互动数变化）为独立小功能，本期不实现；',
    consume_now: '选目标时消费 strategies/<platform>.json 的 engage.target_traits（hub strategy show <platform>）',
  };
}
