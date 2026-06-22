/**
 * ============================================================================
 * CONVERSATION LANGUAGE — detect Swedish, ask once, then lock & remember
 * ============================================================================
 * The setter speaks English by default. When a lead turns out to be Swedish we
 * want the WHOLE conversation to run in Swedish — same rules, same voice, same
 * funnel steps, just translated — and to STAY in Swedish (no English<->Swedish
 * flip-flopping). The chosen language is stored on the lead
 * (leads.conversation_language) so it survives across messages and restarts.
 *
 * The rule Maher asked for:
 *   - If a lead has LITERALLY said they speak Swedish -> switch straight to
 *     Swedish.
 *   - If we only SUSPECT Swedish (they wrote a Swedish phrase, or said they're
 *     from Sweden while typing English) -> ask once, in Swedish:
 *     "snackar du svenska?" and keep replying in English until they answer.
 *   - Once locked to Swedish, never revert just because a later message has
 *     some English in it.
 *
 * State machine (the value stored in leads.conversation_language):
 *   'en'          default English (also the value for null/unknown)
 *   'sv_pending'  a Swedish signal was seen; the AI asks once and waits
 *   'sv'          locked Swedish for the rest of the conversation
 *   'en_declined' the lead declined Swedish; stay English, don't ask again
 *
 * Cost: the classifier (one cheap Haiku call) ONLY runs when there's an actual
 * Swedish hint, or when we're waiting on an answer to our question. Plain
 * English threads never trigger it, so normal conversations pay nothing extra.
 * ============================================================================
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Message, type LanguageDirective } from "./prompts/master";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  throw new Error("Missing ANTHROPIC_API_KEY in environment variables.");
}
const anthropic = new Anthropic({ apiKey: anthropicKey });

// Lightweight, fast model for classification — must not delay the reply.
const CLASSIFIER_MODEL = "claude-haiku-4-5";

export type LanguageState = "en" | "sv_pending" | "sv" | "en_declined";

/** Result the webhook acts on: what to persist + how to steer THIS reply. */
export interface LanguageResolution {
  /** The value to store on leads.conversation_language. */
  state: LanguageState;
  /**
   * What to inject into this reply's system prompt. 'lock_sv' = write fully in
   * Swedish; 'ask_sv' = ask "snackar du svenska?" once; null = leave as-is.
   */
  directive: LanguageDirective | null;
}

interface LanguageSignal {
  /** Lead LITERALLY said they speak Swedish / are Swedish / want Swedish. */
  explicit_swedish: boolean;
  /** The lead's latest message is actually written in Swedish. */
  wrote_swedish: boolean;
  /** Lead said they're located in Sweden (even if typed in English). */
  from_sweden: boolean;
  /** We asked "snackar du svenska?" and they confirmed yes. */
  confirmed_yes: boolean;
  /** Lead said they don't speak Swedish / prefer English. */
  declined: boolean;
}

/**
 * Heuristic pre-filter: does this message look like it MIGHT be Swedish? Kept
 * deliberately permissive — it only decides whether to spend a classifier call,
 * which makes the real (accurate) decision. Looks for distinctive Swedish
 * words/greetings and the å/ä/ö characters.
 */
function isLikelySwedish(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();

  const strong = [
    "hej", "hejsan", "tja", "tjena", "tjabba", "läget", "jag", "och", "är",
    "jättebra", "fattar", "sverige", "svenska", "förlåt", "tack så mycket",
    "vi ses", "hej då", "asg", "grymt", "najs", "ingen aning", "snackar",
  ];
  const supporting = [
    "att", "för", "inte", "vad", "hur", "varför", "vill", "kanske", "mycket",
    "bara", "också", "där", "här", "när", "vem", "skulle", "kommer", "måste",
    "behöver", "pengar", "jobb", "snälla", "gör", "väldigt", "ganska", "lite",
  ];

  const words = new Set(t.split(/[^a-zåäö]+/).filter(Boolean));
  const hasSwedishChars = /[åäö]/.test(t);

  if (strong.some((w) => (w.includes(" ") ? t.includes(w) : words.has(w)))) {
    return true;
  }
  const supportHits = supporting.filter((w) => words.has(w)).length;
  if (supportHits >= 2) return true;
  if (hasSwedishChars && supportHits >= 1) return true;

  return false;
}

// Sweden references that also appear in ENGLISH text (place/nationality names).
// Used to trigger the classifier when a lead writes "i'm from stockholm" or
// "i'm swedish" in English — which isLikelySwedish (a Swedish-LANGUAGE detector)
// would otherwise miss.
const SWEDEN_KEYWORDS = [
  "sweden", "sverige", "swedish", "stockholm", "gothenburg", "göteborg",
  "goteborg", "malmö", "malmo", "uppsala", "scandinav",
];

/** Does a string mention Sweden / Swedish (in English or Swedish)? */
function mentionsSweden(text: string): boolean {
  if (!text) return false;
  const l = text.toLowerCase();
  return SWEDEN_KEYWORDS.some((k) => l.includes(k));
}

