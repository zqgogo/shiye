import { ShiyeDB, DB_NAME } from './db.js';
import { createRepositories, createBackupRepository } from './repositories.js';
import type { Repositories } from '@shiye/application';

export * from './db.js';
export * from './repositories.js';
export * from './backup.js';

export interface ShiyeStore {
  db: ShiyeDB;
  repos: Repositories;
}

/**
 * 扩展弹窗、service worker 与工作台页面都通过这里访问同一个 IndexedDB 主库。
 * UI 不直接操作 db，只使用 repos（application 定义的接口）。
 */
export function createShiyeStore(name: string = DB_NAME): ShiyeStore {
  const db = new ShiyeDB(name);
  return { db, repos: createRepositories(db, createBackupRepository(db)) };
}
