/**
 * THE BRAIN
 * ---------
 * This file is the single AI call. One agent. One prompt. Minimalist.
 *
 * Why one agent (not router → response → validator)?
 *   - Less to break.
 *   - Cheaper.
 *   - Easier to debug.
 *   - Claude Sonnet 4.6 is smart enough to do it all in one call.
 *
 * Obedience strategy (the 10/10 promise):
 *   - Rules injected at TOP and BOTTOM of system prompt (proven technique)
 *   - Claude sees the rules in 2 places, treats them as absolute
 *   - If needed, we can add a post-generation rule-check pass later (V2)
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildSystemBlocks,
  buildMessageHistory,
  type ClientConfig,
  type Message,
  type StageContext,
  type LanguageDirective,
} from "./prompts/master";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  throw new Error("Missing ANTHROPIC_API_KEY in environment variables.");
}

const anthropic = new Anthropic({ apiKey: anthropicKey });

// Model used for production replies. Sonnet 4.6 = best balance of quality + speed + cost.
export const PRODUCTION_MODEL = "claude-sonnet-4-6";

export interface GenerateReplyParams {
  client: ClientConfig;
  history: Message[];   // The full conversation, oldest first
  // Current funnel position. When provided, the reply is railed to this one
  // stage so the model cannot skip ahead. Omitted => legacy full-script mode.
  stage?: StageContext;
  // Language steer for this reply (resolved per lead by lib/language.ts).
  // 'lock_sv' => reply entirely in Swedish; 'ask_sv' => ask "snackar du
  // svenska?" once; omitted => English/default.
  language?: LanguageDirective;
  // One-off directive folded into THIS reply only (anti-repeat guard's retry:
  // "you already said X, don't repeat it / don't re-ask"). Usually undefined.
  extraInstruction?: string;
}

export interface GenerateReplyResult {
  reply: string;                    // The final cleaned reply (with [[SPLIT]] tokens preserved)
  segments: string[];               // Reply split into individual messages
  raw_response: string;             // What Claude returned before cleaning
  system_prompt_used: string;       // The full system prompt sent (for logging)
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

/**
 * Generate a reply for the given conversation.
 *
 * This is the ONE function the rest of the app calls to get an AI response.
 */
