/**
 * ============================================================================
 * DIG DEEPER INTO PAIN — an empathy overlay on the reply pipeline
 * ============================================================================
 * Not a funnel stage. A stage-agnostic interrupt: when the lead shares
 * something emotionally heavy (at ANY point — opener, middle, right before the
 * pitch, or never), the setter PAUSES the funnel for a moment, genuinely digs
 * into the pain with empathy, then RESUMES exactly where it left off.
 *
 * It rides entirely on mechanisms that already exist:
 *   - DETECTION piggybacks on the stage tracker (one Haiku call, no extra
 *     latency). The tracker returns `dig_pain` and captures the pain as facts.
 *   - HOLD reuses the engine's existing "don't advance" behaviour: while
 *     digging, the funnel stage is frozen, so the conversation resumes on the
 *     right step.
 *   - GUIDANCE is injected as a per-reply `extraInstruction` (volatile, never
 *     cached, never pollutes the stage rail).
 *   - MEMORY: captured pain (pain / pain_impact / pain_duration) lands in
 *     stage_data and is re-injected into every future reply, so it's there at
 *     pitch time.
 *
 * It adds NO new send, NO new timer, NO background job. When pain_dig_enabled
 * is false the whole thing is inert and the reply pipeline is byte-identical to
 * before.
 * ============================================================================
 */

/**
 * The default trigger words + dig style. A client may override this with
 * clients.pain_protocol (edited by Maher just by talking to Jarvis). Both the
 * detector and the reply read the SAME protocol, so there's one source of truth.
 */
export const DEFAULT_PAIN_PROTOCOL = `TRIGGERS — treat the lead's MOST RECENT message as an emotional-pain moment when they share something genuinely heavy about THEMSELVES, either with words like:
stressed, overwhelmed, burned out / burnt out, exhausted, drained, spread thin, can't keep up, anxious, anxiety, depressed, traumatized, trauma, ptsd, panic, terrified, scared, afraid, dreading, hopeless, numb, stuck, lost, trapped, fed up, sick of it, can't take it, breaking point, falling apart, desperate, struggling, suffering, miserable, failure, worthless, not good enough, ashamed, embarrassed, broke, drowning (financially), paycheck to paycheck, not sleeping, health suffering
— OR clearly heavy emotional sentiment even without one of those exact words (e.g. "i honestly can't keep doing this", "it's wearing me down").
Do NOT trigger on light / casual / throwaway use, on jokes, on someone ELSE'S feelings, or on a pain we have already explored and validated in this conversation.

HOW TO DIG (one short, human message at a time, in the operator's voice — never clinical, never therapist-y, never a wall of questions):
1. Reflect the exact word back and ask what they mean by it ("stressed? what do you mean by that exactly").
2. Let them explain, then ask how it's affecting them right now.
3. If it flows naturally, get a sense of the scale (e.g. "how many hours we talking?") and roughly how long it's been going on — purely as EMPATHY about how they feel, NOT as a qualifying or timeline question.
4. Validate genuinely ("i hear you man, makes total sense that's weighing on you").
Then STOP digging and carry on naturally from where the conversation was. Keep it to about 3-4 short exchanges max, then resume.

USE IT LATER: when it's time to pitch, tie the offer to BOTH their goal AND getting this pain off their back (e.g. "i can help you hit 20k and get this stress off you").`;

/** The protocol to use for a client: their override, or the built-in default. */
export function painProtocolFor(override?: string | null): string {
  return override && override.trim() ? override : DEFAULT_PAIN_PROTOCOL;
}

/**
 * The block appended to the stage tracker's system prompt so it ALSO reports
 * whether to dig into pain this turn (and captures the pain facts). Only added
 * when the overlay is enabled, so a disabled client's tracker prompt is
 * unchanged.
 */
export function painDetectionBlock(protocol: string): string {
  return `

PAIN-DIG DETECTION (separate from the stage — this is an empathy overlay):
Read the lead's MOST RECENT message and decide "dig_pain". Set "dig_pain": true when they just shared something emotionally heavy about themselves that we have NOT yet fully explored and validated in the conversation. Use this guide for what counts as heavy (and what to ignore):
${protocol}

While "dig_pain" is true you MUST keep the current stage (do NOT advance — we pause the funnel to be human for a moment). Also add any pain facts you learn to "captured" using these exact keys:
- "pain": the core thing in a few words (e.g. "burnout from overworking")
- "pain_impact": how it's affecting them (e.g. "health, no time for himself")
- "pain_duration": roughly how long (e.g. "~2 months")
Set "dig_pain": false once the pain has been heard and validated, or when the latest message is not an emotional disclosure.
Include "dig_pain" in your JSON output.`;
}

/**
 * The per-reply directive injected (as extraInstruction) when the tracker says
 * to dig this turn. Overrides the current step's question for THIS reply only.
 */
export function painDigInstruction(protocol: string, facts: Record<string, unknown>): string {
  const known = [
    facts.pain ? `what they're going through: ${String(facts.pain)}` : null,
    facts.pain_impact ? `how it's affecting them: ${String(facts.pain_impact)}` : null,
    facts.pain_duration ? `how long: ${String(facts.pain_duration)}` : null,
  ].filter(Boolean).join("; ");

  return `PAUSE THE FUNNEL FOR THIS REPLY — the lead just shared something emotionally heavy, and right now your only job is to make them feel heard and understood. Do NOT ask the current step's question this turn and do NOT push the conversation forward; you'll pick the step back up once they feel understood (the system keeps your place). Follow this protocol, sending ONLY the next natural step as one short message in the operator's voice:

<pain_protocol>
${protocol}
</pain_protocol>

${known ? `What you already understand about their pain so far: ${known}. Build on it — don't re-ask what you already know.` : "This pain is fresh — start by reflecting their word back and asking what they mean."}`;
}
