import { describe, expect, it } from 'vitest';
import { AppError, canonicalizeUrl, domainOf, tryCanonicalizeUrl } from './index.js';

describe('canonicalizeUrl', () => {
  it('保留 originalUrl 并规范化主机大小写与默认端口', () => {
    const result = canonicalizeUrl('  HTTPS://Example.COM:443/Path?A=1#Frag  ');
    expect(result.originalUrl).toBe('HTTPS://Example.COM:443/Path?A=1#Frag');
    expect(result.canonicalUrl).toBe('https://example.com/Path?A=1#Frag');
  });

  it('不删除 hash、不合并 http/https、不去 www、不去尾斜线', () => {
    const a = canonicalizeUrl('https://example.com/a#part-2').canonicalUrl;
    const b = canonicalizeUrl('https://example.com/a').canonicalUrl;
    expect(a).not.toBe(b);
    expect(canonicalizeUrl('http://example.com/x').canonicalUrl).toBe('http://example.com/x');
    expect(canonicalizeUrl('https://www.example.com/').canonicalUrl).toBe('https://www.example.com/');
    expect(canonicalizeUrl('https://example.com/dir/').canonicalUrl).toBe('https://example.com/dir/');
  });

  it('拒绝非 http(s)、空值、内嵌凭据和超长 URL', () => {
    for (const bad of ['javascript:alert(1)', 'chrome://bookmarks/', 'file:///etc/passwd', '', '   ']) {
      expect(tryCanonicalizeUrl(bad)).toBeNull();
    }
    expect(() => canonicalizeUrl('https://user:pass@example.com/')).toThrow(AppError);
    expect(() => canonicalizeUrl(`https://example.com/${'a'.repeat(9000)}`)).toThrow(AppError);
  });

  it('域名展示去掉 www', () => {
    expect(domainOf('https://www.example.com/a')).toBe('example.com');
    expect(domainOf('not a url')).toBe('未知来源');
  });
});
