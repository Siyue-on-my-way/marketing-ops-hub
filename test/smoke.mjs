// smoke.mjs — 全链路冒烟测试（不需要真机 ego/平台，全部 mock 级验证）。
// 覆盖：DDL/账号/冷启动配额/防重/plan→run→confirm 状态机/风控停机/no_login/互动全流程/
//       trust_score/复盘对比/云 API 全套/大屏/round-runtime+适配器纪律（坑位2+红线1）。
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pass = [];
const failLog = [];
function check(name, cond, extra = '') {
  if (cond) { pass.push(name); console.log('  ✓ ' + name); }
  else { failLog.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const tmp = mkdtempSync(join(tmpdir(), 'maitian-smoke-'));
process.env.MAITIAN_WORKSPACE_KEY = 'testkey-123';

const { openDb } = await import(join(ROOT, 'backend', 'src', 'db.mjs'));
const { loadConfig } = await import(join(ROOT, 'backend', 'src', 'config.mjs'));
const planner = await import(join(ROOT, 'backend', 'src', 'planner.mjs'));
const { startServer } = await import(join(ROOT, 'backend', 'src', 'server.mjs'));

const baseCfg = loadConfig();
const cfg = JSON.parse(JSON.stringify(baseCfg));
cfg.paths = {
  db: join(tmp, 'hub.db'), runs: join(tmp, 'runs'), shots: join(tmp, 'shots'),
  cache: join(tmp, 'cache'), adapters: baseCfg.paths.adapters, knowledge: baseCfg.paths.knowledge,
};
cfg.cadence.active_hours = [0, 24];          // 测试不卡时段
cfg.cadence.post_gap_sec = [1, 1];
cfg.cadence.interact_gap_sec = [0, 0];
const fakeEgo = join(ROOT, 'test', 'fake-ego.mjs');
chmodSync(fakeEgo, 0o755);
cfg.ego.path = fakeEgo;
const db = openDb(cfg.paths.db);

// ---------- 0. 云服务（先起，后续 confirm/云测试共用；随机端口避免残留进程干扰） ----------
console.log('\n[0] maitian-cloud 启动');
const cloudPort = 20000 + (process.pid % 20000);
const CLOUD = `http://127.0.0.1:${cloudPort}`;
cfg.cloud.base_url = CLOUD;
const cloudProc = spawn(process.execPath, [join(ROOT, 'backend', 'cloud', 'server.mjs')], {
  env: { ...process.env, PORT: String(cloudPort), MAITIAN_DATA_DIR: join(tmp, 'cloud-data'), MAITIAN_WORKSPACE_KEY: 'testkey-123', MAITIAN_SIGN_SECRET: 'test-secret' },
  stdio: 'ignore',
});
process.on('exit', () => { try { cloudProc.kill('SIGKILL'); } catch {} });
let cloudUp = false;
for (let i = 0; i < 40 && !cloudUp; i++) {
  try { const res = await fetch(`${CLOUD}/v1/ping`); if (res.ok) cloudUp = true; } catch {}
  if (!cloudUp) await new Promise((r) => setTimeout(r, 250));
}
check('云服务启动', cloudUp);

// ---------- 1. DDL ----------
console.log('\n[1] DDL 与表结构');
for (const t of ['accounts', 'posts', 'engagements', 'audit_log', 'metrics', 'materials_cache', 'kv', 'journal_outbox']) {
  check(`表 ${t} 存在`, !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t));
}

// ---------- 2. 账号 ----------
console.log('\n[2] 账号管理');
let r = planner.accountsAdd(db, cfg, 'bili', '测试昵称');
check('accounts add bili', r.ok && r.account && r.account.status === 'cold');
const biliId = r.account.id;
r = planner.accountsAdd(db, cfg, 'xhs', '测试小红书号');
const xhsId = r.account.id;
check('accounts add xhs', r.ok);
r = planner.accountsAdd(db, cfg, 'weixin', 'x');
check('拒绝未知平台', !r.ok);
const q = planner.quotaOf({ status: 'cold', daily_quota: JSON.stringify({ post: 2, like: 30, comment: 5, dm: 10 }), trust_score: 0.5 }, cfg);
check('红线10：冷启动 post 配额=0', q.post === 0, JSON.stringify(q));
check('红线10：冷启动互动减半', q.like === 15 && q.comment === 2, JSON.stringify(q));

// ---------- 3. plan：payload/防重/冷启动 ----------
console.log('\n[3] plan 排期');
const payloadFile = join(tmp, 'payload.json');
writeFileSync(payloadFile, JSON.stringify({
  bili: { title: '测试视频标题', text: '正文内容', tags: ['测试'], local_media_path: '/tmp/fake.mp4' },
  xhs: { title: '小红书标题', text: '正文', tags: [] },
}));
r = planner.plan(db, cfg, 'mat-1', { platforms: 'bili', accounts: biliId, payloadFile });
check('冷启动账号 plan 被拒（红线10）', r.results[0].skipped && r.results[0].skipped.includes('冷启动'), JSON.stringify(r.results));

// 转 active（模拟冷启动完成）；并提高 post 配额便于多场景测试
db.prepare(`UPDATE accounts SET status='active', trust_score=1, created_at=?, daily_quota=? WHERE id IN (?,?)`)
  .run(new Date(Date.now() - 20 * 86400000).toISOString(), JSON.stringify({ post: 10, like: 30, comment: 5, dm: 10 }), biliId, xhsId);

r = planner.plan(db, cfg, 'mat-1', { platforms: 'bili', accounts: biliId, payloadFile });
check('plan 成功', r.ok && r.results[0].post_id, JSON.stringify(r));
const postId = r.results[0].post_id;
r = planner.plan(db, cfg, 'mat-1', { platforms: 'bili', accounts: biliId, payloadFile });
check('红线6：同素材同账号同平台防重', r.results[0].skipped && r.results[0].skipped.includes('duplicate'));
r = planner.accountsRemove(db, biliId);
check('有任务的账号拒绝删除（审计不可断）', !r.ok && r.error.includes('拒绝删除'), JSON.stringify(r));
r = planner.plan(db, cfg, 'mat-2', { platforms: 'bili', accounts: biliId, payloadFile });
const firstSched = db.prepare('SELECT scheduled_at FROM posts WHERE id=?').get(postId).scheduled_at;
check('红线7：第二篇自动顺延 post_gap', r.ok && r.results[0].scheduled_at > firstSched, JSON.stringify(r.results[0]));
r = planner.plan(db, cfg, 'mat-3', { platforms: 'bili', accounts: biliId });
check('无 payload-file 拒绝', !r.ok);

// ---------- 4. run：preflight+fill → filled ----------
console.log('\n[4] run 执行（fake ego）');
r = await planner.run(db, cfg, { due: true });
const pRow = db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
check('run 后状态 filled（待人审）', pRow.status === 'filled', JSON.stringify({ status: pRow.status, error: pRow.error }));

// no_login 场景
writeFileSync(payloadFile, JSON.stringify({ bili: { title: '二号素材', text: 'x', tags: [], local_media_path: '/tmp/fake.mp4' } }));
process.env.FAKE_EGO_STDOUT = JSON.stringify({ ok: true, data: { ok: true, need_login: true } });
r = planner.plan(db, cfg, 'mat-nologin', { platforms: 'bili', accounts: biliId, payloadFile });
r = await planner.run(db, cfg, { due: true });
const nl = db.prepare(`SELECT * FROM posts WHERE material_cloud_id='mat-nologin'`).get();
check('D1：未登录 → skipped(no_login)', nl && nl.status === 'skipped' && String(nl.error).includes('no_login'), JSON.stringify({ s: nl && nl.status, e: nl && nl.error }));
delete process.env.FAKE_EGO_STDOUT;

// 风控场景（preflight 即命中）
process.env.FAKE_EGO_STDOUT = JSON.stringify({ ok: false, error: 'RISK_SIGNAL', data: { risk: ['验证码'] } });
r = planner.plan(db, cfg, 'mat-risk', { platforms: 'bili', accounts: biliId, payloadFile });
const riskPostId = r.results[0].post_id;
r = await planner.run(db, cfg, { due: true });
const rp = db.prepare('SELECT * FROM posts WHERE id=?').get(riskPostId);
const acctAfter = db.prepare('SELECT * FROM accounts WHERE id=?').get(biliId);
check('红线2：风控 → skipped(risk)', rp.status === 'skipped' && String(rp.error).includes('risk'), JSON.stringify({ s: rp.status, e: rp.error }));
check('风控 → risk_events+1 & trust 下降', acctAfter.risk_events === 1 && acctAfter.trust_score < 1, `events=${acctAfter.risk_events} trust=${acctAfter.trust_score}`);
const d = new Date();
const pausedKey = `paused:${biliId}:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
check('风控 → 当日停机', !!db.prepare('SELECT v FROM kv WHERE k=?').get(pausedKey));
db.prepare('DELETE FROM kv WHERE k LIKE ?').run('paused:%'); // 复位停机
db.prepare(`UPDATE accounts SET risk_events=0, trust_score=1 WHERE id=?`).run(biliId);
delete process.env.FAKE_EGO_STDOUT;

// ---------- 5. confirm：published→confirmed ----------
console.log('\n[5] confirm 回读');
r = await planner.confirm(db, cfg, postId);
check('confirm → confirmed + url', r.ok && r.status === 'confirmed' && r.url === 'https://example.com/fake-post', JSON.stringify(r));

// ---------- 6. 互动全流程 ----------
console.log('\n[6] 互动：draft→approve→execute（红线8）');
const planFile = join(tmp, 'interact.json');
writeFileSync(planFile, JSON.stringify([
  { kind: 'comment', target: 'https://mock.local/v/1', draft: '这个转场做得真细，学到了' },
  { kind: 'like', target: 'https://mock.local/v/2' },
  { kind: 'friend_dm', target: 'user-42', draft: '上次你聊的剪辑插件我试了，确实快' },
]));
r = planner.interact(db, cfg, biliId, planFile);
check('互动计划落库 drafted', r.ok && r.results.every((x) => x.engagement_id || x.skipped), JSON.stringify(r));
const draftCount = db.prepare(`SELECT COUNT(*) n FROM engagements WHERE account_id=? AND status='drafted'`).get(biliId).n;
check('drafted 数量', draftCount === 3, String(draftCount));
const badFile = join(tmp, 'bad.json');
writeFileSync(badFile, JSON.stringify([
  { kind: 'comment', target: 'a', draft: '顶一个' },
  { kind: 'comment', target: 'b', draft: '顶一个' },
  { kind: 'comment', target: 'c', draft: '顶一个' },
]));
r = planner.interact(db, cfg, biliId, badFile);
check('红线8：模板群发（相同draft≥3）拒绝', !r.ok && String(r.error).includes('红线8'), JSON.stringify(r.error));
r = planner.interact(db, cfg, biliId, planFile);
check('同账号同目标去重', r.results[0].skipped && r.results[0].skipped.includes('duplicate'), JSON.stringify(r.results[0]));
r = planner.approve(db, cfg, 'batch:today');
check('approve batch:today', r.ok && r.approved === 3, JSON.stringify({ ok: r.ok, n: r.approved }));
r = await planner.executeApproved(db, cfg, biliId);
const executed = db.prepare(`SELECT COUNT(*) n FROM engagements WHERE account_id=? AND status='executed'`).get(biliId).n;
check('approved → executed（fake ego）', executed === 3, JSON.stringify(r));

// ---------- 7. trust/复盘 ----------
console.log('\n[7] trust_score 与复盘');
db.prepare(`INSERT INTO metrics(post_id, day, views, likes, comments, shares, collected_at) VALUES
  (?,1,100,10,2,1,?), (?,3,500,40,8,3,?)`).run(postId, new Date().toISOString(), postId, new Date().toISOString());
db.prepare(`INSERT INTO posts(id, material_cloud_id, account_id, platform, adapted_payload, status, scheduled_at, published_at)
  VALUES('p-peer','mp',?,'bili','{}','confirmed',?,?)`).run(biliId, new Date().toISOString(), new Date().toISOString());
db.prepare(`INSERT INTO metrics(post_id, day, views, likes, comments, shares, collected_at) VALUES('p-peer',1,200,20,4,2,?)`).run(new Date().toISOString());
r = planner.review(db, cfg, postId, 7);
check('复盘卡片含同龄对比', r.ok && r.card.length === 2 && typeof r.card[0].vs_peers.views === 'number', JSON.stringify(r.card && r.card[0]));
check('同龄对比数值正确（100-200=-100）', r.card[0].vs_peers.views === -100, JSON.stringify(r.card[0].vs_peers));

// ---------- 8. 云 API ----------
console.log('\n[8] maitian-cloud API');
try {
  let res = await fetch(`${CLOUD}/v1/materials`);
  check('无 key → 401', res.status === 401);
  const H = { authorization: 'Bearer testkey-123' };
  res = await fetch(`${CLOUD}/v1/materials`, { headers: H });
  check('带 key 列表可达', res.ok);

  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake-video-bytes-0')]), 'video0.mp4');
  fd.append('meta', JSON.stringify({ title: '第一条素材', type: 'video', platform_tags: ['common', 'bili'] }));
  res = await fetch(`${CLOUD}/v1/materials`, { method: 'POST', headers: H, body: fd });
  const up = await res.json();
  check('上传素材', res.ok && up.id, JSON.stringify(up));
  const matId = up.id;

  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('fake-video-bytes-0')]), 'video0-again.mp4');
  fd2.append('meta', JSON.stringify({ title: '重复上传', type: 'video', platform_tags: ['common'] }));
  res = await fetch(`${CLOUD}/v1/materials`, { method: 'POST', headers: H, body: fd2 });
  const up2 = await res.json();
  check('sha256 去重返回既有 id', up2.dedup === true && up2.id === matId, JSON.stringify(up2));

  res = await fetch(`${CLOUD}/v1/materials?platform=xhs`, { headers: H });
  let list = await res.json();
  check('列表含 common 候选', list.items.some((i) => i.id === matId));

  res = await fetch(`${CLOUD}/v1/materials/${matId}/claim`, { method: 'POST', headers: H, body: JSON.stringify({ device: 'devA' }) });
  check('claim devA', (await res.json()).ok === true);
  res = await fetch(`${CLOUD}/v1/materials/${matId}/claim`, { method: 'POST', headers: H, body: JSON.stringify({ device: 'devB' }) });
  check('他人 claim → 409', res.status === 409);
  res = await fetch(`${CLOUD}/v1/materials/${matId}/claim`, { method: 'POST', headers: H, body: JSON.stringify({ device: 'devA' }) });
  check('同人 claim 幂等', (await res.json()).ok === true);
  res = await fetch(`${CLOUD}/v1/materials/${matId}/release`, { method: 'POST', headers: H, body: '{}' });
  check('release', (await res.json()).ok === true);

  res = await fetch(`${CLOUD}/v1/materials/${matId}/used`, { method: 'POST', headers: H, body: JSON.stringify({ platform: 'bili', account_id: biliId, url: 'https://b23.tv/x' }) });
  check('used 回写', (await res.json()).ok === true);
  res = await fetch(`${CLOUD}/v1/materials?platform=bili`, { headers: H });
  list = await res.json();
  check('used_on 追加', list.items[0].used_on.length === 1, JSON.stringify(list.items[0].used_on));

  res = await fetch(`${CLOUD}/v1/materials/${matId}/download`, { headers: H, redirect: 'manual' });
  check('download → 302', res.status === 302);
  const loc = res.headers.get('location');
  res = await fetch(`${CLOUD}${loc}`);
  const buf = Buffer.from(await res.arrayBuffer());
  check('签名 URL 取回文件一致', buf.toString() === 'fake-video-bytes-0');
  res = await fetch(`${CLOUD}/v1/files/${matId}?exp=1&sig=bad`);
  check('坏签名 → 403', res.status === 403);

  res = await fetch(`${CLOUD}/v1/journal`, { method: 'POST', headers: H, body: JSON.stringify({ device: 'devA', action: 'post_confirmed', detail: { x: 1 } }) });
  check('journal', (await res.json()).ok === true);

  res = await fetch(`${CLOUD}/v1/keys/rotate`, { method: 'POST', headers: H });
  const rot = await res.json();
  check('rotate 返回新 key', res.ok && rot.new_key, JSON.stringify(rot));
  res = await fetch(`${CLOUD}/v1/materials?limit=1`, { headers: { authorization: 'Bearer ' + rot.new_key } });
  check('新 key 可用', res.ok);
  res = await fetch(`${CLOUD}/v1/materials?limit=1`, { headers: H });
  check('旧 key 7 天双活仍可用', res.ok);
} catch (e) {
  check('云 API 流程异常', false, String(e));
}

// ---------- 9. 大屏 ----------
console.log('\n[9] 大屏 :8787');
cfg.hub.port = 20000 + ((process.pid + 7) % 20000);
const srv = startServer(db, cfg);
await new Promise((res) => setTimeout(res, 300));
let html = '';
try { html = await (await fetch(`http://127.0.0.1:${cfg.hub.port}/`)).text(); } catch {}
check('大屏页面可访问', html.includes('待审队列') && html.includes('红线'));
try {
  const st = await (await fetch(`http://127.0.0.1:${cfg.hub.port}/api/state`)).json();
  check('/api/state 结构', st.ok && Array.isArray(st.accounts) && st.queue && Array.isArray(st.calendar) && Array.isArray(st.audit));
} catch (e) { check('/api/state 结构', false, String(e)); }
srv.close();

// ---------- 10. round-runtime + 适配器纪律 ----------
console.log('\n[10] round-runtime（mock ego 全局）+ 坑位纪律 + 红线1');
const { createMockPage, installMockEgo, uninstallMockEgo } = await import(join(ROOT, 'test', 'mock-page.mjs'));
const page = createMockPage({ metrics: { 播放: 1000, 点赞: 100, 评论: 20, 分享: 5 } });
installMockEgo(page);
const rt = await import(join(ROOT, 'backend', 'src', 'ego', 'round-runtime.mjs'));
const P = {
  action: 'fill-bili-test', op: 'fill',
  account: { id: 'a-test', ego_space_id: 'mt-bili-a-test', display_name: '测试昵称', platform: 'bili' },
  params: { payload: { title: '测试视频标题', text: '正文', tags: ['测试'], local_media_path: '/tmp/fake.mp4' }, postId: 'p-test' },
  paths: {
    knowledge: join(baseCfg.paths.knowledge, 'bili.json'),
    adapter: join(baseCfg.paths.adapters, 'bili.mjs'),
    shotDir: join(tmp, 'shots2'), shotName: 'fill-test',
  },
};
let captured = null;
const origLog = console.log;
console.log = (line) => { if (String(line).startsWith('@@RESULT@@')) captured = JSON.parse(String(line).slice(10)); };
await rt.run(P);
console.log = origLog;
check('round-runtime fill 输出协议', captured && captured.ok === true && captured.data.drafted === true, JSON.stringify(captured && captured.error));
check('文件经 waitForFileChooser 上传', page.files.includes('/tmp/fake.mp4'), JSON.stringify(page.files));
const clicks = page.callLog.filter((c) => c.op === 'CLICK');
check('发生过点击（上传/标签等）', clicks.length >= 2, String(clicks.length));
let discipline = true;
for (let i = 0; i < page.callLog.length; i++) {
  if (page.callLog[i].op === 'CLICK') {
    const prev = page.callLog.slice(Math.max(0, i - 3), i).map((c) => c.op);
    if (!prev.includes('SCROLL_TEXT') && !prev.includes('SCROLL_SEL')) discipline = false;
  }
}
check('坑位2：所有点击前都有 scroll→重取', discipline, JSON.stringify(page.callLog));
const submitClicked = page.callLog.some((c, i) => {
  if (c.op !== 'CLICK') return false;
  const prev = page.callLog.slice(Math.max(0, i - 2), i);
  return prev.some((x) => x.op === 'FIND_TEXT' && /提交稿件|发布|Post|Publish|submit/i.test(x.needle || ''));
});
check('红线1：未点击任何发布/提交按钮', !submitClicked, JSON.stringify(clicks));
check('提交按钮仅被滚动定位（不点击）', page.callLog.some((c) => (c.op === 'SCROLL_SEL' && c.selector === '.submit-btn') || (c.op === 'SCROLL_TEXT' && c.needle === '提交稿件')), JSON.stringify(page.callLog.filter((c) => c.op.startsWith('SCROLL'))));
const Pv = JSON.parse(JSON.stringify(P)); Pv.op = 'verify';
captured = null;
console.log = (line) => { if (String(line).startsWith('@@RESULT@@')) captured = JSON.parse(String(line).slice(10)); };
await rt.run(Pv);
console.log = origLog;
check('verify 回读通过', captured && captured.ok && captured.data.ok === true, JSON.stringify(captured && captured.error));
const Pc = JSON.parse(JSON.stringify(P)); Pc.op = 'collect';
captured = null;
console.log = (line) => { if (String(line).startsWith('@@RESULT@@')) captured = JSON.parse(String(line).slice(10)); };
await rt.run(Pc);
console.log = origLog;
check('collect 读到指标', captured && captured.ok && captured.data.metrics && captured.data.metrics.views === 1000, JSON.stringify(captured && captured.data));
uninstallMockEgo();

// ---------- 11. 清理 ----------
db.close();
cloudProc.kill('SIGKILL');
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n===== 冒烟结果：${pass.length} 通过 / ${failLog.length} 失败 =====`);
if (failLog.length) {
  console.log('失败项：');
  for (const f of failLog) console.log('  ✗ ' + f);
  process.exit(1);
}
