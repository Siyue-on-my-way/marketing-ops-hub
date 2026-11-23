// round-runtime.mjs — round 脚本运行时。每轮由 hub 生成一个脚本文件（幂等、可追溯），
// 该运行时在 ego nodejs 沙箱内执行；测试环境可通过注入 globalThis.taskSpace 等 mock 运行。
// 输出协议：stdout 最后一行 `@@RESULT@@{json}`，形如 {ok, data?, shot?, error?}（规格 §4.5）。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageText, queryFirstVisible } from '../adapters/runtime.mjs';

const out = (j) => { console.log('@@RESULT@@' + JSON.stringify(j)); };

/** 账号→space（§4.5）：优先接管既有 space；不存在则按 acct-<id> 创建 */
async function openSpace(account) {
  if (typeof globalThis.takeOverTaskSpace === 'function') {
    try { return await globalThis.takeOverTaskSpace(account.ego_space_id); }
    catch { /* space 不存在 → 继续走新建 */ }
  }
  if (typeof globalThis.taskSpace !== 'function') {
    throw new Error('EGO_API_MISSING: taskSpace 不可用——本脚本必须在 ego nodejs 内运行');
  }
  return globalThis.taskSpace('acct-' + account.id);
}

async function pickPage(task, url) {
  let page = null;
  try { const pages = await task.pages(); if (Array.isArray(pages) && pages.length) page = pages[0]; } catch {}
  if (!page) { try { page = await task.userPage(); } catch {} }
  if (!page) throw new Error('EGO_NO_PAGE: task space 内无可用页面');
  if (url) {
    await page.goto(url, { timeout: 60000 });
    try { await page.waitForLoadState(); } catch {}
  }
  return page;
}

export async function saveShot(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  try {
    const r = await page.screenshot({ path: file });
    // 兼容两种实现：ego 直接落盘（返回 undefined）或返回 base64/dataURL（此处补写盘）
    if (typeof r === 'string' && r.length > 128) {
      const b64 = r.includes(',') ? r.split(',')[1] : r;
      writeFileSync(file, Buffer.from(b64, 'base64'));
    }
  } catch (e) {
    return null; // 截图失败不阻塞主流程，但记录在案
  }
  return file;
}

/** 风控检测（§4.5：每个动作前调用；知识包 risk 数组：纯文本 / re:正则 / sel:选择器） */
export async function detectRisk(page, k) {
  const hits = [];
  const text = await pageText(page);
  for (const s of (k && k.risk) || []) {
    try {
      if (s.startsWith('re:')) { if (new RegExp(s.slice(3), 'i').test(text)) hits.push(s); }
      else if (s.startsWith('sel:')) { if (await queryFirstVisible(page, s.slice(4))) hits.push(s); }
      else if (s && text.includes(s)) hits.push(s);
    } catch { /* 单条信号检测失败不影响整体 */ }
  }
  return hits;
}

/**
 * P = {
 *   action, op,                       // 如 'fill-bili' / 'fill'
 *   account: {id, ego_space_id, display_name, platform},
 *   params: {url?, payload?},
 *   paths: {knowledge, adapter, shotDir, shotName},
 * }
 */
export async function run(P) {
  let page = null;
  try {
    const k = JSON.parse(readFileSync(P.paths.knowledge, 'utf8'));
    const adapter = (await import(pathToFileURL(P.paths.adapter).href)).default;
    const task = await openSpace(P.account);
    const url = (P.params && P.params.url) || (k.pages && k.pages.login && k.pages.login.url);
    page = await pickPage(task, url);
    try { await page.waitForLoadState(); } catch {}

    if (P.op !== 'login') {
      const risk = await detectRisk(page, k);
      if (risk.length) {
        const shot = await saveShot(page, P.paths.shotDir, P.paths.shotName + '-risk');
        return out({ ok: false, error: 'RISK_SIGNAL', data: { risk }, shot });
      }
    }

    const fn = adapter[P.op];
    if (typeof fn !== 'function') return out({ ok: false, error: 'BAD_OP: ' + P.op });
    const ctx = {
      account: P.account,
      task,
      postId: P.params && P.params.postId,
      engagementId: P.params && P.params.engagementId,
      handOff: () => task.handOff(),  // 控制权交还用户（扫码/权限弹窗）
      userPage: () => task.userPage(),
      shot: (name) => saveShot(page, P.paths.shotDir, `${P.paths.shotName}-${name}`),
    };
    const data = (await fn(page, (P.params && P.params.payload) || null, k, ctx)) || {};
    const shot = await saveShot(page, P.paths.shotDir, P.paths.shotName);
    return out({ ok: true, data, shot });
  } catch (e) {
    let shot = null;
    try { if (page) shot = await saveShot(page, P.paths.shotDir, P.paths.shotName + '-err'); } catch {}
    return out({ ok: false, error: String((e && e.stack) || e), shot });
  }
}
