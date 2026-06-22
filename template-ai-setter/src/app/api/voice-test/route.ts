/**
 * VOICE DELIVERY SPIKE — prove GHL can deliver an audio clip into an IG DM that
 * actually plays, BEFORE we wire voice into the live reply path.
 *
 * It synthesizes a clip (using the provided voiceId, else the client's
 * setter_voice_id, else the env ELEVENLABS_VOICE_ID — so we can prove DELIVERY
 * with any voice without waiting on the clone), hosts it, and sends it as a GHL
 * attachment to a real contact. Returns the URL + send result so we can see
 * exactly what GHL did.
 *
 * POST /api/voice-test  body { contactId, text?, voiceId?, channel? }
 *   (optional bearer auth: DM_INTEL_SECRET or CRON_SECRET)
 *
 * Touches nothing in the live pipeline. Safe to deploy dormant.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { OWNER_SLUG } from "@/lib/owner";
import { makeVoiceClip } from "@/lib/voice";
import { sendGHLMessage } from "@/lib/ghl";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const secret = process.env.DM_INTEL_SECRET || process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | { contactId?: string; text?: string; voiceId?: string; channel?: "IG" | "SMS" | "WhatsApp" | "FB" }
    | null;
  const contactId = body?.contactId?.trim();
  if (!contactId) return NextResponse.json({ ok: false, reason: "missing_contactId" }, { status: 400 });

  const { data: client } = await supabase
    .from("clients")
    .select("ghl_api_key, ghl_location_id, setter_voice_id")
    .eq("slug", OWNER_SLUG)
    .maybeSingle();
  const c = client as { ghl_api_key?: string; ghl_location_id?: string; setter_voice_id?: string } | null;
  if (!c?.ghl_api_key || !c?.ghl_location_id) {
    return NextResponse.json({ ok: false, reason: "client_ghl_not_configured" }, { status: 400 });
  }

  const voiceId = body?.voiceId || c.setter_voice_id || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) return NextResponse.json({ ok: false, reason: "no_voice_id_available" }, { status: 400 });

  const text = body?.text?.trim() || "hey man, just wanted to send a quick voice note instead of typing it all out";

  const url = await makeVoiceClip(text, voiceId);
  if (!url) return NextResponse.json({ ok: false, reason: "clip_generation_failed", voiceId }, { status: 502 });

  const result = await sendGHLMessage({
    ghl_api_key: c.ghl_api_key,
    ghl_location_id: c.ghl_location_id,
    ghl_contact_id: contactId,
    message: "",
    type: body?.channel || "IG",
    attachments: [url],
  });

  return NextResponse.json({ ok: result.success, clip_url: url, send: result });
}

/**
 * Browser-triggerable variant so Maher can fire a test from a URL (the agent is
 * network-blocked from calling it). Lets us iterate on HOW the audio is sent:
 *   /api/voice-test?contactId=XXX                  → audio only (empty text)
 *   /api/voice-test?contactId=XXX&caption=1        → audio + a short caption
 *   /api/voice-test?contactId=XXX&text=hej%20bror  → custom spoken text
 * Returns JSON showing the clip URL + exactly what GHL returned.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.DM_INTEL_SECRET || process.env.CRON_SECRET;
  if (secret && req.nextUrl.searchParams.get("secret") !== secret) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const p = req.nextUrl.searchParams;
  const contactId = (p.get("contactId") || "").trim();
  if (!contactId) return NextResponse.json({ ok: false, reason: "missing_contactId" }, { status: 400 });

  const { data: client } = await supabase
    .from("clients").select("ghl_api_key, ghl_location_id, setter_voice_id, setter_voice_id_sv")
    .eq("slug", OWNER_SLUG).maybeSingle();
  const c = client as { ghl_api_key?: string; ghl_location_id?: string; setter_voice_id?: string; setter_voice_id_sv?: string } | null;
  if (!c?.ghl_api_key || !c?.ghl_location_id) return NextResponse.json({ ok: false, reason: "client_ghl_not_configured" }, { status: 400 });

  const voiceId = p.get("voiceId") || c.setter_voice_id || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) return NextResponse.json({ ok: false, reason: "no_voice_id" }, { status: 400 });

  // kind=video → test whether GHL will forward a VIDEO (mp4 w/ audio) to IG even
  // though it rejects raw audio ("only images"). kind=image → control (images are
  // known to work). Default → the real mp3 voice clip.
  const kind = (p.get("kind") || "audio").toLowerCase();
  let attachmentUrl: string | null = null;
  if (kind === "video") {
    // public sample mp4 that HAS audio (Google CDN, ~2.5MB, under IG's 25MB cap)
    attachmentUrl = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
  } else if (kind === "image") {
    attachmentUrl = "https://picsum.photos/seed/teu/600/600.jpg";
  } else {
    const text = (p.get("text") || "yo bror, testar bara att skicka ett röstmeddelande istället för text").trim();
    attachmentUrl = await makeVoiceClip(text, voiceId);
  }
  if (!attachmentUrl) return NextResponse.json({ ok: false, reason: "clip_generation_failed", voiceId }, { status: 502 });

  // url=<any> overrides the attachment entirely, so we can rapidly test specific
  // mp4/image URLs (incl. our own Supabase-hosted ones) without redeploying.
  const override = p.get("url");
  if (override) attachmentUrl = override;

  // caption=1 sends a tiny bit of text WITH the attachment (some integrations drop
  // a pure attachment-only message); otherwise attachment only.
  const message = p.get("caption") ? "🎤" : "";
  const result = await sendGHLMessage({
    ghl_api_key: c.ghl_api_key,
    ghl_location_id: c.ghl_location_id,
    ghl_contact_id: contactId,
    message,
    type: (p.get("channel") as "IG" | "SMS" | "WhatsApp" | "FB") || "IG",
    attachments: [attachmentUrl],
  });

  return NextResponse.json({ ok: result.success, kind, attachment_url: attachmentUrl, sent_with_caption: !!p.get("caption"), send: result });
}
