// bili.mjs — Bilibili 适配器（M1 首个全流程验证平台）。
// 发布流程：投稿页上传 → 等转码 → 标题(≤80) → 简介 → 标签面板点选 → 附加勾选 →
//           滚动到「提交稿件」并停（红线 1：人亲手点提交）。
import { makeAdapter, revealSubmitOnly } from './base.mjs';
import { clickText, clickSelector, typeInto, humanPause, waitText } from './runtime.mjs';

export default makeAdapter({
  id: 'bili',

  async fill(page, payload, k, ctx) {
    if (!payload || !payload.title) throw new Error('fill(bili): payload.title 必填');
    const warn = [];
    const P = (k.pages && k.pages.publish) || {};

    // 进入发布页（round 默认打开 login.url）
    if (P.url) {
      try { await page.goto(P.url, { timeout: 60000 }); } catch (e) { warn.push('goto 发布页: ' + String(e).slice(0, 120)); }
      try { await page.waitForLoadState(); } catch {}
      await humanPause(2000, 4000);
    }

    // ① 上传视频：先挂 waitForFileChooser 再点上传按钮（规格 §1.3 首选路径）
    const media = payload.local_media_path;
    if (media) {
      let chooser = null;
      let chooserP = null;
      if (typeof page.waitForFileChooser === 'function') {
        chooserP = page.waitForFileChooser({ timeout: 45000 }).catch(() => null);
      } else {
        warn.push('ego 页面无 waitForFileChooser，走隐藏 input 备选路径');
      }
      const up = P.upload_text
        ? await clickText(page, page.mouse, P.upload_text, { hoverMs: 600 })
        : P.upload_sel
          ? await clickSelector(page, page.mouse, P.upload_sel, { hoverMs: 600 })
          : { clicked: false, reason: '知识包未配置上传入口(upload_text/upload_sel)' };
      if (!up.clicked) warn.push('上传入口点击失败: ' + up.reason);
      if (chooserP) {
        chooser = await chooserP;
        if (chooser) {
          await chooser.setFiles(Array.isArray(media) ? media : [media]);
        } else {
          warn.push('文件选择器未出现（45s）');
        }
      }
      if (!chooser && P.file_input_sel && typeof page.setInputFiles === 'function') {
        try { await page.setInputFiles(P.file_input_sel, Array.isArray(media) ? media : [media]); }
        catch (e) { warn.push('setInputFiles 失败: ' + String(e).slice(0, 120)); }
      }
      // ② 等转码出表单（转码等待放宽到 5 分钟）
      if (P.form_ready_text) {
        const ready = await waitText(page, P.form_ready_text, 300000);
        if (!ready) warn.push('等待表单就绪超时(' + P.form_ready_text + ')，仍继续尝试填写');
      }
      await humanPause(1500, 3000);
    } else {
      warn.push('payload.local_media_path 缺失（图文/纯文字场景可忽略）');
    }

    // ③ 标题（≤80 字，差异表）
    const rTitle = await typeInto(page, page.keyboard, {
      selector: P.title_sel, focusText: P.title_focus_text,
      text: payload.title, maxLen: (k.limits && k.limits.title_max) || 80,
    });
    if (!rTitle.ok) warn.push('标题填写失败: ' + rTitle.reason);
    await humanPause();

    // ④ 简介
    if (payload.text) {
      const rDesc = await typeInto(page, page.keyboard, {
        selector: P.desc_sel, focusText: P.desc_focus_text, text: payload.text,
      });
      if (!rDesc.ok) warn.push('简介填写失败: ' + rDesc.reason);
      await humanPause();
    }

    // ⑤ 标签：点标签面板 → 面板内搜索 → 点选（坑位 7：必须在面板内操作）
    for (const tag of (payload.tags || []).slice(0, 10)) {
      try {
        if (P.tag_area_text) await clickText(page, page.mouse, P.tag_area_text, { hoverMs: 800 });
        if (P.tag_input_sel) await typeInto(page, page.keyboard, { selector: P.tag_input_sel, text: tag });
        await humanPause(500, 1200);
        const pick = await clickText(page, page.mouse, tag, { exact: true });
        if (!pick.clicked) warn.push('标签未点选: ' + tag);
        await humanPause(400, 900);
      } catch (e) { warn.push('标签异常 ' + tag + ': ' + String(e).slice(0, 80)); }
    }

    // ⑥ 附加勾选（二创声明等，按知识包配置）
    for (const t of P.check_texts || []) {
      const c = await clickText(page, page.mouse, t, { hoverMs: 400 });
      if (!c.clicked) warn.push('勾选项未找到: ' + t);
    }

    // ⑦ 封面确认（知识包配置该步文本时执行）
    if (P.cover_confirm_text) {
      const c = await clickText(page, page.mouse, P.cover_confirm_text, { hoverMs: 400 });
      if (!c.clicked) warn.push('封面确认未找到: ' + P.cover_confirm_text);
    }

    // ⑧ 红线 1：滚动到「提交稿件」→ 重新取坐标 → 停。发布由用户亲手完成。
    const submitInfo = await revealSubmitOnly(page, k, warn);
    return {
      drafted: true,
      submitLocated: !!submitInfo,
      next: '请人工在平台页面核对后亲手点击「提交稿件」（红线 1），完成后运行 hub confirm ' + (ctx.postId || '<post_id>'),
      warn,
    };
  },
});
