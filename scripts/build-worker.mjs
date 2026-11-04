import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
mkdirSync('.verify/worker-build', { recursive: true });
const result = spawnSync(process.execPath, [path.resolve('node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--outdir', path.resolve('.verify/worker-build'), '--config', path.resolve('apps/worker/wrangler.jsonc')], {
  stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.resolve('.verify/worker-build/wrangler.log') },
});
process.exit(result.status ?? 1);
