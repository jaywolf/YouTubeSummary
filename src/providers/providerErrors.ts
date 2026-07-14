import { AppError, type AppErrorCode, type RecoveryAction } from "../domain/errors";

type ErrorDefinition = {
  code: AppErrorCode;
  retryable: boolean;
  safeMessage: string;
  recoveryAction: RecoveryAction;
};

const STATUS_ERRORS: Record<number, ErrorDefinition> = {
  401: {
    code: "credentials_rejected",
    retryable: false,
    safeMessage: "The provider rejected the saved API key. Replace it in Settings.",
    recoveryAction: "settings"
  },
  402: {
    code: "insufficient_credits",
    retryable: false,
    safeMessage: "The provider account has insufficient credits or requires payment.",
    recoveryAction: "settings"
  },
  403: {
    code: "provider_forbidden",
    retryable: false,
    safeMessage: "The provider denied access to this model or request.",
    recoveryAction: "change_model"
  },
  408: {
    code: "network_timeout",
    retryable: true,
    safeMessage: "The provider request timed out.",
    recoveryAction: "retry"
  },
  429: {
    code: "rate_limited",
    retryable: true,
    safeMessage: "The provider rate limit was reached. Try again shortly.",
    recoveryAction: "retry"
  }
};

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1_000));
}

export function redactProviderMessage(value: string, apiKey: string): string {
  let redacted = value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  if (apiKey) redacted = redacted.split(apiKey).join("[redacted]");
  return redacted;
}

export function providerHttpError(response: Response): AppError {
  const definition = STATUS_ERRORS[response.status] ?? (response.status >= 500
    ? {
        code: "provider_unavailable" as const,
        retryable: true,
        safeMessage: "The provider is temporarily unavailable.",
        recoveryAction: "retry" as const
      }
    : {
        code: "configuration_invalid" as const,
        retryable: false,
        safeMessage: "The provider rejected the request configuration.",
        recoveryAction: "settings" as const
      });
  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
  return new AppError({
    ...definition,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  });
}

export function normalizeProviderError(error: unknown, apiKey: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AppError({
      code: "request_canceled",
      retryable: false,
      safeMessage: "Summary generation was canceled.",
      recoveryAction: "none",
      cause: error
    });
  }
  if (error instanceof TypeError) {
    return new AppError({
      code: "network_unavailable",
      retryable: true,
      safeMessage: "The provider could not be reached. Check the network and provider URL.",
      recoveryAction: "retry",
      cause: error
    });
  }
  return new AppError({
    code: "provider_unavailable",
    retryable: true,
    safeMessage: redactProviderMessage("The provider response could not be processed.", apiKey),
    recoveryAction: "retry",
    ...(error instanceof Error ? { cause: error } : {})
  });
}

export function providerOutputInvalid(cause?: Error): AppError {
  return new AppError({
    code: "provider_output_invalid",
    retryable: true,
    safeMessage: "The model returned an invalid summary. Retry or choose another model.",
    recoveryAction: "change_model",
    ...(cause ? { cause } : {})
  });
}
