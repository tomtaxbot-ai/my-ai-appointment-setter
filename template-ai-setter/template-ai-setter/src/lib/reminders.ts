/**
 * JOB REMINDER ENGINE — texts the CUSTOMER ~24h before their booked job, on the
 * same Instagram DM thread they already used. Tradesman-skin feature: once a job
 * is locked into the GHL calendar, the customer gets one friendly "still good
 * for [day]?" nudge the day before, with an easy opening to reschedule.
 *
 * Design mirrors the nurture engine (a SCHEDULE pass that backfills jobs from
 * real signals, then a FLUSH pass that atomically claims + sends everything
 * due), but lives in its own `job_reminders` table so it can never collide with
 * the closer-call nurture flow.
 *
 * SAFETY: nothing fires for a client unless clients.reminders_enabled = true.
 * Dormant by default, so shipping it is harmless.
 *
 * Driven by the same cron tick as nurture (/api/cron/nurture), which Supabase
 * pg_cron pings every few minutes — so no extra Vercel cron slot is needed.
 */
import { supabase, logEvent, saveMessage, type Lead } from "./supabase";
import { sendGHLMessage, getContactUpcomingAppointment } from "./ghl";

// How far before the job the reminder goes out (24h, per the chosen setting).
const LEAD_TIME_MS = 24 * 3_600_000;

interface EnabledClient {
  id: string;
  ghl_api_key: string | null;
  ghl_location_id: string | null;
  timezone: string | null;
}

interface ReminderJob {
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
    .select("id, ghl_api_key, ghl_location_id, timezone")
    .eq("reminders_enabled", true)
    .eq("is_active", true);
  return (data ?? []) as EnabledClient[];
}

/** Format the job date/time in the client's timezone, e.g. "Tuesday at 2:00 pm". */
function formatApptWhen(apptISO: string, tz: string | null): string {
  const d = new Date(apptISO);
  if (Number.isNaN(d.getTime())) return "your booked time";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz || "Europe/London",
    }).format(d);
  } catch {
    return "your booked time";
  }
}

const REMINDER_MSGS = [
  (when: string) => `hey, just a reminder we're booked in for ${when} — still all good your end?`,
  (when: string) => `quick reminder we've got you down for ${when} — does that still work for you?`,
];
const pick = <T>(a: T[]): T => a[(Math.random() * a.length) | 0];

function reminderText(apptISO: string, tz: string | null): string {
  return pick(REMINDER_MSGS)(formatApptWhen(apptISO, tz));
}

/** When to fire: 24h before the job, but never in the past and always >=1h out. */
function reminderRunAt(apptISO: string): Date | null {
  const appt = new Date(apptISO).getTime();
  if (Number.isNaN(appt)) return null;
  const now = Date.now();
  if (appt <= now) return null;
  let runAt = appt - LEAD_TIME_MS;
  runAt = Math.max(runAt, now + 5 * 60_000); // never in the past
  if (runAt >= appt - 60 * 60_000) return null; // job too soon to bother (<1h notice)
  return new Date(runAt);
}

/**
 * SCHEDULE PASS — for each reminders-enabled client, look at recently-active
 * BOOKED leads (those the funnel pushed into post_book / proof / nurture), pull
 * their real upcoming appointment time from GHL, and schedule a one-day-out
 * reminder. Deduped per (lead, appointment time) so a rescheduled job gets a
 * fresh reminder while an unchanged one is never double-booked.
 */
