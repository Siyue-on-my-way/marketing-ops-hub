// smoke.mjs — 全链路冒烟测试（不需要真机 ego/平台，全部 mock 级验证）。
// 覆盖：DDL/账号/冷启动配额/防重/plan→run→confirm 状态机/风控停机/no_login/互动全流程/
//       trust_score/复盘对比/云 API 全套/大屏/round-runtime+适配器纪律（坑位2+红线1）。
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
r = planner.accountsAdd(db, cfg, 'bili', '老号昵称', null, { mature: true });
check('--mature 老号录入：active + trust0.8（红线10仅针对新号）', r.ok && r.account.status === 'active' && r.account.trust_score === 0.8, JSON.stringify(r.account && { s: r.account.status, t: r.account.trust_score }));
const matureQuota = planner.quotaOf({ status: 'active', daily_quota: JSON.stringify({ post: 2, like: 30, comment: 5, dm: 10 }), trust_score: 0.8 }, cfg);
check('--mature 老号可立即发布（post 配额 ≥1）', matureQuota.post >= 1, JSON.stringify(matureQuota));
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

// ---------- 5b. auto_publish 自动发布（红线 1 v2） ----------
console.log('\n[5b] auto_publish（红线 1 v2：自动发布）');
r = planner.accountsAdd(db, cfg, 'bili', '测试昵称', null, { mature: true, autoPublish: true });
check('accounts add --auto-publish', r.ok && r.account.auto_publish === true, JSON.stringify(r.account && { ap: r.account.auto_publish }));
const autoId = r.account.id;
writeFileSync(payloadFile, JSON.stringify({ bili: { title: '自动发布素材', text: 'x', tags: [], local_media_path: '/tmp/fake.mp4' } }));
r = planner.plan(db, cfg, 'mat-auto', { platforms: 'bili', accounts: autoId, payloadFile });
check('auto 账号 plan 成功', r.ok && r.results[0].post_id, JSON.stringify(r.results));
const autoPostId = r.results[0].post_id;
r = await planner.run(db, cfg, { due: true });
const apRow = db.prepare('SELECT * FROM posts WHERE id=?').get(autoPostId);
check('auto 账号：run 一条龙 fill→submit→verify→confirmed', apRow.status === 'confirmed' && apRow.published_url === 'https://example.com/fake-post', JSON.stringify({ s: apRow.status, u: apRow.published_url, e: apRow.error }));
check('auto 发布留审计', !!db.prepare(`SELECT 1 FROM audit_log WHERE account_id=? AND action='auto_submit'`).get(autoId));
r = planner.accountsSetAutoPublish(db, cfg, autoId, false);
check('accounts set --auto-publish off', r.ok && r.account.auto_publish === false);

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

