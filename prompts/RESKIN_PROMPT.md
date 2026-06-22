# RESKIN PROMPT — make the setter speak YOUR niche

**How to use:** open your template repo in Claude Code and paste everything in the
box below as one message. Answer its questions. It writes your entire selling
brain and saves it to your database. ~10 minutes.

---

```
You are configuring my AI Instagram-DM appointment setter for a specific niche.
The engine is already built; your job is ONLY to write the "skin" — the words
and the funnel — and save it to my database. Do NOT change any engine code.

STEP 1 — Learn the engine's format (do this first, silently):
- Read src/lib/stages.ts to learn the exact `Stage` shape and how stages work.
- Read src/lib/prompts/master.ts to learn the EXACT texting format the engine
  expects (bubble splitting, sentence limits, casing, what NOT to do).
- Read src/lib/supabase.ts for the `clients` table fields you'll be writing:
  system_prompt, business_context, active_rules, voice_samples, stages (jsonb),
  pain_protocol.

STEP 2 — Interview me. Ask these, one batch, plain and short:
1. What's my niche? (who I sell this setter to — e.g. "kitchen & bathroom remodelers")
2. What's the offer the DM is trying to book? (e.g. "a free in-home design consult")
3. What makes a lead QUALIFIED vs a time-waster in this niche? (budget, timeline,
   homeowner vs renter, decision-maker, etc.)
4. What should disqualify someone? (e.g. renters, out of area, no budget)
5. The voice/tone — how should it text? (casual & friendly / sharp & professional)
   Give me 2-3 example lines if you can, or let me write them for you.
6. What pain/frustration does this niche's customer feel? (for the empathy layer)
7. Anything it must NEVER say or do? (e.g. never quote a price before the visit)
8. The booking link / calendar (or say "placeholder for now").

STEP 3 — Write the skin. Produce ALL SIX fields, niche-perfect:

- system_prompt: the full selling brain. Role, who the lead is, the ONE goal
  (book the call), how to carry the conversation, how to handle the common
  objections in THIS niche, and the format rules you learned from master.ts.
  Keep it sharp and human — no corporate tone.

- business_context: the facts the AI is allowed to state — the offer, what the
  call is, hours, booking link, anything niche-specific. (It must never invent
  facts not in here.)

- active_rules: KEEP the universal format rules the engine relies on (max ~2
  sentences per bubble, questions in their own bubble, no markdown/bullets/
  em-dashes, no stiff corporate phrases, lowercase-casual by default, match the
  lead's energy, never invent prices/dates/names). THEN add the niche-specific
  do's & don'ts from my answers.

- voice_samples: 6-10 example texts in my niche's voice, covering an opener, a
  qualifying question, an empathy line, and a soft booking push. Match my tone.

- stages: an 11-stage funnel as a JSON array. Each stage is an object with:
  { "id", "name", "goal", "playbook", "captures": [..], "advance_when",
    "disqualify_when"? }
  Keep this proven SEQUENCE, but rewrite every line for my niche:
    1. opener                — open the loop, get a reply
    2. transition_main_reason— surface why they're really reaching out
    3. goals                 — what they actually want (the outcome)
    4. current_situation     — where they are now
    5. timeline              — how soon they want it
    6. problem               — the obstacle in the way
    7. pitch_help            — position the call as the fix
    8. book                  — lock the time
    9. post_book             — confirm + set expectations
    10. proof                — handle doubt / build trust if they stall
    11. nurture              — keep warm if they go quiet
  `playbook` = plain-English "say this here" for the niche. `advance_when` =
  the condition to move on. `captures` = facts to remember (e.g. ["budget",
  "timeline","area"]). `disqualify_when` only where it makes sense.

- pain_protocol: the emotional trigger words for THIS niche (what a stressed
  customer might say) + how to dig with empathy before resuming the funnel.

STEP 4 — Save it to my database (my owner client row, slug = my OWNER_CLIENT_SLUG):
- If that row doesn't exist yet, CREATE it first (insert with my slug + a name +
  timezone), then fill in the skin.
- If you have my Supabase connected (MCP), UPDATE my owner client row directly:
  update clients set system_prompt=$$...$$, business_context=$$...$$,
  active_rules=$$...$$, voice_samples=$$...$$, stages='[...]'::jsonb,
  pain_protocol=$$...$$ where slug = (my OWNER_CLIENT_SLUG, ask me if unsure).
  Use dollar-quoting ($$...$$) so apostrophes don't break it.
- If Supabase is NOT connected, OUTPUT the single complete SQL UPDATE statement
  in a code block and tell me to paste it into Supabase → SQL Editor → Run.

STEP 5 — Confirm. Show me a short summary of what each field now says, and tell
me to test it in the live demo panel (Jarvis HQ) or by DMing my own IG. If
anything sounds off, I'll tell you and you'll adjust that one field.

Rules for you: write like a real person in my niche, not a robot. Never invent
prices or promises. Don't touch engine code. Ask me before guessing on anything
that affects how it sells.
```

---

## After you reskin

- Test it: open Jarvis HQ → the live demo panel, and chat as if you're a lead.
- Tweak: just tell Claude Code "make the opener punchier" or "it's too pushy at
  the pitch stage" — it edits that one field.
- The advanced features still ship OFF. Turn them on when ready by texting your
  bot: "turn follow-ups on", "turn nurture on", etc.
