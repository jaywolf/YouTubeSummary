import type { ProviderConfig } from "../domain/settings";
import { createOpenAiCompatibleProvider } from "./openaiCompatible";
import { createOpenAiResponsesProvider } from "./openaiResponses";
import type { ProviderClient, ProviderDependencies } from "./types";

export function createProvider(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
  dependencies: ProviderDependencies = {}
): ProviderClient {
  return config.kind === "openai"
    ? createOpenAiResponsesProvider(config, fetchImpl, dependencies)
    : createOpenAiCompatibleProvider(config, fetchImpl, dependencies);
}

export type {
  ProviderClient,
  ProviderDependencies,
  ProviderEvent,
  ProviderRequest,
  Sleep
} from "./types";
