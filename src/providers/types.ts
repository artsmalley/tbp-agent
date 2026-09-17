// Provider adapter: the agent's tool loop is provider-agnostic; each provider
// owns its own wire message format. Working messages are opaque to the loop —
// they are created by the provider (fromHistory / assistantMessage /
// toolResultsMessage) and passed back into runRound.

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
};

export type ToolUse = { id: string; name: string; input: any };

export type ToolResult = {
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type ImageAttachment = {
  /** One of image/jpeg, image/png, image/gif, image/webp. */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
};

export type RoundResult = {
  /** Text emitted this round (final answer when toolUses is empty). */
  text: string;
  toolUses: ToolUse[];
  /** Provider-format assistant message to append to the working array. */
  assistantMessage: any;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Vision input attached to a user turn; providers map to their wire format. */
  images?: ImageAttachment[];
};

export interface ModelProvider {
  /** Convert durable plain-text history into provider working messages. */
  fromHistory(history: ChatMessage[]): any[];
  /** One model call over the working messages. */
  runRound(
    system: string,
    tools: ToolSpec[],
    working: any[],
    opts?: { maxTokens?: number }
  ): Promise<RoundResult>;
  /** Provider-format message carrying tool results back to the model. */
  toolResultsMessage(results: ToolResult[]): any;
}