export async function generateReply(
  params: GenerateReplyParams
): Promise<GenerateReplyResult> {
  const startTime = Date.now();

  const { stable, volatile } = buildSystemBlocks(
    params.client,
    params.stage,
    params.language,
    params.extraInstruction
  );
  const systemPrompt = `${stable}\n\n${volatile}`;
  const messages = buildMessageHistory(params.history);

  // Safety: if there's nothing to reply to, don't call the API
  if (messages.length === 0) {
    throw new Error("Cannot generate reply: conversation history is empty.");
  }

  // The conversation MUST end with a user message for Claude to reply to it
  if (messages[messages.length - 1].role !== "user") {
    throw new Error("Cannot generate reply: last message is not from the lead.");
  }

  const response = await anthropic.messages.create({
    model: PRODUCTION_MODEL,
    max_tokens: 1024,
    // Prompt caching: the stable block (engine directives + client rules/voice/
    // context/process) is byte-identical for every lead of this client, so it
    // carries the cache breakpoint. Within the 5-min cache window, repeat
    // replies read it at ~10% of the input price. Volatile content (time,
    // language, stage, slots) comes after the breakpoint, uncached.
    system: [
      { type: "text", text: stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: volatile },
    ],
    messages,
  });

  const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  console.log(
    `[brain] tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}, ` +
      `cache_write: ${cacheWrite}, cache_read: ${cacheRead}` +
      (cacheRead > 0 ? " (cache HIT)" : cacheWrite > 0 ? " (cache warmed)" : " (no cache — prompt may be under the cacheable minimum)")
  );

  // Extract text content
  const rawResponse = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");

  // Clean + split the reply
  const cleaned = cleanReply(rawResponse);
  const segments = splitReply(cleaned);

  return {
    reply: cleaned,
    segments,
    raw_response: rawResponse,
    system_prompt_used: systemPrompt,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Strip common AI tells from the response.
 * Belt-and-suspenders: the system prompt already forbids these, but
 * we clean them post-hoc just in case.
 */
function cleanReply(text: string): string {
  let cleaned = text.trim();

  // Remove wrapping quotes if Claude wrapped the whole thing in quotes
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Remove "Response:" or similar prefixes
  cleaned = cleaned.replace(/^(response|reply|message|here'?s? (your |a |my )?(reply|response|message)):\s*/i, "");

  // Replace em-dashes with regular dashes (em-dashes are AI giveaway)
  cleaned = cleaned.replace(/—/g, "-");

  // Replace en-dashes with regular dashes too
  cleaned = cleaned.replace(/–/g, "-");

  // Smart quotes → straight quotes
  cleaned = cleaned.replace(/[\u2018\u2019]/g, "'");
  cleaned = cleaned.replace(/[\u201C\u201D]/g, '"');

  return cleaned;
}

/**
 * Hard cap on how long any single bubble can be. The model is told to keep
 * messages short, but this is the code-level guarantee — no bubble ever ships
 * longer than this, no matter what the model produces.
 */
const MAX_WORDS_PER_BUBBLE = 20;

/**
 * Split the reply into individual bubbles.
 *
 * Splits on BOTH the explicit [[SPLIT]] token AND on line breaks, because the
 * model frequently separates its thoughts with blank lines instead of the
 * token. Either signal produces a new bubble — so the AI can't ship a wall of
 * text even if it ignores the [[SPLIT]] instruction.
 *
 * Then every resulting bubble is run through a 20-word cap (enforceMaxWords) so
 * nothing is ever longer than MAX_WORDS_PER_BUBBLE.
 */
function splitReply(text: string): string[] {
  // Split on the explicit [[SPLIT]] token first. A message the model marked as a
  // VOICE note (starts with [[VOICE]]) is kept WHOLE — one spoken clip is never
  // word-capped or line-split. Everything else keeps the legacy behaviour:
  // split on line breaks too, then enforce the per-bubble word cap.
  const parts = text
    .split(/\[\[SPLIT\]\]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: string[] = [];
  for (const part of parts) {
    if (/^\s*\[\[VOICE\]\]/i.test(part)) {
      segments.push(part); // marker preserved; sent as a single voice clip downstream
      continue;
    }
    for (const seg of part.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      segments.push(...enforceMaxWords(seg, MAX_WORDS_PER_BUBBLE));
    }
  }
  return segments;
}

/** Count words in a string. */
function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Ensure no bubble exceeds maxWords. If a segment is too long, break it at
 * natural clause boundaries (sentence-enders and commas), greedily packing
 * clauses up to the limit so the bubbles still read like a human texting. If a
 * single clause is itself longer than the cap, it's hard-split by word count as
 * a last resort.
 */
function enforceMaxWords(segment: string, maxWords: number): string[] {
  if (wordCount(segment) <= maxWords) return [segment];

  const clauses = (segment.match(/[^.!?,]+[.!?,]*/g) || [segment])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const bubbles: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length > 0) {
      bubbles.push(current.join(" "));
      current = [];
      currentWords = 0;
    }
  };

  for (const clause of clauses) {
    const cWords = wordCount(clause);

    // Clause alone is over the cap — flush what we have, then hard-split it.
    if (cWords > maxWords) {
      flush();
      const words = clause.split(/\s+/);
      for (let i = 0; i < words.length; i += maxWords) {
        bubbles.push(words.slice(i, i + maxWords).join(" "));
      }
      continue;
    }

    if (currentWords + cWords > maxWords) flush();
    current.push(clause);
    currentWords += cWords;
  }
  flush();

  // Drop trailing commas left over from clause splitting so bubbles look clean.
  return bubbles
    .map((b) => b.replace(/[,\s]+$/, "").trim())
    .filter((b) => b.length > 0);
}

/**
 * Calculate a realistic typing delay for a message.
 * Based on average human typing speed (~40 wpm = ~200 chars/min = ~3 chars/sec).
 * Capped at 8 seconds max so the lead doesn't bounce.
 */
export function calculateTypingDelay(messageText: string): number {
  const chars = messageText.length;
  const baseDelay = 800;                  // 0.8s minimum "reading the message" delay
  const typingDelay = (chars / 3) * 1000; // ~3 chars/sec typing speed
  const total = baseDelay + typingDelay;
  return Math.min(total, 8000);           // cap at 8s
}
