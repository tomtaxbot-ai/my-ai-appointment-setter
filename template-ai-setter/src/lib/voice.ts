/**
 * ============================================================================
 * SETTER VOICE NOTES — speak a reply in the operator's cloned voice
 * ============================================================================
 * Turns a piece of reply text into an mp3 in the operator's ElevenLabs cloned
 * voice, hosts it on a public Supabase bucket, and returns the URL so it can be
 * sent as a GHL attachment into the IG DM.
 *
 * SAFETY: every function is best-effort and returns null on ANY failure (no
 * key, no voice id, TTS error, upload error). The caller MUST fall back to
 * sending text, so a voice hiccup can never drop or break a reply. Reuses the
 * same ElevenLabs key the orbit's Jarvis voice already uses.
 *
 * The conversation TEXT is always the source of truth (stored in messages,
 * used for memory + anti-repeat). Voice is only the DELIVERY of that text.
 * ============================================================================
 */
import { supabase } from "./supabase";

const TTS_MODEL = "eleven_turbo_v2_5"; // low-latency, conversational, ~half credit cost
const VOICE_BUCKET = "voice-notes";
const MAX_TTS_CHARS = 800; // keep clips short + cheap; long replies stay text

/** Marker the brain puts at the start of a message it wants spoken. */
export const VOICE_MARKER_RE = /^\s*\[\[VOICE\]\]/i;

/** The right cloned-voice id for the thread's language: Swedish clone on a
 *  Swedish-locked thread, otherwise the default (English) clone. */
export function voiceIdForLang(opts: { voiceId?: string | null; voiceIdSv?: string | null; langState?: string | null }): string | null {
  return (opts.langState === "sv" ? opts.voiceIdSv : opts.voiceId) || null;
}

/** Voice is live for THIS reply when it's enabled AND a clone id exists for the
 *  thread's language (Swedish thread needs a Swedish clone, English needs the
 *  English clone). */
export function voiceActive(opts: { enabled?: boolean; voiceId?: string | null; voiceIdSv?: string | null; langState?: string | null }): boolean {
  return opts.enabled === true && !!voiceIdForLang(opts);
}

/**
 * Backstop: expand the most common DM shorthand into real words BEFORE speaking,
 * so a stray "u"/"r"/"w/" can never get mangled by TTS. The brain already writes
 * voice messages in full words; this just catches slips. Conservative on purpose.
 */
const SPEECH_FIXES: [RegExp, string][] = [
  [/\bu're\b/gi, "you're"], [/\bu\b/gi, "you"], [/\bur\b/gi, "your"],
  [/\br\b/gi, "are"], [/\bw\/\b/gi, "with"], [/\bbc\b/gi, "because"],
  [/\brn\b/gi, "right now"], [/\btbh\b/gi, "to be honest"], [/\bidk\b/gi, "I don't know"],
  [/\blmk\b/gi, "let me know"], [/\bngl\b/gi, "not gonna lie"], [/\bimo\b/gi, "in my opinion"],
];
export function normalizeForSpeech(text: string): string {
  let out = text || "";
  for (const [re, rep] of SPEECH_FIXES) out = out.replace(re, rep);
  return out;
}

/** The standing instruction injected into the reply when voice is live. Shared
 *  by the live webhook and the Test Chat so both decide voice identically.
 *  The beat list below is Maher's agreed voice policy (still a default — read
 *  the moment). Same in English and Swedish. */
export const VOICE_INSTRUCTION = `VOICE NOTES: you can send a message as a VOICE NOTE in your real voice instead of text by putting [[VOICE]] at the very START of that message. Rules:
- Write voice lines in FULL, correctly-spelled words with normal punctuation, because they are SPOKEN OUT LOUD ("are you with me" — never "r u w me") — but keep your natural casual spoken tone. (Same in Swedish: spell properly even though you'd text in shorthand.)
- One short spoken thought (~1-4 sentences). Do NOT put [[SPLIT]] inside a voice message.
- NEVER voice anything with a link, a price, or specific times/numbers the lead has to read — those stay text.

SEND A VOICE NOTE ON THESE BEATS (strong defaults):
- The OPENER / takeover ("appreciate the follow brother, tell me a bit about yourself, where you based?") — open in your voice to introduce yourself and build instant rapport.
- The MAIN-REASON question ("one of my favourite questions i love to ask is, what's the MAIN reason behind wanting to start?").
- The deeper GOAL question ("freedom means different things to everyone, what does it actually mean to you?" / "what's the outcome of having more time?").
- The REFRAME ("bro that's exactly it, so this isn't about the money, it's about the peace and time with the people you love").
- "WHY NOW — what made you feel now is the time?".
- The PROBLEM normalize ("it's not that you don't want to, it's that you don't know where to start — a lot of guys feel that way").
- The feeling-based CONSEQUENCE ("what's so bad about that if it keeps going?").
- The PITCH ("what if i put you on a 45-60 min call with Ethan, he gives you a step-by-step roadmap...").
- The affirmation after they agree ("sick bro, the fact you'll invest 45 min tells me you're serious...").
- The PRE-CALL reassurance ("just be yourself, show up 10 min early, you'll walk away with clarity").
- "IS THIS AN AI?" → ALWAYS answer with a voice note — your real voice instantly proves you're human.
- "why all these questions?" → voice ("haha obv trying to get a good interview bro... i'm here to help, i need the full picture").

KEEP AS TEXT: where they live, what they do for work, the income numbers (what they make / need), the pin-down nudges, any $ math, the booking times + email + link, the proof reel + training video links, all post-booking confirmation, "is the call free?", and price ranges. Don't voice every message — mix naturally.`;

/** text -> mp3 buffer in the given cloned voice. null on any failure. */
export async function synthesizeVoice(text: string, voiceId: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const clean = normalizeForSpeech((text || "").trim());
  if (!apiKey || !voiceId || !clean) return null;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: clean.slice(0, MAX_TTS_CHARS),
          model_id: TTS_MODEL,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
        }),
      }
    );
    if (!res.ok) {
      console.error("[voice] elevenlabs tts failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("[voice] synthesize threw:", err);
    return null;
  }
}

/** Upload an mp3 buffer to the public bucket, return its public URL. null on failure. */
export async function hostVoiceClip(buf: Buffer): Promise<string | null> {
  try {
    const path = `clips/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.mp3`;
    const { error } = await supabase.storage
      .from(VOICE_BUCKET)
      .upload(path, buf, { contentType: "audio/mpeg", upsert: false });
    if (error) {
      console.error("[voice] upload failed:", error.message);
      return null;
    }
    const { data } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(path);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.error("[voice] host threw:", err);
    return null;
  }
}

/** Full pipeline: text -> hosted mp3 URL in the cloned voice. null on any failure. */
export async function makeVoiceClip(text: string, voiceId: string): Promise<string | null> {
  const buf = await synthesizeVoice(text, voiceId);
  if (!buf) return null;
  return hostVoiceClip(buf);
}

/**
 * Hard guardrails on whether a given message is even ELIGIBLE to be a voice
 * note, regardless of the "when" policy. Things you can't tap/read inside a
 * voice note must always be text.
 */
export function voiceEligible(text: string): boolean {
  const t = (text || "").trim();
  if (t.length < 12) return false;                 // tiny acks stay text
  if (t.length > MAX_TTS_CHARS) return false;       // very long stays text
  if (/https?:\/\/|www\.|\.com|\.io|\b\d{1,2}[:.]\d{2}\b/i.test(t)) return false; // links / times
  if (/\b(calendly|booking|link|slot|am|pm)\b/i.test(t) && /\d/.test(t)) return false; // times-ish
  return true;
}
