# AI Setter

Your 24/7 AI DM appointment setter. Lives in Instagram DMs via GoHighLevel.
Speaks in your voice. Obeys your rules. Books advisory sessions.

---

## The 30-second tour

```
Instagram DM → GoHighLevel webhook → this app → Claude AI →
this app → GoHighLevel → Instagram DM (reply sent)
```

Everything is logged in Supabase. You train the AI by editing 4 fields
on your client row in Supabase.

---

## The 4 fields you control (your training surface)

Open Supabase → Table Editor → `clients` → edit your row.

1. **`system_prompt`** — your master instructions. SOP, tone, what to do.
2. **`voice_samples`** — paste real DMs you've sent. The AI clones this voice.
3. **`active_rules`** — plain-English rules. "never say lol", "always
   ask their name before pitching", etc.
4. **`business_context`** — your offer, prices, links, hours. Facts the AI
   needs to know about your business.

That's it. Edit any of these → save → AI obeys the next message.

---

## How the test chat works

1. Run `pnpm dev` (or `npm run dev`)
2. Open http://localhost:3000
3. Type messages as if you were a lead
4. AI replies as if it were you
5. Adjust your training in Supabase, hit "reset", try again

Use this to dial in the voice + rules BEFORE you go live in real Instagram.

---

## Going live (the 4-step checklist)

1. **Get your GHL Private Integration Token** for your location.
   Supabase → `clients` → set `ghl_api_key` and `ghl_location_id`.
2. **Add a webhook in GHL** pointing to:
   `https://YOUR-VERCEL-URL.vercel.app/api/webhook/ghl`
   with header `x-webhook-secret: YOUR_SECRET_FROM_ENV`
3. **Trigger:** "Inbound Message" event
4. **Test:** DM your own IG from another account. Watch your AI reply.

---

## Project structure

```
src/
  app/
    page.tsx                       ← test chat UI (the browser tool)
    layout.tsx                     ← Next.js root layout
    api/
      webhook/ghl/route.ts         ← receives IG DMs from GHL
      test/route.ts                ← receives test messages from the chat UI
  lib/
    brain.ts                       ← calls Claude, returns a reply
    supabase.ts                    ← typed DB helpers
    ghl.ts                         ← sends messages back via GHL
    prompts/
      master.ts                    ← THE SYSTEM PROMPT (humanization + obedience)
```

---

## Where to look when something breaks

| Problem                          | Where to look                                  |
|----------------------------------|------------------------------------------------|
| AI not replying at all           | Vercel logs (Functions tab)                    |
| AI sounding wrong                | `clients.voice_samples` + `clients.system_prompt` |
| AI breaking a rule               | `clients.active_rules` (add the rule explicitly) |
| Can't see what AI is thinking    | `ai_decisions` table — every call is logged    |
| GHL not sending webhooks         | GHL webhook settings + secret header           |
| Database empty                   | `events` table — should grow as leads come in  |

---

## Status: V1 (minimalist)

What's IN V1:
- Single agent (Claude Sonnet 4.6)
- Voice + rules + system prompt training
- Inbound webhook (GHL → IG)
- Outbound replies (back to IG via GHL)
- Memory (every message saved forever)
- Test chat UI
- Funnel tracking
- Full debug logging

What's NOT in V1 (intentional — minimalism):
- Multi-channel (SMS, WhatsApp) — add when needed
- Follow-up sequences — you'll define the SOP, we'll add Inngest later
- Voice notes — V2
- Dashboard UI for non-technical users — V2
- Multi-tenant (multiple clients) — schema supports it, UI doesn't yet

When V1 proves out for your own business, we copy the engine and configure
it for tattoo studios. Same code, different `clients` row.
