import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const directory = path.resolve('.verify/cloudflare-setup');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const files = ['publisher.txt', 'reader.txt', 'WRITE_TOKEN_SHA256.txt', 'READ_TOKEN_SHA256.txt', 'local.dev.vars', 'submitter.txt', 'SUBMIT_TOKEN_SHA256.txt'];
if (files.some((name) => existsSync(path.join(directory, name)))) throw new Error('已有凭据文件，未覆盖。请先安全保存原文件，再将其移到其他位置。');
const publisher = randomBytes(32).toString('base64url'), reader = randomBytes(32).toString('base64url'), submitter = randomBytes(32).toString('base64url');
const hash = (text) => createHash('sha256').update(text).digest('hex');
for (const [name, value] of Object.entries({ 'publisher.txt': publisher, 'reader.txt': reader, 'submitter.txt': submitter,
  'SUBMIT_TOKEN_SHA256.txt': hash(submitter), 'WRITE_TOKEN_SHA256.txt': hash(publisher), 'READ_TOKEN_SHA256.txt': hash(reader),
  'local.dev.vars': `WRITE_TOKEN_SHA256=${hash(publisher)}\nREAD_TOKEN_SHA256=${hash(reader)}\nSUBMIT_TOKEN_SHA256=${hash(submitter)}` })) {
  writeFileSync(path.join(directory, name), `${value}\n`, { flag: 'wx', mode: 0o600 });
}
console.log('已生成三份独立应用凭据及其哈希：.verify/cloudflare-setup/。未打印凭据；请妥善保存，不要提交或转发发布凭据。');
