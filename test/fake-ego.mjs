#!/usr/bin/env node
// fake-ego.mjs — 冒烟测试用 ego 替身：忽略参数，按 FAKE_EGO_STDOUT 环境变量输出 @@RESULT@@ JSON。
// 缺省输出「超集成功结果」，满足 preflight/fill/verify/collect/engage 各协议字段。
const DEFAULT = {
  ok: true,
  data: {
    ok: true,            // verify/collect 语义
    need_login: false,   // preflight 语义
    loggedIn: true,      // login 语义
    displayName: '测试昵称',
    drafted: true,       // fill 语义
    warn: [],
    done: true,          // engage 语义
    url: 'https://example.com/fake-post',
    metrics: { views: 100, likes: 10, comments: 2, shares: 1 },
  },
  shot: null,
};
const raw = process.env.FAKE_EGO_STDOUT || '';
console.log('@@RESULT@@' + (raw || JSON.stringify(DEFAULT)));
