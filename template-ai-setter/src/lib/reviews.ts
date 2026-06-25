/**
 * REVIEW REQUEST ENGINE — DMs the CUSTOMER a quick review ask a few hours
 * after their booked job has happened, on the same Instagram thread they
 * already used. Tradesman-skin feature: the job is done, so we nudge for a
 * Google/Trustpilot review while the experience is still fresh.
 *
 * "Job happened" is detected purely from job_reminders rows the reminder
 * engine already scheduled (appt_at in the past) — no new GHL calls here.
 *
 * Design mirrors the reminder engine (a SCHEDULE pass that backfills review
 * jobs from job_reminders, then a FLUSH pass that atomically claims + sends
 * everything due), but lives in its own `review_requests` table so it can
 * never collide with job_reminders or the nurture flow.
 *
 * SAFETY: nothing fires for a client unless clients.reviews_enabled = true
 * AND clients.review_link is set. Dormant by default, so shipping it is
 * harmless.
 *
 * Driven by the same cron tick as nurture (/api/cron/nurture).
 */
import { supabase, logEvent, saveMessage, type Lead } from "./supabase";
import { sendGHLMessage } from "./ghl";

// How long after the job the review ask goes out (3h, per the chosen setting).
const REVIEW_DELAY_MS = 3 * 3_600_000;
// Only look at jobs that happened in the last 7 days — anything older is stale.
const LOOKBACK_MS = 7 * 24 * 3_600_000;

interface EnabledClient {
  id: string;
  ghl_api_key: string | null;
  ghl_location_id: string | null;
  timezone: string | null;
  review_link: string;
}

interface ReviewJob {
  id: string;
  client_id: string;
  lead_id: string;
  ghl_contact_id: string | null;
  channel: string;
  run_at: string;
  status: string;
  attempts: number;
  appt_at: string;
  meta: Record<string, unknown> | null;
}

async function enabledClients(): Promise<EnabledClient[]> {
  const { data } = await supabase
    .from("clients")
    .select("id, ghl_api_key, ghl_location_id, timezone, review_link")
    .eq("reviews_enabled", true)
    .eq("is_active", true)
    .not("review_link", "is", null);
  return (data ?? []) as EnabledClient[];
}

const REVIEW_MSGS = [
  (link: string) => `hope the job went well! if you've got a sec, would mean a lot if you left us a quick review here: ${link}`,
  (link: string) => `glad we could get that sorted for you — if you don't mind, a quick review would really help us out: ${link}`,
];
const pick = <T>(a: T[]): T => a[(Math.random() * a.length) | 0];

function reviewText(link: string): string {
  return pick(REVIEW_MSGS)(link);
}

/** When to fire: 3h after the job, but never in the past. */
function reviewRunAt(apptISO: string): Date | null {
  const appt = new Date(apptISO).getTime();
  if (Number.isNaN(appt)) return null;
  if (appt > Date.now()) return null; // job hasn't happened yet
  let runAt = appt + REVIEW_DELAY_MS;
  runAt = Math.max(runAt, Date.now() + 5 * 60_000); // never in the past
  return new Date(runAt);
}

/**
 * SCHEDULE PASS — for each reviews-enabled client, look at job_reminders rows
 * whose appointment time has passed in the last 7 days (i.e. the job
 * happened) and schedule a review-request DM 3h out. Deduped per
 * (lead, appointment time) via the review_requests unique constraint, same as
 * job_reminders.
 */
async function scheduleBacklog(clients: EnabledClient[]): Promise<void> {
  const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const nowIso = new Date().toISOString();
  for (const client of clients) {
    const { data: jobs } = await supabase
      .from("job_reminders")
      .select("lead_id, ghl_contact_id, appt_at")
      .eq("client_id", client.id)
      .gte("appt_at", sinceIso)
      .lt("appt_at", nowIso)
      .limit(200);

    for (const j of (jobs ?? []) as { lead_id: string; ghl_contact_id: string | null; appt_at: string }[]) {
      // Already have a review request for THIS appointment time? skip.
      const { data: existing } = await supabase
        .from("review_requests")
        .select("id")
        .eq("lead_id", j.lead_id)
        .eq("appt_at", j.appt_at)
        .maybeSingle();
      if (existing) continue;
      const runAt = reviewRunAt(j.appt_at);
      if (!runAt) continue;
      await supabase.from("review_requests").upsert(
        {
          client_id: client.id,
          lead_id: j.lead_id,
          ghl_contact_id: j.ghl_contact_id,
          channel: "IG",
          appt_at: j.appt_at,
          run_at: runAt.toISOString(),
          status: "pending",
          meta: {},
        },
        { onConflict: "lead_id,appt_at", ignoreDuplicates: true }
      );
    }
  }
}

function markDone(id: string, status: "sent" | "skipped", reason?: string) {
  supabase
    .from("review_requests")
    .update({ status, sent_at: new Date().toISOString(), meta: reason ? { skip_reason: reason } : {} })
    .eq("id", id)
    .then(undefined, () => {});
}

