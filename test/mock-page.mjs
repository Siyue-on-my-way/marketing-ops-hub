// mock-page.mjs — round-runtime/适配器测试用假页面：实现 ego page API 的最小子集，
// 并记录调用日志（callLog），用于断言坑位纪律（滚动→重取坐标→点击）与红线 1（不点发布）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createMockPage(opts = {}) {
  const elements = opts.elements || [
    { tag: 'BUTTON', text: '上传投稿', selector: null },
    { tag: 'DIV', text: '填写资料', selector: null },
    { tag: 'INPUT', text: '填写标题', selector: '.title-input' },
    { tag: 'TEXTAREA', text: '填写简介', selector: '.desc-input' },
    { tag: 'BUTTON', text: '添加标签', selector: null },
    { tag: 'BUTTON', text: '提交稿件', selector: '.submit-btn' },
    { tag: 'DIV', text: '测试视频标题', selector: null },
    { tag: 'SPAN', text: '测试昵称', selector: '.username' },
    { tag: 'BUTTON', text: '赞', selector: '.like-btn' },
    { tag: 'BUTTON', text: '评论', selector: '.comment-btn' },
  ];
  const innerText = opts.innerText || '测试昵称 创作中心 上传投稿 填写资料';
  const callLog = [];
  const files = [];

  const describe = (el) => {
    const x = 100, y = 200;
    return { tag: el.tag, text: el.text, x, y, w: 50, h: 20, visible: true };
  };

  const page = {
    callLog,
    files,
    __closed: false,
    async goto(url, _o) { callLog.push({ op: 'GOTO', url }); return null; },
    async waitForLoadState() { callLog.push({ op: 'WAIT_LOAD' }); return null; },
    url() { return opts.url || 'https://mock.local/page'; },
    async title() { return 'mock'; },
    async screenshot({ path } = {}) {
      if (path) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex')); }
      callLog.push({ op: 'SHOT', path: path || null });
      return undefined;
    },
    async evaluate(expr, ...args) {
      if (expr.includes('/*JS_INNERTEXT*/')) return innerText;
      if (expr.includes('/*JS_FIND_BY_TEXT*/')) {
        const [needle] = args;
        const el = elements.find((e) => needle && e.text.includes(needle));
        callLog.push({ op: 'FIND_TEXT', needle });
        return el ? describe(el) : null;
      }
      if (expr.includes('/*JS_SCROLL_TEXT*/')) {
        const [needle] = args;
        const el = elements.find((e) => needle && e.text.includes(needle));
        callLog.push({ op: 'SCROLL_TEXT', needle });
        return el ? describe(el) : null;
      }
      if (expr.includes('/*JS_SET_VALUE_NATIVE*/')) {
        const [selector, text] = args;
        const known = elements.some((e) => e.selector === selector);
        callLog.push({ op: 'SET_VALUE', selector, length: String(text || '').length });
        return known ? { ok: true, length: String(text || '').length } : { ok: false, reason: 'not_found' };
      }
      if (expr.includes('/*JS_QUERY_FIRST_VISIBLE*/')) {
        const [selector] = args;
        const el = elements.find((e) => e.selector === selector);
        callLog.push({ op: 'QUERY_SEL', selector });
        return el ? describe(el) : null;
      }
      if (expr.includes('/*JS_SCROLL_SELECTOR*/')) {
        const [selector] = args;
        const el = elements.find((e) => e.selector === selector);
        callLog.push({ op: 'SCROLL_SEL', selector });
        return el ? describe(el) : null;
      }
      if (expr.includes('/*JS_READ_METRIC*/')) {
        const [label] = args;
        const m = (opts.metrics || {})[label];
        callLog.push({ op: 'READ_METRIC', label });
        return m == null ? null : m;
      }
      if (expr.includes('location.href')) return opts.url || 'https://mock.local/page';
      return null;
    },
    async waitForFileChooser({ timeout } = {}) {
      callLog.push({ op: 'WAIT_CHOOSER' });
      return { setFiles: async (fs) => { files.push(...fs); callLog.push({ op: 'SET_FILES', files: fs }); } };
    },
    async setInputFiles(sel, fs) {
      files.push(...(Array.isArray(fs) ? fs : [fs]));
      callLog.push({ op: 'SET_INPUT_FILES', selector: sel, files: fs });
      return null;
    },
    mouse: {
      async move(x, y) { callLog.push({ op: 'MOVE', x, y }); },
      async click(x, y) { callLog.push({ op: 'CLICK', x, y }); },
    },
    keyboard: {
      async insertText(t) { callLog.push({ op: 'INSERT_TEXT', length: String(t || '').length }); },
    },
  };
  return page;
}

/** mock ego 全局：globalThis.taskSpace / takeOverTaskSpace */
export function installMockEgo(page) {
  globalThis.takeOverTaskSpace = async (id) => ({ id, pages: async () => [page], userPage: async () => page, handOff: async () => { page.callLog.push({ op: 'HANDOFF' }); } });
  globalThis.taskSpace = globalThis.takeOverTaskSpace;
}
export function uninstallMockEgo() {
  delete globalThis.takeOverTaskSpace;
  delete globalThis.taskSpace;
}
