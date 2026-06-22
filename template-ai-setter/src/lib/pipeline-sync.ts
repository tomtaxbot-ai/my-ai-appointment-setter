/**
 * ============================================================================
 * PIPELINE AUTO-MOVE — keep the GHL card in step with the setter's funnel
 * ============================================================================
 * THE GAP THIS CLOSES: the setter works a lead through its own funnel
 * (clients.stages → leads.funnel_stage) but never moved the lead's CARD in the
 * GHL "AI Sales Pipeline". So setter-driven leads sat at "New Lead" on the board
 * forever, and the Jarvis pipeline watcher (which logs milestone events when a
 * GHL stage CHANGES) had nothing to react to. Result: an understated funnel.
 *
 * THE FIX: at two setter milestones we nudge the GHL card forward —
 *   - active conversation (any qualifying stage) → "Waiting For Reply (lead needs to msg)"
 *   - pitch reached or beyond                    → "Call Pitched"
 * and on a disqualify we move it to "Disqualified". We write NOTHING else: we do
 * NOT touch leads.stage. The watcher then sees the GHL change on its next pass
 * and logs the milestone event exactly as if a human had dragged the card. So
 * the dashboard, reporting views, and Jarvis HQ need zero changes — they already
 * consume the watcher's output.
 *
 * SAFETY (why this can't corrupt the board or fight the booking workflow):
 *   1. FORWARD-ONLY. Every stage the setter is allowed to move BETWEEN has a
 *      rank; a move only happens when the target rank is strictly higher. A lead
 *      who already booked (or is "Lead Lost", "Client Won", etc.) is in a stage
 *      with NO rank → the setter treats the card as owned by the booking workflow
 *      or a human closer and never touches it. This is what stops a booked lead's
 *      "thanks bro" from yanking their card back to mid-funnel.
 *   2. SAME-PIPELINE ONLY. If the opportunity isn't in the AI Sales Pipeline we
 *      skip — never reach across pipelines.
 *   3. MOVE-ONLY, NEVER CREATE. ~99% of leads already have an opportunity; the
 *      handful without are skipped silently. We never POST a new opportunity, so
 *      we can never duplicate the one the booking workflow makes.
 *   4. BEST-EFFORT. Every failure is swallowed + logged to webhook_debug_logs;
 *      this never throws into the reply path (and runs only after the reply is
 *      already sent).
 *   5. STAGE-CONFIGURED CLIENTS ONLY. The caller passes a funnel stage id only
 *      when the client has stages; legacy full-script clients no-op.
 * ============================================================================
 */

import { findContactOpportunity, listPipelines, moveOpportunityStage } from "./ghl";
import { supabase } from "./supabase";

/** The single pipeline the setter operates in (TEU "AI Sales Pipeline"). */
export const AI_SALES_PIPELINE_ID = "guHUTUQU0FaKR1xfTfwT";

/**
 * GHL stages the setter is allowed to move a card BETWEEN, with their funnel
 * rank (lower = earlier). A card whose current stage is NOT in this map is owned
 * by the booking workflow ("Appointment Booked"+) or a human closer ("Client
 * Won"/"Lead Lost"/"No Show"/etc.) — the setter must never touch it. Keys are
 * lowercased for case-insensitive matching against the live pipeline names.
 */
export const SETTER_OWNED_RANK: Record<string, number> = {
  "new lead": 0,
  "outreach to (ai needs to msg)": 1,
  "waiting for reply (lead needs to msg)": 1,
  "call pitched": 2,
};

/**
 * Setter funnel stage id (from clients.stages) → the GHL stage that position
 * maps to. Everything up to (but not including) the pitch maps to the active-
 * conversation stage; the pitch and everything after it map to "Call Pitched"
 * (the setter's ceiling — the booking workflow owns "Appointment Booked"+).
 */
