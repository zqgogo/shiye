import { describe, expect, it } from 'vitest';
import { backupFileName, snapshotFileName } from './backup.js';

describe('导出文件名', () => {
  it('精确到秒：同一天导出两次不会重名', () => {
    const first = backupFileName('2026-10-29T03:18:52.933Z');
    const second = backupFileName('2026-10-29T03:19:07.001Z');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^shiye-backup-\d{8}-\d{6}\.json$/);
  });

  it('快照文件名同样带时分秒', () => {
    expect(snapshotFileName('2026-10-29T03:18:52.933Z')).toMatch(
      /^shiye-collection-\d{8}-\d{6}\.html$/
    );
  });

  it('时间不可解析时退回当天时间，仍然可用', () => {
    expect(backupFileName('not-a-date')).toMatch(/^shiye-backup-\d{8}-\d{6}\.json$/);
  });
});