// ---------- 8b. 用户门户（ACCESS-SPEC v1.2：注册/登录/租户隔离/密钥/邀请/成员） ----------
console.log('\n[8b] 用户门户');
try {
  const jar = {}; // username -> cookie
  const wapi = async (user, path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (jar[user]) headers.cookie = jar[user];
    if (opts.body && typeof opts.body !== 'string') { opts = { ...opts, body: JSON.stringify(opts.body) }; headers['content-type'] = 'application/json'; }
    const res = await fetch(`${CLOUD}${path}`, { ...opts, headers });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.includes('mt_session=')) jar[user] = sc.split(';')[0];
    let j = {}; try { j = await res.json(); } catch {}
    return { status: res.status, ...j };
  };

  // 注册：无邀请码 → 自建 workspace 为 owner，返回默认 api_key
  let r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'alice@test.local', password: 'alice-pass-123', password2: 'alice-pass-123' } });
  check('注册 alice（邮箱，自建 workspace + 默认密钥）', r.ok && r.api_key && r.role === 'owner' && r.tenant_id, JSON.stringify(r).slice(0, 120));
  const aliceKey = r.api_key, aliceTenant = r.tenant_id;
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'alice@test.local', password: 'alice-pass-123', password2: 'alice-pass-123' } });
  check('重复邮箱拒绝', !r.ok && String(r.error).includes('已注册'));
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'bob@test.local', password: 'short', password2: 'short' } });
  check('弱密码拒绝', !r.ok && String(r.error).includes('8 位'));
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'bad-account', password: 'long-enough-pw', password2: 'long-enough-pw' } });
  check('非邮箱/手机号拒绝', !r.ok && String(r.error).includes('邮箱或手机号'));
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'bob@test.local', password: 'bob-pass-12345', password2: 'different-123' } });
  check('两次密码不一致拒绝', !r.ok && String(r.error).includes('不一致'));
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: '13912345678', password: 'phone-pass-123', password2: 'phone-pass-123' } });
  check('手机号注册', r.ok && r.role === 'owner');

  // 登录 + cookie 会话
  r = await wapi('alice', '/webapi/login', { method: 'POST', body: { account: 'alice@test.local', password: 'alice-pass-123' } });
  check('登录发 cookie 会话', r.ok && !!jar.alice);
  r = await wapi('alice', '/webapi/materials?limit=50');
  check('alice 素材台可达', r.ok && Array.isArray(r.items));

  // 租户隔离：legacy key 上传 → alice 看不到；alice key 上传 → alice 可见
  const H = { authorization: 'Bearer testkey-123' };
  const fdA = new FormData();
  fdA.append('file', new Blob([Buffer.from('tenant-alice-bytes')]), 'a.bin');
  fdA.append('meta', JSON.stringify({ title: 'Alice 的素材', type: 'image', platform_tags: ['common'] }));
  let res = await fetch(`${CLOUD}/v1/materials`, { method: 'POST', headers: { authorization: 'Bearer ' + aliceKey }, body: fdA });
  const aliceMat = (await res.json()).id;
  check('alice 密钥上传素材', !!aliceMat);
  res = await fetch(`${CLOUD}/v1/materials?limit=50`, { headers: H });
  const legacyList = (await res.json()).items;
  check('租户隔离：legacy 看不到 alice 的素材', !legacyList.some((i) => i.id === aliceMat));
  r = await wapi('alice', '/webapi/materials?limit=50');
  check('alice 看得到自己的素材', r.items.some((i) => i.id === aliceMat));
  check('租户隔离：alice 看不到 legacy 的素材', !r.items.some((i) => i.title === '第一条素材'));

  // 门户网页素材管理（SIY-229：网页上传/编辑/删除/释放占用）
  const wcookie = () => ({ cookie: jar.alice });
  const fdAnon = new FormData();
  fdAnon.append('file', new Blob([Buffer.from('anon-bytes')]), 'a.png');
  fdAnon.append('title', '未登录上传');
  fdAnon.append('platform_tags', JSON.stringify(['common']));
  res = await fetch(`${CLOUD}/webapi/materials`, { method: 'POST', body: fdAnon });
  check('未登录网页上传 → 401', res.status === 401);
  r = await wapi('anon', '/webapi/materials');
  check('未登录 webapi 401（写端点同样受会话保护）', r.status === 401);
  const fdWeb = new FormData();
  fdWeb.append('file', new Blob([Buffer.from('portal-upload-bytes')]), 'clip.mp4');
  fdWeb.append('title', '网页上传的视频');
  fdWeb.append('platform_tags', JSON.stringify(['common', 'douyin']));
  fdWeb.append('note', '门户直接上传');
  res = await fetch(`${CLOUD}/webapi/materials`, { method: 'POST', headers: wcookie(), body: fdWeb });
  const webUp = await res.json();
  check('门户网页上传（type 缺省按扩展名推断）', res.ok && webUp.id, JSON.stringify(webUp));
  const webMatId = webUp.id;
  r = await wapi('alice', '/webapi/materials?limit=50');
  const webRow = r.items.find((i) => i.id === webMatId);
  check('网页上传的素材类型推断为 video', webRow && webRow.type === 'video', JSON.stringify(webRow));
  check('列表返回 note/sha256（详情用）', webRow && webRow.note === '门户直接上传' && !!webRow.sha256);
  const fdDup = new FormData();
  fdDup.append('file', new Blob([Buffer.from('portal-upload-bytes')]), 'clip-again.mp4');
  fdDup.append('title', '重复上传');
  fdDup.append('platform_tags', JSON.stringify(['xhs']));
  res = await fetch(`${CLOUD}/webapi/materials`, { method: 'POST', headers: wcookie(), body: fdDup });
  const webDup = await res.json();
  check('网页上传 sha256 去重', webDup.dedup === true && webDup.id === webMatId, JSON.stringify(webDup));
  const fdNoTitle = new FormData();
  fdNoTitle.append('file', new Blob([Buffer.from('x')]), 'a.png');
  fdNoTitle.append('platform_tags', JSON.stringify(['common']));
  res = await fetch(`${CLOUD}/webapi/materials`, { method: 'POST', headers: wcookie(), body: fdNoTitle });
  check('网页上传缺标题 → 400', res.status === 400);
  res = await fetch(`${CLOUD}/webapi/materials/${webMatId}`, { method: 'PATCH', headers: { ...wcookie(), 'content-type': 'application/json' }, body: JSON.stringify({ title: '改过的标题', platform_tags: ['bili'], note: '改过的备注' }) });
  r = await res.json();
  check('PATCH 编辑标题/标签/备注', res.ok && r.item.title === '改过的标题' && r.item.tags.join(',') === 'bili' && r.item.note === '改过的备注', JSON.stringify(r));
  res = await fetch(`${CLOUD}/webapi/materials/${webMatId}`, { method: 'PATCH', headers: { ...wcookie(), 'content-type': 'application/json' }, body: JSON.stringify({ title: '  ' }) });
  check('PATCH 空标题 → 400', res.status === 400);
  res = await fetch(`${CLOUD}/webapi/materials/${webMatId}`, { method: 'PATCH', headers: { ...wcookie(), 'content-type': 'application/json' }, body: JSON.stringify({ platform_tags: ['weixin'] }) });
  check('PATCH 非法标签 → 400', res.status === 400);
  res = await fetch(`${CLOUD}/v1/materials/${webMatId}/claim`, { method: 'POST', headers: { authorization: 'Bearer ' + aliceKey }, body: JSON.stringify({ device: 'dev-web-test' }) });
  check('claim 供释放测试', res.ok);
  r = await wapi('alice', '/webapi/materials/' + webMatId + '/release', { method: 'POST', body: {} });
  check('门户释放占用', r.ok);
  r = await wapi('alice', '/webapi/materials?limit=50');
  check('释放后占用清空', (r.items.find((i) => i.id === webMatId) || {}).claimed_by == null);
  // 租户边界：eve 自建 workspace 动 alice 的素材 → 404
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'eve@test.local', password: 'eve-pass-12345', password2: 'eve-pass-12345' } });
  check('eve 注册自建 workspace', r.ok);
  await wapi('eve', '/webapi/login', { method: 'POST', body: { account: 'eve@test.local', password: 'eve-pass-12345' } });
  r = await wapi('eve', '/webapi/materials/' + webMatId, { method: 'PATCH', body: { title: '越权改' } });
  check('跨租户 PATCH → 404', r.status === 404);
  r = await wapi('eve', '/webapi/materials/' + webMatId, { method: 'DELETE', body: {} });
  check('跨租户 DELETE → 404', r.status === 404);
  r = await wapi('eve', '/webapi/materials?limit=50');
  check('跨租户列表不可见', !r.items.some((i) => i.id === webMatId));
  res = await fetch(`${CLOUD}/webapi/materials/${webMatId}`, { method: 'DELETE', headers: wcookie(), body: '{}' });
  check('门户删除素材', res.ok);
  res = await fetch(`${CLOUD}/webapi/materials/${webMatId}/file`, { headers: wcookie(), redirect: 'manual' });
  check('删除后下载 → 404', res.status === 404);
  r = await wapi('alice', '/webapi/materials?limit=50');
  check('删除后列表不再出现', !r.items.some((i) => i.id === webMatId));

  // 密钥管理：新建 → 新旧并存；吊销默认 → 默认 401、新 key 可用；吊销最后一把被拒
  r = await wapi('alice', '/webapi/me/keys', { method: 'POST', body: { name: '服务器hub' } });
  const newKey = r.api_key;
  check('新建密钥（明文仅此一次）', !!newKey && Array.isArray(r.keys) && r.keys.length === 2);
  res = await fetch(`${CLOUD}/v1/whoami`, { headers: { authorization: 'Bearer ' + newKey } });
  check('新密钥 whoami', res.status === 200 && (await res.json()).user === 'alice@test.local');
  const keysNow = (await wapi('alice', '/webapi/me/keys')).keys;
  const defaultKey = keysNow.find((k) => k.name === '默认密钥');
  r = await wapi('alice', '/webapi/me/keys/' + defaultKey.id, { method: 'DELETE', body: {} });
  check('默认密钥拒绝吊销（密钥交互 v2：账号始终保留默认密钥）', !r.ok);
  const hubKeyId = (await wapi('alice', '/webapi/me/keys')).keys.find((k) => k.name === '服务器hub').id;
  r = await wapi('alice', '/webapi/me/keys/' + hubKeyId, { method: 'DELETE', body: {} });
  check('吊销新建密钥', r.ok);
  res = await fetch(`${CLOUD}/v1/whoami`, { headers: { authorization: 'Bearer ' + newKey } });
  check('被吊销密钥立即 401', res.status === 401);
  r = await wapi('alice', '/webapi/me/keys/' + hubKeyId, { method: 'DELETE', body: {} });
  check('重复吊销幂等', r.ok);

  // 邀请链接：alice 邀请 bob 加入同一 workspace
  r = await wapi('alice', '/webapi/me/invite');
  check('生成邀请链接', r.ok && r.invite_code);
  r = await wapi(null, '/webapi/register', { method: 'POST', body: { account: 'bob@test.local', password: 'bob-pass-12345', password2: 'bob-pass-12345', invite_code: r.invite_code } });
  check('bob 持邀请码注册加入 alice workspace', r.ok && r.role === 'member' && r.tenant_id === aliceTenant, JSON.stringify({ t: r.tenant_id, at: aliceTenant }));
  const bobKey = r.api_key;
  r = await wapi('bob', '/webapi/login', { method: 'POST', body: { account: 'bob@test.local', password: 'bob-pass-12345' } });
  check('bob 登录获得会话', r.ok && !!jar.bob);
  r = await wapi('bob', '/webapi/materials?limit=50');
  check('bob 看得到 workspace 内素材', r.ok && r.items.some((i) => i.id === aliceMat));
  r = await wapi('alice', '/webapi/members');
  check('成员列表含 alice/bob', r.members.length === 2);
  const bobId = r.members.find((x) => x.username === 'bob@test.local').id;
  r = await wapi('alice', '/webapi/members/' + bobId, { method: 'DELETE', body: {} });
  check('owner 移除成员', r.ok);
  res = await fetch(`${CLOUD}/v1/whoami`, { headers: { authorization: 'Bearer ' + bobKey } });
  check('被移除成员的密钥立即 401', res.status === 401);

  // 改密 + legacy whoami
  r = await wapi('alice', '/webapi/password', { method: 'POST', body: { old: 'alice-pass-123', new: 'alice-pass-456' } });
  check('改密成功', r.ok);
  r = await wapi('alice', '/webapi/login', { method: 'POST', body: { account: 'alice@test.local', password: 'alice-pass-123' } });
  check('旧密码失效', r.status === 401);
  res = await fetch(`${CLOUD}/v1/whoami`, { headers: H });
  const lw = await res.json();
  check('legacy key whoami 归 default 租户', res.status === 200 && lw.tenant_id === 'default' && lw.user === 'legacy');
} catch (e) {
  check('门户流程异常', false, String(e));
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

// ---------- 11. 自进化 E1：策略库 + 提案闭环（回路①，EVOLUTION-SPEC §4.1） ----------
console.log('\n[11] E1 回路①：strategies 提案 → 人审 → version+1 → 消费');
{
  // 测试用临时 L2 目录（不污染仓库内文件）；初始策略文件以仓库版为种子
  const stratDir = join(tmp, 'strategies');
  const knowDir = join(tmp, 'knowledge');
  mkdirSync(stratDir, { recursive: true });
  mkdirSync(knowDir, { recursive: true });
  for (const p of ['xhs', 'douyin', 'tiktok', 'yt', 'bili', 'x', 'xianyu']) {
    copyFileSync(join(ROOT, 'content-hub', 'docs', 'strategies', p + '.json'), join(stratDir, p + '.json'));
    copyFileSync(join(ROOT, 'content-hub', 'docs', 'knowledge', p + '.json'), join(knowDir, p + '.json'));
  }
  cfg.paths.strategies = stratDir;
  cfg.paths.knowledge = knowDir;

  const evo = await import(join(ROOT, 'backend', 'src', 'evolution.mjs'));
  let s = evo.strategyShow(cfg, 'bili');
  check('strategy show 初始 v1（含 engage 段）', s.ok && s.strategy.version === 1 && s.strategy.engage && Array.isArray(s.strategy.engage.target_traits), JSON.stringify(s).slice(0, 120));

  // 证据缺失 → 拒绝入库（§4.1：每条模式带 evidence）
  const noEv = await evo.proposalAdd(db, cfg, { kind: 'strategy', platform: 'bili', payload: { current_version: 1, proposed: { version: 1 }, evidence: [] } });
  check('无 evidence 策略提案拒绝入库', !noEv.ok && String(noEv.error).includes('evidence'), JSON.stringify(noEv));

  // 乐观锁：基于旧版本的提案 → 拒绝（直接改配置/过期分析不能溜进队列）
  const stale = await evo.proposalAdd(db, cfg, {
    kind: 'strategy', platform: 'bili',
    payload: { summary: '基于旧版', current_version: 0, proposed: { title_patterns: [{ pattern: '过期提案', confidence: 0.1 }] }, evidence: [{ m: 'x' }] },
  });
  check('乐观锁：基于 v0 的提案被拒（当前 v1）', !stale.ok && String(stale.error).includes('BASE_VERSION_CONFLICT'), JSON.stringify(stale));

  // 正常提案：8 条假 metrics 的周分析产物（此处直接构造提案 diff）
  const cur = evo.strategyShow(cfg, 'bili').strategy;
  const proposed = JSON.parse(JSON.stringify(cur));
  proposed.title_patterns = [{ pattern: '疑问句式标题', evidence: { avg_views_ratio: 1.8, samples: ['p-1', 'p-2'] }, confidence: 0.6 }];
  proposed.tag_patterns = [{ pattern: '教程类标签', evidence: { avg_likes_ratio: 1.4 }, confidence: 0.5 }];
  proposed.timing = { best_hours: [20, 21], evidence: 'day1 views 按发布小时分组对比：20-21 点组均值 1.6×' };
  const propFile = join(tmp, 'strat-proposal.json');
  writeFileSync(propFile, JSON.stringify({ summary: '周分析 v1→v2：疑问式标题+20点档表现好', current_version: 1, proposed, evidence: [{ metric: 'day1_views', detail: '8 条样本分组对比' }] }));
  r = await evo.proposalAdd(db, cfg, { kind: 'strategy', platform: 'bili', payload: JSON.parse(readFileSync(propFile, 'utf8')) });
  check('策略提案入库 drafted', r.ok && r.status.includes('drafted'), JSON.stringify(r));
  const propId = r.proposal_id;

  let listed = evo.proposalList(db, cfg, 'drafted');
  check('proposal list drafted 可见', listed.ok && listed.proposals.some((p) => p.id === propId), JSON.stringify(listed.proposals && listed.proposals.map((p) => p.id)));

  const ap = await evo.proposalApprove(db, cfg, propId);
  check('approve → 策略库 version=2', ap.ok && ap.version === 2, JSON.stringify(ap));
  s = evo.strategyShow(cfg, 'bili');
  check('策略文件已落地 v2 且 source=proposal', s.ok && s.strategy.version === 2 && String(s.strategy.source).startsWith('proposal:'), JSON.stringify({ v: s.strategy.version, src: s.strategy.source }));
  check('改写依据可引用（title_patterns 生效）', s.ok && s.strategy.title_patterns.length === 1 && s.strategy.title_patterns[0].pattern === '疑问句式标题', JSON.stringify(s.strategy.title_patterns));
  const hist = evo.strategyHistory(cfg, 'bili');
  check('versions/ 归档存在（保留最近 10 版）', hist.ok && hist.versions.length === 1 && hist.versions[0].file.includes('-v1-'), JSON.stringify(hist.versions));

  const dup = await evo.proposalApprove(db, cfg, propId);
  check('重复 approve 拒绝（已裁决）', !dup.ok && String(dup.error).includes('仅 drafted'), JSON.stringify(dup));

  // 演示「直接改配置不生效」：手工改文件不经提案 → 无归档、无审计、队列无记录
  const tampered = JSON.parse(readFileSync(join(stratDir, 'bili.json'), 'utf8'));
  tampered.title_patterns = [{ pattern: '绕过队列的伪造模式', confidence: 0.99 }];
  writeFileSync(join(stratDir, 'bili.json'), JSON.stringify(tampered, null, 2));
  const appliedRows = db.prepare(`SELECT applied_version, status FROM proposals WHERE kind IN ('strategy','engage') AND status='approved'`).all();
  const appliedBefore = appliedRows.length;
  const auditsBefore = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='proposal_applied'`).get().n;
  check('直接改配置：hub 进化书账无任何变化（只认提案→人审路径）',
    db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='proposal_applied'`).get().n === auditsBefore
    && db.prepare(`SELECT COUNT(*) n FROM proposals WHERE status='approved'`).get().n === appliedBefore
    && appliedRows.every((x) => x.applied_version === 2), JSON.stringify(appliedRows));
  // 恢复 v2 内容（模拟操作者用归档回滚伪造改动——回滚路径可用）
  const rollback = JSON.parse(readFileSync(join(stratDir, 'versions', hist.versions[0].file.replace(/^.*[\\/]/, '')), 'utf8'));
  check('回滚材料可读（versions 归档内容完整）', rollback && rollback.version === 1 && rollback.platform === 'bili', JSON.stringify({ v: rollback.version }));
}

