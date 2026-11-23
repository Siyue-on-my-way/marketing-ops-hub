// config.mjs — 配置加载（config.json 优先，缺省回退 config.example.json；环境变量可覆盖）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './db.mjs';

const DEFAULTS = {
  hub: { host: '127.0.0.1', port: 8787 },
  ego: { path: '' },
  cloud: { base_url: '' },
  cadence: { active_hours: [9, 21], post_gap_sec: [120, 300], interact_gap_sec: [30, 120], session_max_min: 120 },
  quota_default: { post: 2, like: 30, comment: 5, dm: 10 },
  cold_start_days: 14,
};

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || typeof over !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function loadConfig() {
  let fileCfg = {};
  // 配置查找：/app/config.json（compose 挂载 :ro）→ ROOT/config.json → ROOT/config.example.json
  for (const p of ['/app/config.json', join(ROOT, 'config.json'), join(ROOT, 'config.example.json'), join(ROOT, 'config', 'config.example.json')]) {
    if (existsSync(p)) { fileCfg = JSON.parse(readFileSync(p, 'utf8')); break; }
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);
  if (process.env.MAITIAN_HUB_HOST) cfg.hub.host = process.env.MAITIAN_HUB_HOST;
  // 目录约定：默认相对 backend/；容器内经 MAITIAN_DATA_DIR / MAITIAN_VAR_DIR 重定向到挂载卷
  const dataDir = process.env.MAITIAN_DATA_DIR || join(ROOT, 'data');
  const varDir = process.env.MAITIAN_VAR_DIR || join(ROOT, 'var');
  cfg.paths = {
    db: join(dataDir, 'hub.db'),
    runs: join(varDir, 'runs'),
    shots: join(varDir, 'shots'),
    cache: join(varDir, 'cache'),
    adapters: join(ROOT, 'src', 'adapters'),
    // 知识包：env（容器 /app/knowledge）→ 仓库根 content-hub/docs/knowledge（本机模式）→ ROOT/knowledge
    knowledge: process.env.MAITIAN_KNOWLEDGE_DIR
      || [join(ROOT, '..', 'content-hub', 'docs', 'knowledge'), join(ROOT, 'knowledge')].find(existsSync)
      || join(ROOT, '..', 'content-hub', 'docs', 'knowledge'),
  };
  if (process.env.MAITIAN_CLOUD_URL) cfg.cloud.base_url = process.env.MAITIAN_CLOUD_URL;
  return cfg;
}

export const workspaceKey = () => process.env.MAITIAN_WORKSPACE_KEY || '';

export const PLATFORMS = ['xhs', 'douyin', 'tiktok', 'yt', 'bili', 'x', 'xianyu'];
export const PLATFORM_NAMES = {
  xhs: '小红书', douyin: '抖音', tiktok: 'TikTok', yt: 'YouTube',
  bili: 'Bilibili', x: 'X', xianyu: '闲鱼',
};
