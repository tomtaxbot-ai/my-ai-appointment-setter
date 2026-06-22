/**
 * DM INTELLIGENCE — MONTHLY safety-net run. Triggered by Supabase pg_cron on the
 * 1st of each month. Analyses clients with dm_intel_enabled = true, writes a
 * report, and pings the owner that it's ready to read. Read-only over business
 * data — it only produces advisory suggestions, never changes config.
 *
 * On-demand runs (orbit / Telegram via /api/dm-intel/run) work regardless of the
 * flag and this route. The flag only governs THIS automatic monthly run.
 *
 * GET /api/cron/dm-intel   (optional CRON_SECRET bearer auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { runDmIntelMonthly } from "@/lib/dmintel";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await runDmIntelMonthly();
  return NextResponse.json({ ok: true });
}
