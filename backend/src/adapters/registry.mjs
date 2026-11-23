// registry.mjs — 平台适配器注册表（麦田 ADAPTERS 风格，自研多账号版）。
// 适配器接口（规格 §4.4）：
//   preflight(page) -> {need_login, displayName?}
//   login(page, payload, k, ctx) -> {loggedIn, displayName?} | {need_login}
//   fill(page, payload, k, ctx) -> {drafted:true, warn:[...]}   —— 填完即停，绝不点发布（红线 1）
//   verify(page, payload, k, ctx) -> {ok, url?}
//   collect(page, payload, k, ctx) -> {ok, metrics{views,likes,comments,shares,followers_delta}}
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const loaded = new Map();

export function adapterPath(cfg, platform) {
  return join(cfg.paths.adapters, platform + '.mjs');
}
export function knowledgePath(cfg, platform) {
  return join(cfg.paths.knowledge, platform + '.json');
}
export function hasAdapter(cfg, platform) {
  return existsSync(adapterPath(cfg, platform)) && existsSync(knowledgePath(cfg, platform));
}

export async function getAdapter(cfg, platform) {
  if (loaded.has(platform)) return loaded.get(platform);
  if (!hasAdapter(cfg, platform)) {
    throw new Error(`ADAPTER_MISSING: ${platform} 缺少适配器或知识包（${adapterPath(cfg, platform)} / ${knowledgePath(cfg, platform)}）`);
  }
  const mod = await import(pathToFileURL(adapterPath(cfg, platform)).href);
  loaded.set(platform, mod.default);
  return mod.default;
}

export function readKnowledge(cfg, platform) {
  return JSON.parse(readFileSync(knowledgePath(cfg, platform), 'utf8'));
}
