/**
 * JARVIS HQ — LIVE DEMO SETTER. Powers the interactive "fake DM" panel: Maher
 * (or a prospect) types AS THE LEAD, and the REAL TEU AI setter replies — same
 * brain the production setter uses (generateReply → the client's own SOP,
 * voice samples, and rules from the DB). No GHL, no DB writes, no real lead —
 * pure showcase, but the setter behaves EXACTLY as it does live.
 *
 * POST /api/hq/demo-dm?k=<key>  body: { history:[{role:"lead"|"setter",content}] }
 *   → { messages: string[] }   (the setter's reply, split into real bubbles)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { OWNER_SLUG } from "@/lib/owner";
import { generateReply } from "@/lib/brain";
import type { ClientConfig, Message } from "@/lib/prompts/master";
import { getAccessKey } from "@/lib/access";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const OPENER = "yo brother — what you working on these days?";

export async function POST(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { history?: Array<{ role: string; content: string }> } | null;
    const hist = (body?.history ?? []).slice(-20);
    // No lead message to reply to yet → the setter's real opener.
    if (!hist.length || hist[hist.length - 1].role !== "lead") {
      return NextResponse.json({ messages: [OPENER] });
    }

    // Load the REAL TEU setter config — its SOP, voice, rules, offer.
    const { data: client } = await supabase.from("clients").select("*").eq("slug", OWNER_SLUG).maybeSingle();
    if (!client) return NextResponse.json({ messages: [OPENER] });

    const history: Message[] = hist.map((m) => ({
      role: m.role === "setter" ? ("ai" as const) : ("lead" as const),
      content: String(m.content ?? "").slice(0, 600),
      created_at: new Date().toISOString(),
    }));

    // Same call the production setter makes. No stage rail → the operator's full
    // SOP drives the reply (exactly how it reads a fresh thread).
    const result = await generateReply({ client: client as unknown as ClientConfig, history });
    const bubbles = (result.segments || []).map((s) => s.trim()).filter(Boolean).slice(0, 4);
    return NextResponse.json({ messages: bubbles.length ? bubbles : [result.reply.trim() || "got it — tell me more"] });
  } catch (err) {
    console.error("[hq/demo-dm] error:", err);
    return NextResponse.json({ messages: ["one sec — say that again?"] });
  }
}
