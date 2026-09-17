import config from "../config";
import { AnthropicProvider } from "./anthropicProvider";
import { AzureOpenAIProvider } from "./azureOpenAIProvider";
import { ModelProvider } from "./types";

export function createProvider(): ModelProvider {
  if (config.modelProvider === "azure-openai") {
    if (!config.azureOpenAIEndpoint || !config.azureOpenAIDeployment) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT are required when MODEL_PROVIDER=azure-openai"
      );
    }
    return new AzureOpenAIProvider(
      config.azureOpenAIDeployment,
      config.azureOpenAIApiKey,
      config.azureOpenAIEndpoint
    );
  }
  return new AnthropicProvider(
    config.anthropicModel,
    config.anthropicApiKey,
    config.anthropicBaseUrl
  );
}

export * from "./types";