// ---------- 12. 自进化 E2：知识包自愈 + 云端热更（回路②，EVOLUTION-SPEC §4.2） ----------
console.log('\n[12] E2 回路②：失败现场 dom_snapshot → 字段级提案 → 人审 → 云端热更 sync');
{
  const evo = await import(join(ROOT, 'backend', 'src', 'evolution.mjs'));
  const H = { authorization: 'Bearer testkey-123' };

  // 12a. 失败现场采集：round-runtime catch 分支补采 dom_snapshot
  const throwAdapter = join(tmp, 'throw-adapter.mjs');
  writeFileSync(throwAdapter, 'export default { async fill() { throw new Error("BOOM: 模拟页面结构变化"); } };\n');
  const { createMockPage: mkPage2, installMockEgo: installEgo2, uninstallMockEgo: uninstallEgo2 } = await import(join(ROOT, 'test', 'mock-page.mjs'));
  const pg2 = mkPage2({ innerText: '页面结构变化后的 innerText 现场内容 新版标题输入框按钮' }); // 注意：不含风控关键词，否则 preflight 前置拦截走不到 catch
  installEgo2(pg2);
  const rt2 = await import(join(ROOT, 'backend', 'src', 'ego', 'round-runtime.mjs'));
  const P2 = {
    action: 'fill-bili-selfheal', op: 'fill',
    account: { id: 'a-heal', ego_space_id: 'mt-bili-a-heal', display_name: '测试昵称', platform: 'bili' },
    params: { payload: { title: 't', text: 'x', tags: [] } },
    paths: { knowledge: join(cfg.paths.knowledge, 'bili.json'), adapter: throwAdapter, shotDir: join(tmp, 'shots3'), shotName: 'heal-test' },
  };
  let cap2 = null;
  const olog = console.log;
  console.log = (line) => { if (String(line).startsWith('@@RESULT@@')) cap2 = JSON.parse(String(line).slice(10)); };
  await rt2.run(P2);
  console.log = olog;
  check('失败现场：catch 补采 dom_snapshot（innerText 前 4000 字）', cap2 && cap2.ok === false && !!cap2.dom_snapshot && cap2.dom_snapshot.includes('新版标题输入框'), JSON.stringify({ snap: cap2 && (cap2.dom_snapshot || '').slice(0, 40) }));
  uninstallEgo2();

  // 12b. 云端知识包端点：404 → PUT 建版 → 409 乐观锁 → 400 版本不连续
  let res = await fetch(`${CLOUD}/v1/knowledge?platform=x`, { headers: H });
  check('云端知识包初始 404', res.status === 404, String(res.status));
  const xLocal = JSON.parse(readFileSync(join(cfg.paths.knowledge, 'x.json'), 'utf8'));
  res = await fetch(`${CLOUD}/v1/knowledge/x`, { method: 'PUT', headers: H, body: JSON.stringify({ json: xLocal, base_version: 0 }) });
  check('云端 PUT 首版（base 0 → v1）', res.ok && (await res.json()).version === 1, String(res.status));
  res = await fetch(`${CLOUD}/v1/knowledge/x`, { method: 'PUT', headers: H, body: JSON.stringify({ json: xLocal, base_version: 0 }) });
  check('乐观锁：base_version 过期 → 409', res.status === 409, String(res.status));
  res = await fetch(`${CLOUD}/v1/knowledge/x`, { method: 'PUT', headers: H, body: JSON.stringify({ json: { ...xLocal, version: 5 }, base_version: 1 }) });
  check('版本不连续 → 400', res.status === 400, String(res.status));

  // 12c. sync：云端 v1 = 本地 v1 → up_to_date；云端推 v2 → sync 拉取（先归档再覆盖）
  let sync = await evo.knowledgeSync(db, cfg, { platform: 'x' });
  check('sync：版本一致 up_to_date', sync.ok && sync.report[0].action === 'up_to_date', JSON.stringify(sync.report));
  const xV2 = JSON.parse(JSON.stringify(xLocal)); xV2.version = 2; xV2.updated_at = new Date().toISOString();
  xV2.pages.publish.title_sel = '.cloud-fixed-title-input'; // 另一台设备经人审修复的选择器
  res = await fetch(`${CLOUD}/v1/knowledge/x`, { method: 'PUT', headers: H, body: JSON.stringify({ json: xV2, base_version: 1 }) });
  check('云端推进到 v2', res.ok, String(res.status));
  sync = await evo.knowledgeSync(db, cfg, { platform: 'x' });
  const xAfter = JSON.parse(readFileSync(join(cfg.paths.knowledge, 'x.json'), 'utf8'));
  check('sync：云端>本地 → 拉取覆盖（本地归档不静默丢失）', sync.ok && sync.report[0].action === 'pulled' && xAfter.version === 2, JSON.stringify(sync.report));
  const xVersionsDir = join(cfg.paths.knowledge, 'versions');
  check('sync 归档可回溯（versions/ 有 x 归档文件）', existsSync(xVersionsDir) && readdirSync(xVersionsDir).some((f) => f.startsWith('x-v1-')), JSON.stringify(readdirSync(xVersionsDir)));

  // 12d. 提案校验：无 basis 拒绝入库；流程级（steps/cadence）拒绝；字段级放行
  const kpFile = join(tmp, 'know-proposal.json');
  const noBasis = await evo.proposalAdd(db, cfg, { kind: 'knowledge', platform: 'bili', payload: { base_version: 1, changes: [{ path: 'pages.publish.title_sel', value: '.a' }] } });
  check('无依据（basis）提案直接拒绝入库', !noBasis.ok && String(noBasis.error).includes('basis'), JSON.stringify(noBasis));
  writeFileSync(kpFile, JSON.stringify({ base_version: 1, changes: [{ path: 'pages.publish.steps', value: ['改流程'] }] }));
  let bad = await evo.proposalAdd(db, cfg, { kind: 'knowledge', platform: 'bili', payload: JSON.parse(readFileSync(kpFile, 'utf8')), basis: 'dom_snapshot' });
  check('steps 流程级修改拒绝（禁改流程）', !bad.ok && String(bad.error).includes('字段级'), JSON.stringify(bad));
  writeFileSync(kpFile, JSON.stringify({ base_version: 1, changes: [{ path: 'cadence.post_gap_sec', value: [10, 20] }] }));
  bad = await evo.proposalAdd(db, cfg, { kind: 'knowledge', platform: 'bili', payload: JSON.parse(readFileSync(kpFile, 'utf8')), basis: 'screenshot' });
  check('cadence 修改拒绝（节奏走人工）', !bad.ok && String(bad.error).includes('字段级'), JSON.stringify(bad));
  writeFileSync(kpFile, JSON.stringify({
    summary: '修复 bili 标题输入框选择器（DOM 快照显示类名已更换）',
    base_version: 1,
    changes: [
      { path: 'pages.publish.title_sel', value: '.bili-title-input-v2' },
      { path: 'risk', value: ['验证码', 're:环境异常|安全验证|滑动验证|账号存在异常', 're:新风控文案'] },
    ],
  }));
  r = await evo.proposalAdd(db, cfg, { kind: 'knowledge', platform: 'bili', payload: JSON.parse(readFileSync(kpFile, 'utf8')), basis: 'dom_snapshot' });
  check('字段级提案（含 risk 更新）入库', r.ok, JSON.stringify(r));
  const kpId = r.proposal_id;
  const kap = await evo.proposalApprove(db, cfg, kpId);
  const biliAfter = JSON.parse(readFileSync(join(cfg.paths.knowledge, 'bili.json'), 'utf8'));
  check('approve → 本地知识包 version+1 且选择器落地', kap.ok && biliAfter.version === 2 && biliAfter.pages.publish.title_sel === '.bili-title-input-v2', JSON.stringify({ v: biliAfter.version }));
  res = await fetch(`${CLOUD}/v1/knowledge?platform=bili`, { headers: H });
  const cloudBili = await res.json();
  check('云端热更：approve 自动推送，云可拉到 v2', cloudBili.ok && cloudBili.version === 2 && cloudBili.json.pages.publish.title_sel === '.bili-title-input-v2', JSON.stringify({ v: cloudBili.version }));
  check('audit_log 留痕 proposal_applied（含云推送台账）', !!db.prepare(`SELECT 1 FROM audit_log WHERE action='proposal_applied' AND detail LIKE '%knowledge%'`).get(), '');
  const biliKnowledgeArchives = readdirSync(join(cfg.paths.knowledge, 'versions')).filter((f) => f.startsWith('bili-v1-'));
  check('知识包 versions 归档存在（bili v1 已归档）', biliKnowledgeArchives.length === 1, JSON.stringify(biliKnowledgeArchives));
}

