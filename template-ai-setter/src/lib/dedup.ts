/**
 * ============================================================================
 * ANTI-REPEAT (duplicate-reply guard)
 * ============================================================================
 * Pure helpers used by the webhook before sending a generated reply: they
 * decide whether the fresh reply is essentially a REPEAT of something the
 * setter already said (e.g. re-asking a question the lead just answered). The
 * webhook regenerates once with a "don't repeat" directive when this fires, and
 * suppresses the message entirely if it's still a duplicate.
 *
 * Kept dependency-free and pure so it's unit-testable without the DB/model
 * (see scripts/dedup-cases.ts).
 * ============================================================================
 */

/**
 * Normalize a bubble for near-duplicate comparison: lowercase, strip
 * punctuation/emoji, collapse whitespace. Keeps letters (incl. Swedish å/ä/ö
 * and other Unicode letters) and digits so Swedish replies compare correctly.
 */
export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct word set of a normalized bubble. */
function wordSet(s: string): Set<string> {
  return new Set(normalizeForCompare(s).split(" ").filter(Boolean));
}

/**
 * Overlap coefficient (Szymkiewicz–Simpson): shared words ÷ the SMALLER word
 * set (0..1). Chosen over Jaccard because a re-asked question is often reworded
 * with a different lead-in ("so what would you say is..." vs "what's...") — the
 * differing prefixes drag Jaccard down, but the shared core question still makes
 * the overlap near 1. Genuinely different funnel questions stay well below the
 * threshold, so this separates true repeats from real next-step questions.
 */
export function wordOverlap(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Minimum word count for a bubble to be eligible for repeat-checking. Short
 *  acks ("nice nice", "okej", "ja hör dig bror") are below this and are never
 *  flagged, so the guard only ever catches substantive repeats (questions). */
export const MIN_WORDS_FOR_REPEAT_CHECK = 4;

/** Overlap at or above this counts as the "same" bubble (reworded repeat). */
export const REPEAT_SIMILARITY_THRESHOLD = 0.8;

/**
 * Is the freshly generated reply essentially a repeat of one we already sent?
 * Each substantive new bubble (>= MIN_WORDS_FOR_REPEAT_CHECK words after
 * normalizing) is compared to our recent AI bubbles; a normalized-equal match,
 * or a word-overlap >= REPEAT_SIMILARITY_THRESHOLD against a prior bubble that
 * is ALSO substantive, counts as a repeat. Deliberately conservative: a false
 * positive would suppress a legitimate reply, so both sides must be real
 * sentences (not short fragments) before the overlap rule can fire.
 */
export function isRepeatReply(
  newSegments: string[],
  priorAiBubbles: string[]
): boolean {
  for (const seg of newSegments) {
    const norm = normalizeForCompare(seg);
    if (norm.split(" ").filter(Boolean).length < MIN_WORDS_FOR_REPEAT_CHECK) {
      continue; // ignore short acks
    }
    for (const prior of priorAiBubbles) {
      const pn = normalizeForCompare(prior);
      if (!pn) continue;
      if (pn === norm) return true;
      const priorWords = pn.split(" ").filter(Boolean).length;
      if (
        priorWords >= MIN_WORDS_FOR_REPEAT_CHECK &&
        wordOverlap(seg, prior) >= REPEAT_SIMILARITY_THRESHOLD
      ) {
        return true;
      }
    }
  }
  return false;
}
