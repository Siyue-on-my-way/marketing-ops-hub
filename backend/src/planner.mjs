// planner.mjs — hub 核心业务层：账号管理 / 排期 / 执行 / 人审 / 配额 / trust_score / 健康 / 复盘 / 守护。
// 红线落点：红线 5 先落库后动作（plan/interact 先 INSERT）；红线 6 防重（UNIQUE 约束）；
//           红线 7 拟人节奏与配额（quotaOf/间隔抖动/活跃时段）；红线 10 冷启动（quotaOf cold 分支）。
import { existsSync, readFileSync } from 'node:fs';
import { openDb, kvGet, kvSet } from './db.mjs';
import { loadConfig, workspaceKey, PLATFORMS } from './config.mjs';
import { nowIso, jitter, localDate, inActiveHours, newId, sleep, parseLocal } from './util.mjs';
import { writeRoundScript, runEgo, egoExe } from './ego.mjs';
import { adapterPath, knowledgePath, hasAdapter } from './adapters/registry.mjs';
import * as cloud from './cloud-client.mjs';

// ---------- 基础 ----------

export function audit(db, accountId, action, detail, extra = {}) {
  db.prepare('INSERT INTO audit_log(ts, account_id, action, url, detail, shot) VALUES(?,?,?,?,?,?)')
    .run(nowIso(), accountId || null, action, extra.url || null,
      typeof detail === 'string' ? detail : JSON.stringify(detail), extra.shot || null);
}

function getAccount(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
}

function localDayBounds(d = new Date()) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return [s.toISOString(), new Date(s.getTime() + 86400000).toISOString()];
}