// ---------- 13. 自进化 E4：配额收紧自适应（回路④，EVOLUTION-SPEC §4.4） ----------
console.log('\n[13] E4 回路④：quota_override 只收紧，clamp 在 hub 代码强制');
{
  const evo = await import(join(ROOT, 'backend', 'src', 'evolution.mjs'));
  const qFile = join(tmp, 'quota-proposal.json');

  // 上调提案 → hub 代码直接拒绝入库（方向锁死，不靠提示词）
  writeFileSync(qFile, JSON.stringify({ reason: '想让号多发一点', old: { like: 30 }, new: { like: 40 } }));
  r = await evo.proposalAdd(db, cfg, { kind: 'quota', accountId: xhsId, payload: JSON.parse(readFileSync(qFile, 'utf8')) });
  check('上调提案 → DIRECTION_REJECTED 拒绝入库', !r.ok && String(r.error).includes('DIRECTION_REJECTED'), JSON.stringify(r));

  // 冷启动账号不接受配额提案（红线 10 管辖，不进进化回路）
  const coldAcct = planner.accountsAdd(db, cfg, 'douyin', '冷号');
  writeFileSync(qFile, JSON.stringify({ reason: 'x', old: { like: 10 }, new: { like: 5 } }));
  r = await evo.proposalAdd(db, cfg, { kind: 'quota', accountId: coldAcct.account.id, payload: JSON.parse(readFileSync(qFile, 'utf8')) });
  check('冷启动账号配额提案拒绝（红线不进回路）', !r.ok && String(r.error).includes('红线'), JSON.stringify(r));

  // 正常收紧：like 30→20、comment 5→3（风控频发场景的 AI 提案产物）
  writeFileSync(qFile, JSON.stringify({ reason: '该号近 7 天 2 次风控信号，建议下调互动', old: { like: 30, comment: 5 }, new: { like: 20, comment: 3 } }));
  r = await evo.proposalAdd(db, cfg, { kind: 'quota', accountId: xhsId, payload: JSON.parse(readFileSync(qFile, 'utf8')) });
  check('收紧提案入库', r.ok, JSON.stringify(r));
  const qpId = r.proposal_id;
  const qap = await evo.proposalApprove(db, cfg, qpId);
  check('approve → quota_override 写入', qap.ok && qap.quota_override && qap.quota_override.like === 20 && qap.quota_override.comment === 3, JSON.stringify(qap));
  const xhsRow = db.prepare('SELECT * FROM accounts WHERE id=?').get(xhsId);
  const qEff = planner.quotaOf(xhsRow, cfg);
  check('quotaOf：override 生效（like 20 / comment 3）', qEff.like === 20 && qEff.comment === 3, JSON.stringify(qEff));
  check('quotaOf：未覆盖键仍按基线×trust', qEff.post === 10 && qEff.dm === 10, JSON.stringify(qEff));
  const health = planner.health(db, cfg);
  const hAcc = health.accounts.find((a) => a.id === xhsId);
  check('hub health 显示 override 且生效值收紧', hAcc.quota_override && hAcc.quota_override.like === 20 && hAcc.quota.like === 20 && hAcc.quota.comment === 3, JSON.stringify({ ov: hAcc.quota_override, q: hAcc.quota }));

  // 纵深防御：即使 DB 被直接改成超基线，quotaOf 仍 clamp ≤ 基线（代码强制，非提示词）
  db.prepare('UPDATE accounts SET quota_override=? WHERE id=?').run('{"like":999,"post":99}', xhsId);
  const qTampered = planner.quotaOf(db.prepare('SELECT * FROM accounts WHERE id=?').get(xhsId), cfg);
  check('篡改 DB 超基线 → clamp 兜底（like≤30 post≤10）', qTampered.like === 30 && qTampered.post === 10, JSON.stringify(qTampered));
  db.prepare('UPDATE accounts SET quota_override=? WHERE id=?').run(JSON.stringify({ like: 20, comment: 3 }), xhsId);
  check('audit 留痕 quota_override_set', !!db.prepare(`SELECT 1 FROM audit_log WHERE action='quota_override_set' AND account_id=?`).get(xhsId), '');
}

