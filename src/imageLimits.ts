import { ChatMessage } from "./providers/types";

// Decimal MB, matching the learner-facing limits.
export const MAX_IMAGE_BYTES = 4_000_000;
export const MAX_IMAGES_PER_TURN = 3;
export const MAX_ENCODED_IMAGE_BYTES = 12_000_000;
const MAX_IMAGE_TURNS = 3;

// Keep the newest images within both the turn limit and encoded-byte budget.
// New attachments are already capped to the request budget by extractImages.
export function pruneOldImages(history: ChatMessage[]): void {
  let turns = 0;
  let bytes = 0;
  let full = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (!message.images?.length) continue;
    turns++;
    const retained = [];
    for (let j = message.images.length - 1; j >= 0; j--) {
      const image = message.images[j];
      if (turns > MAX_IMAGE_TURNS || bytes + image.data.length > MAX_ENCODED_IMAGE_BYTES) full = true;
      if (!full) {
        retained.unshift(image);
        bytes += image.data.length;
      }
    }
    if (retained.length !== message.images.length) {
      message.content = [message.content, "[One or more images attached here have been removed from context.]"]
        .filter(Boolean).join(" ");
      message.images = retained.length ? retained : undefined;
    }
  }
}