/** 今日已用量：post 按 posts（filling/filled/published/confirmed）；互动按 engagements（drafted 起即占额，保守） */
export function usedToday(db, accountId, kind) {
  const [s, e] = localDayBounds();
  if (kind === 'post') {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<?
       AND status IN ('filling','filled','published','confirmed')`
    ).get(accountId, s, e).n;
  }
  const map = { like: 'like', comment: 'comment', dm: 'friend_dm' };
  const k = map[kind] || kind;
  return db.prepare(
    `SELECT COUNT(*) AS n FROM engagements WHERE account_id=? AND kind=? AND created_at>=? AND created_at<?
     AND status IN ('drafted','approved','executed')`
  ).get(accountId, k, s, e).n;
}

/**
 * 配额计算（红线 7/10）：
 * - cold（冷启动 14 天内）：post=0（不发布），互动配额减半；
 * - paused/banned_watch：全 0；
 * - active：基础配额 × trust_score（逼近 1 才逐步放开）。
 */
export function quotaOf(account, cfg) {
  const base = JSON.parse(account.daily_quota || '{}');
  const fill = (o) => ({ post: o.post ?? 2, like: o.like ?? 30, comment: o.comment ?? 5, dm: o.dm ?? 10 });
  if (account.status === 'cold') {
    const b = fill(base);
    return { post: 0, like: Math.max(1, Math.floor(b.like / 2)), comment: Math.floor(b.comment / 2), dm: Math.floor(b.dm / 2) };
  }
  if (account.status === 'paused' || account.status === 'banned_watch') {
    return { post: 0, like: 0, comment: 0, dm: 0 };
  }
  const b = fill(base);
  const f = Math.min(1, Math.max(0.25, account.trust_score ?? 0.5));
  return { post: Math.floor(b.post * f), like: Math.floor(b.like * f), comment: Math.floor(b.comment * f), dm: Math.floor(b.dm * f) };
}

/** 冷启动到期检查：14 天且 trust≥0.8 → active（红线 10） */
export function refreshStatus(db, cfg, account) {
  if (account.status !== 'cold') return account;
  const created = Date.parse(account.created_at || nowIso());
  const days = (Date.now() - created) / 86400000;
  if (days >= (cfg.cold_start_days ?? 14) && account.trust_score >= 0.8) {
    db.prepare(`UPDATE accounts SET status='active', updated_at=? WHERE id=?`).run(nowIso(), account.id);
    audit(db, account.id, 'cold_start_done', `冷启动 ${Math.floor(days)} 天完成，trust=${account.trust_score}，转 active`);
    return getAccount(db, account.id);
  }
  return account;
}

/** 风控命中处理：risk_events+1、trust−0.2、3 次进 banned_watch、当日停机（红线 2/8） */
function riskHit(db, account, r) {
  db.prepare(
    `UPDATE accounts SET risk_events=risk_events+1,
       trust_score=MAX(0.05, trust_score-0.2),
       status=CASE WHEN risk_events+1>=3 THEN 'banned_watch' ELSE status END,
       updated_at=? WHERE id=?`
  ).run(nowIso(), account.id);
  kvSet(db, `paused:${account.id}:${localDate()}`, { reason: (r.data && r.data.risk) || r.error });
  audit(db, account.id, 'RISK_SIGNAL', r.data || r.error, { shot: r.shot });
}

function markSkipped(db, postId, reason, detail) {
  db.prepare(`UPDATE posts SET status='skipped', error=? WHERE id=?`).run(`${reason}: ${detail}`.slice(0, 500), postId);
}

// ---------- 账号 ----------

export function accountsList(db, cfg) {
  const out = [];
  for (const a of db.prepare('SELECT * FROM accounts ORDER BY created_at').all()) {
    const q = quotaOf(refreshStatus(db, cfg, a), cfg);
    const login = kvGet(db, 'login:' + a.id);
    const coldDays = a.status === 'cold'
      ? Math.max(0, Math.ceil(((cfg.cold_start_days ?? 14) * 86400000 - (Date.now() - Date.parse(a.created_at || nowIso()))) / 86400000))
      : 0;
    out.push({
      id: a.id, platform: a.platform, display_name: a.display_name, ego_space_id: a.ego_space_id,
      owner_device: a.owner_device, status: a.status, trust_score: a.trust_score, risk_events: a.risk_events,
      quota: q, used: { post: usedToday(db, a.id, 'post'), like: usedToday(db, a.id, 'like'), comment: usedToday(db, a.id, 'comment'), dm: usedToday(db, a.id, 'dm') },
      cold_days_left: coldDays,
      login: login ? { ok: login.ok, displayName: login.displayName, checked_at: login.checked_at } : { ok: null, note: '未预检' },
    });
  }
  return out;
}

export function accountsAdd(db, cfg, platform, name, ownerDevice) {
  if (!PLATFORMS.includes(platform)) return { ok: false, error: '未知平台: ' + platform + '（可选: ' + PLATFORMS.join(',') + '）' };
  const id = newId('a');
  const egoSpaceId = `mt-${platform}-${id}`;
  db.prepare(
    `INSERT INTO accounts(id, platform, display_name, ego_space_id, owner_device, status, daily_quota, trust_score, risk_events, created_at, updated_at)
     VALUES(?,?,?,?,?, 'cold', ?, 0.5, 0, ?, ?)`
  ).run(id, platform, name, egoSpaceId, ownerDevice || null, JSON.stringify(cfg.quota_default), nowIso(), nowIso());
  audit(db, id, 'account_add', { platform, name, cold_start: '红线10：14 天冷启动，不发布' });
  return { ok: true, account: accountsList(db, cfg).find((x) => x.id === id) };
}

export function accountsRemove(db, id) {
  const usedP = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE account_id=?').get(id).n;
  const usedE = db.prepare('SELECT COUNT(*) AS n FROM engagements WHERE account_id=?').get(id).n;
  if (usedP || usedE) return { ok: false, error: `该账号有 ${usedP} 条发布任务 / ${usedE} 条互动记录，拒绝删除（审计不可断）。如确需移除请人工处理 DB。` };
  db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  return { ok: true };
}

/**
 * 扫码登录（D1/红线 3）：打开该账号 space 的登录页 → handOff 交还用户扫码 →
 * 轮询快照确认昵称。绝不代填凭据；10 分钟未完成即超时返回（上层提示 skipped(no_login) 语义）。
 */
export async function accountLogin(db, cfg, accountId) {
  const account = getAccount(db, accountId);
  if (!account) return { ok: false, error: '账号不存在: ' + accountId };
  const r = await runOp(db, cfg, account, 'login');
  if (r.ok && r.data && r.data.loggedIn) {
    const dn = r.data.displayName;
    kvSet(db, 'login:' + account.id, { ok: true, displayName: dn, checked_at: nowIso() });
    // 红线 4：昵称核对，不符立即停
    if (dn && account.display_name && !dn.includes(account.display_name) && !account.display_name.includes(dn)) {
      db.prepare(`UPDATE accounts SET status='paused', updated_at=? WHERE id=?`).run(nowIso(), account.id);
      audit(db, account.id, 'IDENTITY_MISMATCH', { login_as: dn, expect: account.display_name }, { shot: r.shot });
      return { ok: false, error: `IDENTITY_MISMATCH: 登录态昵称「${dn}」与账号「${account.display_name}」不符（红线 4，账号已暂停待人工处理）` };
    }
    audit(db, account.id, 'login_ok', { displayName: dn }, { shot: r.shot });
    return { ok: true, account: account.display_name, displayName: dn, shot: r.shot };
  }
  kvSet(db, 'login:' + account.id, { ok: false, checked_at: nowIso() });
  audit(db, account.id, 'login_failed', { error: r.error || 'timeout' }, { shot: r.shot });
  return { ok: false, error: r.error || 'LOGIN_TIMEOUT: 10 分钟未完成扫码（对应规则：该账号本轮任务 skipped(no_login)）', shot: r.shot };
}

// ---------- ego 调用 ----------

export async function runOp(db, cfg, account, op, params = {}) {
  const P = {
    action: `${op}-${account.platform}-${account.id}`,
    op,
    account: { id: account.id, ego_space_id: account.ego_space_id, display_name: account.display_name, platform: account.platform },
    params,
    paths: {
      knowledge: knowledgePath(cfg, account.platform),
      adapter: adapterPath(cfg, account.platform),
      shotDir: cfg.paths.shots,
      shotName: `${op}-${account.platform}-${account.id}-${Date.now()}`,
    },
  };
  const script = writeRoundScript(cfg, P);
  const timeoutMs = op === 'login' ? 10.5 * 60 * 1000 : op === 'fill' ? 15 * 60 * 1000 : 5 * 60 * 1000;
  return runEgo(cfg, script, { timeoutMs });
}

// ---------- 排期 plan ----------

export function plan(db, cfg, materialId, { platforms, accounts, at, payloadFile }) {
  if (!payloadFile || !existsSync(payloadFile)) {
    return { ok: false, error: '必须提供 --payload-file（AI 按平台改写、用户过目后的 payload 映射 {"xhs":{...},"bili":{...}}）——hub 不生成文案' };
  }
  let payloads;
  try { payloads = JSON.parse(readFileSync(payloadFile, 'utf8')); } catch (e) { return { ok: false, error: 'payload-file 解析失败: ' + e.message }; }
  const ids = String(accounts || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { ok: false, error: '必须提供 --accounts（账号 id 列表）' };
  const plats = String(platforms || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!plats.length) return { ok: false, error: '必须提供 --platforms' };
  const results = [];
  let t = at ? (parseLocal(at) || new Date(Date.parse(at))) : new Date();
  if (!t || Number.isNaN(t.getTime())) t = new Date();
  for (const platform of plats) {
    if (!PLATFORMS.includes(platform)) { results.push({ platform, error: '未知平台' }); continue; }
    const payload = payloads[platform];
    if (!payload || !payload.title) { results.push({ platform, skipped: 'payload 缺失或缺 title（AI 改写差异表须覆盖每个平台）' }); continue; }
    for (const aid of ids) {
      let a = getAccount(db, aid);
      if (!a) { results.push({ platform, account: aid, error: '账号不存在' }); continue; }
      if (a.platform !== platform) { results.push({ platform, account: a.display_name, skipped: '平台不匹配（账号是 ' + a.platform + '）' }); continue; }
      a = refreshStatus(db, cfg, a);
      const q = quotaOf(a, cfg);
      const used = usedToday(db, a.id, 'post');
      if (a.status === 'cold') {
        results.push({ platform, account: a.display_name, skipped: `quota（红线10：冷启动期 ${Math.ceil((cfg.cold_start_days ?? 14))} 天内禁止发布）` });
        continue;
      }
      if (used >= q.post) { results.push({ platform, account: a.display_name, skipped: `quota（今日 ${used}/${q.post}）` }); continue; }
      const id = newId('p');
      try {
        db.prepare(
          `INSERT INTO posts(id, material_cloud_id, account_id, platform, adapted_payload, status, scheduled_at)
           VALUES(?,?,?,?,?, 'planned', ?)`
        ).run(id, materialId || null, a.id, platform, JSON.stringify(payload), t.toISOString());
        audit(db, a.id, 'plan', { post_id: id, platform, material: materialId, scheduled_at: t.toISOString() });
        results.push({ platform, account: a.display_name, post_id: id, scheduled_at: t.toISOString() });
        t = new Date(t.getTime() + jitter(cfg.cadence.post_gap_sec) * 1000); // 红线 7：发布间隔 ≥2 分钟随机抖动
      } catch (e) {
        if (String(e).includes('UNIQUE')) results.push({ platform, account: a.display_name, skipped: 'duplicate（红线 6：同素材同账号同平台只发一次）' });
        else results.push({ platform, account: a.display_name, error: String(e) });
      }
    }
  }
  return { ok: true, results };
}

// ---------- 执行 run ----------

export async function run(db, cfg, { due = false } = {}) {
  let sql = `SELECT p.id AS post_id, p.material_cloud_id, p.account_id, p.platform, p.adapted_payload, p.scheduled_at,
    a.platform AS acct_platform, a.display_name, a.ego_space_id, a.status AS acct_status, a.trust_score, a.risk_events, a.daily_quota, a.created_at AS acct_created
    FROM posts p JOIN accounts a ON a.id=p.account_id WHERE p.status='planned'`;
  const args = [];
  if (due) { sql += ' AND p.scheduled_at<=?'; args.push(nowIso()); }
  sql += ' ORDER BY p.scheduled_at';
  const rows = db.prepare(sql).all(...args);
  const out = [];
  const lastFill = {};
  for (const row of rows) {
    const postId = row.post_id;
    const acct = {
      id: row.account_id, platform: row.acct_platform, display_name: row.display_name,
      ego_space_id: row.ego_space_id, status: row.acct_status, trust_score: row.trust_score,
      risk_events: row.risk_events, daily_quota: row.daily_quota, created_at: row.acct_created,
    };
    // 红线 7：活跃时段 9–21 点
    if (!inActiveHours(cfg)) {
      out.push({ post_id: postId, deferred: 'inactive_hours（红线7：仅 9–21 点执行）' });
      break; // 后面的也要等时段，直接停
    }
    const q = quotaOf(refreshStatus(db, cfg, { ...acct }), cfg);
    const used = usedToday(db, acct.id, 'post');
    if (used >= q.post) { markSkipped(db, postId, 'quota', `今日 ${used}/${q.post}`); out.push({ post_id: postId, skipped: 'quota' }); continue; }
    if (kvGet(db, `paused:${acct.id}:${localDate()}`)) {
      markSkipped(db, postId, 'risk', '账号当日因风控信号停机');
      out.push({ post_id: postId, skipped: 'risk' }); continue;
    }
    // 红线 7：同账号发布间隔（跨任务也生效）
    const gapMs = jitter(cfg.cadence.post_gap_sec) * 1000;
    const waitMs = (lastFill[acct.id] || 0) + gapMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    // D1/红线 3：登录预检，未登录放弃（绝不代填凭据）
    const pf = await runOp(db, cfg, acct, 'preflight');
    if (pf.error === 'RISK_SIGNAL') {
      riskHit(db, acct, pf);
      markSkipped(db, postId, 'skipped(risk)', 'preflight 风控信号: ' + JSON.stringify((pf.data && pf.data.risk) || []));
      out.push({ post_id: postId, skipped: 'risk' });
      continue;
    }
    if (!pf.ok || (pf.data && pf.data.need_login)) {
      markSkipped(db, postId, 'skipped(no_login)', pf.error || 'need_login（D1：扫码永远人做，本轮放弃）');
      kvSet(db, 'login:' + acct.id, { ok: false, checked_at: nowIso() });
      audit(db, acct.id, 'skipped_no_login', { post_id: postId });
      out.push({ post_id: postId, skipped: 'no_login' });
      continue;
    }
    // 红线 4：身份复核——昵称与账号不符立即停
    const dn = pf.data && pf.data.displayName;
    if (dn && acct.display_name && !dn.includes(acct.display_name) && !acct.display_name.includes(dn)) {
      db.prepare(`UPDATE accounts SET status='paused', updated_at=? WHERE id=?`).run(nowIso(), acct.id);
      markSkipped(db, postId, 'skipped(risk)', `身份不符：登录态昵称「${dn}」≠ 账号「${acct.display_name}」`);
      audit(db, acct.id, 'IDENTITY_MISMATCH', { post_id: postId, login_as: dn, expect: acct.display_name }, { shot: pf.shot });
      out.push({ post_id: postId, skipped: 'identity_mismatch（红线 4，账号已暂停待人工处理）' });
      continue;
    }
    kvSet(db, 'login:' + acct.id, { ok: true, displayName: dn, checked_at: nowIso() });

    // 素材本地化（无本地文件时从云端下载/读缓存）
    let payload;
    try { payload = JSON.parse(row.adapted_payload); } catch { payload = {}; }
    if (!payload.local_media_path && row.material_cloud_id) {
      const dl = await cloud.downloadMaterial(db, cfg, workspaceKey(), row.material_cloud_id);
      if (!dl.ok) {
        db.prepare(`UPDATE posts SET status='failed', error=? WHERE id=?`).run('素材下载失败: ' + dl.error, postId);
        out.push({ post_id: postId, failed: 'material_download: ' + dl.error });
        continue;
      }
      payload.local_media_path = dl.path;
    }

    // 状态机推进：filling（先落库后动作）
    db.prepare(`UPDATE posts SET status='filling' WHERE id=?`).run(postId);
    const r = await runOp(db, cfg, acct, 'fill', { payload, postId });
    lastFill[acct.id] = Date.now();
    if (r.ok) {
      const warn = (r.data && r.data.warn) || [];
      db.prepare(`UPDATE posts SET status='filled', filled_at=?, shot_filled=?, error=? WHERE id=?`)
        .run(nowIso(), r.shot || null, warn.length ? 'warn: ' + JSON.stringify(warn).slice(0, 450) : null, postId);
      audit(db, acct.id, 'fill', { post_id: postId, platform: row.platform, warn }, { shot: r.shot });
      out.push({ post_id: postId, status: 'filled（待人审：请去平台亲手点发布，再 hub confirm）', warn });
    } else if (r.error === 'RISK_SIGNAL') {
      riskHit(db, acct, r);
      markSkipped(db, postId, 'skipped(risk)', '风控信号: ' + JSON.stringify((r.data && r.data.risk) || []));
      out.push({ post_id: postId, skipped: 'risk' });
    } else if (r.timed_out) {
      markSkipped(db, postId, 'skipped(no_login)', 'ego 执行超时（疑似停留在扫码）');
      out.push({ post_id: postId, skipped: 'no_login(timeout)' });
    } else {
      db.prepare(`UPDATE posts SET status='failed', error=? WHERE id=?`).run(String(r.error).slice(0, 500), postId);
      audit(db, acct.id, 'fill_failed', { post_id: postId, error: r.error }, { shot: r.shot });
      out.push({ post_id: postId, failed: r.error });
    }
  }
  return { ok: true, processed: out };
}

// ---------- 人审 confirm ----------

export async function confirm(db, cfg, postId) {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  if (!p) return { ok: false, error: 'post not found: ' + postId };
  if (!['filled', 'published'].includes(p.status)) {
    return { ok: false, error: `状态为 ${p.status}，仅 filled（已填写待人点发布）/published 可 confirm——发布按钮必须由用户亲手点（红线 1）` };
  }
  const acct = getAccount(db, p.account_id);
  let payload = {};
  try { payload = JSON.parse(p.adapted_payload); } catch {}
  if (p.status === 'filled') {
    // 用户声明已亲手点发布 → published
    db.prepare(`UPDATE posts SET status='published', published_at=? WHERE id=?`).run(nowIso(), postId);
    audit(db, acct.id, 'user_published_assert', { post_id: postId });
  }
  // 回读确认（只读）
  const r = await runOp(db, cfg, acct, 'verify', { payload, postId });
  if (r.ok && r.data && r.data.ok) {
    db.prepare(`UPDATE posts SET status='confirmed', published_url=?, shot_published=? WHERE id=?`)
      .run((r.data && r.data.url) || null, r.shot || null, postId);
    audit(db, acct.id, 'confirmed', { post_id: postId, url: r.data.url }, { shot: r.shot });
    if (p.material_cloud_id) {
      await cloud.markUsed(db, cfg, workspaceKey(), p.material_cloud_id, { platform: p.platform, account_id: acct.id, url: r.data.url });
    }
    await cloud.journal(db, cfg, workspaceKey(), { action: 'post_confirmed', account_id: acct.id, detail: { post_id: postId, platform: p.platform, url: r.data.url } });
    return { ok: true, status: 'confirmed', url: r.data.url };
  }
  const verr = (r.data && r.data.error) || r.error || '未知';
  db.prepare(`UPDATE posts SET error=? WHERE id=?`).run(('verify 未通过: ' + verr).slice(0, 500), postId);
  return { ok: false, error: 'VERIFY_FAILED: ' + verr, hint: '已标记 published；平台可能在审核中，稍后重跑 hub confirm ' + postId };
}

// ---------- 互动 interact / approve ----------

const KINDS = ['like', 'comment', 'follow', 'topic_reply', 'friend_dm'];

export function interact(db, cfg, accountId, planFile) {
  if (!planFile || !existsSync(planFile)) return { ok: false, error: '必须提供 --plan <plan.json>（[{kind,target,draft}]）' };
  let items;
  try { items = JSON.parse(readFileSync(planFile, 'utf8')); } catch (e) { return { ok: false, error: 'plan 解析失败: ' + e.message }; }
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'plan 必须是非空数组' };
  for (const it of items) {
    if (!KINDS.includes(it.kind)) return { ok: false, error: '未知互动类型: ' + it.kind + '（可选: ' + KINDS.join(',') + '）' };
    if (!it.target) return { ok: false, error: '互动缺少 target' };
    if (['comment', 'topic_reply', 'friend_dm'].includes(it.kind) && !(it.draft || '').trim()) {
      return { ok: false, error: `${it.kind} 缺 draft（红线 8：AI 草拟 → 人审后才执行）` };
    }
  }
  // 红线 8：禁止模板群发——同批相同 draft ≥3 次直接拒绝
  const counts = {};
  for (const it of items) if (it.draft) counts[it.draft] = (counts[it.draft] || 0) + 1;
  const dup = Object.entries(counts).filter(([, n]) => n >= 3);
  if (dup.length) return { ok: false, error: '红线8拒绝：相同草拟内容出现≥3次，疑似模板群发: ' + dup.slice(0, 2).map(([d]) => d.slice(0, 24)).join(' / ') };

  const acct = getAccount(db, accountId);
  if (!acct) return { ok: false, error: '账号不存在: ' + accountId };
  const q = quotaOf(refreshStatus(db, cfg, acct), cfg);
  const results = [];
  for (const it of items) {
    const used = usedToday(db, acct.id, it.kind === 'friend_dm' ? 'dm' : it.kind);
    const limit = q[it.kind === 'friend_dm' ? 'dm' : it.kind] ?? 0;
    if (used >= limit) { results.push({ ...it, skipped: `quota（今日 ${used}/${limit}）` }); continue; }
    const id = newId('e');
    try {
      db.prepare(`INSERT INTO engagements(id, account_id, kind, target, draft, status, created_at) VALUES(?,?,?,?,?, 'drafted', ?)`)
        .run(id, acct.id, it.kind, it.target, it.draft || '', nowIso());
      audit(db, acct.id, 'engage_draft', { id, kind: it.kind, target: it.target });
      results.push({ ...it, engagement_id: id, status: 'drafted（待大屏人审 approve）' });
    } catch (e) {
      if (String(e).includes('UNIQUE')) results.push({ ...it, skipped: 'duplicate（同账号同目标去重；私聊每会话 1 条上限）' });
      else results.push({ ...it, error: String(e) });
    }
  }
  return { ok: true, results, note: '互动须在大屏（或 hub approve）人审后才执行' };
}

export function approve(db, cfg, arg) {
  if (arg === 'batch:today') {
    const [s, e] = localDayBounds();
    const rows = db.prepare(`SELECT id, kind, target, draft FROM engagements WHERE status='drafted' AND created_at>=? AND created_at<?`).all(s, e);
    db.prepare(`UPDATE engagements SET status='approved', approved_at=? WHERE status='drafted' AND created_at>=? AND created_at<?`).run(nowIso(), s, e);
    audit(db, null, 'approve_batch_today', { count: rows.length });
    return { ok: true, approved: rows.length, items: rows, note: '仅限今日草拟批次；跨批次请逐条审' };
  }
  const e = db.prepare('SELECT * FROM engagements WHERE id=?').get(arg);
  if (!e) return { ok: false, error: 'engagement not found: ' + arg };
  if (e.status !== 'drafted') return { ok: false, error: '状态为 ' + e.status + '，仅 drafted 可 approve' };
  db.prepare(`UPDATE engagements SET status='approved', approved_at=? WHERE id=?`).run(nowIso(), arg);
  audit(db, e.account_id, 'approve', { id: arg, kind: e.kind, target: e.target });
  return { ok: true, engagement: e };
}

export function reject(db, cfg, id) {
  const e = db.prepare('SELECT * FROM engagements WHERE id=?').get(id);
  if (!e) return { ok: false, error: 'engagement not found: ' + id };
  db.prepare(`UPDATE engagements SET status='rejected' WHERE id=?`).run(id);
  audit(db, e.account_id, 'reject', { id, kind: e.kind });
  return { ok: true };
}

/** 执行已批准互动（daemon 与 interact 命令共用）：拟人间隔 30–120s，逐条 login 预检 + 风控检测 */
export async function executeApproved(db, cfg, accountId) {
  const acct0 = getAccount(db, accountId);
  if (!acct0) return { ok: false, error: 'account not found' };
  const acct = refreshStatus(db, cfg, acct0);
  const rows = db.prepare(`SELECT * FROM engagements WHERE account_id=? AND status='approved' ORDER BY rowid`).all(acct.id);
  const out = [];
  const lastExec = kvGet(db, `last_exec:${acct.id}`) || 0;
  let prev = lastExec;
  for (const e of rows) {
    if (!inActiveHours(cfg)) { out.push({ id: e.id, deferred: 'inactive_hours' }); break; }
    if (kvGet(db, `paused:${acct.id}:${localDate()}`)) { out.push({ id: e.id, deferred: 'risk_paused' }); break; }
    const q = quotaOf(acct, cfg);
    const qk = e.kind === 'friend_dm' ? 'dm' : e.kind;
    const used = usedToday(db, acct.id, qk);
    if (used >= (q[qk] ?? 0)) {
      db.prepare(`UPDATE engagements SET status='skipped', error='quota' WHERE id=?`).run(e.id);
      out.push({ id: e.id, skipped: 'quota' }); continue;
    }
    const waitMs = prev + jitter(cfg.cadence.interact_gap_sec) * 1000 - Date.now(); // 红线 7：互动间隔 30–120s
    if (waitMs > 0) await sleep(waitMs);
    const pf = await runOp(db, cfg, acct, 'preflight');
    if (pf.error === 'RISK_SIGNAL') {
      riskHit(db, acct, pf);
      db.prepare(`UPDATE engagements SET status='skipped', error='risk' WHERE id=?`).run(e.id);
      out.push({ id: e.id, skipped: 'risk' });
      continue;
    }
    if (!pf.ok || (pf.data && pf.data.need_login)) {
      db.prepare(`UPDATE engagements SET status='skipped', error='no_login' WHERE id=?`).run(e.id);
      kvSet(db, 'login:' + acct.id, { ok: false, checked_at: nowIso() });
      out.push({ id: e.id, skipped: 'no_login' }); continue;
    }
    prev = Date.now();
    const r = await runOp(db, cfg, acct, 'engage', { payload: { kind: e.kind, target: e.target, draft: e.draft }, engagementId: e.id });
    kvSet(db, `last_exec:${acct.id}`, prev);
    if (r.ok && r.data && r.data.done !== false) {
      db.prepare(`UPDATE engagements SET status='executed', executed_at=?, shot=?, error=NULL WHERE id=?`).run(nowIso(), r.shot || null, e.id);
      audit(db, acct.id, 'engage_exec', { id: e.id, kind: e.kind, target: e.target }, { shot: r.shot });
      await cloud.journal(db, cfg, workspaceKey(), { action: 'engage_' + e.kind, account_id: acct.id, detail: { target: e.target } });
      out.push({ id: e.id, status: 'executed' });
    } else if (r.error === 'RISK_SIGNAL') {
      riskHit(db, acct, r);
      db.prepare(`UPDATE engagements SET status='skipped', error='risk' WHERE id=?`).run(e.id);
      out.push({ id: e.id, skipped: 'risk' });
    } else {
      db.prepare(`UPDATE engagements SET error=? WHERE id=?`).run(String(r.error || 'exec_failed').slice(0, 300), e.id); // 保持 approved 可重试（2 次失败由 skill 层停手）
      out.push({ id: e.id, error: r.error, warn: (r.data && r.data.warn) || [] });
    }
  }
  return { ok: true, results: out };
}

// ---------- 健康 / 复盘 / doctor ----------

export function health(db, cfg) {
  return { ok: true, accounts: accountsList(db, cfg) };
}

export function review(db, cfg, postId, days = 7) {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  if (!p) return { ok: false, error: 'post not found' };
  const rows = db.prepare('SELECT * FROM metrics WHERE post_id=? AND day<=? ORDER BY day').all(postId, days);
  // 与「上期同龄」对比：同账号其他帖子在相同 day 的均值
  const baseline = {};
  const peers = db.prepare(`SELECT id FROM posts WHERE account_id=? AND id!=? AND status IN ('confirmed','published')`).all(p.account_id, postId);
  for (const peer of peers) {
    for (const m of db.prepare('SELECT * FROM metrics WHERE post_id=? AND day<=?').all(peer.id, days)) {
      (baseline[m.day] = baseline[m.day] || []).push(m);
    }
  }
  const avg = (arr, f) => arr && arr.length ? Math.round(arr.reduce((s, x) => s + (x[f] || 0), 0) / arr.length) : null;
  const card = rows.map((m) => {
    const b = baseline[m.day] || [];
    return {
      day: m.day, views: m.views, likes: m.likes, comments: m.comments, shares: m.shares, followers_delta: m.followers_delta,
      vs_peers: {
        views: m.views != null && avg(b, 'views') != null ? m.views - avg(b, 'views') : null,
        likes: m.likes != null && avg(b, 'likes') != null ? m.likes - avg(b, 'likes') : null,
      },
    };
  });
  return { ok: true, post: { id: p.id, platform: p.platform, status: p.status, published_at: p.published_at, url: p.published_url }, card };
}

export function doctor(db, cfg) {
  const exe = egoExe(cfg);
  const ego = { configured: !!exe, path: exe || null, found: !!(exe && existsSync(exe)) };
  const key = workspaceKey();
  const accounts = accountsList(db, cfg).map((a) => ({
    id: a.id, platform: a.platform, display_name: a.display_name, status: a.status,
    login_ok: a.login.ok, login_display_name: a.login.displayName, login_checked_at: a.login.checked_at,
  }));
  const missingAdapters = [];
  for (const a of db.prepare('SELECT DISTINCT platform FROM accounts').all()) {
    if (!hasAdapter(cfg, a.platform)) missingAdapters.push(a.platform);
  }
  return {
    ok: true,
    ego,
    hub: { db: cfg.paths.db, port: cfg.hub.port },
    cloud: { configured: !!cfg.cloud.base_url, base_url: cfg.cloud.base_url, key_set: !!key },
    accounts,
    missing_adapters: missingAdapters,
    note: '登录态矩阵来自最近一次 preflight/login 快照缓存；run/confirm 会实时刷新',
  };
}

// ---------- 守护 daemon ----------

/** 到期数据采集：发布后第 1/3/7 天 collect → metrics（复盘卡片用） */
async function collectDueMetrics(db, cfg) {
  const posts = db.prepare(`SELECT * FROM posts WHERE status IN ('confirmed','published') AND published_at IS NOT NULL`).all();
  const out = [];
  for (const p of posts) {
    const pub = Date.parse(p.published_at);
    for (const day of [1, 3, 7]) {
      const due = pub + day * 86400000;
      if (Date.now() < due) continue;
      const has = db.prepare('SELECT 1 FROM metrics WHERE post_id=? AND day=?').get(p.id, day);
      if (has) continue;
      const acct = getAccount(db, p.account_id);
      if (!acct) continue;
      let payload = {}; try { payload = JSON.parse(p.adapted_payload); } catch {}
      const r = await runOp(db, cfg, acct, 'collect', { payload, postId: p.id });
      if (r.ok && r.data && r.data.ok) {
        const m = r.data.metrics || {};
        db.prepare(
          `INSERT OR REPLACE INTO metrics(post_id, day, views, likes, comments, shares, followers_delta, collected_at)
           VALUES(?,?,?,?,?,?,?,?)`
        ).run(p.id, day, m.views ?? null, m.likes ?? null, m.comments ?? null, m.shares ?? null, m.followers_delta ?? null, nowIso());
        out.push({ post_id: p.id, day, metrics: m });
      } else {
        // 采集失败不无限重试：记录 kv，当日不再尝试（明天再试）
        kvSet(db, `collect_fail:${p.id}:${day}:${localDate()}`, r.error || 'failed');
      }
    }
  }
  return out;
}

/** trust_score 日更：昨日有活动且无风控 → +0.05（上限 1） */
function trustDailyTick(db) {
  const [ys, ye] = localDayBounds(new Date(Date.now() - 86400000));
  for (const a of db.prepare('SELECT * FROM accounts').all()) {
    const k = `trust_tick:${a.id}:${localDate()}`;
    if (kvGet(db, k)) continue;
    kvSet(db, k, 1);
    const risky = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE account_id=? AND ts>=? AND ts<? AND action='RISK_SIGNAL'`).get(a.id, ys, ye).n;
    const active = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE account_id=? AND ts>=? AND ts<?`).get(a.id, ys, ye).n;
    if (active > 0 && risky === 0) {
      db.prepare('UPDATE accounts SET trust_score=MIN(1, trust_score+0.05), updated_at=? WHERE id=?').run(nowIso(), a.id);
    }
  }
}

export async function daemonOnce(db, cfg) {
  const posts = await run(db, cfg, { due: true });
  const engaged = [];
  for (const a of db.prepare('SELECT id FROM accounts').all()) {
    const r = await executeApproved(db, cfg, a.id);
    if (r.results && r.results.length) engaged.push(...r.results);
  }
  const collected = await collectDueMetrics(db, cfg);
  const flushed = await cloud.flushOutbox(db, cfg, workspaceKey());
  trustDailyTick(db);
  kvSet(db, 'daemon_heartbeat', nowIso());
  return { posts: posts.processed, engaged, collected, flushed };
}

export async function daemonLoop(db, cfg, tickMs = 30000) {
  for (;;) {
    try { await daemonOnce(db, cfg); } catch (e) { console.error('[daemon]', e && e.stack || e); }
    await sleep(tickMs);
  }
}
