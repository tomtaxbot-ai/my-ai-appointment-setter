/**
 * DM INTELLIGENCE — on-demand run (for the Telegram bot).
 *
 * The orbit runs the analysis in-process via the HQ chat tool. The Telegram bot
 * (Python) can't run the TS analyser, so it POSTs here to trigger the same job
 * and gets back the rich report (summary + findings + suggestions + ready text).
 *
 * Read-only over business data; it only writes its own report tables and returns
 * advisory suggestions. It NEVER changes the setter.
 *
 * POST /api/dm-intel/run   (optional bearer auth: DM_INTEL_SECRET or CRON_SECRET)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { OWNER_SLUG } from "@/lib/owner";
import { runDmIntel } from "@/lib/dmintel";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  const secret = process.env.DM_INTEL_SECRET || process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const { data: client } = await supabase.from("clients").select("id").eq("slug", OWNER_SLUG).maybeSingle();
  const clientId = (client as { id: string } | null)?.id;
  if (!clientId) return NextResponse.json({ ok: false, reason: "client_not_found" }, { status: 404 });

  const result = await runDmIntel(clientId, "manual");
  return NextResponse.json(result);
}
