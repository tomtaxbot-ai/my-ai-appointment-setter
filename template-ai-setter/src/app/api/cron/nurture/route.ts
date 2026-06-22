/**
 * NURTURE ENGINE TICK — schedules new proactive touches (from recent bookings
 * and video-link sends) and sends everything due. Idempotent; safe no-op unless
 * a client has nurture_enabled = true.
 *
 * Driven by Supabase pg_cron (every few minutes — the reliable timer that works
 * around Vercel Hobby's 1-cron/day limit), plus a daily Vercel cron backstop.
 *
 * GET /api/cron/nurture   (optional CRON_SECRET bearer auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { runNurture } from "@/lib/nurture";
import { runFollowups } from "@/lib/followups";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [nurture, followups] = await Promise.all([runNurture(), runFollowups()]);
  return NextResponse.json({ ok: true, nurture, followups });
}
