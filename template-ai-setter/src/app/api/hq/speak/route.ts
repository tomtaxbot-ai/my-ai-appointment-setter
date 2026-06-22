/**
 * JARVIS HQ — voice. Proxies text to ElevenLabs Text-to-Speech and streams
 * back MP3 audio. Key-gated. The ElevenLabs key stays server-side (env
 * ELEVENLABS_API_KEY) — the browser never sees it.
 *
 * POST /api/hq/speak?k=<key>  body: { text }     → audio/mpeg (streamed)
 * GET  /api/hq/speak?k=<key>&text=<text>          → audio/mpeg (streamed —
 *      lets the browser's <audio> element play while the voice generates)
 *
 * Voice resolution (once, cached in the lambda):
 *   1. ELEVENLABS_VOICE_ID env if set
 *   2. else fetch the account's voices and match "Hale" by name
 *   3. else the first available voice
 */
import { NextRequest, NextResponse } from "next/server";
import { getAccessKey } from "@/lib/access";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TTS_MODEL = "eleven_turbo_v2_5"; // low-latency, conversational
const PREFERRED_VOICE_NAME = "hale";

let cachedVoiceId: string | null = null;

async function resolveVoiceId(apiKey: string): Promise<string | null> {
  if (cachedVoiceId) return cachedVoiceId;
  const envId = process.env.ELEVENLABS_VOICE_ID;
  if (envId) {
    cachedVoiceId = envId;
    return cachedVoiceId;
  }
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { voices?: Array<{ voice_id: string; name: string }> };
    const voices = data.voices ?? [];
    const hale = voices.find((v) => (v.name || "").toLowerCase().includes(PREFERRED_VOICE_NAME));
    cachedVoiceId = (hale ?? voices[0])?.voice_id ?? null;
    return cachedVoiceId;
  } catch {
    return null;
  }
}

async function synthesize(req: NextRequest, rawText: string) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "voice_not_configured" }, { status: 503 });
    }

    const text = (rawText || "").trim().slice(0, 2000);
    if (!text) return NextResponse.json({ error: "empty_text" }, { status: 400 });

    const voiceId = await resolveVoiceId(apiKey);
    if (!voiceId) {
      return NextResponse.json({ error: "no_voice_available" }, { status: 503 });
    }

    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: TTS_MODEL,
          voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35 },
        }),
      }
    );

    if (!ttsRes.ok) {
      const detail = await ttsRes.text().catch(() => "");
      console.error("[hq/speak] elevenlabs error:", ttsRes.status, detail.slice(0, 300));
      // 401 from EL = bad/missing key permissions; surface a clean code
      return NextResponse.json(
        { error: ttsRes.status === 401 ? "voice_key_invalid" : "tts_failed" },
        { status: 502 }
      );
    }

    // pass the audio through AS IT ARRIVES — the browser starts playing the
    // first chunks instead of waiting for the whole mp3 to be generated
    return new NextResponse(ttsRes.body, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[hq/speak] error:", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  return synthesize(req, body?.text ?? "");
}

/** GET variant so the <audio> element can stream straight from the URL. */
export async function GET(req: NextRequest) {
  return synthesize(req, req.nextUrl.searchParams.get("text") ?? "");
}