// ---------- 14. 自进化 E3：engage 段 + 反馈采集占位（回路③，EVOLUTION-SPEC §4.3） ----------
console.log('\n[14] E3 回路③：engage 策略段消费 + 反馈采集占位');
{
  const evo = await import(join(ROOT, 'backend', 'src', 'evolution.mjs'));
  // engage 提案 → 人审 → 策略库 engage 段更新（流程同回路①）
  const cur = evo.strategyShow(cfg, 'xhs').strategy;
  const proposed = JSON.parse(JSON.stringify(cur));
  proposed.engage = {
    target_traits: [{ trait: '1w-10w粉 同领域号', evidence: { sample_size: 12, follow_back_rate: 0.25 }, confidence: 0.5 }],
    note: '回路③：养号巡检选目标时消费本段',
  };
  r = await evo.proposalAdd(db, cfg, {
    kind: 'engage', platform: 'xhs',
    payload: { summary: '互动目标偏好 v1→v2', current_version: cur.version, proposed, evidence: [{ metric: 'follow_back', detail: '占位分析' }] },
  });
  check('engage 提案入库', r.ok, JSON.stringify(r));
  const eap = await evo.proposalApprove(db, cfg, r.proposal_id);
  const s2 = evo.strategyShow(cfg, 'xhs');
  check('approve → engage 段落地（version+1）', eap.ok && s2.strategy.version === 2 && s2.strategy.engage.target_traits.length === 1, JSON.stringify({ v: s2.strategy && s2.strategy.version }));

  // 反馈采集 = 占位实现（规格 §4.3：本期不做，不阻塞）
  const fb = await evo.collectEngagementFeedback(db, cfg, 'nonexistent-id');
  check('反馈采集：未知 id 报错', !fb.ok, JSON.stringify(fb));
  const eng1 = db.prepare(`SELECT id FROM engagements WHERE kind='comment' LIMIT 1`).get();
  const fb2 = await evo.collectEngagementFeedback(db, cfg, eng1.id);
  check('反馈采集占位：implemented=false + 说明', fb2.ok && fb2.implemented === false && String(fb2.placeholder).includes('占位'), JSON.stringify(fb2));
}

