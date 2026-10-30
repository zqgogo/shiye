export function nowIso(): string {
  return new Date().toISOString();
}

/** 把数值时间戳、日期字符串统一成 ISO；无法解析时退回当前时间。 */
export function toIso(value: unknown, fallback: string = nowIso()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return fallback;
}

export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return null;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatDate(iso)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 文件名用的本地时间戳，精确到秒。
 *
 * 导出文件名曾经只到「日」，同一天导出第二次就会和第一次同名：用户分不清哪份更新，
 * 替换前的安全备份还会和当天已有备份撞名，无交互下载时甚至直接覆盖掉上一份。
 */
export function fileStamp(iso: string | null, fallback: Date = new Date()): string {
  const parsed = iso ? new Date(iso) : fallback;
  const date = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
