#!/usr/bin/env node
// hub.mjs — 本地中控 CLI（规格 §4.2 命令表）。skill 只通过这些命令驱动 hub。
// 所有命令输出 JSON（skill 消费）；不向 stdout 打印非 JSON 的过程信息。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, kvGet } from './db.mjs';
import { loadConfig, credentialsPath } from './config.mjs';
import { nowIso } from './util.mjs';
import * as planner from './planner.mjs';
import * as evolution from './evolution.mjs';
import * as cloud from './cloud-client.mjs';
import { startServer } from './server.mjs';

const cfg = loadConfig();
const db = openDb(cfg.paths.db);

/** 读取 join 时写入的本机凭证；未入职返回 null */
function loadJoinedKey() {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}
// ---------- 机器可读命令目录（MCP tools/list 同思路）：hub tools / hub help ----------
const CATALOG = [
  { name: 'accounts list', args: '', desc: '列出本机已录入平台账号（id/platform/昵称/status/登录态/配额/trust_score）' },
  { name: 'accounts add', args: '<platform> <name> [--mature] [--auto-publish] [--device <d>]', desc: '录入平台账号（platform ∈ xhs,douyin,tiktok,yt,bili,x,xianyu）；--mature=老号跳过14天冷启动；--auto-publish=发布走 auto 模式' },
  { name: 'accounts set', args: '<id> --auto-publish on|off', desc: '切换账号自动发布模式' },
  { name: 'accounts login', args: '<account_id>', desc: '弹出 ego 浏览器登录该账号（用户手机扫码，等最多10分钟）' },
  { name: 'accounts remove', args: '<id>', desc: '移除平台账号' },
  { name: 'plan', args: '<material_id> --platforms xhs,douyin --accounts <id,id> [--at "YYYY-MM-DD HH:mm"] --payload-file <payload.json>', desc: '建发布任务（payload=AI 改写后的各平台文案 JSON，先落库）' },
  { name: 'run', args: '[--due]', desc: '执行到期任务：登录预检→配额/防重校验→填写→截图→（开 --auto-publish 的账号）自动发布+回读 /（默认 review）停下待人点发布' },
  { name: 'confirm', args: '<post_id>', desc: 'review 账号专用：人已亲手点发布，回读确认→published' },
  { name: 'interact', args: '<account_id> --plan <plan.json>', desc: '生成互动计划（点赞/评论/私聊/话题回复），草拟全部入大屏待人 approve 后才执行' },
  { name: 'approve', args: '<engagement_id | batch:today>', desc: '人审通过互动（当前所有互动均需大屏 approve 后才执行）' },
  { name: 'reject', args: '<engagement_id>', desc: '驳回互动草拟' },
  { name: 'health', args: '', desc: '账号健康总览（trust_score/配额用量/风控事件/登录态）' },
  { name: 'review', args: '<post_id> [days=7]', desc: '复盘卡片（第1/3/7天数据+与上期同龄对比）' },
  { name: 'doctor', args: '', desc: '环境自检（ego/hub/各账号登录态/云端连通）→ JSON' },
  { name: 'join', args: '<API密钥>', desc: '门户「密钥管理」复制密钥，一次性绑定本机到 workspace' },
  { name: 'whoami', args: '', desc: '用已存 API key 查询当前用户/租户/密钥/素材统计' },
  { name: 'materials', args: '[--platform p] [--limit n]', desc: '列出云端素材（云不可达自动降级本地缓存）' },
  { name: 'strategy show', args: '<platform>', desc: '查看平台当前策略库版本' },
  { name: 'strategy history', args: '<platform>', desc: '策略库历史版本' },
  { name: 'proposal add', args: '--kind strategy|knowledge|quota|engage --platform <p> [--account <id>] --payload-file <f> [--basis dom_snapshot|screenshot]', desc: '提交进化提案（唯一进化入口，人审后生效）' },
  { name: 'proposal list', args: '[status]', desc: '列出进化提案' },
  { name: 'proposal approve', args: '<id>', desc: '批准并落地进化提案' },
  { name: 'proposal reject', args: '<id>', desc: '驳回进化提案' },
  { name: 'knowledge sync', args: '[--platform p]', desc: '从云端拉取最新知识包' },
  { name: 'knowledge push', args: '<platform>', desc: '推送本地知识包到云端（乐观锁）' },
  { name: 'knowledge status', args: '', desc: '本地/云端知识包版本对照' },
  { name: 'engage feedback', args: '<engagement_id>', desc: '互动效果反馈采集（回路③）' },
  { name: 'daemon', args: '', desc: '常驻守护：到点自动执行到期任务' },
  { name: 'web', args: '', desc: '启动大屏 :8787' },
  { name: 'serve', args: '', desc: 'daemon + web 一起跑' },
  { name: 'version', args: '', desc: '版本号' },
  { name: 'tools', args: '', desc: '本目录（机器可读，agent 自发现入口）' },
];
function toolCatalog(cfg) {
  const base = (cfg.cloud && cfg.cloud.base_url || '').replace(/\/$/, '');
  return {
    ok: true,
    service: 'maitian-hub-cli',
    version: '0.1.0',
    protocol: '所有命令输出 JSON；成功 ok:true，失败 ok:false + error。agent 按目录参数拼命令即可，输出都可直接解析。',
    commands: CATALOG,
    discovery: {
      cloud_http_api: base ? 'GET ' + base + '/v1/endpoints（Bearer API key）——云端素材/密钥/知识包 HTTP 接口目录' : 'GET <cloud>/v1/endpoints（Bearer API key）——先在 config.json 配置 cloud.base_url',
      skill_doc: 'content-hub/SKILL.md —— 完整流程编排与红线',
    },
  };
}
function usage() {
  print({
    ok: false,
    error: '未知命令或参数不足',
    usage: CATALOG.map((c) => 'node src/hub.mjs ' + c.name + (c.args ? ' ' + c.args : '') + '    # ' + c.desc),
    hint: 'node src/hub.mjs tools   # 机器可读命令目录（agent 自发现入口）',
  });
  process.exitCode = 1;
}

