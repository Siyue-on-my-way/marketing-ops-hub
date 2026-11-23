// tiktok.mjs — TikTok 适配器（网页版 studio.tiktok.com；风险敏感度：中）。
// 文案 ≤2200；可能需要登录态区域匹配（知识包 notes 记录）。填完即停（红线 1）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause, waitText } from './runtime.mjs';

export default makeAdapter({
  id: 'tiktok',

  async fill(page, payload, k, ctx) {
    if (!payload) throw new Error('fill(tiktok): payload 必填');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};

    if (P.url) {
      try { await page.goto(P.url, { timeout: 90000 }); } catch (e) { warn.push('goto: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2500, 5000);
    }

    // ① 上传
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
        const ready = await waitText(page, P.form_ready_text, 300000);
        if (!ready) warn.push('等待上传处理超时(' + P.form_ready_text + ')');
      }
      await humanPause(1500, 3000);
    }

    // ② 文案（caption ≤2200，含话题标签）
    const caption = [payload.text || payload.title, ...(payload.tags || []).map((t) => '#' + t.replace(/^#/, ''))]
      .filter(Boolean).join('\n');
    const rCap = await typeInto(page, page.keyboard, {
      selector: P.caption_sel, focusText: P.caption_focus_text, text: caption, maxLen: (k.limits && k.limits.caption_max) || 2200,
    });
    if (!rCap.ok) warn.push('文案填写失败: ' + rCap.reason);
    await humanPause();

    // ③ 红线 1：滚动到 Post 按钮附近 → 停（Post/Publish 按钮绝不点击）
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在 TikTok 页面核对后亲手点「Post」（红线 1），完成后 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },
});
