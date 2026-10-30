import { LIMITS } from './constants.js';
import { AppError } from './errors.js';

/** 按 Unicode 码点计数，避免 emoji / 中文被 length 少算。 */
export function codePointLength(value: string): number {
  return [...value].length;
}

export function requireText(value: unknown, field: string, max: number, min = 1): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const length = codePointLength(text);
  if (length < min) {
    throw new AppError('INVALID_INPUT', `${field}不能为空。`);
  }
  if (length > max) {
    throw new AppError('INVALID_INPUT', `${field}最多 ${max} 个字符，当前 ${length} 个。`);
  }
  return text;
}

/** 可选文本：超限显式报错，绝不静默截断。 */
export function optionalText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value : '';
  if (codePointLength(text) > max) {
    throw new AppError('INVALID_INPUT', `${field}最多 ${max} 个字符，当前 ${codePointLength(text)} 个。`);
  }
  return text;
}

export function clampForStorage(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join('') : value;
}

/** 规范化 JSON 指纹：键排序，数组保序。用于 inputHash。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // 无 WebCrypto（极老环境）时退回确定性弱指纹，仅用于同机续接，不做安全用途。
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `weak-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : value;
}

export const TITLE_FALLBACK = '未命名收藏';

/** 缺标题时使用域名/URL，并标注是未提取的占位。 */
export function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const path = parsed.pathname.replace(/\/$/, '');
    return truncate(path && path !== '' ? `${host}${path}` : host, LIMITS.title);
  } catch {
    return TITLE_FALLBACK;
  }
}
