// ego.mjs — hub 侧 ego 执行桥：生成 round 脚本 + 调用 ego + 解析 stdout JSON 协议。
// hub 不直接跑 ego：每轮一个新 round 脚本文件（规格 §4.5），幂等、可追溯、崩溃可重放。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nowIso } from './util.mjs';
import { ROOT } from './db.mjs';

export function egoExe(cfg) {
  return (cfg.ego && cfg.ego.path) || process.env.MAITIAN_EGO_PATH || '';
}

export function writeRoundScript(cfg, P) {
  mkdirSync(cfg.paths.runs, { recursive: true });
  const runtimeUrl = pathToFileURL(join(ROOT, 'src', 'ego', 'round-runtime.mjs')).href;
  const script =
    `// 自动生成 round 脚本（hub ${nowIso()}）— 幂等、可追溯；勿手改，重跑=重新生成\n` +
    `const P = ${JSON.stringify(P, null, 2)};\n` +
    `await import(${JSON.stringify(runtimeUrl)}).then((m) => m.run(P));\n`;
  const file = join(cfg.paths.runs, `${Date.now()}-${P.action}.mjs`);
  writeFileSync(file, script);
  return file;
}

/**
 * 调用 ego 执行 round 脚本：`<ego> nodejs -e "await import('file:///<脚本绝对路径>')"`。
 * Windows PowerShell 5.1 会把 stderr 报成 NativeCommandError，不代表失败（坑位 10）：
 * 判定一律以 stdout 的 @@RESULT@@ JSON + 退出码为准。
 */
export function runEgo(cfg, scriptPath, { timeoutMs = 180000 } = {}) {
  const exe = egoExe(cfg);
  if (!exe) {
    return { ok: false, error: 'EGO_NOT_CONFIGURED: 未配置 ego 全路径，请先运行 content-hub/scripts/doctor（不臆造路径）' };
  }
  if (!existsSync(exe)) {
    return { ok: false, error: 'EGO_NOT_FOUND: 配置的 ego 路径不存在: ' + exe };
  }
  const url = pathToFileURL(scriptPath).href;
  const r = spawnSync(exe, ['nodejs', '-e', `await import(${JSON.stringify(url)})`], {
    timeout: timeoutMs,
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true,
  });
  const parsed = parseEgoStdout(r.stdout || '');
  if (parsed) return parsed;
  if (r.signal === 'SIGTERM' || (r.error && r.error.code === 'ETIMEDOUT')) {
    return { ok: false, error: `EGO_TIMEOUT: 超过 ${timeoutMs}ms 未完成`, timed_out: true };
  }
  if (r.error) return { ok: false, error: 'EGO_SPAWN_FAILED: ' + (r.error.message || String(r.error)) };
  if (r.status !== 0) return { ok: false, error: `EGO_EXIT_${r.status}: ${(r.stderr || '').slice(0, 500)}` };
  return { ok: false, error: 'EGO_NO_RESULT: round 脚本未按协议输出 @@RESULT@@ JSON。stdout 前 300 字: ' + (r.stdout || '').slice(0, 300) };
}

export function parseEgoStdout(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    const m = t.startsWith('@@RESULT@@') ? t.slice('@@RESULT@@'.length) : t;
    if (!m.startsWith('{')) continue;
    try {
      const j = JSON.parse(m);
      if (typeof j.ok === 'boolean') return j;
    } catch { /* 继续向前找 */ }
  }
  return null;
}
