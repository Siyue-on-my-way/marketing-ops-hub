// xhs.mjs — 小红书适配器。**麦田最保守路径照搬**（风险敏感度：高）：
//   只读已渲染 DOM、像人一样滚动、低频操作、绝不调用平台内部接口。
//   笔记标题 ≤20 字。填完即停，发布由人亲手完成（红线 1）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause, waitText } from './runtime.mjs';

export default makeAdapter({
  id: 'xhs',

  async fill(page, payload, k, ctx) {
    if (!payload || !payload.title) throw new Error('fill(xhs): payload.title 必填');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};
    // 保守路径：仅页面级操作；任意一步失败不重试第二次点击（低频），记录 warn 交人工
    if (P.url) {
      try { await page.goto(P.url, { timeout: 60000 }); } catch (e) { warn.push('goto: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2000, 4000);
    }

    // ① 上传图片/视频
    const media = payload.local_media_path;
    if (media) {
      let chooserP = typeof page.waitForFileChooser === 'function'
        ? page.waitForFileChooser({ timeout: 45000 }).catch(() => null)
        : null;
      const up = P.upload_text
        ? await clickText(page, page.mouse, P.upload_text, { hoverMs: 800 })
        : P.upload_sel
          ? await clickSelector(page, page.mouse, P.upload_sel, { hoverMs: 800 })
          : { clicked: false, reason: '知识包未配置上传入口' };
      if (!up.clicked) warn.push('上传入口点击失败: ' + up.reason);
      const chooser = chooserP ? await chooserP : null;
      if (chooser) {
        await chooser.setFiles(Array.isArray(media) ? media : [media]);
      } else if (P.file_input_sel && typeof page.setInputFiles === 'function') {
        try { await page.setInputFiles(P.file_input_sel, Array.isArray(media) ? media : [media]); }
        catch (e) { warn.push('setInputFiles: ' + String(e).slice(0, 120)); }
      } else {
        warn.push('文件选择器未出现且无 file_input_sel 备选');
      }
      if (P.form_ready_text) {
        const ready = await waitText(page, P.form_ready_text, 120000);
        if (!ready) warn.push('等待编辑器就绪超时(' + P.form_ready_text + ')');
      }
      await humanPause(1500, 3000);
    }

    // ② 标题（≤20 字，差异表）
    const rTitle = await typeInto(page, page.keyboard, {
      selector: P.title_sel, focusText: P.title_focus_text,
      text: payload.title, maxLen: (k.limits && k.limits.title_max) || 20,
    });
    if (!rTitle.ok) warn.push('标题填写失败: ' + rTitle.reason);
    await humanPause();

    // ③ 正文
    if (payload.text) {
      const rBody = await typeInto(page, page.keyboard, {
        selector: P.body_sel, focusText: P.body_focus_text, text: payload.text,
      });
      if (!rBody.ok) warn.push('正文填写失败: ' + rBody.reason);
      await humanPause();
    }

    // ④ 话题标签（保守：仅点选已有推荐话题，不做搜索输入）
    for (const tag of (payload.tags || []).slice(0, 5)) {
      const pick = await clickText(page, page.mouse, '#' + tag.replace(/^#/, ''), { exact: false });
      if (!pick.clicked) { /* 推荐话题不含该标签属常态，不告警 */ }
      await humanPause(600, 1400);
    }

    // ⑤ 红线 1：滚动到发布按钮 → 停
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在小红书页面核对后亲手点「发布」（红线 1），完成后 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },
});
