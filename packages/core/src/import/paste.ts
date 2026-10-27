import { LIMITS } from '../constants.js';
import type { ImportParseResult, ParsedImportEntry } from '../types.js';
import { AppError } from '../errors.js';

/**
 * 多链接粘贴解析：每行或空白分隔，不联网抓标题。
 * 行号保留用户在输入框里的可见行，便于核对。
 */
export function parsePasteInput(text: string): ImportParseResult {
  const lines = text.split(/\r\n|\r|\n/);
  const entries: ParsedImportEntry[] = [];
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    for (const token of line.split(/\s+/).filter(Boolean)) {
      if (entries.length >= LIMITS.importRows) {
        throw new AppError('TOO_MANY_ROWS', `单批最多 ${LIMITS.importRows} 条，请拆分后重试。`);
      }
      entries.push({
        sourceKey: `paste-${lineNo}-${entries.length + 1}`,
        line: lineNo,
        originalUrl: token,
        title: '',
        sourceFolder: '',
      });
    }
  }
  return { entries, warnings: [], nodes: entries.length };
}
