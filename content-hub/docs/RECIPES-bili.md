# RECIPES-bili.md — Bilibili 实测细则

> 状态：**初始版，未真机验证**（本文件随实测滚动更新；每次实测后回填知识包并升 version）。

## 发布流程（预期，对照知识包 pages.publish.steps）

1. 入口 `https://member.bilibili.com/platform/upload/video/frame`，点「上传投稿」。
2. `waitForFileChooser`（45s）→ `chooser.setFiles([视频绝对路径])`。
3. 转码等待：轮询文本「填写资料」出现，最长 5 分钟。
4. 标题 ≤80 字（native setter 优先，失败回退点击聚焦 + insertText）。
5. 简介：同上。
6. 标签：点「添加标签」→ 面板内输入 → 点选候选（坑位 7：必须在面板内）。
7. 二创声明等勾选项：按知识包 check_texts。
8. **滚动到「提交稿件」→ scrollIntoView(center) → 重新取坐标 → 停止。发布由用户亲手点（红线 1）。**
9. 用户点完 → `hub confirm` → verify 到「稿件管理」列表找标题 → published_url。

## 待实测回填项（首验清单 M1）

- [ ] login.check_text / display_name 定位方式（快照确认）
- [ ] upload 入口文本是否稳定（「上传投稿」vs 图标按钮）
- [ ] form_ready_text 实际文案
- [ ] title/desc 的 sel（native setter 用）
- [ ] tag 面板 sel 与点选路径
- [ ] submit_sel
- [ ] metrics 页面字段 label 与数值位置
- [ ] 风控信号文案样本（真实截图）

## 变更记录

- v1（2026-11-23）：初始结构，来自规格 §4.4 差异表与 ego 坑位清单，未真机验证。
