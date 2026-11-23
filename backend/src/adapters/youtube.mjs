// youtube.mjs — YouTube 适配器（studio.youtube.com；风险敏感度：低）。
// 页面重、加载慢（waitFor 放宽到 60s）；英文界面，文本目标用英文（知识包）。
// 向导 Next 步进允许系统点击（非发布动作）；最终「Publish」按钮绝不点击（红线 1）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause, waitText } from './runtime.mjs';

export default makeAdapter({
  id: 'yt',

  async fill(page, payload, k, ctx) {
    if (!payload || !payload.title) throw new Error('fill(yt): payload.title 必填');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};

    if (P.url) {
      try { await page.goto(P.url, { timeout: 90000 }); } catch (e) { warn.push('goto: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(3000, 6000); // 页面重，放宽
    }

    // ① 上传（YouTube 上传页 chooser 最可靠）
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
      // ② 等标题表单出现（上传处理慢，放宽 10 分钟）
      if (P.form_ready_text) {
        const ready = await waitText(page, P.form_ready_text, 600000);
        if (!ready) warn.push('等待标题表单超时(' + P.form_ready_text + ')');
      }
      await humanPause(2000, 4000);
    }

    // ③ 标题（≤100 字符）与描述（≤5000）
    const rTitle = await typeInto(page, page.keyboard, {
      selector: P.title_sel, focusText: P.title_focus_text,
      text: payload.title, maxLen: (k.limits && k.limits.title_max) || 100,
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

    // ④ 观众选项/检查步骤：按知识包 next_texts 步进（向导导航，非发布动作）
    for (const t of P.next_texts || []) {
      const c = await clickText(page, page.mouse, t, { hoverMs: 500 });
      if (!c.clicked) warn.push('向导步骤未找到: ' + t);
      await humanPause(1200, 2500);
    }

    // ⑤ 红线 1：滚动到 Publish 按钮 → 停。Publish 由人亲手点。
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在 YouTube Studio 核对后亲手点「Publish」（红线 1），完成后 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },
});