async function scheduleBacklog(clients: EnabledClient[]): Promise<void> {
  const since = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString(); // last 2 weeks
  for (const client of clients) {
    if (!client.ghl_api_key || !client.ghl_location_id) continue;
    const { data: leads } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", client.id)
      .in("funnel_stage", ["post_book", "proof", "nurture"])
      .gte("last_message_at", since)
      .order("last_message_at", { ascending: false })
      .limit(60);

    for (const lead of (leads ?? []) as Lead[]) {
      if (!lead.ghl_contact_id || lead.nurture_paused || lead.ai_paused || lead.status === "done") continue;
      const apptISO = await getContactUpcomingAppointment(client.ghl_api_key, lead.ghl_contact_id);
      if (!apptISO) continue;
      // Already have a reminder for THIS appointment time? skip.
      const { data: existing } = await supabase
        .from("job_reminders")
        .select("id")
        .eq("lead_id", lead.id)
        .eq("appt_at", apptISO)
        .maybeSingle();
      if (existing) continue;
      const runAt = reminderRunAt(apptISO);
      if (!runAt) continue;
      await supabase.from("job_reminders").upsert(
        {
          client_id: client.id,
          lead_id: lead.id,
          ghl_contact_id: lead.ghl_contact_id,
          channel: "IG",
          appt_at: apptISO,
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
    .from("job_reminders")
    .update({ status, sent_at: new Date().toISOString(), meta: reason ? { skip_reason: reason } : {} })
    .eq("id", id)
    .then(undefined, () => {});
}

/**
 * FLUSH PASS — send every due reminder. Each job is CLAIMED atomically
 * (pending → sending) before sending so concurrent cron ticks can never send
 * the same reminder twice; a claim stuck in "sending" >10min self-heals.
 */
async function flushDue(clients: EnabledClient[]): Promise<{ sent: number; skipped: number; failed: number }> {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const clientIds = clients.map((c) => c.id);
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: due } = await supabase
    .from("job_reminders")
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
        .from("job_reminders")
        .update({ status: "sending", sent_at: nowIso })
        .eq("id", cand.id)
        .or(`status.eq.pending,and(status.eq.sending,sent_at.lt.${staleIso})`)
        .select("*");
      const j = (claimedRows ?? [])[0] as ReminderJob | undefined;
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
      // Job already happened (or was moved earlier than the reminder) → pointless.
      if (new Date(j.appt_at).getTime() <= Date.now()) {
        skip("appt_passed");
        continue;
      }

      // Don't talk over a live exchange — release the claim and retry later.
      const defer = async (ms: number) => {
        await supabase
          .from("job_reminders")
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

      const text = reminderText(j.appt_at, client.timezone);
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
          .from("job_reminders")
          .update({ attempts, status: attempts >= 4 ? "failed" : "pending", sent_at: null, run_at: new Date(Date.now() + 20 * 60_000).toISOString() })
          .eq("id", j.id);
        failed++;
        continue;
      }

      // Message is OUT — mark terminal immediately (retry until it sticks) so a
      // crash in the bookkeeping below can never re-claim and re-send it.
      for (let a = 0; a < 4; a++) {
        const { error } = await supabase.from("job_reminders").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", j.id);
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
          model_used: "reminder_engine",
        });
        await logEvent({ client_id: j.client_id, lead_id: lead.id, event_type: "job_reminder_sent", metadata: { appt_at: j.appt_at } });
      } catch (bk) {
        console.error("[reminders] post-send bookkeeping failed (message already sent):", j.id, bk);
      }
    } catch (err) {
      // Leave a stuck "sending" claim for the 10-min stale-reclaim rather than
      // resetting to pending (which would be a double-send vector post-send).
      console.error("[reminders] job errored (left for stale-reclaim):", cand.id, err);
      failed++;
    }
  }
  return { sent, skipped, failed };
}

/** The whole engine: schedule new reminders, then send everything due. Safe
 *  no-op when no client has reminders_enabled. */
export async function runReminders(): Promise<{ enabled: number; sent: number; skipped: number; failed: number }> {
  try {
    const clients = await enabledClients();
    if (!clients.length) return { enabled: 0, sent: 0, skipped: 0, failed: 0 };
    await scheduleBacklog(clients);
    const r = await flushDue(clients);
    return { enabled: clients.length, ...r };
  } catch (err) {
    console.error("[reminders] runReminders failed:", err);
    return { enabled: 0, sent: 0, skipped: 0, failed: 0 };
  }
}
