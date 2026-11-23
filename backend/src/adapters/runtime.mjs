// runtime.mjs — 适配器页面操作辅助（在 ego nodejs 沙箱内随适配器一起运行）。
// 坑位纪律统一封装在此，适配器代码不得绕过：
//  - 坑位 1：hover 才出现的按钮 → clickText(..., {hoverMs:1000})
//  - 坑位 2：滚动后坐标失效 → clickText 内部强制「滚动→重新取坐标→再点」
//  - 坑位 3：文本定位 TreeWalker（见 dom.mjs）
//  - 坑位 6：React 受控输入 → setValueNative（native setter + input 事件）
import {
  JS_INNERTEXT, JS_FIND_BY_TEXT, JS_SCROLL_TEXT, JS_SET_VALUE_NATIVE,
  JS_QUERY_FIRST_VISIBLE, JS_SCROLL_SELECTOR, JS_READ_METRIC, JS_DOC_URL,
} from './dom.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 拟人小停顿（毫秒区间随机）——红线 7 */
export const humanPause = (min = 800, max = 2200) =>
  sleep(min + Math.floor(Math.random() * Math.max(1, max - min)));

export async function evalJs(page, expr, ...args) {
  return page.evaluate(expr, ...args);
}
export async function pageText(page) {
  try { return (await page.evaluate(JS_INNERTEXT)) || ''; } catch { return ''; }
}
export async function docUrl(page) {
  try { return await page.evaluate(JS_DOC_URL); } catch { try { return page.url(); } catch { return null; } }
}
export async function findByText(page, needle, opts = {}) {
  try { return await page.evaluate(JS_FIND_BY_TEXT, needle, opts); } catch { return null; }
}
export async function scrollTextIntoView(page, needle, opts = {}) {
  try { return await page.evaluate(JS_SCROLL_TEXT, needle, opts); } catch { return null; }
}
export async function queryFirstVisible(page, selector) {
  try { return await page.evaluate(JS_QUERY_FIRST_VISIBLE, selector); } catch { return null; }
}
export async function scrollSelectorIntoView(page, selector) {
  try { return await page.evaluate(JS_SCROLL_SELECTOR, selector); } catch { return null; }
}
export async function readMetricByLabel(page, label) {
  try { return await page.evaluate(JS_READ_METRIC, label); } catch { return null; }
}
/** 坑位 6：React 受控输入；失败返回 {ok:false,...} 由调用方决定回退路径 */
export async function setValueNative(page, selector, text) {
  try { return await page.evaluate(JS_SET_VALUE_NATIVE, selector, text); }
  catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
}

/**
 * 文本定位点击（坑位 1/2/3 的完整纪律）：
 * 定位 → scrollIntoView(center) → 重新取坐标 → move → (hover 等待) → click。
 * 返回 {clicked, info?, reason?}；找不到/不可见一律失败返回，绝不盲点。
 */
export async function clickText(page, mouse, needle, { exact = false, hoverMs = 0 } = {}) {
  let info = await findByText(page, needle, { exact });
  if (!info) return { clicked: false, reason: 'not_found: ' + needle };
  await scrollTextIntoView(page, needle, { exact });
  await humanPause(300, 900);
  info = await findByText(page, needle, { exact }); // 坑位 2：滚动后重新取坐标
  if (!info || !info.visible) return { clicked: false, reason: 'not_visible_after_scroll: ' + needle };
  await mouse.move(info.x, info.y);
  if (hoverMs) await sleep(hoverMs); // 坑位 1：hover 才出现的按钮
  await mouse.click(info.x, info.y);
  return { clicked: true, info };
}

/** 选择器点击（选择器来自知识包，禁止代码内写死）：同样遵守滚动→重取坐标→点击 */
export async function clickSelector(page, mouse, selector, { hoverMs = 0 } = {}) {
  let info = await queryFirstVisible(page, selector);
  if (!info) return { clicked: false, reason: 'not_found: ' + selector };
  await scrollSelectorIntoView(page, selector);
  await humanPause(300, 900);
  info = await queryFirstVisible(page, selector); // 坑位 2
  if (!info) return { clicked: false, reason: 'not_visible_after_scroll: ' + selector };
  await mouse.move(info.x, info.y);
  if (hoverMs) await sleep(hoverMs);
  await mouse.click(info.x, info.y);
  return { clicked: true, info };
}

/**
 * 文本输入统一入口：优先 native setter（选择器来自知识包），
 * 失败回退「点击聚焦 + keyboard.insertText」（坑位 6 的兜底路径）。
 */
export async function typeInto(page, keyboard, { selector, focusText, text, maxLen }) {
  const value = maxLen ? String(text ?? '').slice(0, maxLen) : String(text ?? '');
  if (selector) {
    const r = await setValueNative(page, selector, value);
    if (r && r.ok) return { ok: true, via: 'native_setter' };
  }
  if (focusText) {
    const c = await clickText(page, page.mouse, focusText);
    if (c.clicked) {
      try { await keyboard.insertText(value); return { ok: true, via: 'insertText', warn: selector ? 'native_setter 失败已回退 insertText' : null }; }
      catch (e) { return { ok: false, reason: 'insertText_failed: ' + String(e) }; }
    }
    return { ok: false, reason: 'focus_not_found: ' + focusText };
  }
  return { ok: false, reason: 'no_selector_and_no_focus_text' };
}

/** 保存截图（saveShot 的适配器侧薄封装） */
export async function shot(ctx, name) {
  try { return await ctx.shot(name); } catch { return null; }
}

/** 轮询等待某文本出现（如转码完成、表单就绪） */
export async function waitText(page, needle, timeoutMs = 60000, { interval = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await findByText(page, needle);
    if (hit) return hit;
    await sleep(interval);
  }
  return null;
}
