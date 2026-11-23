// dom.mjs — 页面内执行的 JS 表达式（字符串形态，供 page.evaluate 使用）。
// 约束：这些代码运行在浏览器上下文里，禁止 import；每条表达式以 /*JS_*/// 标记开头，供 mock 测试分发。
// 坑位 3：文本定位一律用 TreeWalker（按 textContent 匹配），禁止裸 querySelector 猜 hash 类名。

export const JS_INNERTEXT = `/*JS_INNERTEXT*/ () => {
  const b = document.body;
  return b ? (b.innerText || '') : '';
}`;

export const JS_FIND_BY_TEXT = `/*JS_FIND_BY_TEXT*/ (needle, opts) => {
  opts = opts || {};
  if (!needle) return null;
  const root = document.body;
  if (!root) return null;
  const visible = (el) => {
    try {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  };
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: String(el.innerText || el.textContent || '').trim().slice(0, 80),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
    };
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const t = n.nodeValue.trim();
      if (!t) return NodeFilter.FILTER_REJECT;
      const parent = n.parentElement;
      if (parent && !visible(parent)) return NodeFilter.FILTER_REJECT;
      const hit = opts.exact ? (t === needle) : t.includes(needle);
      return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    let el = node.parentElement;
    for (let i = 0; i < 6 && el; i++) {
      const clickable = el.tagName === 'BUTTON' || el.tagName === 'A' ||
        el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab');
      if (clickable) return describe(el);
      el = el.parentElement;
    }
    return describe(node.parentElement);
  }
  return null;
}`;

export const JS_SCROLL_TEXT = `/*JS_SCROLL_TEXT*/ (needle, opts) => {
  opts = opts || {};
  const root = document.body;
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const t = n.nodeValue.trim();
      const hit = opts.exact ? (t === needle) : t.includes(needle);
      return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    let el = node.parentElement;
    if (!el) continue;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {
      try { el.scrollIntoView({ block: 'center' }); } catch (e2) {}
    }
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: String(el.innerText || '').trim().slice(0, 80),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      visible: r.width > 0 && r.height > 0,
    };
  }
  return null;
}`;

export const JS_SET_VALUE_NATIVE = `/*JS_SET_VALUE_NATIVE*/ (selector, text) => {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: 'not_found' };
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  el.focus();
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
    : (el instanceof HTMLInputElement) ? HTMLInputElement.prototype : null;
  if (!proto) {
    // contenteditable 等：退化为 insertText 由调用方处理
    return { ok: false, reason: 'not_input' };
  }
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; // 坑位 6：React 受控输入
  setter.call(el, text == null ? '' : String(text));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, length: String(text == null ? '' : text).length };
}`;

export const JS_QUERY_FIRST_VISIBLE = `/*JS_QUERY_FIRST_VISIBLE*/ (selector) => {
  let els = [];
  try { els = Array.from(document.querySelectorAll(selector)); } catch (e) { return null; }
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return {
        tag: el.tagName,
        text: String(el.innerText || '').trim().slice(0, 60),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        visible: true,
      };
    }
  }
  return null;
}`;

export const JS_SCROLL_SELECTOR = `/*JS_SCROLL_SELECTOR*/ (selector) => {
  let els = [];
  try { els = Array.from(document.querySelectorAll(selector)); } catch (e) { return null; }
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
      const r2 = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: String(el.innerText || '').trim().slice(0, 60),
        x: Math.round(r2.x + r2.width / 2),
        y: Math.round(r2.y + r2.height / 2),
        visible: true,
      };
    }
  }
  return null;
}`;

export const JS_READ_METRIC = `/*JS_READ_METRIC*/ (label) => {
  const root = document.body;
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = (n.nodeValue || '').trim();
      return t && t.includes(label) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node = walker.nextNode();
  if (!node) return null;
  let cell = node.parentElement;
  for (let i = 0; i < 6 && cell; i++) {
    const scope = cell.parentElement ? Array.from(cell.parentElement.children) : [cell];
    for (const sib of scope) {
      const m = String(sib.innerText || '').match(/(-?[\\d,][\\d,.]*\\s*[万kKwW]?)/);
      if (m) {
        let v = m[1].trim().replace(/,/g, '');
        let mult = 1;
        if (/[万wW]/.test(v)) { mult = 10000; v = v.replace(/[万wW]/g, ''); }
        if (/[kK]/.test(v)) { mult = 1000; v = v.replace(/[kK]/g, ''); }
        const n = parseFloat(v);
        if (!Number.isNaN(n)) return Math.round(n * mult);
      }
    }
    cell = cell.parentElement;
  }
  return null;
}`;

export const JS_DOC_URL = `/*JS_DOC_URL*/ () => location.href`;
