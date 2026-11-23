#!/usr/bin/env bash
# redline-check.sh — 红线自检（规格 §7.5）：
# 适配器/执行层代码中「点击发布/提交按钮」这一动作必须零命中。
# （互动类的发送属于红线 8 的 approve-后执行模型，其代码不引用发布/提交字样，亦应零命中。）
cd "$(dirname "$0")/.." || exit 1
echo "== 红线自检：src/ 内 click 与 发布/提交/publish/submit 同行 =="
hits=$(grep -rnE "click" backend/src/ --include='*.mjs' | grep -E "发布|提交|[Pp]ublish|[Ss]ubmit" | grep -v "^\s*//" | grep -vE "^\S+:[0-9]+:\s*(//|\*)" || true)
if [ -n "$hits" ]; then
  echo "❌ 红线违规命中："
  echo "$hits"
  exit 1
fi
echo "✅ 零命中：适配器代码不点击发布/提交按钮"
echo ""
echo "== 红线自检：代码中写死平台 hash 类名（启发式：css-_ / css- 数字类名）=="
hits2=$(grep -rnE "css-[a-z0-9]{6,}" backend/src/ --include='*.mjs' || true)
if [ -n "$hits2" ]; then
  echo "❌ 疑似写死 hash 类名："
  echo "$hits2"
  exit 1
fi
echo "✅ 零命中：选择器全部来自知识包 JSON"
