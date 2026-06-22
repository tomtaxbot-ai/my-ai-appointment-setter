# ONBOARD A CLIENT — add a business you're selling the setter to

Run this once per business (client) you put the setter live for. It adds them to
your database, inherits your niche skin, and gives you their exact Instagram/GHL
hookup. ~5 minutes.

**How to use:** open your repo in Claude Code and paste the box below as one
message. Answer its questions.

---

```
You are onboarding a client onto my platform. Each client is one row in the
`clients` table; the webhook routes inbound DMs to the right client by
`ghl_location_id`. Do NOT change engine code.

FIRST-TIME / OWN SETTER: if I tell you this is MY OWN setter (my first row), use
MY OWN Instagram's GHL creds, set the slug to my OWNER_CLIENT_SLUG, and in STEP 2
choose neither copy nor reskin — just create the row with EMPTY skin (I'll reskin
next). Then in STEP 3, clearly print the new row's `id` and label it
"OWNER_CLIENT_ID — save this for the Telegram bot."

STEP 0 — Read src/lib/supabase.ts for the `clients` columns so you write valid data.

STEP 1 — Collect these from me (ask for any I don't give, one short list):
- Business name (display) — e.g. "Bright Kitchens Co"
- slug — lowercase-hyphens, auto-make one from the name if I don't say
- GHL Location ID (their GHL → Settings → Company)
- GHL Private Integration Token (starts with pit-; their GHL → Settings →
  Private Integrations → create, enable Conversations + Contacts)
- Booking calendar ID (their GHL calendar) — or "placeholder"
- Timezone — default to mine if unknown
- Their specifics for business_context: the exact offer, hours, booking link,
  and anything unique to THIS business (name, location, any promo).

STEP 2 — Decide the skin (ask me which):
  (A) SAME niche as my other clients (default): inherit my niche skin. Copy
      system_prompt, active_rules, voice_samples, stages, and pain_protocol
      FROM my owner client row (slug = my OWNER_CLIENT_SLUG) into the new row,
      and write a fresh business_context from this client's specifics above.
  (B) DIFFERENT niche: tell me, and we'll run the RESKIN flow for this client
      instead of copying.

STEP 3 — Create the client row.
- If Supabase is connected (MCP): insert the row. For option (A), read my owner
  row's skin fields and copy them; set name, slug, ghl_location_id, ghl_api_key,
  ghl_calendar_id, timezone, the new business_context, is_active=true, and leave
  ALL feature flags at their default OFF (nurture_enabled, followup_enabled,
  dm_intel_enabled, pain_dig_enabled, voice_enabled, whale_radar_enabled = false).
- If Supabase is NOT connected: output the full INSERT (or INSERT ... SELECT that
  copies my owner skin) as one SQL block for me to run in Supabase → SQL Editor.
  Use dollar-quoting ($$...$$) for text fields.
- Then verify: select id, name, slug, ghl_location_id, is_active from clients
  where slug = '<new-slug>';

STEP 4 — Give me the GHL webhook setup to paste into THIS client's GHL
(Settings → Webhooks), using my real live URL (ask me for it if you don't know):
  URL:           https://MY-LIVE-URL/api/webhook/ghl
  Method:        POST
  Event:         Inbound Message
  Custom header: x-webhook-secret = (my GHL_WEBHOOK_SECRET — tell me to grab it
                 from my Vercel env; do not print the value)

STEP 5 — Smoke test. Give me this command (swap in real values) and tell me a
JSON `reply` means it's working:
  curl -X POST https://MY-LIVE-URL/api/test \
    -H "Content-Type: application/json" \
    -d '{"message":"hey is this you","client_slug":"<new-slug>","session_id":"smoke"}'

STEP 6 — End with this checklist:
  [ ] Client row created + verified
  [ ] Webhook added in the client's GHL (config above)
  [ ] Smoke test returned a reply
  [ ] Live test: DM the client's actual Instagram from another account
  [ ] Watch one real conversation before walking away

Rules for you: never invent a Location ID or token — if I don't have one, stop
and tell me where to get it. Never hardcode anything in code. State sensible
defaults (timezone, channel=instagram) and proceed.
```

---

## Notes

- **The GHL key lives in the database row, never in code or env** — that's why
  each client just needs their `clients` row filled in.
- Every client ships with the advanced features **OFF**. Turn them on per client
  by telling your Telegram bot, e.g. "turn follow-ups on for Bright Kitchens."
- Removing a client: set `is_active=false` (pauses replies) or delete the row.
