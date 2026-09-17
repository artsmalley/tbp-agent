const config = {
  // "anthropic" (default) or "azure-openai" — selects the model provider.
  modelProvider: process.env.MODEL_PROVIDER || "anthropic",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
  // Optional: point at an Anthropic-compatible gateway (e.g. Azure Foundry's
  // /anthropic route) instead of api.anthropic.com. Leave unset for direct.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,

  // Azure OpenAI (MODEL_PROVIDER=azure-openai): resource endpoint like
  // https://<resource>.openai.azure.com — deployment name, not model id.
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
};

export default config;
