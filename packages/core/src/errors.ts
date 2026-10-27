/** 统一错误码。界面按 code 映射文案与允许的下一步动作。 */
export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'ALREADY_APPLIED'
  | 'REVISION_CONFLICT'
  | 'STALE_SUGGESTION'
  | 'DELETED_RECORD'
  | 'TOMBSTONED'
  | 'LOCKED_FIELD'
  | 'PRIVACY_BLOCKED'
  | 'CATEGORY_IN_USE'
  | 'PINNED_LIMIT'
  | 'AI_DISABLED'
  | 'TEST_REQUIRED'
  | 'HOST_PERMISSION_DENIED'
  | 'AUTH_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'OUTCOME_UNKNOWN'
  | 'INVALID_AI_REPLY'
  | 'STORAGE_FAILED'
  | 'UNSUPPORTED_VERSION';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** 把未知异常归一成用户可读文案，避免把堆栈直接暴露到界面。 */
export function toUserMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '操作未完成，请重试。';
}