/** Does a captured location string point to Sweden? (only a classifier hint) */
function isSwedishLocation(loc: unknown): boolean {
  if (typeof loc !== "string") return false;
  return mentionsSweden(loc);
}

/** Normalize the stored value (which may be null/unknown) into a known state. */
function normalizeState(v: string | null | undefined): LanguageState {
  if (v === "sv" || v === "sv_pending" || v === "en_declined") return v;
  return "en";
}

/** The text of the most recent lead message in the thread, if any. */
function lastLeadText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "lead") return history[i].content || "";
  }
  return "";
}

const LANGUAGE_SYSTEM_PROMPT = `You analyze an Instagram DM thread to decide whether an English-speaking setter should move the conversation into SWEDISH. In the transcript the prospect is "Lead" and we are "Me".

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"explicit_swedish":bool,"wrote_swedish":bool,"from_sweden":bool,"confirmed_yes":bool,"declined":bool}

Judge mainly from the Lead's MOST RECENT messages:
- "explicit_swedish": the Lead LITERALLY stated they speak Swedish, are Swedish, or want to talk in Swedish (e.g. "I'm Swedish", "jag pratar svenska", "can we talk in swedish", "yeah swedish is my first language"). Simply writing a Swedish word does NOT count here.
- "wrote_swedish": the Lead's latest message is genuinely written in the Swedish language (a real Swedish phrase or sentence) — not just the word "hej" dropped inside otherwise-English text.
- "from_sweden": the Lead said they are located in Sweden / Stockholm / a Swedish city (counts even if they typed it in English).
- "confirmed_yes": we asked the Lead something like "snackar du svenska?" and they answered yes / confirmed (ja, japp, jo, yes, yep, "i do").
- "declined": the Lead indicated they do NOT speak Swedish or prefer English (no, nah, "english is fine", "i don't speak swedish").

Set each flag independently. When unsure about any flag, set it false.`;

/** Render recent history as a plain transcript for the classifier. */
function transcript(history: Message[]): string {
  return history
    .slice(-12)
    .map((m) => `${m.role === "lead" ? "Lead" : "Me"}: ${m.content}`)
    .join("\n");
}

/** Extract the first JSON object from a model response and parse it. */
function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function classifyLanguageSignal(history: Message[]): Promise<LanguageSignal> {
  const resp = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 120,
    system: LANGUAGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: transcript(history) }],
  });
  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  const out = parseJsonObject(raw);
  return {
    explicit_swedish: out.explicit_swedish === true,
    wrote_swedish: out.wrote_swedish === true,
    from_sweden: out.from_sweden === true,
    confirmed_yes: out.confirmed_yes === true,
    declined: out.declined === true,
  };
}

/**
 * Decide the language state for this lead and how to steer the current reply.
 *
 * Fail-safe: any classifier error leaves the language exactly where it was and
 * never forces a switch — an English thread stays English.
 */
export async function resolveConversationLanguage(params: {
  current: string | null | undefined;
  history: Message[];
  /** A captured location fact (e.g. stage_data.location), if known. */
  knownLocation?: unknown;
}): Promise<LanguageResolution> {
  const current = normalizeState(params.current);

  // Already locked to Swedish: never re-evaluate, always reinforce the lock.
  if (current === "sv") return { state: "sv", directive: "lock_sv" };

  const latest = lastLeadText(params.history);
  const hint =
    isLikelySwedish(latest) ||
    mentionsSweden(latest) ||
    isSwedishLocation(params.knownLocation);

  // No Swedish hint and we're not waiting on an answer -> nothing to do. This
  // is the common path for normal English threads: zero extra model calls.
  if (current !== "sv_pending" && !hint) {
    return { state: current, directive: null };
  }

  let signal: LanguageSignal;
  try {
    signal = await classifyLanguageSignal(params.history);
  } catch (e) {
    console.error("[language] classify failed — leaving language unchanged:", e);
    return { state: current, directive: null };
  }

  // Literally told us they speak Swedish -> switch straight to Swedish, even
  // from a previously-declined state (an explicit ask reopens it).
  if (signal.explicit_swedish || signal.confirmed_yes) {
    return { state: "sv", directive: "lock_sv" };
  }

  if (current === "sv_pending") {
    // We already asked. Writing Swedish now is confirmation enough to lock.
    if (signal.wrote_swedish) return { state: "sv", directive: "lock_sv" };
    if (signal.declined) return { state: "en_declined", directive: null };
    // Still unresolved — keep waiting, but do NOT ask again.
    return { state: "sv_pending", directive: null };
  }

  if (current === "en_declined") {
    // They already said no; only an explicit Swedish ask (handled above)
    // reopens it. A stray Swedish word does not re-trigger the question.
    return { state: "en_declined", directive: null };
  }

  // current === "en": a suspicion (wrote Swedish, or said they're from Sweden)
  // -> ask once and wait, staying in English for the rest of this reply.
  if (signal.wrote_swedish || signal.from_sweden) {
    return { state: "sv_pending", directive: "ask_sv" };
  }

  return { state: "en", directive: null };
}
