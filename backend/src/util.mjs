// util.mjs — 通用小工具（零依赖）
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const nowIso = () => new Date().toISOString();
export const newId = (p = '') => p + randomUUID().slice(0, 8);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [min,max] 闭区间随机整数 —— 拟人抖动（红线 7） */
export const jitter = ([min, max]) => min + Math.floor(Math.random() * (max - min + 1));

/** 本地时区 yyyy-mm-dd */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 本地时间 "yyyy-mm-dd HH:MM" 解析为 Date（hub plan --at 用） */
export function parseLocal(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);
  return null;
}
export function inActiveHours(cfg, d = new Date()) {
  const [a, b] = cfg.cadence?.active_hours ?? [9, 21];
  const h = d.getHours();
  return h >= a && h < b;
}
export function ok(data) { return { ok: true, data }; }
export function fail(error, extra = {}) { return { ok: false, error: String(error), ...extra }; }

export function readJsonArg(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