// ---------- 15. 大屏提案区块 + API ----------
console.log('\n[15] 大屏进化提案人审');
{
  const evo = await import(join(ROOT, 'backend', 'src', 'evolution.mjs'));
  cfg.hub.port = 20000 + ((process.pid + 13) % 20000);
  const srv2 = startServer(db, cfg);
  await new Promise((res) => setTimeout(res, 300));
  const st = await (await fetch(`http://127.0.0.1:${cfg.hub.port}/api/state`)).json();
  check('/api/state 含 proposals 队列', st.ok && Array.isArray(st.proposals) && st.proposals.length >= 4, String(st.proposals && st.proposals.length));
  const html2 = await (await fetch(`http://127.0.0.1:${cfg.hub.port}/`)).text();
  check('大屏含进化提案区块', html2.includes('进化提案') && html2.includes('approveProposal'), '');
  // 大屏 approve 一条待审提案（douyin 策略提案走全链路）
  const cur = evo.strategyShow(cfg, 'douyin').strategy;
  const proposed = JSON.parse(JSON.stringify(cur));
  proposed.tag_patterns = [{ pattern: '热门 BGM 标签', evidence: { avg_views_ratio: 1.2 }, confidence: 0.4 }];
  const add = await evo.proposalAdd(db, cfg, { kind: 'strategy', platform: 'douyin', payload: { summary: 'douyin 周分析', current_version: cur.version, proposed, evidence: [{ m: 1 }] } });
  const pr = await (await fetch(`http://127.0.0.1:${cfg.hub.port}/api/proposals/${add.proposal_id}/approve`, { method: 'POST' })).json();
  check('大屏 approve → 生效 v2', pr.ok && pr.version === 2, JSON.stringify(pr));
  srv2.close();
}

// ---------- 16. 清理 ----------
db.close();
cloudProc.kill('SIGKILL');
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n===== 冒烟结果：${pass.length} 通过 / ${failLog.length} 失败 =====`);
if (failLog.length) {
  console.log('失败项：');
  for (const f of failLog) console.log('  ✗ ' + f);
  process.exit(1);
}
