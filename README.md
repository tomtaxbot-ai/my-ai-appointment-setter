# 🚀 Build Your Own AI Appointment Setter — Student Guide

Hey — welcome. You're about to stand up the exact same AI system I use: an AI that lives inside Instagram DMs, talks to leads like a human, qualifies them, follows up, handles objections, and books calls on autopilot — plus a money dashboard and a Telegram remote to control it all.

**Read this first — it changes everything:** You are not going to write code. You'll make a few accounts, click some buttons, and paste a couple of prompts. An AI called Claude Code does all the technical work. If anything breaks, paste the error into Claude Code and say "fix this." You can't really break anything.

⏱️ **Total: ~1–1.5 hours, mostly just signing up for stuff.**

## PART 1 — Make your accounts (≈20 min)

Grab the **bold bit** from each into a notes file:

- **Anthropic** (the AI brain) → console.anthropic.com → API Keys → Create → copy **`sk-ant-...`**
- **Supabase** (the memory) → supabase.com → New Project → Settings → API → copy **Project URL + service_role key**
- **GitHub** → github.com (just sign up)
- **Vercel** (runs the website) → vercel.com → Continue with GitHub
- **Railway** (runs the bot) → railway.app → Login with GitHub
- **Telegram** → @BotFather → /newbot → copy the **token**; then @userinfobot → copy your **ID**
- **GoHighLevel** → Settings → Company → **Location ID**; Settings → Private Integrations → Create (Conversations + Contacts) → **`pit-` token**

Also make up two random passwords: **`CRON_SECRET`** and **`GHL_WEBHOOK_SECRET`**.

## PART 2 — Get your own copy (1 click)

Open the link I sent → green **"Use this template"** → name it **my-ai-setter** → Create. You now have your own private copy.

## PART 3 — Build it (Claude does the work)

Go to claude.ai/code → new session → pick your repo → paste:

> Read SETUP.md and walk me through every step, one at a time, doing all the technical parts for me. Ask me for any keys you need. Start now.

Then just follow it. It builds your database, tells you what to click in Vercel + Railway, and gives you the Instagram hookup.

## PART 4 — Make it speak YOUR niche (≈10 min)

Paste:

> Open prompts/RESKIN_PROMPT.md and run it on me.

Answer its questions → it writes your whole sales brain.

## PART 5 — Go live for a client (≈5 min)

Per business you sell to, paste:

> Open prompts/ONBOARD_CLIENT_PROMPT.md and run it on me.

---

**Stuck?** Paste the error into Claude Code and say "fix this." Then message me only if truly stuck. You've got this. 🚀
