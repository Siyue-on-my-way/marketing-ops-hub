// migrate-keys.mjs — 一次性迁移（2026-11 密钥可复制改造配套）：
//   1) 旧版有效密钥（key_enc 为空且未吊销）→ 同名生成一把加密存储的新密钥（可复制/回显），并移除旧记录
//   2) 已吊销的旧版记录（key_enc 为空且已吊销）→ 直接清除
// 用法：MAITIAN_DATA_DIR=<数据目录> node cloud/migrate-keys.mjs
// 容器内：docker compose exec maitian-cloud node cloud/migrate-keys.mjs
// 注意：新密钥明文不显示（门户列表悬停「复制」即可取回）；旧密钥立即失效，使用旧密钥的设备需换新。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { openStore, sha256 } from './store.mjs';

const DATA_DIR = process.env.MAITIAN_DATA_DIR || join(import.meta.dirname, 'data');
const store = openStore(DATA_DIR);

function keyEncSecret() {
  if (process.env.MAITIAN_KEY_ENC_SECRET) return process.env.MAITIAN_KEY_ENC_SECRET;
  if (existsSync(store.keySecretFile)) return readFileSync(store.keySecretFile, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(store.keySecretFile, s);
  return s;
}
function encryptKey(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyEncSecret(), 'hex'), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

const legacyActive = store.db.prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL AND key_enc IS NULL').all();
const legacyRevoked = store.db.prepare('SELECT * FROM api_keys WHERE revoked_at IS NOT NULL AND key_enc IS NULL').all();
const now = new Date().toISOString();

let replaced = 0;
for (const row of legacyActive) {
  const plain = 'mtk_' + randomBytes(24).toString('hex');
  store.db.prepare(
    'INSERT INTO api_keys(id, user_id, tenant_id, name, key_hash, key_hint, key_enc, created_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run('k' + randomBytes(6).toString('hex'), row.user_id, row.tenant_id, row.name, sha256(plain), plain.slice(0, 6) + '…', encryptKey(plain), now);
  store.db.prepare('DELETE FROM api_keys WHERE id=?').run(row.id);
  replaced += 1;
  console.log(`replaced: user=${row.user_id} name=${row.name} old_hint=${row.key_hint} → 新密钥已生成（门户列表悬停复制）`);
}
let purged = 0;
for (const row of legacyRevoked) {
  store.db.prepare('DELETE FROM api_keys WHERE id=?').run(row.id);
  purged += 1;
  console.log(`purged revoked legacy: hint=${row.key_hint}`);
}

const left = store.db.prepare('SELECT COUNT(*) n FROM api_keys WHERE revoked_at IS NULL AND key_enc IS NULL').get().n;
console.log(`\n完成：替换 ${replaced} 把旧版有效密钥，清除 ${purged} 条旧版吊销记录；剩余不可回显的有效密钥：${left}`);
if (left > 0) process.exit(1);