/**
 * FLUSH PASS — send every due review request. Each job is CLAIMED atomically
 * (pending → sending) before sending so concurrent cron ticks can never send
 * the same review ask twice; a claim stuck in "sending" >10min self-heals.
 */
async function flushDue(clients: EnabledClient[]): Promise<{ sent: number; skipped: number; failed: number }> {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const clientIds = clients.map((c) => c.id);
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: due } = await supabase
    .from("review_requests")
    .select("id")
    .or(`status.eq.pending,and(status.eq.sending,sent_at.lt.${staleIso})`)
    .lte("run_at", nowIso)
    .in("client_id", clientIds)
    .order("run_at")
    .limit(40);
  let sent = 0,
    skipped = 0,
    failed = 0;

  for (const cand of (due ?? []) as { id: string }[]) {
    try {
      const { data: claimedRows } = await supabase
        .from("review_requests")
        .update({ status: "sending", sent_at: nowIso })
        .eq("id", cand.id)
        .or(`status.eq.pending,and(status.eq.sending,sent_at.lt.${staleIso})`)
        .select("*");
      const j = (claimedRows ?? [])[0] as ReviewJob | undefined;
      if (!j) continue; // someone else claimed it

      const client = byId.get(j.client_id);
      const { data: leadRow } = await supabase.from("leads").select("*").eq("id", j.lead_id).maybeSingle();
      const lead = leadRow as Lead | null;

      const skip = (reason: string) => {
        markDone(j.id, "skipped", reason);
        skipped++;
      };
      if (!lead || !lead.ghl_contact_id || !client?.ghl_api_key || !client.ghl_location_id) {
        skip("missing_lead_or_client");
        continue;
      }
      if (lead.nurture_paused) {
        skip("lead_nurture_paused");
        continue;
      }
      if (lead.ai_paused) {
        skip("ai_paused");
        continue;
      }
      if (lead.status === "done") {
        skip("lead_done");
        continue;
      }

      // Don't talk over a live exchange — release the claim and retry later.
      const defer = async (ms: number) => {
        await supabase
          .from("review_requests")
          .update({ status: "pending", sent_at: null, run_at: new Date(Date.now() + ms).toISOString(), attempts: j.attempts + 1 })
          .eq("id", j.id);
        skipped++;
      };
      const { data: lastMsg } = await supabase
        .from("messages")
        .select("role, created_at")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lm = lastMsg as { role: string; created_at: string } | null;
      if (lm) {
        const age = Date.now() - new Date(lm.created_at).getTime();
        if (lm.role === "human" && age < 15 * 60_000) {
          await defer(60 * 60_000);
          continue;
        }
        if (age < 90_000) {
          await defer(5 * 60_000);
          continue;
        }
      }

      const text = reviewText(client.review_link);
      const res = await sendGHLMessage({
        ghl_api_key: client.ghl_api_key,
        ghl_location_id: client.ghl_location_id,
        ghl_contact_id: lead.ghl_contact_id,
        message: text,
        type: (j.channel as "IG") || "IG",
      });
      if (!res.success) {
        const attempts = j.attempts + 1;
        await supabase
          .from("review_requests")
          .update({ attempts, status: attempts >= 4 ? "failed" : "pending", sent_at: null, run_at: new Date(Date.now() + 20 * 60_000).toISOString() })
          .eq("id", j.id);
        failed++;
        continue;
      }

      // Message is OUT — mark terminal immediately (retry until it sticks) so a
      // crash in the bookkeeping below can never re-claim and re-send it.
      for (let a = 0; a < 4; a++) {
        const { error } = await supabase.from("review_requests").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", j.id);
        if (!error) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      sent++;
      try {
        await saveMessage({
          lead_id: lead.id,
          client_id: j.client_id,
          role: "ai",
          content: text,
          channel: "instagram",
          ghl_message_id: res.ghl_message_id,
          model_used: "review_engine",
        });
        await logEvent({ client_id: j.client_id, lead_id: lead.id, event_type: "review_requested", metadata: { appt_at: j.appt_at } });
      } catch (bk) {
        console.error("[reviews] post-send bookkeeping failed (message already sent):", j.id, bk);
      }
    } catch (err) {
      // Leave a stuck "sending" claim for the 10-min stale-reclaim rather than
      // resetting to pending (which would be a double-send vector post-send).
      console.error("[reviews] job errored (left for stale-reclaim):", cand.id, err);
      failed++;
    }
  }
  return { sent, skipped, failed };
}

/** The whole engine: schedule new review requests, then send everything due.
 *  Safe no-op when no client has reviews_enabled. */
export async function runReviews(): Promise<{ enabled: number; sent: number; skipped: number; failed: number }> {
  try {
    const clients = await enabledClients();
    if (!clients.length) return { enabled: 0, sent: 0, skipped: 0, failed: 0 };
    await scheduleBacklog(clients);
    const r = await flushDue(clients);
    return { enabled: clients.length, ...r };
  } catch (err) {
    console.error("[reviews] runReviews failed:", err);
    return { enabled: 0, sent: 0, skipped: 0, failed: 0 };
  }
}
