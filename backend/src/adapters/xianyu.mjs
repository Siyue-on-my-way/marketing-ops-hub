// xianyu.mjs — 闲鱼适配器（商品语义，D3；风险敏感度：高——交易风控）。
// 「帖子」= 买卖贴（商品发布）：标题/描述/价格/分类/成色/多张图片。
// 发布后可能被平台审核延迟显示（verify 需容忍）。填完即停（红线 1）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause, waitText } from './runtime.mjs';

export default makeAdapter({
  id: 'xianyu',

  async fill(page, payload, k, ctx) {
    if (!payload || !payload.title) throw new Error('fill(xianyu): payload.title 必填（商品标题）');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};
    const item = payload.item || {}; // {price, category, condition} 商品扩展字段（D3）

    if (P.url) {
      try { await page.goto(P.url, { timeout: 90000 }); } catch (e) { warn.push('goto: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2500, 5000);
    }

    // ① 商品图片（多张）
    const media = payload.local_media_path;
    if (media) {
      let chooserP = typeof page.waitForFileChooser === 'function'
        ? page.waitForFileChooser({ timeout: 60000 }).catch(() => null)
        : null;
      const up = P.upload_text
        ? await clickText(page, page.mouse, P.upload_text, { hoverMs: 800 })
        : P.upload_sel
          ? await clickSelector(page, page.mouse, P.upload_sel, { hoverMs: 800 })
          : { clicked: false, reason: '知识包未配置上传入口' };
      if (!up.clicked) warn.push('上传入口点击失败: ' + up.reason);
      const chooser = chooserP ? await chooserP : null;
      if (chooser) await chooser.setFiles(Array.isArray(media) ? media : [media]);
      else if (P.file_input_sel && typeof page.setInputFiles === 'function') {
        try { await page.setInputFiles(P.file_input_sel, Array.isArray(media) ? media : [media]); }
        catch (e) { warn.push('setInputFiles: ' + String(e).slice(0, 120)); }
      }
      if (P.form_ready_text) {
        const ready = await waitText(page, P.form_ready_text, 180000);
        if (!ready) warn.push('等待发布表单超时(' + P.form_ready_text + ')');
      }
      await humanPause(1500, 3000);
    }

    // ② 标题（≤30 字）与描述
    const rTitle = await typeInto(page, page.keyboard, {
      selector: P.title_sel, focusText: P.title_focus_text,
      text: payload.title, maxLen: (k.limits && k.limits.title_max) || 30,
    });
    if (!rTitle.ok) warn.push('标题填写失败: ' + rTitle.reason);
    await humanPause();
    if (payload.text) {
      const rDesc = await typeInto(page, page.keyboard, {
        selector: P.desc_sel, focusText: P.desc_focus_text, text: payload.text,
      });
      if (!rDesc.ok) warn.push('描述填写失败: ' + rDesc.reason);
      await humanPause();
    }

    // ③ 价格
    if (item.price != null) {
      const rPrice = await typeInto(page, page.keyboard, {
        selector: P.price_sel, focusText: P.price_focus_text, text: String(item.price), maxLen: 10,
      });
      if (!rPrice.ok) warn.push('价格填写失败: ' + rPrice.reason);
      await humanPause();
    }

    // ④ 分类（坑位 7：点分类入口 → 在面板内搜索/逐级点选）
    if (item.category) {
      try {
        if (P.category_entry_text) {
          const open = await clickText(page, page.mouse, P.category_entry_text, { hoverMs: 800 });
          if (!open.clicked) warn.push('分类入口未找到: ' + P.category_entry_text);
        }
        if (P.category_input_sel) await typeInto(page, page.keyboard, { selector: P.category_input_sel, text: item.category });
        await humanPause(600, 1300);
        const pick = await clickText(page, page.mouse, item.category, { exact: true });
        if (!pick.clicked) warn.push('分类未点选: ' + item.category);
        await humanPause(400, 900);
      } catch (e) { warn.push('分类异常: ' + String(e).slice(0, 80)); }
    }

    // ⑤ 成色（点选项文本）
    if (item.condition) {
      const c = await clickText(page, page.mouse, item.condition, { exact: true, hoverMs: 400 });
      if (!c.clicked) warn.push('成色选项未找到: ' + item.condition);
    }

    // ⑥ 红线 1：滚动到发布按钮 → 停。发布由人亲手完成（平台可能再审核延迟）。
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在闲鱼页面核对后亲手点「发布」（红线 1，注意平台审核延迟），完成后 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },

  /** 闲鱼商品审核延迟：verify 失败时明确提示可能仍在审核（覆盖基类提示语义） */
  async verify(page, payload, k, ctx) {
    const r = await makeAdapter({ id: 'xianyu' }).verify(page, payload, k, ctx);
    if (!r.ok) r.error += '（闲鱼商品可能处于平台审核中，可稍后重试 confirm）';
    return r;
  },
});
