export type AppErrorCode =
  | "unsupported_page"
  | "video_context_unavailable"
  | "captions_unavailable"
  | "transcript_extraction_failed"
  | "configuration_missing"
  | "configuration_invalid"
  | "custom_permission_denied"
  | "credentials_rejected"
  | "insufficient_credits"
  | "provider_forbidden"
  | "rate_limited"
  | "provider_unavailable"
  | "network_unavailable"
  | "network_timeout"
  | "context_limit_exceeded"
  | "provider_output_invalid"
  | "content_filtered"
  | "request_canceled"
  | "request_interrupted"
  | "internal_error";

export type RecoveryAction = "retry" | "settings" | "change_model" | "none";
export type SafeAppError = {
  code: AppErrorCode;
  retryable: boolean;
  safeMessage: string;
  recoveryAction: RecoveryAction;
  retryAfterSeconds?: number;
};

export type AppErrorOptions = SafeAppError & { cause?: Error };

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly recoveryAction: RecoveryAction;
  readonly retryAfterSeconds?: number;

  constructor({ cause, ...safeError }: AppErrorOptions) {
    super(safeError.safeMessage, cause ? { cause } : undefined);
    this.name = "AppError";
    this.code = safeError.code;
    this.retryable = safeError.retryable;
    this.safeMessage = safeError.safeMessage;
    this.recoveryAction = safeError.recoveryAction;
    if (safeError.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = safeError.retryAfterSeconds;
    }
  }
}

export function toSafeError(error: AppError): SafeAppError {
  const safeError: SafeAppError = {
    code: error.code,
    retryable: error.retryable,
    safeMessage: error.safeMessage,
    recoveryAction: error.recoveryAction
  };

  if (error.retryAfterSeconds !== undefined) {
    safeError.retryAfterSeconds = error.retryAfterSeconds;
  }

  return safeError;
}
