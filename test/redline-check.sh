#!/usr/bin/env bash
# redline-check.sh — 红线自检（规格 §7.5，红线 1 v2 版）：
# 「点击发布/提交按钮」的代码路径**只允许存在**于 backend/src/adapters/submit.mjs（AUTO_PUBLISH），
# 且该文件必须带 AUTO_PUBLISH 门禁标记（仅 auto_publish 账号会被 hub 调度到 submit 操作）。
# 其余任何代码（适配器 fill / 互动 engage / 工具层）出现点击发布/提交均视为违规。
cd "$(dirname "$0")/.." || exit 1
echo "== 红线自检 1：click 与 发布/提交/publish/submit 同行（submit.mjs 除外）=="
hits=$(grep -rnE "click" backend/src/ --include='*.mjs' \
  | grep -E "发布|提交|[Pp]ublish|[Ss]ubmit" \
  | grep -v "adapters/submit.mjs" \
  | grep -vE "^[^:]+:[0-9]+:\s*(//|\*)" || true)
if [ -n "$hits" ]; then
  echo "❌ 红线违规命中（发布点击只能存在于 submit.mjs）："
  echo "$hits"
  exit 1
fi
echo "✅ 通过：除 submit.mjs 外零命中"
echo ""
echo "== 红线自检 2：submit.mjs 必须带 AUTO_PUBLISH 门禁标记 =="
if ! grep -q "AUTO_PUBLISH" backend/src/adapters/submit.mjs; then
  echo "❌ submit.mjs 缺少 AUTO_PUBLISH 门禁说明"
  exit 1
fi
echo "✅ 通过：submit.mjs 带门禁标记（仅 auto_publish 账号可调度）"
echo ""
echo "== 红线自检 3：代码中写死平台 hash 类名（启发式：css-_ / css- 数字类名）=="
hits2=$(grep -rnE "css-[a-z0-9]{6,}" backend/src/ --include='*.mjs' || true)
if [ -n "$hits2" ]; then
  echo "❌ 疑似写死 hash 类名："
  echo "$hits2"
  exit 1
fi
echo "✅ 零命中：选择器全部来自知识包 JSON"
