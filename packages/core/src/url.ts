import { LIMITS } from './constants.js';
import { AppError } from './errors.js';

export interface UrlChecked {
  /** 用户输入（trim 后）的原始地址，作为 originalUrl 保存。 */
  originalUrl: string;
  /** 保守规范化结果，仅用于去重与索引，不覆盖 originalUrl。 */
  canonicalUrl: string;
}

/**
 * URL 规范化（保守）：
 * - 仅接受 http / https（含大写协议）；
 * - URL 内含账号密码一律拒绝；
 * - 主机名小写、去掉协议默认端口（由 URL 解析器完成）；
 * - 保留会改变内容的 path / query / hash：不删 hash、不合并 http 与 https、
 *   不去 www、不去尾斜线、不做相似标题合并。
 */
export function canonicalizeUrl(input: string): UrlChecked {
  const originalUrl = String(input ?? '').trim();
  if (!originalUrl) {
    throw new AppError('INVALID_INPUT', '请输入网址。');
  }
  if (originalUrl.length > LIMITS.url) {
    throw new AppError('INVALID_INPUT', `网址超过 ${LIMITS.url} 个字符。`);
  }
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    throw new AppError('INVALID_INPUT', '不是有效的网址，请包含 http:// 或 https://。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_INPUT', '只支持 http 或 https 链接。');
  }
  if (!parsed.hostname) {
    throw new AppError('INVALID_INPUT', '网址缺少主机名。');
  }
  if (parsed.username || parsed.password) {
    throw new AppError('INVALID_INPUT', '网址中包含账号或密码，已拒绝保存。');
  }
  if (parsed.href.length > LIMITS.url) {
    throw new AppError('INVALID_INPUT', `规范化后的网址超过 ${LIMITS.url} 个字符。`);
  }
  return { originalUrl, canonicalUrl: parsed.href };
}

/** 尝试规范化，不抛出异常。用于逐行解析。 */
export function tryCanonicalizeUrl(input: string): UrlChecked | null {
  try {
    return canonicalizeUrl(input);
  } catch {
    return null;
  }
}

export function isHttpUrl(input: string): boolean {
  return tryCanonicalizeUrl(input) !== null;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '未知来源';
  }
}

/** 仅用于展示：超长链接换行而不是撑破布局。 */
export function truncateMiddle(value: string, max = 80): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  const head = chars.slice(0, Math.floor(max / 2) - 1).join('');
  const tail = chars.slice(-(Math.floor(max / 2) - 1)).join('');
  return `${head}…${tail}`;
}
