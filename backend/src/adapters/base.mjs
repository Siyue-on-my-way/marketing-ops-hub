// base.mjs — 平台适配器基类。preflight/login/verify/collect 为知识包驱动的通用实现；
// 各平台文件只需实现 fill（发布填写，填完即停，绝不点击发布——红线 1）。
// 选择器/文本全部来自知识包 JSON（docs/knowledge/<platform>.json），代码写死 hash 类名视为 bug。
import {
  findByText, scrollSelectorIntoView, scrollTextIntoView, clickText, clickSelector, typeInto, humanPause,
  readMetricByLabel, docUrl, shot,
} from './runtime.mjs';

/**
 * 红线 1 的收尾动作（各平台 fill 复用）：只滚动到提交按钮、重新取坐标供截图留证，
 * **绝不点击**。适配器代码中「点击发布/提交」这一动作不存在。
 */
export async function revealSubmitOnly(page, k, warn) {
  const P = (k.pages && k.pages.publish) || {};
  if (P.submit_sel) {
    const info = await scrollSelectorIntoView(page, P.submit_sel); // 只滚动定位，不点击
    if (!info) warn.push('未定位到提交按钮(' + P.submit_sel + ')，请人工在页面上找到发布按钮');
    return info;
  }
  if (P.submit_text) {
    const hit = await findByText(page, P.submit_text);
    if (hit) {
      await scrollTextIntoView(page, P.submit_text); // 只滚动定位，不点击
      const again = await findByText(page, P.submit_text); // 坑位 2：滚动后重取
      return again;
    }
    warn.push('未定位到提交按钮文本(' + P.submit_text + ')，请人工在页面上找到发布按钮');
    return null;
  }
  warn.push('知识包未配置 submit_sel/submit_text，请人工确认发布按钮位置');
  return null;
}