export const FUNNEL_TO_GHL: Record<string, string> = {
  opener: "Waiting For Reply (lead needs to msg)",
  transition_main_reason: "Waiting For Reply (lead needs to msg)",
  goals: "Waiting For Reply (lead needs to msg)",
  current_situation: "Waiting For Reply (lead needs to msg)",
  timeline: "Waiting For Reply (lead needs to msg)",
  problem: "Waiting For Reply (lead needs to msg)",
  pitch_help: "Call Pitched",
  book: "Call Pitched",
  post_book: "Call Pitched",
  proof: "Call Pitched",
  nurture: "Call Pitched",
};

export const DISQUALIFIED_STAGE = "Disqualified";

export interface SyncClient {
  id: string;
  ghl_api_key?: string | null;
  ghl_location_id?: string | null;
}

export interface SyncLead {
  id: string;
  ghl_contact_id?: string | null;
}

function rankOf(stageName: string | null | undefined): number | undefined {
  if (!stageName) return undefined;
  return SETTER_OWNED_RANK[stageName.trim().toLowerCase()];
}

/**
 * PURE decision: given the card's CURRENT GHL stage name and the desired target
 * stage name, decide whether the setter is allowed to move it. No I/O — this is
 * the safety core and is unit-tested directly.
 *
 *   - terminal=false (conversation / pitch): move only if target rank is
 *     strictly higher than current rank, AND the current stage is setter-owned.
 *   - terminal=true (disqualify): move from ANY setter-owned stage; still never
 *     from a workflow/human-owned stage.
 */
export function decideMove(params: {
  currentStageName: string | null;
  targetStageName: string;
  terminal?: boolean;
}): { move: boolean; reason: string } {
  const { currentStageName, targetStageName, terminal } = params;
  const currentRank = rankOf(currentStageName);

  // Card is owned by the booking workflow or a human closer — hands off.
  if (currentRank === undefined) {
    return { move: false, reason: `not_setter_owned:${currentStageName ?? "unknown"}` };
  }

  // Already in the target stage → nothing to do.
  if ((currentStageName ?? "").trim().toLowerCase() === targetStageName.trim().toLowerCase()) {
    return { move: false, reason: "already_there" };
  }

  if (terminal) {
    // Disqualify is a terminal exit allowed from any setter-owned stage.
    return { move: true, reason: `terminal:${currentStageName}->${targetStageName}` };
  }

  const targetRank = rankOf(targetStageName);
  if (targetRank === undefined) {
    // Target isn't a setter-owned stage — refuse (shouldn't happen via the maps).
    return { move: false, reason: `target_not_setter_owned:${targetStageName}` };
  }
  if (targetRank <= currentRank) {
    // Sideways or backward — never move the card the wrong way.
    return { move: false, reason: `not_forward:${currentStageName}->${targetStageName}` };
  }
  return { move: true, reason: `forward:${currentStageName}->${targetStageName}` };
}

// Stage ids never change, so cache the AI-pipeline stage list to keep the hot
// webhook path from re-fetching pipelines on every inbound (warm invocations
// only; a cold start just re-fetches). Short TTL so a board edit is picked up.
let stageCache: { at: number; stages: Array<{ id: string; name: string }> } | null = null;
const STAGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getAiPipelineStages(
  apiKey: string,
  locationId: string
): Promise<Array<{ id: string; name: string }>> {
  if (stageCache && Date.now() - stageCache.at < STAGE_CACHE_TTL_MS) return stageCache.stages;
  const pipelines = await listPipelines(apiKey, locationId);
  const p = pipelines.find((pl) => pl.id === AI_SALES_PIPELINE_ID);
  const stages = p?.stages ?? [];
  if (stages.length) stageCache = { at: Date.now(), stages };
  return stages;
}

