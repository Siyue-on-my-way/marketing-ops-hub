// server.mjs — 大屏 :8787（单页零框架，规格 §4.2 ④：待审队列/日历/账号健康/审计时间线）。
// 默认只绑定 127.0.0.1（本机使用）；容器模式由 MAITIAN_HUB_HOST=0.0.0.0 放开，网关统一入口。
// SERVER_TOKEN 设置时对 /api/* 强制校验（豁免 /api/health 健康探针）——部署安全层，不改业务逻辑。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as planner from './planner.mjs';
import * as evolution from './evolution.mjs';
import { nowIso } from './util.mjs';

const VERSION = '0.1.0';
const SERVER_TOKEN = process.env.SERVER_TOKEN || '';
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');

function authorized(req, p, u) {
  if (!SERVER_TOKEN) return true; // 本机模式：无 token 配置即不启用
  if (p === '/api/health') return true; // 健康探针豁免
  const t = req.headers['x-server-token'];
  const auth = req.headers.authorization || '';
  return t === SERVER_TOKEN || auth === 'Bearer ' + SERVER_TOKEN || (u.searchParams.get('token') === SERVER_TOKEN);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function startServer(db, cfg) {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (!authorized(req, p, u)) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED: 缺少或错误的 SERVER_TOKEN（X-Server-Token 头或 ?token=）' });
      if (p === '/api/health') return sendJson(res, 200, { ok: true, version: VERSION, now: nowIso() });
      if (p === '/api/state') return sendJson(res, 200, state(db, cfg));
      if (p === '/api/shots' && u.searchParams.get('f')) {
        const f = u.searchParams.get('f');
        if (!f.includes('..')) {
          const file = join(cfg.paths.shots, f);
          if (existsSync(file)) {
            res.writeHead(200, { 'content-type': 'image/png' });
            return res.end(readFileSync(file));
          }
        }
        res.writeHead(404); return res.end('not found');
      }
      let m;
      if ((m = p.match(/^\/api\/engagements\/([^/]+)\/(approve|reject)$/)) && req.method === 'POST') {
        const r = m[2] === 'approve' ? planner.approve(db, cfg, m[1]) : planner.reject(db, cfg, m[1]);
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      if (p === '/api/engagements/approve-batch' && req.method === 'POST') {
        return sendJson(res, 200, planner.approve(db, cfg, 'batch:today'));
      }
      if ((m = p.match(/^\/api\/posts\/([^/]+)\/confirm$/)) && req.method === 'POST') {
        const r = await planner.confirm(db, cfg, m[1]);
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      if ((m = p.match(/^\/api\/posts\/([^/]+)\/review$/))) {
        return sendJson(res, 200, planner.review(db, cfg, m[1]));
      }
      // 自进化提案人审闸门（EVOLUTION-SPEC §2：大屏批量过目 approve/reject）
      if ((m = p.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/)) && req.method === 'POST') {
        const r = m[2] === 'approve' ? await evolution.proposalApprove(db, cfg, m[1]) : evolution.proposalReject(db, cfg, m[1]);
        return sendJson(res, r.ok ? 200 : (r.code === 409 ? 409 : 409), r);
      }
      if (p === '/' || p === '/index.html') {
        const html = readFileSync(join(STATIC_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.stack) || e) });
    }
  });
  server.listen(cfg.hub.port, cfg.hub.host, () => {
    console.log(`[hub] 大屏 http://${cfg.hub.host}:${cfg.hub.port}`);
  });
  return server;
}

function state(db, cfg) {
  const accounts = planner.accountsList(db, cfg);
  const queuePosts = db.prepare(
    `SELECT p.id, p.platform, p.status, p.adapted_payload, p.shot_filled, p.scheduled_at, a.display_name, a.id AS account_id
     FROM posts p JOIN accounts a ON a.id=p.account_id WHERE p.status IN ('filled','published') ORDER BY p.scheduled_at`
  ).all().map((r) => ({ ...r, adapted_payload: safeJson(r.adapted_payload) }));
  const queueEng = db.prepare(
    `SELECT e.id, e.kind, e.target, e.draft, e.status, e.created_at, a.display_name, a.platform
     FROM engagements e JOIN accounts a ON a.id=e.account_id WHERE e.status='drafted' ORDER BY e.created_at`
  ).all();
  const calendar = db.prepare(
    `SELECT p.id, p.platform, p.status, p.scheduled_at, a.display_name FROM posts p JOIN accounts a ON a.id=p.account_id
     ORDER BY p.scheduled_at DESC LIMIT 100`
  ).all();
  const auditRows = db.prepare(`SELECT ts, account_id, action, detail, shot FROM audit_log ORDER BY id DESC LIMIT 50`).all();
  // 自进化提案队列（人审闸门）：drafted 待审在前，最近已裁决的留档展示
  const proposals = db.prepare(`SELECT * FROM proposals ORDER BY (status='drafted') DESC, rowid DESC LIMIT 50`).all()
    .map((r) => ({
      id: r.id, kind: r.kind, platform: r.platform, account_id: r.account_id, basis: r.basis,
      status: r.status, created_at: r.created_at, decided_at: r.decided_at, applied_version: r.applied_version,
      payload: safeJson(r.payload),
    }));
  return { ok: true, now: nowIso(), accounts, queue: { posts: queuePosts, engagements: queueEng }, calendar, audit: auditRows, proposals };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}
