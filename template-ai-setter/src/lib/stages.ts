/**
 * ============================================================================
 * STAGE ENGINE — conversation state machine
 * ============================================================================
 * The reply brain used to be stateless: every message, it re-read the whole
 * script and GUESSED where in the funnel the conversation was. With thin
 * context it grabbed the catchiest scripted lines and skipped steps (e.g.
 * jumping straight to "i have a few minutes over" on a bare "yes brother").
 *
 * This module gives the setter a MEMORY of where it is:
 *
 *   1. The funnel is an ordered list of STAGES (stored per-client in
 *      clients.stages). Each stage has a goal, a playbook (exact things to
 *      say), what facts to capture, and the condition to advance.
 *
 *   2. Before every reply, the STAGE MANAGER (a fast Haiku call) reads the
 *      conversation + the current recorded stage and decides:
 *        - which stage we're on now (it may STAY or advance AT MOST one step)
 *        - which facts we just learned (location, goal, job, savings, email…)
 *        - whether the lead raised an objection (handle, don't advance)
 *        - whether a disqualify branch fired (e.g. 3rd-world location)
 *
 *   3. The reply generator is then told ONLY the current stage's playbook, so
 *      it physically cannot fire a later step.
 *
 * The stage the lead is on + the facts learned are persisted on the lead row
 * (leads.stage, leads.stage_data), so it's sticky across messages and the
 * setter never re-asks something it already knows.
 *
 * SAFETY: this engine never advances more than one stage per turn, and on any
 * manager error it fails CLOSED — it keeps the current stage and never skips.
 * If a client has no stages configured, the whole engine no-ops and the legacy
 * full-script behaviour is used unchanged.
 * ============================================================================
 */

import Anthropic from "@anthropic-ai/sdk";
import { painDetectionBlock, painProtocolFor } from "./paindig";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  throw new Error("Missing ANTHROPIC_API_KEY in environment variables.");
}
const anthropic = new Anthropic({ apiKey: anthropicKey });

// Fast, cheap model for stage tracking — must not slow the reply down. Same
// class of model the screener uses for classification.
export const STAGE_MODEL = "claude-haiku-4-5";

/** One stage of a client's funnel. Authored in plain English by the operator. */
export interface Stage {
  /** Stable id, e.g. "opener". Used to record where the lead is. */
  id: string;
  /** Human label, e.g. "Opener". */
  name: string;
  /** One line: what this stage is trying to achieve. */
  goal: string;
  /** Plain-English instructions for exactly what to say at this stage. */
  playbook: string;
  /** Fact keys to extract while on/after this stage (e.g. ["location"]). */
  captures?: string[];
  /** Plain-English condition that must be TRUE to move to the next stage. */
  advance_when: string;
  /** Optional: plain-English condition that disqualifies the lead entirely. */
  disqualify_when?: string;
}

/** Facts learned about a lead, accumulated across stages. */
export type StageData = Record<string, unknown>;