function argFlag(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes('--' + name);

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'accounts': {
      if (sub === 'list') return print(planner.accountsList(db, cfg));
      if (sub === 'add') {
        const [platform, name] = rest;
        if (!platform || !name) return usage();
        return print(planner.accountsAdd(db, cfg, platform, name, argFlag('device'), { mature: hasFlag('mature'), autoPublish: hasFlag('auto-publish') }));
      }
      if (sub === 'set') {
        const [id] = rest;
        if (!id) return usage();
        const ap = argFlag('auto-publish');
        if (ap === undefined || !['on', 'off'].includes(ap)) return print({ ok: false, error: '需要 --auto-publish on|off' });
        return print(planner.accountsSetAutoPublish(db, cfg, id, ap === 'on'));
      }
      if (sub === 'login') {
        const [id] = rest;
        if (!id) return usage();
        return print(await planner.accountLogin(db, cfg, id));
      }
      if (sub === 'remove') {
        const [id] = rest;
        if (!id) return usage();
        return print(planner.accountsRemove(db, id));
      }
      return usage();
    }
    case 'plan': {
      const materialId = sub;
      if (!materialId) return usage();
      return print(planner.plan(db, cfg, materialId, {
        platforms: argFlag('platforms'),
        accounts: argFlag('accounts'),
        at: argFlag('at'),
        payloadFile: argFlag('payload-file'),
      }));
    }
    case 'run':
      return print(await planner.run(db, cfg, { due: hasFlag('due') }));
    case 'confirm': {
      const id = sub;
      if (!id) return usage();
      return print(await planner.confirm(db, cfg, id));
    }
    case 'interact': {
      const accountId = sub;
      if (!accountId) return usage();
      const r = planner.interact(db, cfg, accountId, argFlag('plan'));
      if (r.ok && hasFlag('execute')) r.executed = await planner.executeApproved(db, cfg, accountId);
      return print(r);
    }
    case 'approve': {
      if (!sub) return usage();
      return print(planner.approve(db, cfg, sub));
    }
    case 'reject': {
      if (!sub) return usage();
      return print(planner.reject(db, cfg, sub));
    }
    case 'health':
      return print(planner.health(db, cfg));
    case 'review': {
      const id = sub;
      if (!id) return usage();
      return print(planner.review(db, cfg, id, Number(rest[0]) || 7));
    }
    case 'doctor':
      return print(await planner.doctor(db, cfg));
    // ---------- 访问体系（ACCESS-SPEC v1.2）：门户注册 → 复制默认密钥 → join 入职 ----------
    case 'join': {
      const key = (sub && !sub.startsWith('--') ? sub : '') || argFlag('key') || '';
      if (!key) {
        return print({ ok: false, error: '用法: hub join <你的API密钥>（登录门户 http://<服务器>/ → 密钥管理 → 复制默认密钥）' });
      }
      if (!cfg.cloud.base_url) return print({ ok: false, error: 'config.json 未配置 cloud.base_url' });
      let who;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(cfg.cloud.base_url.replace(/\/$/, '') + '/v1/whoami', {
          headers: { authorization: 'Bearer ' + key }, signal: ctrl.signal,
        });
        clearTimeout(t);
        who = await res.json().catch(() => ({}));
        if (res.status !== 200 || !who.ok) return print({ ok: false, error: '密钥校验失败（HTTP ' + res.status + '）：' + (who.error || '无效密钥') });
      } catch (e) {
        return print({ ok: false, error: '无法连接云服务: ' + String(e && e.message || e) });
      }
      mkdirSync(dirname(cfg.paths.db), { recursive: true });
      const credPath = credentialsPath();
      writeFileSync(credPath, JSON.stringify({ api_key: key, tenant_id: who.tenant_id, tenant_name: who.tenant_name, user: who.user, joined_at: nowIso() }, null, 2) + '\n');
      try { chmodSync(credPath, 0o600); } catch { /* Windows 忽略 */ }
      return print({ ok: true, tenant_id: who.tenant_id, tenant_name: who.tenant_name, user: who.user, key_name: who.key_name, credentials: credPath, note: '已写入本机凭证（0600）；hub doctor 可复查' });
    }
    // ---------- CLI 凭证通道：用已存 API key 查用户档案 / 云端素材 ----------
    case 'whoami': {
      const cred = loadJoinedKey();
      if (!cred || !cred.api_key) return print({ ok: false, error: '尚未入职：先执行 hub join <API密钥>（登录门户 →「密钥管理」复制默认密钥）' });
      return print(await cloud.api(cfg, cred.api_key, 'GET', '/v1/whoami'));
    }
    case 'materials': {
      const cred = loadJoinedKey();
      if (!cred || !cred.api_key) return print({ ok: false, error: '尚未入职：先执行 hub join <API密钥>（登录门户 →「密钥管理」复制默认密钥）' });
      const platform = argFlag('platform') || '';
      const limit = Math.max(1, Math.min(100, Number(argFlag('limit') || 20)));
      return print(await cloud.listMaterials(db, cfg, cred.api_key, platform, limit));
    }
    // ---------- 自进化（EVOLUTION-SPEC）：proposals 唯一进化入口 ----------
    case 'strategy': {
      if (sub === 'show') {
        if (!rest[0]) return usage();
        return print(evolution.strategyShow(cfg, rest[0]));
      }
      if (sub === 'history') {
        if (!rest[0]) return usage();
        return print(evolution.strategyHistory(cfg, rest[0]));
      }
      return usage();
    }
    case 'proposal': {
      if (sub === 'add') {
        const pf = argFlag('payload-file');
        if (!pf || !existsSync(pf)) return print({ ok: false, error: '必须提供 --payload-file <提案 JSON>' });
        let payload;
        try { payload = JSON.parse(readFileSync(pf, 'utf8')); } catch (e) { return print({ ok: false, error: 'payload-file 解析失败: ' + e.message }); }
        return print(evolution.proposalAdd(db, cfg, {
          kind: argFlag('kind'),
          platform: argFlag('platform'),
          accountId: argFlag('account'),
          payload,
          basis: argFlag('basis'),
        }));
      }
      if (sub === 'list') return print(evolution.proposalList(db, cfg, rest[0]));
      if (sub === 'approve') {
        if (!rest[0]) return usage();
        return print(await evolution.proposalApprove(db, cfg, rest[0]));
      }
      if (sub === 'reject') {
        if (!rest[0]) return usage();
        return print(evolution.proposalReject(db, cfg, rest[0]));
      }
      return usage();
    }
    case 'knowledge': {
      if (sub === 'sync') return print(await evolution.knowledgeSync(db, cfg, { platform: argFlag('platform') }));
      if (sub === 'push') {
        if (!rest[0]) return usage();
        return print(await evolution.knowledgePush(db, cfg, rest[0]));
      }
      if (sub === 'status') return print(evolution.knowledgeStatus(db, cfg));
      return usage();
    }
    case 'engage': {
      if (sub === 'feedback') {
        if (!rest[0]) return usage();
        return print(await evolution.collectEngagementFeedback(db, cfg, rest[0]));
      }
      return usage();
    }
    case 'daemon':
      await planner.daemonLoop(db, cfg);
      return;
    case 'web':
      startServer(db, cfg);
      return;
    case 'serve':
      startServer(db, cfg);
      await planner.daemonLoop(db, cfg);
      return;
    case 'version':
      return print({ ok: true, version: '0.1.0', now: nowIso(), daemon_heartbeat: kvGet(db, 'daemon_heartbeat') });
    case 'help':
    case 'tools':
      return print(toolCatalog(cfg));
    default:
      return usage();
  }
}

main().catch((e) => {
  print({ ok: false, error: String((e && e.stack) || e) });
  process.exit(1);
});
