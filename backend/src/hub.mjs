#!/usr/bin/env node
// hub.mjs — 本地中控 CLI（规格 §4.2 命令表）。skill 只通过这些命令驱动 hub。
// 所有命令输出 JSON（skill 消费）；不向 stdout 打印非 JSON 的过程信息。
import { existsSync, readFileSync } from 'node:fs';
import { openDb, kvGet } from './db.mjs';
import { loadConfig } from './config.mjs';
import { nowIso } from './util.mjs';
import * as planner from './planner.mjs';
import * as evolution from './evolution.mjs';
import { startServer } from './server.mjs';

const cfg = loadConfig();
const db = openDb(cfg.paths.db);

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}
function usage() {
  print({
    ok: false,
    usage: [
      'node src/hub.mjs accounts list | add <platform> <name> [--mature（已有老号，跳过14天冷启动）] [--auto-publish（自动发布，红线1 v2）] | set <id> --auto-publish on|off | login <account_id> | remove <id>',
      'node src/hub.mjs plan <material_id> --platforms xhs,douyin --accounts <id,id> [--at "2026-11-24 10:00"] --payload-file <payload.json>',
      'node src/hub.mjs run [--due]',
      'node src/hub.mjs confirm <post_id>',
      'node src/hub.mjs interact <account_id> --plan <plan.json>',
      'node src/hub.mjs approve <engagement_id | batch:today>   |   reject <engagement_id>',
      'node src/hub.mjs health | review <post_id> [days] | doctor',
      // 自进化（EVOLUTION-SPEC）：proposals 是唯一进化入口；策略库/知识包只经人审 approve 后由 hub 落地
      'node src/hub.mjs strategy show <platform> | history <platform>',
      'node src/hub.mjs proposal add --kind strategy|knowledge|quota|engage --platform <p> [--account <id>] --payload-file <f> [--basis dom_snapshot|screenshot] | list [status] | approve <id> | reject <id>',
      'node src/hub.mjs knowledge sync [--platform <p>] | push <platform> | status',
      'node src/hub.mjs engage feedback <engagement_id>   # 回路③反馈采集（本期占位）',
      'node src/hub.mjs daemon | web | serve',
    ],
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
      return print(planner.doctor(db, cfg));
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
    default:
      return usage();
  }
}

main().catch((e) => {
  print({ ok: false, error: String((e && e.stack) || e) });
  process.exit(1);
});
