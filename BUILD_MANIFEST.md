# AI Appointment Setter — Build Manifest

**What this is:** the complete list of everything the AI Appointment Setter product
is made of, and — for each piece — whether it's **universal** (ships finished, you
never touch it) or **personalized** (you fill it in for your niche / your client).

This is the "V52" starting point. You are NOT building from scratch. You are
taking a finished machine and pouring your own words into it.

---

## The product is 3 systems

| # | System | In plain English |
|---|--------|------------------|
| 1 | **The AI Setter** | The brain that lives in the Instagram DMs, talks to leads, qualifies them, handles objections, follows up, and books calls — automatically, 24/7. |
| 2 | **Jarvis HQ** | The futuristic control room: a voice-controlled orbit + a live money/tracking dashboard. You talk to your whole business and watch it breathe. |
| 3 | **The Telegram Bot** | Your remote control. Text it like a person — "turn the AI off for John", "how many did we book this week" — and it does it. |

> **Not included** (these are separate products, kept out on purpose): the YouTube
> scripting / idea engine, the teleprompter, and the content pipeline. This kit is
> ONLY the appointment setter + its HQ + its Telegram control.

---

## The legend (how to read the tags)

| Tag | Meaning | Who sets it |
|-----|---------|-------------|
| 🔵 **UNIVERSAL** | The machinery. Identical for every niche. Ships done — never edit. | Nobody |
| 🟡 **NICHE SKIN** | The words. Set **once** for your niche (remodelers, dentists…). | You, the student |
| 🟢 **PER-CLIENT** | Keys + calendar for each business you sell to. | You, per client |
| 🔑 **SECRET** | Your own logins/API keys for your own copy. | You, once at setup |

**The golden rule:** the engine is *dumb on purpose*. All the selling smarts live
in the 🟡 skin (stored in the database), never in the code. That's why one machine
works for any niche — you just change the words.

---

## SYSTEM 1 — The AI Setter

### The machinery (🔵 never touch)

| Piece | What it does |
|-------|--------------|
| **Inbound handler** | Catches every DM the moment it arrives, figures out which business it's for, and kicks off a reply. |
| **Stage machine** | Tracks where each lead is in the funnel (opener → reason → goals → situation → timeline → problem → pitch → book) so it never repeats itself or skips a step. |
| **Reply engine** | Writes the reply in your brand's voice, splits it into natural texting bubbles, and types at a human pace. |
| **No-double-message guard** | Multiple fast DMs can't make it reply twice or talk over itself. |
| **Follow-up engine** | If a lead goes quiet, it re-engages on a smart schedule — the *timing & escalation logic* is built in. |
| **Nurture engine** | After a call is booked, it warms the lead up to the call — the *structure* is built in. |
| **Screener** | Spots spammers / other business owners / friends, pauses the AI, and pings you instead of replying. |
| **Pain-dig overlay** | When a lead says something emotionally heavy, it pauses the funnel, digs with empathy, then resumes. |
| **Whale radar** | Scores every lead; pings you the moment a high-value one shows up. |
| **Voice notes** | Can reply in a cloned voice. **Ships OFF** (Instagram can't receive audio yet). |
| **DM Intelligence** | Once a month, studies all your conversations and reports what's working + what to fix. |
| **Source attribution** | Records where each lead came from (which post, ad, campaign) for the dashboard. |
| **Auto-pause + always-ping** | Any time the AI pauses/disqualifies someone on its own, it tells you on Telegram every single time. |

### The words (🟡 your niche skin — stored in the database, edited by talking to Jarvis)

| Field | What you put in it | Example: yours vs a remodeler's |
|-------|--------------------|--------------------------------|
| **system_prompt** | How it sells — its whole personality & playbook. | "Help young guys escape the 9-5" → "Help homeowners stop dreading their outdated kitchen" |
| **business_context** | The facts: the offer, hours, booking link, calendar. | Your coaching offer → the remodeler's free in-home quote |
| **active_rules** | Hard do's & don'ts. | "Never mention $100M Leads" → "Never quote a price before the site visit" |
| **voice_samples** | How the brand texts (so it sounds human). | Your texting style → the remodeler's casual style |
| **stages** | The actual questions it asks at each funnel step. | "What's stopping you escaping?" → "What's making you want to redo the kitchen now?" |
| **pain_protocol** | What counts as "emotional", and how to dig. | Money/freedom despair → reno stress, decision fatigue |

> Follow-up & nurture **wording** lives here too. The *when* and *how often* is
> universal machinery; the *what it says* is your skin.

### The on/off switches (ship OFF — flip them on when ready)

`nurture` · `follow-ups` · `DM Intelligence` · `pain-dig` · `voice` · `whale radar`
— all start OFF so a fresh setup is calm and safe. Turn each on from Telegram or HQ.

---

## SYSTEM 2 — Jarvis HQ

### The machinery (🔵 never touch)

| Piece | What it does |
|-------|--------------|
| **The orbit** | The voice control room. Talk to it; it acts and talks back. |
| **Living orbit** | Reacts in real time — glows & chimes when cash lands or a lead moves. |
| **Deal-close takeover** | Full-screen cinematic when money comes in ("Boom. $X just landed."). |
| **Pitch mode** | A self-running showcase reel for when you demo it to a prospect. |
| **Live demo setter** | A fake-DM panel that uses your *real* AI — so prospects can try it live. |
| **The dashboard** | Every number: funnels, cash, follow-ups, speed, sources — to the cent. |
| **Money Flow** | The animated "DMs → cash" strip. |

### The words (🟡)

| Piece | What you change |
|-------|------------------|
| **Dashboard name** | "TEU DASHBOARD" → the student's brand name. |

---

## SYSTEM 3 — The Telegram Bot

### The machinery (🔵 never touch)

| Piece | What it does |
|-------|--------------|
| **Owner controls** | Turn the whole setter on/off, edit its brain/rules, flip whale/voice/nurture/follow-ups/DM-intel, log follower gains, pull reports. |
| **Per-lead controls** | "Turn AI off for John", pause/resume, mute nurture/follow-up/voice/whale for one person, ban a spammer, find a lead. |
| **Team logging** | Closers/setters text in their call results & payments; it logs them to the dashboard. |
| **Reminders** | Pings you for split-pay collections, follow-ups, etc. |
| **Smart router** | Understands plain English and sends each request to the right place. |

### The words (🟡)

| Piece | What you change |
|-------|------------------|
| **Bot persona** | Light branding (its name / who it serves). |

---

## What YOU plug in (the only things you ever set)

### 🔑 Your own secrets (once, when you stand up your copy)
- Anthropic API key (the AI brain)
- Supabase URL + key (your database)
- Telegram bot token + your Telegram user ID (your remote control)
- GHL webhook secret (connects Instagram DMs in)
- *(ElevenLabs voice key — optional, voice ships OFF)*

### 🟢 Per client you sell to (takes minutes each)
- Business name + a short tag (slug)
- Their GHL Location ID + API token
- Their booking calendar ID
- Their timezone

### 🟡 Your niche skin (set once for your niche; can override per client)
- The 6 skin fields above (`system_prompt`, `business_context`, `active_rules`,
  `voice_samples`, `stages`, `pain_protocol`).
- **You won't write these by hand** — the reskin prompt writes them for you from a
  few answers about your niche.

---

## The mental model to remember

> **The engine is the same for everyone. You only ever change the words — and even
> the words get written for you.** Pick a niche, answer a few questions, deploy.
> Then for each business you sell to: paste in 4 keys, go live.