export function makeAdapter(spec) {
  const adapter = {
    id: spec.id,

    /** 登录预检：只读判断（快照找昵称/登录文本），不写不点 */
    async preflight(page, _payload, k, ctx) {
      const L = k.pages && k.pages.login;
      await humanPause(1000, 2500);
      if (L && L.check_text) {
        const hit = await findByText(page, L.check_text);
        if (!hit) return { need_login: true };
      }
      let displayName = null;
      if (L && L.display_name_text) {
        const hit = await findByText(page, L.display_name_text);
        displayName = hit ? hit.text : null;
      }
      return { need_login: false, displayName };
    },

    /** 登录：handOff 把控制权交还用户扫码（D1：扫码永远人做）；轮询 9.5 分钟，超时 need_login */
    async login(page, _payload, k, ctx) {
      const L = k.pages && k.pages.login;
      if (L && L.url) { try { await page.goto(L.url, { timeout: 60000 }); } catch {} }
      await ctx.handOff();
      const deadline = Date.now() + 9.5 * 60 * 1000; // D1：10 分钟未完成 → skipped(no_login)
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const chk = await adapter.preflight(page, null, k, ctx);
          if (!chk.need_login) return { loggedIn: true, displayName: chk.displayName };
        } catch { /* 页面被用户操作中，继续轮询 */ }
      }
      return { loggedIn: false, need_login: true };
    },

    /** 回读确认（只读）：用户点完发布后，到后台列表核对新帖 */
    async verify(page, payload, k, ctx) {
      const V = k.pages && k.pages.verify;
      if (V && V.url) {
        try { await page.goto(V.url, { timeout: 60000 }); } catch (e) { return { ok: false, error: 'verify_goto: ' + String(e) }; }
        try { await page.waitForLoadState(); } catch {}
        await humanPause(1500, 3000);
      }
      const needle = payload && payload.title;
      if (!needle) return { ok: false, error: 'verify: payload.title 缺失' };
      const hit = await findByText(page, needle);
      if (!hit) return { ok: false, error: 'verify: 后台列表未找到新帖标题（发布可能仍在审核/延迟）' };
      let url = null;
      try { url = await docUrl(page); } catch {}
      return { ok: true, url };
    },

    /** 数据采集（只读自己后台创作者中心） */
    async collect(page, _payload, k, ctx) {
      const M = k.pages && k.pages.metrics;
      if (!M || !M.url) return { ok: false, error: 'collect: 知识包缺少 metrics.url' };
      try { await page.goto(M.url, { timeout: 60000 }); } catch (e) { return { ok: false, error: 'collect_goto: ' + String(e) }; }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2000, 4000);
      const metrics = {};
      const missing = [];
      for (const [field, label] of Object.entries(M.fields || {})) {
        const v = await readMetricByLabel(page, label);
        metrics[field] = v;
        if (v == null) missing.push(field + ':' + label);
      }
      return { ok: true, metrics, warn: missing.length ? ['未读到指标(需核对知识包 fields): ' + missing.join(', ')] : [] };
    },

    /**
     * 互动执行（红线 8 模型：AI 草拟 → 大屏人审 approve → 才执行）。
     * 注意：发布类（发帖/商品）遵守红线 1「人亲手点发布」；互动类的人审把关点
     * 是 approve 环节（用户已逐条看过草拟内容并批准），故此处由系统执行发送。
     * 这一「红线 1 / 红线 8 边界裁定」需产品侧确认（见 SKILL.md）。
     */
    async engage(page, payload, k, ctx) {
      const I = k.interact || {};
      const kind = payload.kind;
      const warn = [];
      // ① 浏览目标 ≥ 阅读时长（拟人，红线 8 的「像人一样」要求）
      if (payload.target && /^https?:/.test(payload.target)) {
        try { await page.goto(payload.target, { timeout: 60000 }); await page.waitForLoadState(); } catch (e) { warn.push('goto target: ' + String(e).slice(0, 100)); }
        await humanPause(8000, 20000);
      }
      if (kind === 'like') {
        const c = I.like && I.like.click_text
          ? await clickText(page, page.mouse, I.like.click_text, { hoverMs: 400 })
          : I.like && I.like.click_sel
            ? await clickSelector(page, page.mouse, I.like.click_sel, { hoverMs: 400 })
            : { clicked: false, reason: '知识包 interact.like 未配置' };
        if (!c.clicked) return { done: false, error: 'like 未执行: ' + c.reason };
        return { done: true, warn };
      }
      if (kind === 'comment' || kind === 'topic_reply') {
        const C = I.comment || {};
        if (!payload.draft) return { done: false, error: '评论类互动 draft 为空（红线 8 要求人工审过的内容）' };
        const r = await typeInto(page, page.keyboard, { selector: C.box_sel, focusText: C.box_focus_text, text: payload.draft });
        if (!r.ok) return { done: false, error: '评论框填写失败: ' + r.reason };
        await humanPause(800, 1800);
        const s = C.send_text
          ? await clickText(page, page.mouse, C.send_text, { hoverMs: 300 })
          : C.send_sel
            ? await clickSelector(page, page.mouse, C.send_sel, { hoverMs: 300 })
            : { clicked: false, reason: '知识包 interact.comment.send 未配置' };
        if (!s.clicked) return { done: false, error: '评论发送失败: ' + s.reason };
        return { done: true, warn };
      }
      if (kind === 'friend_dm') {
        const D = I.dm || {};
        if (!payload.draft) return { done: false, error: '私聊 draft 为空（红线 8：必须个性化草拟）' };
        const r = await typeInto(page, page.keyboard, { selector: D.box_sel, focusText: D.box_focus_text, text: payload.draft });
        if (!r.ok) return { done: false, error: '私聊输入失败: ' + r.reason };
        await humanPause(800, 1800);
        const s = D.send_text
          ? await clickText(page, page.mouse, D.send_text, { hoverMs: 300 })
          : D.send_sel
            ? await clickSelector(page, page.mouse, D.send_sel, { hoverMs: 300 })
            : { clicked: false, reason: '知识包 interact.dm.send 未配置' };
        if (!s.clicked) return { done: false, error: '私聊发送失败: ' + s.reason };
        return { done: true, warn }; // 每会话 1 条上限由 DB UNIQUE(account_id,kind,target) 强制
      }
      if (kind === 'follow') {
        const F = I.follow || {};
        const c = F.click_text
          ? await clickText(page, page.mouse, F.click_text, { hoverMs: 400 })
          : F.click_sel
            ? await clickSelector(page, page.mouse, F.click_sel, { hoverMs: 400 })
            : { clicked: false, reason: '知识包 interact.follow 未配置' };
        if (!c.clicked) return { done: false, error: 'follow 未执行: ' + c.reason };
        return { done: true, warn };
      }
      return { done: false, error: 'unknown kind: ' + kind };
    },

    /**
     * 红线 1 v2：自动发布（AUTO_PUBLISH）。唯一实现委托给 adapters/submit.mjs（全仓库唯一
     * 点击发布按钮的代码路径）；仅当账号显式开启 auto_publish 时 hub 才会调度本操作。
     */
    async submit(page, payload, k, ctx) {
      const { autoSubmit } = await import('./submit.mjs');
      return autoSubmit(page, payload, k, ctx);
    },

    ...spec,
  };
  return adapter;
}

/** 公共小工具再导出，供平台适配器使用 */
export { findByText, scrollSelectorIntoView, clickText, typeInto, humanPause, readMetricByLabel, docUrl, shot };
