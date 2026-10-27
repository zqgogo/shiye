import { LIMITS } from '../constants.js';
import type { ImportParseResult, ImportParseWarning, ParsedImportEntry } from '../types.js';
import { clampForStorage } from '../text.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);?/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const key = body.toLowerCase();
    return NAMED_ENTITIES[key] ?? NAMED_ENTITIES[body] ?? match;
  });
}

interface AttributeMap {
  [name: string]: string;
}

function parseAttributes(raw: string): AttributeMap {
  const attrs: AttributeMap = Object.create(null) as AttributeMap;
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    if (name) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function collapse(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * Netscape 书签 HTML 的纯解析器。
 * 不创建 DOM、不执行脚本、不加载图片或样式；只扫描标签与文本。
 * 目录按 DL/DT/H3 栈解析，兼容 H3 与嵌套 DL 同级以及 DT 内嵌 DL 两种结构。
 */
export function parseBookmarkHtml(html: string): ImportParseResult {
  const warnings: ImportParseWarning[] = [];
  const entries: ParsedImportEntry[] = [];
  const source = html.replace(/^\uFEFF/, '');

  if (!source.trim()) {
    return { entries, warnings: [{ code: 'EMPTY', message: '文件是空的。' }], nodes: 0 };
  }
  if (source.includes('\uFFFD')) {
    warnings.push({
      code: 'ENCODING',
      message: '文件包含无法解码的字符，标题可能不完整；请确认导出文件为 UTF-8。',
    });
  }

  const folderStack: string[] = [];
  let pendingFolder: string | null = null;
  let inH3 = false;
  let h3Buffer = '';
  let anchorHref: string | null = null;
  let anchorBuffer = '';
  let anchorIndex = 0;
  let nodes = 0;
  let depthWarned = false;
  let nodeWarned = false;
  let index = 0;

  const currentFolder = (): string => {
    const parts = folderStack.filter((part) => part.trim().length > 0);
    if (parts.length > LIMITS.importDepth) return parts.slice(0, LIMITS.importDepth).join(' / ');
    return parts.join(' / ');
  };

  let brokenWarned = false;

  const flushAnchor = (closed = true): void => {
    if (anchorHref === null) return;
    const href = anchorHref.trim();
    anchorHref = null;
    if (!closed && !brokenWarned) {
      brokenWarned = true;
      warnings.push({
        code: 'BROKEN_STRUCTURE',
        message: '有链接标签未正常闭合，已按可读内容尽量读取。',
      });
    }
    const rawTitle = collapse(decodeEntities(anchorBuffer));
    anchorBuffer = '';
    if (!href) return;
    let title = rawTitle;
    if ([...title].length > LIMITS.title) {
      title = clampForStorage(title, LIMITS.title);
      warnings.push({
        code: 'TITLE_TRUNCATED',
        message: `标题超过 ${LIMITS.title} 个字符，已截断显示。`,
      });
    }
    anchorIndex += 1;
    entries.push({
      sourceKey: `entry-${anchorIndex}`,
      line: anchorIndex,
      originalUrl: href,
      title,
      sourceFolder: currentFolder(),
    });
  };

  const handleTag = (tagText: string): void => {
    const closing = tagText.startsWith('/');
    const body = closing ? tagText.slice(1).trim() : tagText.replace(/\/$/, '').trim();
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(body);
    if (!nameMatch) return;
    const name = (nameMatch[1] ?? '').toLowerCase();
    nodes += 1;

    if (name === 'a') {
      if (closing) {
        flushAnchor(true);
        return;
      }
      flushAnchor(false);
      const attrs = parseAttributes(body.slice(name.length));
      pendingFolder = null;
      anchorHref = attrs['href'] ?? '';
      anchorBuffer = '';
      return;
    }

    if (name === 'h3') {
      if (closing) {
        inH3 = false;
        pendingFolder = collapse(decodeEntities(h3Buffer));
        h3Buffer = '';
      } else {
        inH3 = true;
        h3Buffer = '';
      }
      return;
    }

    if (name === 'dl') {
      if (closing) {
        if (folderStack.length > 1) folderStack.pop();
        pendingFolder = null;
      } else {
        if (folderStack.length >= LIMITS.importDepth && !depthWarned) {
          depthWarned = true;
          warnings.push({
            code: 'DEPTH_LIMIT',
            message: `目录层级超过 ${LIMITS.importDepth} 层，更深的目录会合并到上限层级。`,
          });
        }
        folderStack.push(pendingFolder ?? '');
        pendingFolder = null;
      }
      return;
    }

    if (name === 'p' || name === 'dt' || name === 'dd') return;

    // 其余标签（script/style/title 等）只需在开始处结束当前文本收集，内容本身不会被使用。
    if (!closing && (name === 'script' || name === 'style' || name === 'title')) {
      inH3 = false;
      h3Buffer = '';
    }
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    const textChunk = source.slice(index, lt === -1 ? source.length : lt);
    if (textChunk) {
      if (inH3) h3Buffer += textChunk;
      else if (anchorHref !== null) anchorBuffer += textChunk;
    }
    if (lt === -1) {
      index = source.length;
      break;
    }
    index = lt;

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<script', index) || source.startsWith('<style', index)) {
      const closeIndex = source.indexOf(
        source.startsWith('<script', index) ? '</script' : '</style',
        index
      );
      index = closeIndex === -1 ? source.length : closeIndex;
      continue;
    }

    // 找标签结束位置时跳过引号内的 >，兼容属性值里出现 > 的情况。
    let cursor = index + 1;
    let quote: string | null = null;
    while (cursor < source.length) {
      const char = source[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) break;
    handleTag(source.slice(index + 1, cursor));
    index = cursor + 1;

    if (nodes > LIMITS.importNodes) {
      if (!nodeWarned) {
        nodeWarned = true;
        warnings.push({
          code: 'NODE_LIMIT',
          message: `文件节点数超过 ${LIMITS.importNodes} 个，剩余部分未解析。`,
        });
      }
      break;
    }
  }
  flushAnchor(false);

  if (entries.length === 0) {
    warnings.push({ code: 'NO_LINKS', message: '没有找到书签链接，请确认文件来自浏览器书签导出。' });
  }

  return { entries, warnings, nodes };
}
