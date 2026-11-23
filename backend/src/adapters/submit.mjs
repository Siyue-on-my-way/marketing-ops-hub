// submit.mjs — AUTO_PUBLISH 自动发布执行（红线 1 v2）。
// 本文件是全仓库唯一「点击发布/提交按钮」的代码路径（红线自检 test/redline-check.sh 校验）：
// 仅当账号显式开启 auto_publish（hub accounts add/set --auto-publish）时，hub 才会调度
// submit 操作；review 模式账号永远不会进入这里。风控检测由 round-runtime 在本操作前强制
// 执行（命中即 RISK_SIGNAL → 账号当日停机）。内容人审前移不变：文案+素材必须先经用户过目。
import { clickText, clickSelector, humanPause } from './runtime.mjs';

export async function autoSubmit(page, payload, k, ctx) {
  const P = (k.pages && k.pages.publish) || {};
  let clicked;
  if (P.submit_sel) {
    clicked = await clickSelector(page, page.mouse, P.submit_sel, { hoverMs: 600 });
  } else if (P.submit_text) {
    clicked = await clickText(page, page.mouse, P.submit_text, { hoverMs: 600 });
  } else {
    return { submitted: false, error: '知识包未配置 submit_sel/submit_text，无法自动发布（坑位 2 纪律要求先定位再点）' };
  }
  if (!clicked.clicked) return { submitted: false, error: '发布按钮点击失败: ' + clicked.reason };
  await humanPause(3000, 6000); // 等平台响应提交
  return { submitted: true, warn: [] };
}