/** What the stage manager decides for a single inbound message. */
export interface StageResolution {
  /** The stage the conversation is now on (after any one-step advance). */
  stage: Stage;
  /** Merged facts: prior stage_data + anything newly captured this turn. */
  stageData: StageData;
  /** The lead's latest message is a question/objection to handle, not advance. */
  objection: boolean;
  /** A disqualify branch fired (e.g. 3rd-world location) — do not reply. */
  disqualify: boolean;
  /** One-line explanation from the manager (for logging). */
  reason: string;
  /** True if the recorded stage changed this turn (for event logging). */
  advanced: boolean;
  /**
   * The lead shared something emotionally heavy — pause the funnel this turn and
   * dig into the pain with empathy (see lib/paindig.ts). Only ever true when the
   * client has pain_dig_enabled. When true the stage is held (never advanced).
   */
  digPain: boolean;
  /**
   * Whale-radar read: expected-value score (0-100) of this lead = likelihood ×
   * deal size, with a rough value band + reason. Only present when the client
   * has whale_radar_enabled. Used to ping the owner about high-value leads.
   */
  whale?: { score: number; reason: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + validate a client's stored stages. Returns [] if none/invalid. */
export function parseStages(raw: unknown): Stage[] {
  if (!Array.isArray(raw)) return [];
  const stages = raw.filter(
    (s): s is Stage =>
      !!s &&
      typeof s === "object" &&
      typeof (s as Stage).id === "string" &&
      typeof (s as Stage).advance_when === "string"
  );
  return stages;
}

function indexOfStage(stages: Stage[], id: string | null | undefined): number {
  if (!id) return -1;
  return stages.findIndex((s) => s.id === id);
}

/** Render a message list as a plain transcript for the classifier. */
function transcript(msgs: Array<{ role: string; content: string }>): string {
  return msgs
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

/** Build the compact funnel description the manager reasons over. painBlock adds
 *  the dig-pain overlay; whaleBlock adds the whale-radar EV score. */
function buildManagerSystemPrompt(stages: Stage[], painBlock = "", whaleBlock = ""): string {
  const map = stages
    .map((s, i) => {
      const captures = s.captures?.length ? ` | capture: ${s.captures.join(", ")}` : "";
      const dq = s.disqualify_when ? ` | DISQUALIFY IF: ${s.disqualify_when}` : "";
      return `${i}. ${s.id} — goal: ${s.goal} | advance when: ${s.advance_when}${captures}${dq}`;
    })
    .join("\n");

  const ids = stages.map((s) => s.id).join("|");
  const digField = painBlock ? `,"dig_pain":false` : "";
  const whaleField = whaleBlock ? `,"whale":{"score":0,"reason":""}` : "";

  return `You are the STAGE TRACKER for an Instagram DM setter that books sales calls. The conversation follows a fixed, ordered funnel. Your ONLY job is to report which stage the conversation is on right now — you do NOT write any reply.

THE FUNNEL (in order):
${map}

You will get the current recorded stage and the full conversation. Decide the stage the conversation is on NOW.

HARD RULES:
- You may KEEP the current stage, or advance by AT MOST ONE stage. Never jump ahead more than one.
- Advance to the next stage ONLY if the CURRENT stage's "advance when" condition is clearly satisfied by the conversation. When unsure, STAY.
- If the current recorded stage is "unknown", infer the furthest stage that has clearly been completed, reading the whole conversation.
- A bare greeting exchange (e.g. "yo" / "yes brother") with nothing else means we are still on the FIRST stage. Never advance off a greeting.
- "objection" = true if the lead's most recent message is a question, objection, or pushback that must be answered before continuing (it does NOT advance the stage). ALSO set objection = true when the lead is trying to JUMP AHEAD — asking to book, asking what times are available, or asking the price — before the conversation has actually reached that stage. We hold our frame and qualify first, so this never advances the stage.
- "disqualify" = true ONLY if a stage's "DISQUALIFY IF" condition is clearly met.
- "captured" = any facts from the funnel's capture list that the conversation now reveals. Use the exact capture key names. Omit anything not yet known. Do not guess.${painBlock}${whaleBlock}

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"current_stage":"${ids}","captured":{},"objection":false,"disqualify":false${digField}${whaleField},"reason":"<one short line>"}`;
}

/** The whale-radar block appended to the tracker prompt when enabled. */
const WHALE_BLOCK = `

WHALE SCORE (separate from the stage — a real-time read of how BIG and how SERIOUS this lead is):
Rate the lead 0-100 on potential = how strong a fit and how likely to close × how much they could be worth. Weigh: stated or implied income/budget/savings, the SIZE of their goal (wants "$50k/month" or to replace a high salary >> "a bit of extra cash"), urgency ("need this now", a hard deadline), engagement (fast, substantive, eager replies), ICP fit, buying signals (asking how it works / to book), and whether they're the decision-maker. Be CONSERVATIVE early: only go 80+ once there is REAL signal of BOTH money/ambition and intent — never on a greeting or a thin thread. Do NOT guess a price or a contract figure (the operator sets pricing). Output "whale": {"score": 0-100, "reason": "one short line on WHY they're worth jumping on"}. Include "whale" in your JSON.`;

// ---------------------------------------------------------------------------
// The stage manager
// ---------------------------------------------------------------------------

/**
 * Decide the current stage for a conversation. Fails CLOSED: on any error it
 * keeps the recorded stage (or the first stage if none) and never advances,
 * never disqualifies.
 */
export async function resolveStage(params: {
  stages: Stage[];
  currentStageId: string | null;
  stageData: StageData;
  messages: Array<{ role: string; content: string }>;
  /** Enable the "dig deeper into pain" empathy overlay (clients.pain_dig_enabled). */
  painEnabled?: boolean;
  /** Per-client override of the pain protocol; null/undefined => built-in default. */
  painProtocol?: string | null;
  /** Enable the whale-radar EV score (clients.whale_radar_enabled). */
  whaleEnabled?: boolean;
}): Promise<StageResolution> {
  const { stages, currentStageId, stageData, messages, painEnabled, painProtocol, whaleEnabled } = params;

  const firstStage = stages[0];
  const recordedIdx = indexOfStage(stages, currentStageId);
  const recorded = recordedIdx >= 0 ? stages[recordedIdx] : firstStage;

  // Safe fallback used whenever we can't trust the manager: stay put, no skip.
  const failClosed = (reason: string): StageResolution => ({
    stage: recorded,
    stageData,
    objection: false,
    disqualify: false,
    reason,
    advanced: false,
    digPain: false,
  });

  const painBlock = painEnabled ? painDetectionBlock(painProtocolFor(painProtocol)) : "";
  const whaleBlock = whaleEnabled ? WHALE_BLOCK : "";

  let out: Record<string, unknown>;
  try {
    const resp = await anthropic.messages.create({
      model: STAGE_MODEL,
      max_tokens: 380,
      system: buildManagerSystemPrompt(stages, painBlock, whaleBlock),
      messages: [
        {
          role: "user",
          content: `Current recorded stage: ${currentStageId || "unknown"}
Facts already known: ${JSON.stringify(stageData || {})}

Conversation:
${transcript(messages)}`,
        },
      ],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    out = parseJsonObject(raw);
  } catch (e) {
    console.error("[stages] manager failed — staying on current stage:", e);
    return failClosed("stage manager error");
  }

  const reason = String(out.reason || "").slice(0, 300);
  const objection = out.objection === true;
  const disqualify = out.disqualify === true;
  const digPain = painEnabled === true && out.dig_pain === true;
  let whale: StageResolution["whale"];
  if (whaleEnabled && out.whale && typeof out.whale === "object") {
    const w = out.whale as Record<string, unknown>;
    whale = {
      score: Math.max(0, Math.min(100, Math.round(Number(w.score) || 0))),
      reason: String(w.reason || "").slice(0, 200),
    };
  }
  const captured =
    out.captured && typeof out.captured === "object"
      ? (out.captured as Record<string, unknown>)
      : {};

  // Resolve the proposed stage, then clamp so we never advance more than one
  // step beyond the recorded stage (anti-skip safety net, independent of the
  // model). Backward moves are allowed (rare, harmless re-qualification).
  let proposedIdx = indexOfStage(stages, String(out.current_stage || ""));
  if (proposedIdx < 0) {
    // Manager returned an unknown id — keep the recorded stage.
    proposedIdx = Math.max(0, recordedIdx);
  }
  if (recordedIdx >= 0 && proposedIdx > recordedIdx + 1) {
    proposedIdx = recordedIdx + 1;
  }
  // While digging into pain we PAUSE the funnel — never advance this turn, so
  // the conversation resumes on the exact step once the lead feels heard.
  if (digPain) {
    proposedIdx = Math.max(0, recordedIdx);
  }
  const stage = stages[proposedIdx] ?? recorded;

  const mergedData: StageData = { ...(stageData || {}), ...captured };

  return {
    stage,
    stageData: mergedData,
    objection,
    disqualify,
    reason,
    advanced: stage.id !== (currentStageId || firstStage?.id),
    digPain,
    whale,
  };
}
