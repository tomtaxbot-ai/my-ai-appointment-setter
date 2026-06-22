/**
 * MEDIA HANDLING
 * --------------
 * Instagram voice notes and images arrive as "type 18" webhook events with an
 * empty body and NO media URL in the payload. To respond to them we:
 *   1. Call the GHL conversations API to fetch the attachment URL.
 *   2. Download the file once.
 *   3. Audio  -> transcribe with Groq Whisper (whisper-large-v3-turbo).
 *      Image  -> describe with Claude vision (existing Anthropic key).
 *   4. Return the result as plain text, which is stored as the lead's message
 *      and flows through the normal pipeline as if they had typed it.
 *
 * If something can't be handled (reaction, story reply, share, video, or a
 * failed fetch) we return null and the caller skips, exactly as before.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getLatestInboundAttachment } from "./ghl";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VISION_MODEL = "claude-sonnet-4-6";

type AllowedImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const ALLOWED_IMAGE_TYPES: AllowedImageType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export interface ResolveMediaParams {
  apiKey: string;
  locationId: string;
  contactId: string;
}

/**
 * Resolve an incoming media message (voice note / image) into text.
 * Returns null if there's no usable media.
 */
export async function resolveIncomingMedia(
  params: ResolveMediaParams
): Promise<string | null> {
  // Find the attachment, retrying a few times: IG media isn't always queryable
  // the instant the webhook fires (GHL needs a moment to index the attachment).
  let media = await getLatestInboundAttachment(
    params.apiKey,
    params.locationId,
    params.contactId
  );
  for (let attempt = 0; !media && attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    media = await getLatestInboundAttachment(
      params.apiKey,
      params.locationId,
      params.contactId
    );
  }
  if (!media) {
    console.log("[media] no inbound attachment found after retries");
    return null;
  }

  // Download the file once so we can inspect its type and reuse the bytes.
  let bytes: Buffer;
  let contentType: string;
  try {
    const res = await fetch(media.url);
    if (!res.ok) {
      console.error("[media] download failed:", res.status, media.url);
      return null;
    }
    contentType = (res.headers.get("content-type") || "").toLowerCase();
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("[media] download threw:", err);
    return null;
  }

  const kind = classifyMedia(contentType, media.url);
  console.log("[media] attachment:", { kind, contentType, size: bytes.length });

  // Audio AND video both go to transcription: IG voice notes arrive as .mp4
  // (audio in an mp4 container, messageType TYPE_INSTAGRAM), and Groq Whisper
  // transcribes mp4/m4a fine. Treating video as audio also lets us pull speech
  // out of any short clip a lead sends, instead of silently dropping it.
  if (kind === "audio" || kind === "video") {
    return transcribeAudio(bytes, contentType, media.url);
  }
  if (kind === "image") {
    const description = await describeImage(bytes, contentType);
    if (!description) return null;
    return `(the lead sent a photo - here is what's in it: ${description})`;
  }

  console.log("[media] unsupported media kind, skipping");
  return null;
}

function classifyMedia(
  contentType: string,
  url: string
): "audio" | "image" | "video" | "other" {
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";

  const u = url.toLowerCase().split("?")[0];
  if (/\.(ogg|oga|mp3|m4a|aac|wav|opus|webm|flac)$/.test(u)) return "audio";
  if (/\.(jpe?g|png|gif|webp)$/.test(u)) return "image";
  if (/\.(mp4|mov|m4v)$/.test(u)) return "video";
  return "other";
}

/**
 * Transcribe an audio file with Groq Whisper. Always resolves to a string: a
 * real transcript on success, or a graceful fallback the AI can respond to so
 * the conversation never dies on silence.
 */
async function transcribeAudio(
  bytes: Buffer,
  contentType: string,
  url: string
): Promise<string> {
  if (!GROQ_API_KEY) {
    console.error("[media] GROQ_API_KEY not set - cannot transcribe voice note");
    return "(the lead sent a voice note, but voice transcription isn't set up yet - ask them to type it out real quick)";
  }
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: contentType || "audio/ogg" }),
      filenameForAudio(contentType, url)
    );
    form.append("model", GROQ_MODEL);
    form.append("response_format", "json");

    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      console.error("[media] Groq transcription failed:", res.status, await res.text());
      return "(the lead sent a voice note but it couldn't be transcribed - ask them to type it out)";
    }
    const data = await res.json();
    const text = String(data.text || "").trim();
    if (!text) {
      return "(the lead sent a voice note but it came through empty/inaudible - ask them to resend or type it)";
    }
    console.log("[media] transcript:", text.substring(0, 120));
    return text;
  } catch (err) {
    console.error("[media] transcription threw:", err);
    return "(the lead sent a voice note but it couldn't be transcribed - ask them to type it out)";
  }
}

function filenameForAudio(contentType: string, url: string): string {
  if (contentType.includes("ogg")) return "audio.ogg";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "audio.mp3";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac"))
    return "audio.m4a";
  if (contentType.includes("wav")) return "audio.wav";
  if (contentType.includes("webm")) return "audio.webm";
  if (contentType.includes("flac")) return "audio.flac";
  // IG voice notes (and short clips) come as .mp4/.mov — Groq accepts mp4.
  const ext = url.toLowerCase().split("?")[0].split(".").pop();
  if (ext === "mov" || ext === "m4v" || ext === "mp4") return "audio.mp4";
  return ext ? `audio.${ext}` : "audio.mp4";
}

/**
 * Describe an image with Claude vision so the AI can react to it naturally.
 * Includes any visible text. Returns null on failure.
 */
async function describeImage(
  bytes: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    const mediaType: AllowedImageType = ALLOWED_IMAGE_TYPES.includes(
      contentType as AllowedImageType
    )
      ? (contentType as AllowedImageType)
      : "image/jpeg";

    const resp = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
            },
            {
              type: "text",
              text:
                "A lead in an Instagram DM sales conversation just sent this image. " +
                "In 1-2 short sentences, plainly describe what it shows so the rep can react naturally. " +
                "If there is any text in the image, transcribe it exactly. No preamble - just the description.",
            },
          ],
        },
      ],
    });

    const desc = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();
    console.log("[media] image description:", desc.substring(0, 120));
    return desc || null;
  } catch (err) {
    console.error("[media] image description threw:", err);
    return null;
  }
}
