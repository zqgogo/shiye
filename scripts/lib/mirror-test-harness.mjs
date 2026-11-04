import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export async function createMirrorHarness(root, temporary) {
  const output = path.join(temporary, 'worker.mjs');
  await build({ entryPoints: [path.join(root, 'apps/worker/src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output });
  const { handleRequest } = await import(pathToFileURL(output).href);
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(path.join(root, 'apps/worker/migrations/0001_mirror.sql'), 'utf8'));
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first() { return db.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.values) }; }
    syncRun() { return { meta: { changes: Number(db.prepare(this.sql).run(...this.values).changes) } }; }
    async run() { return this.syncRun(); }
  }
  const publisher = 'synthetic_publisher_0123456789_abcdefghijklmnopqrstuvwxyz', reader = 'synthetic_reader_0123456789_abcdefghijklmnopqrstuvwxyz';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const env = { WRITE_TOKEN_SHA256: hash(publisher), READ_TOKEN_SHA256: hash(reader), DB: { prepare: (sql) => new Statement(sql),
    async batch(statements) { db.exec('BEGIN IMMEDIATE'); try { const values = statements.map((statement) => statement.syncRun()); db.exec('COMMIT'); return values; } catch (error) { db.exec('ROLLBACK'); throw error; } } },
    ASSETS: { async fetch(request) { const file = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }[new URL(request.url).pathname];
      if (!file) return new Response('Not Found', { status: 404 }); return new Response(fs.readFileSync(path.join(root, 'apps/worker/public', file[0])), { headers: { 'Content-Type': `${file[1]}; charset=utf-8` } }); } } };
  return { publisher, reader, db, async request(url, init = {}) { const response = await handleRequest(new Request(url, init), env); return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }; }, close: () => db.close() };
}
