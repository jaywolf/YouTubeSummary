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

export type ErrorPresentation = {
  title: string;
  message: string;
  actions: readonly ("retry" | "settings" | "change_model")[];
};

export const ERROR_PRESENTATIONS = {
  unsupported_page: {
    title: "Unsupported page",
    message: "Open a standard YouTube video page to create a summary.",
    actions: []
  },
  video_context_unavailable: {
    title: "Video unavailable",
    message: "The video context could not be read. Reload the page and try again.",
    actions: ["retry"]
  },
  captions_unavailable: {
    title: "Captions unavailable",
    message: "This video does not have captions that can be summarized.",
    actions: []
  },
  transcript_extraction_failed: {
    title: "Transcript unavailable",
    message: "YouTube captions could not be extracted. Try again after reloading the video.",
    actions: ["retry"]
  },
  configuration_missing: {
    title: "Configuration required",
    message: "Choose a provider, model, and API key in settings.",
    actions: ["settings"]
  },
  configuration_invalid: {
    title: "Settings need attention",
    message: "The saved provider settings are invalid. Review them before trying again.",
    actions: ["settings"]
  },
  custom_permission_denied: {
    title: "Provider permission required",
    message: "Allow access to the custom provider origin in settings.",
    actions: ["settings"]
  },
  credentials_rejected: {
    title: "Credentials rejected",
    message: "The provider rejected the saved API key. Replace it in settings.",
    actions: ["settings"]
  },
  insufficient_credits: {
    title: "Provider credits required",
    message: "The provider account does not have enough credits for this request.",
    actions: ["settings"]
  },
  provider_forbidden: {
    title: "Provider access denied",
    message: "The saved account or model does not permit this request.",
    actions: ["settings"]
  },
  rate_limited: {
    title: "Provider is busy",
    message: "The provider rate limit was reached. Wait briefly, then retry.",
    actions: ["retry"]
  },
  provider_unavailable: {
    title: "Provider unavailable",
    message: "The provider is temporarily unavailable. Try again shortly.",
    actions: ["retry"]
  },
  network_unavailable: {
    title: "Network unavailable",
    message: "The provider could not be reached. Check the connection and retry.",
    actions: ["retry"]
  },
  network_timeout: {
    title: "Request timed out",
    message: "The provider took too long to respond. Try again.",
    actions: ["retry"]
  },
  context_limit_exceeded: {
    title: "Model limit exceeded",
    message: "This video does not fit the configured model context limit. Choose a larger model or limit.",
    actions: ["settings"]
  },
  provider_output_invalid: {
    title: "Invalid provider output",
    message: "The provider did not return a valid structured summary.",
    actions: ["retry", "change_model"]
  },
  content_filtered: {
    title: "Summary filtered",
    message: "The provider declined to summarize this content.",
    actions: []
  },
  request_canceled: {
    title: "Summary canceled",
    message: "The summary request was canceled.",
    actions: []
  },
  request_interrupted: {
    title: "Summary interrupted",
    message: "The browser stopped the background task before it finished.",
    actions: ["retry"]
  },
  internal_error: {
    title: "Summary unavailable",
    message: "An unexpected extension error prevented the summary.",
    actions: ["retry"]
  }
} as const satisfies Record<AppErrorCode, ErrorPresentation>;

export function getErrorPresentation(error: Pick<SafeAppError, "code">): ErrorPresentation {
  return ERROR_PRESENTATIONS[error.code];
}

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
