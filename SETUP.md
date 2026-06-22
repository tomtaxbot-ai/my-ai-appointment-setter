# SETUP — Stand up your own AI Appointment Setter

This gets **your own copy** of the whole system live. You do the account
sign-ups (nobody can do those for you), then paste one prompt and let Claude
Code do the technical wiring.

> ⏱️ Realistic time: ~60–90 min the first time, mostly waiting on sign-ups.
> You do **not** need to understand the code. Follow the steps in order.

---

## What you're standing up (3 parts)

| Part | Lives on | What it is |
|------|----------|------------|
| The AI Setter + dashboard + Jarvis HQ | **Vercel** (free tier ok) | The web app that talks to DMs + the control room |
| The database | **Supabase** (free tier ok) | Where every lead, message, and number is stored |
| The Telegram bot | **Railway** (~$5/mo) | Your text-message remote control |

---

## STEP 1 — Make these accounts and grab the keys

Open each link, sign up, and paste what it gives you into a notepad. You'll
hand all of these to the setup prompt in Step 3.

1. **Anthropic** (the AI brain) → https://console.anthropic.com
   → API Keys → Create Key → copy the `sk-ant-...` value.

2. **Supabase** (the database) → https://supabase.com
   → New Project (pick a region near you, set a DB password).
   → Once it's built: Project Settings → API → copy **Project URL** and the
   **`service_role`** key (the secret one, NOT `anon`).

3. **GitHub** → you'll put the code here so Vercel + Railway can deploy it.
   (If you got this kit as a repo, just keep it; you'll connect it in Step 4.)

4. **Vercel** (hosts the app) → https://vercel.com → sign in with GitHub.

5. **Railway** (hosts the bot) → https://railway.app → sign in with GitHub.

6. **Telegram bot** (your remote) → in Telegram, message **@BotFather**
   → `/newbot` → follow prompts → copy the **bot token**.
   → then message **@userinfobot** → copy **your numeric user ID**.

7. **GoHighLevel** (connects Instagram DMs) → in the client's GHL:
   → Settings → Company → copy the **Location ID**.
   → Settings → Private Integrations → Create new (enable *conversations* +
   *contacts*) → copy the token (starts with `pit-`).
   *(You'll need #7 per client you sell to — see ONBOARD_CLIENT. For your own
   test, use your own GHL.)*

**Make up two random passwords** too (any long gibberish strings): one is your
`CRON_SECRET`, one is your `GHL_WEBHOOK_SECRET`. Just save them.

---

## STEP 2 — Put the code in your GitHub

Push **both** template folders to one new private GitHub repo:
- `template-ai-setter/` — the web app + dashboard + Jarvis HQ
- `template-telegram-bot/` — the Telegram remote

In Claude Code, just say: *"create a new private GitHub repo and push the
template-ai-setter and template-telegram-bot folders to it."*

---

## STEP 3 — Build the database

Open Claude Code in the project and paste:

> "Connect to my Supabase project and run `template-ai-setter/db/schema.sql` to
> create all the tables, views, and functions. Then confirm every table was created."

(Paste your Supabase URL + service_role key when asked.) This builds the entire
database in one shot.

---

## STEP 4 — Deploy the app (Vercel)

1. Vercel → Add New Project → import your GitHub repo.
2. **Root Directory:** set it to **`template-ai-setter`**.
3. **Environment Variables:** open `template-ai-setter/.env.example` and add each
   variable + your real value (from Step 1).
   → **Pick your `OWNER_CLIENT_SLUG` now** (e.g. `owner` or your brand). You'll
   reuse the *exact same* value for the bot — write it down.
4. Deploy. When it's green, copy your live URL (e.g. `my-ai-setter.vercel.app`).

The scheduled jobs (follow-ups, nurture, monthly DM analysis) are already in
`vercel.json` — they run automatically once deployed.

---

## STEP 5 — Create your OWN setter (you're your first client)

Your setter runs in your own Instagram DMs first. In Claude Code, run
**`prompts/ONBOARD_CLIENT_PROMPT.md`** pointed at **yourself**:
- Use **your own** GHL Location ID + token (from Step 1, #7).
- Set the slug to the **`OWNER_CLIENT_SLUG`** you chose in Step 4.
- It's your first row, so there's no skin to copy yet — that's the next step.

This gives you two things — **save both**:
- **`OWNER_CLIENT_ID`** (a long UUID) → you'll paste it into the bot in Step 7.
- **Your GHL webhook setup** → add it now in your GHL (Settings → Webhooks):
  URL `https://YOUR-URL.vercel.app/api/webhook/ghl`, event *Inbound Message*,
  custom header `x-webhook-secret` = your `GHL_WEBHOOK_SECRET`. This connects
  your DMs.

---

## STEP 6 — Make it speak your niche (reskin)

Run **`prompts/RESKIN_PROMPT.md`**. It asks a few questions about your niche +
offer and writes your entire selling brain into your owner row. ~10 min.

---

## STEP 7 — Deploy the bot (Railway)

1. Railway → New Project → Deploy from your GitHub repo.
2. **Root Directory:** set it to **`template-telegram-bot`**.
3. **Environment Variables:** open **`template-telegram-bot/.env.example`** (note:
   the bot names Supabase as `AISETTER_SUPABASE_URL` / `AISETTER_SUPABASE_SERVICE_KEY`).
   - `OWNER_CLIENT_SLUG` = the **same** value as the app.
   - `OWNER_CLIENT_ID` = the UUID from Step 5.
   - `AISETTER_BASE_URL` = your Vercel URL from Step 4.
4. Railway uses the `Procfile` automatically. Text your bot on Telegram — it
   should answer.

---

## STEP 8 — Add more clients

For each business you sell to, run **`prompts/ONBOARD_CLIENT_PROMPT.md`** again —
this time it automatically copies your niche skin. Takes a few minutes each.

---

## You're live ✅

- DMs come in → the AI qualifies + books → you watch it in the dashboard.
- Control everything by texting your Telegram bot or talking to Jarvis HQ.
- Everything ships with the advanced features **OFF** (nurture, follow-ups,
  voice, whale radar, DM intelligence). Turn each on when you're ready — just
  tell the bot "turn follow-ups on", etc.

> Stuck on any step? Paste the exact error into Claude Code and say "fix this."
