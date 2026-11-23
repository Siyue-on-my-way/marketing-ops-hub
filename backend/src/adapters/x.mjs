// x.mjs — X (Twitter) 适配器（x.com/compose/post；风险敏感度：低）。
// 280 字符上限（长文走文章功能，v1 不做）；图片附件走帖子附件入口。
// 填完即停：Post 按钮绝不点击（红线 1）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause } from './runtime.mjs';

export default makeAdapter({
  id: 'x',

  async fill(page, payload, k, ctx) {
    if (!payload || (!payload.text && !payload.title)) throw new Error('fill(x): payload.text 必填');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};

    // 打开撰写框（round 默认打开 login.url；此处确保进入 compose）
    if (P.url) {
      try { await page.goto(P.url, { timeout: 90000 }); } catch (e) { warn.push('goto: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2000, 4000);
    }

    // ① 正文（280 字符）
    const text = (payload.text || payload.title || '');
    const rText = await typeInto(page, page.keyboard, {
      selector: P.text_sel, focusText: P.text_focus_text,
      text, maxLen: (k.limits && k.limits.text_max) || 280,
    });
    if (!rText.ok) warn.push('正文填写失败: ' + rText.reason);
    await humanPause();

    // ② 图片附件：点媒体入口 → waitForFileChooser → setFiles
    const media = payload.local_media_path;
    if (media) {
      let chooserP = typeof page.waitForFileChooser === 'function'
        ? page.waitForFileChooser({ timeout: 45000 }).catch(() => null)
        : null;
      const up = P.media_text
        ? await clickText(page, page.mouse, P.media_text, { hoverMs: 500 })
        : P.media_sel
          ? await clickSelector(page, page.mouse, P.media_sel, { hoverMs: 500 })
          : { clicked: false, reason: '知识包未配置媒体入口' };
      if (!up.clicked) warn.push('媒体入口点击失败: ' + up.reason);
      const chooser = chooserP ? await chooserP : null;
      if (chooser) await chooser.setFiles(Array.isArray(media) ? media : [media]);
      else if (P.file_input_sel && typeof page.setInputFiles === 'function') {
        try { await page.setInputFiles(P.file_input_sel, Array.isArray(media) ? media : [media]); }
        catch (e) { warn.push('setInputFiles: ' + String(e).slice(0, 120)); }
      }
      await humanPause(1500, 3000);
    }

    // ③ 红线 1：滚动到 Post 按钮 → 停
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在 X 页面核对后亲手点「Post」（红线 1），完成后 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },
});
