import { Attachment, Channels } from "@microsoft/agents-activity";
import { TurnContext } from "@microsoft/agents-hosting";
import { ImageAttachment } from "./providers/types";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN, MAX_ENCODED_IMAGE_BYTES } from "./imageLimits";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const FILE_CARD = "application/vnd.microsoft.teams.file.download.info";
const TOO_LARGE = "This image is too large. Please send a smaller copy or a screenshot under 4 MB.";
const UNSUPPORTED = "I can read JPEG, PNG, GIF, or WebP pictures, but not this document format. Please paste the relevant text or send screenshots.";

export type ExtractedImages = {
  images: ImageAttachment[];
  /** User-facing notes about attachments that could not be used. */
  problems: string[];
};

// Content-type headers from SharePoint downloadUrls are often
// application/octet-stream, so the file signature is the reliable source of truth.
function sniffImageType(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

// Inline Microsoft URLs need the bot token. File cards carry their own signed
// download URL and must not receive connector credentials.
function inlineAttachmentHost(host: string): boolean {
  return host === "smba.trafficmanager.net" ||
    host === "api.asm.skype.com" || host.endsWith(".asm.skype.com") ||
    host === "botframework.com" || host.endsWith(".botframework.com") ||
    host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com");
}

function fileCardInfo(attachment: Attachment): { downloadUrl?: string; fileType?: string } {
  const content = attachment.content;
  if (!content || typeof content !== "object") return {};
  return {
    downloadUrl: "downloadUrl" in content && typeof content.downloadUrl === "string" ? content.downloadUrl : undefined,
    fileType: "fileType" in content && typeof content.fileType === "string" ? content.fileType : undefined,
  };
}

async function downloadImage(attachment: Attachment, context: TurnContext): Promise<Buffer> {
  const signedUrl = attachment.contentType === FILE_CARD ? fileCardInfo(attachment).downloadUrl : undefined;
  let url = new URL(signedUrl ?? attachment.contentUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid attachment URL");
  const headers = new Headers();
  if (!signedUrl) {
    if (!inlineAttachmentHost(url.hostname)) throw new Error("Unsupported inline attachment host");
    const connector = context.turnState.get(context.adapter.ConnectorClientKey);
    const connectorHeaders = new Headers(connector?.httpClient?.defaultHeaders);
    const authorization = connectorHeaders.get("authorization");
    if (authorization) headers.set("authorization", authorization);
  }

  // Bound both headers and body reads; never buffer an unbounded response.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { headers, signal: controller.signal, redirect: "manual" });
      body = response.body;
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects >= 5) throw new Error("Invalid attachment redirect");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password) throw new Error("Invalid attachment redirect");
      if (next.origin !== url.origin) headers.delete("authorization");
      if (body) await body.cancel();
      url = next;
    }
    body = response.body;
    if (!response.ok || !response.body) throw new Error("Attachment download failed");
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error(TOO_LARGE);
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error(TOO_LARGE);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("The image download timed out. Please try again or send a smaller image.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else if (body) await body.cancel().catch(() => {});
  }
}

export async function extractImages(context: TurnContext): Promise<ExtractedImages> {
  const result: ExtractedImages = { images: [], problems: [] };
  const attachments = (context.activity.attachments ?? []).filter(
    a => a.contentType && !a.contentType.startsWith("text/html")
  );
  if (!attachments.length) return result;
  if (context.activity.channelId !== Channels.Msteams && context.activity.channelId !== Channels.M365Copilot) {
    result.problems.push("Please send images in Teams; attachment downloads are unavailable in this environment.");
    return result;
  }
  let candidates = 0;
  let encodedBytes = 0;
  for (const attachment of attachments) {
    const type = attachment.contentType.toLowerCase();
    const fileType = (fileCardInfo(attachment).fileType ?? attachment.name?.split(".").pop() ?? "").toLowerCase();
    if ((!type.startsWith("image/") && type !== FILE_CARD) ||
        (type === FILE_CARD && fileType && !["jpg", "jpeg", "png", "gif", "webp"].includes(fileType))) {
      result.problems.push(UNSUPPORTED);
      continue;
    }
    if (++candidates > MAX_IMAGES_PER_TURN) {
      result.problems.push("I can read up to three images per message. Please send the remaining images in another message.");
      continue;
    }
    const label = `Image ${candidates}: `;
    try {
      const buf = await downloadImage(attachment, context);
      const mediaType = sniffImageType(buf);
      if (!mediaType) {
        result.problems.push(label + UNSUPPORTED);
        continue;
      }
      const size = 4 * Math.ceil(buf.length / 3);
      if (encodedBytes + size > MAX_ENCODED_IMAGE_BYTES) {
        result.problems.push(label + "These images are too large together. Please send this image in another message or use smaller copies.");
        continue;
      }
      encodedBytes += size;
      result.images.push({ mediaType, data: buf.toString("base64") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Do not expose signed URLs or connector credentials from fetch errors.
      result.problems.push(label + (message === TOO_LARGE || message.includes("download timed out")
        ? message : "I couldn't download this image. Please try attaching it again."));
    }
  }
  result.problems = [...new Set(result.problems)];
  return result;
}
