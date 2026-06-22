/**
 * Daily catch-up for Jarvis's real-time brags (the HQ pulse covers the
 * near-real-time path while the HQ is open; this sweeps anything missed).
 * GET /api/cron/brag — Vercel cron; optional CRON_SECRET bearer auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { bragCheck } from "@/lib/brag";
import { briefCheck, dailyCallSheet } from "@/lib/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await Promise.all([bragCheck(), briefCheck(), dailyCallSheet()]);
  return NextResponse.json({ ok: true });
}
