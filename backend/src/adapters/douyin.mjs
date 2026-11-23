// douyin.mjs — 抖音适配器（风险敏感度：高）。
// 特点：React 受控输入多（坑位 6，native setter 为主路径）；话题/@ 面板须在面板内搜索（坑位 7）。
// 填完即停，发布由人亲手完成（红线 1）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause, waitText } from './runtime.mjs';

export default makeAdapter({
  id: 'douyin',

  async fill(page, payload, k, ctx) {
    if (!payload || !payload.title) throw new Error('fill(douyin): payload.title 必填');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};

    if (P.url) {
      try { await page.goto(P.url, { timeout: 60000 }); } catch (e) { warn.push('goto: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2000, 4000);
    }

    // ① 上传视频
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

    // ② 标题+正文（抖音常合并为一个描述框：text + 换行 + tags 拼接；标题单独框存在时分开填）
    const descText = payload.text ? `${payload.title}\n${payload.text}` : payload.title;
    const rDesc = await typeInto(page, page.keyboard, {
      selector: P.desc_sel, focusText: P.desc_focus_text, text: descText, maxLen: (k.limits && k.limits.desc_max) || 1000,
    });
    if (!rDesc.ok) warn.push('描述填写失败: ' + rDesc.reason);
    await humanPause();

    // ③ 话题面板：点击 # 入口 → 在面板内搜索 → 点选（坑位 7）
    for (const tag of (payload.tags || []).slice(0, 3)) {
      try {
        if (P.topic_entry_text) {
          const open = await clickText(page, page.mouse, P.topic_entry_text, { hoverMs: 600 });
          if (!open.clicked) { warn.push('话题入口未找到: ' + P.topic_entry_text); continue; }
        }
        if (P.topic_input_sel) await typeInto(page, page.keyboard, { selector: P.topic_input_sel, text: tag });
        await humanPause(600, 1300);
        const pick = await clickText(page, page.mouse, tag, { exact: true }); // 在面板内点选
        if (!pick.clicked) warn.push('话题未点选: ' + tag);
        await humanPause(400, 900);
      } catch (e) { warn.push('话题异常 ' + tag + ': ' + String(e).slice(0, 80)); }
    }

    // ④ 红线 1：滚动到发布按钮 → 停
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在抖音页面核对后亲手点「发布」（红线 1），完成后 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },
});
