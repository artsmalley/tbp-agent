import Anthropic from "@anthropic-ai/sdk";
import { ChatMessage, ModelProvider, RoundResult, ToolResult, ToolSpec } from "./types";

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;

  constructor(
    private model: string,
    apiKey: string | undefined,
    baseUrl?: string
  ) {
    this.client = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  fromHistory(history: ChatMessage[]): Anthropic.MessageParam[] {
    return history.map((m) => {
      if (m.role === "user" && m.images && m.images.length > 0) {
        const blocks: Anthropic.ContentBlockParam[] = m.images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: img.data,
          },
        }));
        if (m.content) {
          blocks.push({ type: "text", text: m.content });
        }
        return { role: "user" as const, content: blocks };
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
    // SDK-level streaming keeps the call robust against gateway idle timeouts;
    // the full message is assembled below. cache_control caches the system
    // prompt (the skill file rides every call): repeat calls within the cache
    // TTL bill ~0.1x for that prefix and reduce Foundry token-per-minute pressure.
    const result = await this.client.messages
      .stream({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 2048,
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          },
        ],
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Tool["input_schema"],
              })),
            }
          : {}),
        messages: working as Anthropic.MessageParam[],
      })
      .finalMessage();

    const toolUses = result.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");

    return { text, toolUses, assistantMessage: { role: "assistant", content: result.content } };
  }

  toolResultsMessage(results: ToolResult[]): Anthropic.MessageParam {
    return {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  }
}
