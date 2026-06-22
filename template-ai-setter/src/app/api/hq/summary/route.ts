/**
 * JARVIS HQ — live business metrics for the dashboard.
 * Key-gated (same access key as the prompter). Read-only.
 *
 * GET /api/hq/summary?k=<key> → { pulse, pipeline, team, content, generatedAt }
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAccessKey } from "@/lib/access";

export const dynamic = "force-dynamic";

function sinceISO(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

async function countEvents(type: string, sinceDays: number): Promise<number> {
  const { count } = await supabase
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", type)
    .gt("created_at", sinceISO(sinceDays));
  return count ?? 0;
}

export async function GET(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // ── Pulse ──
    const [leadsToday, leads7d, engagedNow] = await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }).gt("created_at", sinceISO(1)),
      supabase.from("leads").select("id", { count: "exact", head: true }).gt("created_at", sinceISO(7)),
      supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "engaged"),
    ]);
    const [booked7d, qualified7d, won7d, lost7d] = await Promise.all([
      countEvents("call_booked", 7),
      countEvents("tag_qualified", 7),
      countEvents("deal_won", 7),
      countEvents("deal_lost", 7),
    ]);

    // median first-reply seconds (this week)
    let replyMedian: number | null = null;
    try {
      const { data } = await supabase
        .from("reporting_lead_timing")
        .select("first_reply_seconds")
        .gt("lead_created_at", sinceISO(7))
        .not("first_reply_seconds", "is", null)
        .limit(500);
      const vals = (data ?? [])
        .map((r) => r.first_reply_seconds as number)
        .filter((v) => v != null)
        .sort((a, b) => a - b);
      if (vals.length) replyMedian = Math.round(vals[Math.floor(vals.length / 2)]);
    } catch {
      /* view may not exist in all envs — non-fatal */
    }

    // ── Pipeline: recent booked calls + leads by source (7d) ──
    const { data: recentBookings } = await supabase
      .from("events")
      .select("id, created_at, lead_id")
      .eq("event_type", "call_booked")
      .order("created_at", { ascending: false })
      .limit(8);

    const bookings = await Promise.all(
      (recentBookings ?? []).map(async (ev) => {
        let name = "a lead";
        let source = "";
        if (ev.lead_id) {
          const { data: lead } = await supabase
            .from("leads")
            .select("full_name, ig_username, source")
            .eq("id", ev.lead_id)
            .maybeSingle();
          if (lead) {
            name = lead.full_name || lead.ig_username || name;
            source = lead.source || "";
          }
        }
        return { when: ev.created_at, name, source };
      })
    );

    const { data: sourceRows } = await supabase
      .from("leads")
      .select("source")
      .gt("created_at", sinceISO(7))
      .limit(1000);
    const bySource: Record<string, number> = {};
    for (const r of sourceRows ?? []) {
      const s = (r.source || "unknown").trim() || "unknown";
      bySource[s] = (bySource[s] || 0) + 1;
    }
    const topSources = Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([source, count]) => ({ source, count }));

    // ── Team: this week's activity per member ──
    const { data: members } = await supabase
      .from("team_members")
      .select("id, name, role")
      .eq("active", true);
    const team = await Promise.all(
      (members ?? []).map(async (m) => {
        const { data: act } = await supabase
          .from("team_activity")
          .select("outreaches, dials, conversations, pickups, activity_date")
          .eq("team_member_id", m.id)
          .gte("activity_date", sinceISO(7).slice(0, 10));
        const sum = (key: string) =>
          (act ?? []).reduce((t, r) => t + (Number((r as Record<string, unknown>)[key]) || 0), 0);
        return {
          name: m.name,
          role: m.role,
          outreaches: sum("outreaches"),
          dials: sum("dials"),
          conversations: sum("conversations"),
          pickups: sum("pickups"),
        };
      })
    );

    // ── Content: scripts ──
    const { data: scripts } = await supabase
      .from("yt_scripts")
      .select("title, created_at")
      .order("created_at", { ascending: false })
      .limit(6);
    const realScripts = (scripts ?? []).filter(
      (s) => !(s.title || "").toLowerCase().includes("welcome to your prompter")
    );

    return NextResponse.json({
      pulse: {
        leadsToday: leadsToday.count ?? 0,
        leads7d: leads7d.count ?? 0,
        engagedNow: engagedNow.count ?? 0,
        booked7d,
        qualified7d,
        won7d,
        lost7d,
        replyMedianSeconds: replyMedian,
      },
      pipeline: { bookings, topSources },
      team,
      content: {
        scriptCount: realScripts.length,
        latest: realScripts[0]?.title ?? null,
        recent: realScripts.slice(0, 6).map((s) => ({ title: s.title, when: s.created_at })),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[hq/summary] error:", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
