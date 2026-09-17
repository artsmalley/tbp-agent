import { ActivityTypes } from "@microsoft/agents-activity";
import { AgentApplication, MemoryStorage, TurnContext } from "@microsoft/agents-hosting";
import { SKILL_MD } from "./skillPrompt";
import { createProvider, ChatMessage } from "./providers";
import { extractImages } from "./attachments";
import { pruneOldImages } from "./imageLimits";

const provider = createProvider();

// Per-conversation message history, keyed by Teams conversation id.
// In-memory only: a restart clears all sessions (fine for a pilot; add storage for a wide rollout).
type Conversation = {
  history: ChatMessage[];
  pending: Promise<void>;
};
const conversations = new Map<string, Conversation>();
const MAX_HISTORY_MESSAGES = 60;

const storage = new MemoryStorage();
export const agentApp = new AgentApplication({
  storage,
});

agentApp.onConversationUpdate("membersAdded", async (context: TurnContext) => {
  // Static line, authored in code — not model output. The model's first real
  // reply must follow the skill's read-the-room rule.
  await context.sendActivity("Hello, I'm TBP Coach.");
});

agentApp.onActivity(ActivityTypes.Message, async (context: TurnContext) => {
  const conversationId = context.activity.conversation?.id ?? "default";
  const text = (context.activity.text ?? "").trim();

  // Removing the session also invalidates its running and queued turns. New
  // messages can start immediately without waiting for the old model request.
  if (text.toLowerCase() === "start over") {
    conversations.delete(conversationId);
    await context.sendActivity("Session reset. Hello, I'm TBP Coach.");
    return;
  }

  let conversation = conversations.get(conversationId);
  if (!conversation) {
    conversation = { history: [], pending: Promise.resolve() };
    conversations.set(conversationId, conversation);
  }
  const session = conversation;
  const isCurrent = () => conversations.get(conversationId) === session;
  // Enqueue before the first await so even attachment downloads preserve order.
  const turn = session.pending.then(async () => {
    if (isCurrent()) {
      await processTurn(context, text, session, isCurrent);
    }
  });
  // A failed delivery must not prevent the next queued turn from running.
  session.pending = turn.catch(() => {});
  await turn;
});

async function processTurn(
  context: TurnContext,
  text: string,
  session: Conversation,
  isCurrent: () => boolean
): Promise<void> {
  // Attachment handling must never crash the turn — degrade to text-only.
  let images: ChatMessage["images"] = undefined;
  try {
    const extracted = await extractImages(context);
    if (!isCurrent()) return;
    if (extracted.problems.length > 0) {
      console.warn("[agent] attachment problems:", extracted.problems);
      await context.sendActivity(extracted.problems.join(" "));
    }
    if (extracted.images.length > 0) {
      images = extracted.images;
      console.log(
        `[agent] ${images.length} image(s) attached:`,
        images.map((i) => `${i.mediaType} ${Math.round((i.data.length * 3) / 4 / 1024)}KB`).join(", ")
      );
    }
  } catch (err) {
    if (!isCurrent()) return;
    console.error("[agent] attachment pipeline error:", err);
    await context.sendActivity(
      "I hit an error reading your attachment, so I'm continuing without it."
    );
  }

  if (!isCurrent() || (!text && !images)) {
    return;
  }

  // Work on a copy: a failed model call or delivery leaves the saved history intact.
  const history = session.history.map((message) => ({ ...message }));
  history.push({ role: "user", content: text, ...(images ? { images } : {}) });
  pruneOldImages(history);

  try {
    const result = await provider.runRound(SKILL_MD, [], provider.fromHistory(history), {
      // Ceiling, not a target: the skill keeps replies to a few sentences. Thinking
      // tokens on newer models count against this number, so leave headroom.
      maxTokens: 4096,
    });
    if (!isCurrent()) return;
    const answer = result.text;

    history.push({ role: "assistant", content: answer });
    // Trim oldest turns in pairs so the history always starts with a user message.
    while (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, 2);
    }
    await context.sendActivity(answer);
    if (isCurrent()) session.history = history;
  } catch (err) {
    if (!isCurrent()) return;
    console.error("Model call failed:", err);
    await context.sendActivity(
      "Something went wrong reaching the model. Please try again."
    );
  }
}
