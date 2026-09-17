import OpenAI from "openai";
import { ChatMessage, ModelProvider, RoundResult, ToolResult, ToolSpec } from "./types";

// Azure OpenAI through the v1 surface: https://<resource>.openai.azure.com/openai/v1/
// takes the deployment name as the model parameter and needs no api-version.
// Prompt caching is automatic on the OpenAI side (no cache_control equivalent).
export class AzureOpenAIProvider implements ModelProvider {
  private client: OpenAI;

  constructor(
    private deployment: string,
    apiKey: string | undefined,
    endpoint: string
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: `${endpoint.replace(/\/+$/, "")}/openai/v1/`,
    });
  }

  fromHistory(history: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return history.map((m) => {
      if (m.role === "user" && m.images && m.images.length > 0) {
        const parts: OpenAI.ChatCompletionContentPart[] = m.images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        }));
        if (m.content) {
          parts.push({ type: "text", text: m.content });
        }
        return { role: "user" as const, content: parts };
      }
      return { role: m.role, content: m.content };
    });
  }

  async runRound(
    system: string,
    tools: ToolSpec[],
    working: any[],
    opts?: { maxTokens?: number }
  ): Promise<RoundResult> {
    const completion = await this.client.chat.completions.create({
      model: this.deployment,
      max_completion_tokens: opts?.maxTokens ?? 2048,
      messages: [
        { role: "system", content: system },
        ...(working as OpenAI.ChatCompletionMessageParam[]),
      ],
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
          }
        : {}),
    });

    const message = completion.choices[0]?.message;
    if (!message) {
      throw new Error("Azure OpenAI returned no choices");
    }

    const toolUses = (message.tool_calls ?? [])
      .filter((c): c is OpenAI.ChatCompletionMessageToolCall & { type: "function" } => c.type === "function")
      .map((c) => {
        let input: any = {};
        try {
          input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch (err) {
          console.error(`[provider] bad tool arguments for ${c.function.name}:`, err);
        }
        return { id: c.id, name: c.function.name, input };
      });

    return {
      text: message.content ?? "",
      toolUses,
      assistantMessage: message,
    };
  }

  // OpenAI carries each tool result as its own role:"tool" message; the loop
  // pushes whatever we return, so return an array — flattened by the caller.
  toolResultsMessage(results: ToolResult[]): OpenAI.ChatCompletionToolMessageParam[] {
    return results.map((r) => ({
      role: "tool" as const,
      tool_call_id: r.toolUseId,
      content: r.isError ? `ERROR: ${r.content}` : r.content,
    }));
  }
}