/** Resolve a stage NAME to its id within the AI pipeline (exact, then loose). */
function findStageIdByName(
  stages: Array<{ id: string; name: string }>,
  name: string
): string | null {
  const want = name.trim().toLowerCase();
  const exact = stages.find((s) => s.name.trim().toLowerCase() === want);
  const loose = stages.find((s) => s.name.trim().toLowerCase().includes(want));
  return (exact ?? loose)?.id ?? null;
}

function writeDiag(kind: string, data: unknown): void {
  supabase
    .from("webhook_debug_logs")
    .insert({ parse_result: kind, extracted_data: data as never })
    .then(undefined, () => {});
}

/**
 * Apply a guarded move: read the card's LIVE stage from GHL, run decideMove, and
 * only PUT the move when allowed. Returns a small result for logging/testing.
 * Never throws.
 */
async function applyMove(params: {
  client: SyncClient;
  lead: SyncLead;
  targetStageName: string;
  terminal?: boolean;
}): Promise<{ moved: boolean; reason: string; to?: string }> {
  const { client, lead, targetStageName, terminal } = params;
  const apiKey = client.ghl_api_key;
  const locationId = client.ghl_location_id;
  const contactId = lead.ghl_contact_id;
  if (!apiKey || !locationId || !contactId) return { moved: false, reason: "missing_ghl_ids" };

  // LIVE read of the card (not the possibly-stale leads.stage mirror) so we never
  // race the booking workflow and drag a just-booked card backward.
  const opp = await findContactOpportunity(apiKey, locationId, contactId);
  if (!opp) return { moved: false, reason: "no_opportunity" };
  if (opp.pipelineId && opp.pipelineId !== AI_SALES_PIPELINE_ID) {
    return { moved: false, reason: "other_pipeline" };
  }

  const stages = await getAiPipelineStages(apiKey, locationId);
  const currentName = stages.find((s) => s.id === opp.pipelineStageId)?.name ?? null;

  const decision = decideMove({ currentStageName: currentName, targetStageName, terminal });
  if (!decision.move) return { moved: false, reason: decision.reason };

  const targetId = findStageIdByName(stages, targetStageName);
  if (!targetId) return { moved: false, reason: `target_stage_missing:${targetStageName}` };
  if (targetId === opp.pipelineStageId) return { moved: false, reason: "already_there" };

  const r = await moveOpportunityStage(
    apiKey,
    opp.id,
    opp.pipelineId ?? AI_SALES_PIPELINE_ID,
    targetId
  );
  if (!r.success) {
    writeDiag("pipeline_sync_move_failed", {
      lead_id: lead.id,
      to: targetStageName,
      from: currentName,
      error: r.error,
    });
    return { moved: false, reason: `move_failed:${r.error}` };
  }
  return { moved: true, reason: decision.reason, to: targetStageName };
}

/**
 * Conversation / pitch milestone, derived from the setter's resolved funnel
 * stage id. Call AFTER a reply has been sent. No-ops for unknown/legacy stages.
 */
export async function syncPipelineFunnel(params: {
  client: SyncClient;
  lead: SyncLead;
  funnelStageId: string | null;
}): Promise<void> {
  try {
    const target = params.funnelStageId ? FUNNEL_TO_GHL[params.funnelStageId] : undefined;
    if (!target) return;
    await applyMove({ client: params.client, lead: params.lead, targetStageName: target });
  } catch (e) {
    console.error("[pipeline-sync] funnel sync failed:", e);
  }
}

/**
 * Disqualify milestone → move the card to "Disqualified" from any setter-owned
 * stage. Booked/won/lost cards are left untouched (Maher is already pinged by
 * the disqualify branch and handles those by hand).
 */
export async function syncPipelineDisqualified(params: {
  client: SyncClient;
  lead: SyncLead;
}): Promise<void> {
  try {
    await applyMove({
      client: params.client,
      lead: params.lead,
      targetStageName: DISQUALIFIED_STAGE,
      terminal: true,
    });
  } catch (e) {
    console.error("[pipeline-sync] disqualify sync failed:", e);
  }
}
