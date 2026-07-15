import {
  AppError,
  type AppErrorCode,
  type AppErrorOptions,
  type RecoveryAction
} from "../domain/errors";

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
    recoveryAction: "settings"
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

const automaticRetryErrors = new WeakSet<AppError>();

function appError(options: AppErrorOptions, automaticRetry = false): AppError {
  const error = new AppError(options);
  if (automaticRetry) automaticRetryErrors.add(error);
  return error;
}

export function isAutomaticRetryEligible(error: AppError): boolean {
  return automaticRetryErrors.has(error);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return !Number.isFinite(seconds) || seconds > 60 ? 61 : seconds;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  const seconds = Math.max(0, Math.ceil((date - now) / 1_000));
  return !Number.isFinite(seconds) || seconds > 60 ? 61 : seconds;
}

export function redactProviderMessage(value: string, apiKey: string): string {
  let redacted = value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  if (apiKey) redacted = redacted.split(apiKey).join("[redacted]");
  return redacted;
}

function statusError(
  status: number,
  retryAfterSeconds?: number,
  automaticRetry = false
): AppError {
  const definition = STATUS_ERRORS[status] ?? (status >= 500
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
  return appError({
    ...definition,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  }, automaticRetry && (status === 408 || status === 429 || status >= 500));
}

export function providerHttpError(response: Response): AppError {
  return statusError(
    response.status,
    parseRetryAfter(response.headers.get("Retry-After")),
    true
  );
}

export function providerContentFiltered(): AppError {
  return appError({
    code: "content_filtered",
    retryable: false,
    safeMessage: "The provider could not return this summary because of a safety policy.",
    recoveryAction: "none"
  });
}

function looksFiltered(value: unknown): boolean {
  if (typeof value === "string") {
    return /content[_ -]?filter|safety|refusal/i.test(value);
  }
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/content[_ -]?filter|refusal/i.test(key) && entry !== null && entry !== false) return true;
    if (/code|type|reason|finish_reason/i.test(key) && looksFiltered(entry)) return true;
    if (entry && typeof entry === "object" && looksFiltered(entry)) return true;
  }
  return false;
}

export function isProviderContentFiltered(value: unknown): boolean {
  return looksFiltered(value);
}

function numericStatus(value: unknown, depth = 0): number | null {
  if (depth > 3 || !value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(status|status_code|code)$/i.test(key)) {
      const status = typeof entry === "number"
        ? entry
        : typeof entry === "string" && /^\d{3}$/.test(entry) ? Number(entry) : NaN;
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
    const nested = numericStatus(entry, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

export function providerStreamError(value: unknown): AppError {
  if (isProviderContentFiltered(value)) return providerContentFiltered();
  const status = numericStatus(value);
  if (status !== null) return statusError(status);
  return appError({
    code: "provider_unavailable",
    retryable: true,
    safeMessage: "The provider could not complete the response.",
    recoveryAction: "retry"
  });
}

export function providerIncomplete(reason: unknown): AppError {
  if (isProviderContentFiltered(reason)) return providerContentFiltered();
  if (reason === "max_output_tokens") return providerOutputInvalid();
  return appError({
    code: "provider_unavailable",
    retryable: true,
    safeMessage: "The provider ended the response before it was complete.",
    recoveryAction: "retry"
  });
}

export function normalizeProviderError(error: unknown, apiKey: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return appError({
      code: "request_canceled",
      retryable: false,
      safeMessage: "Summary generation was canceled.",
      recoveryAction: "none",
      cause: error
    });
  }
  if (error instanceof TypeError) {
    return appError({
      code: "network_unavailable",
      retryable: true,
      safeMessage: "The provider could not be reached. Check the network and provider URL.",
      recoveryAction: "retry",
      cause: error
    }, true);
  }
  return appError({
    code: "provider_unavailable",
    retryable: true,
    safeMessage: redactProviderMessage("The provider response could not be processed.", apiKey),
    recoveryAction: "retry",
    ...(error instanceof Error ? { cause: error } : {})
  });
}

export function providerOutputInvalid(cause?: Error): AppError {
  return appError({
    code: "provider_output_invalid",
    retryable: true,
    safeMessage: "The model returned an invalid summary. Retry or choose another model.",
    recoveryAction: "change_model",
    ...(cause ? { cause } : {})
  });
}
