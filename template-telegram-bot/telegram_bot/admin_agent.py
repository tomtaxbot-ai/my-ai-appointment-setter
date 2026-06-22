"""
ADMIN AGENT — owner-only Claude tool-use agent that runs the whole system
from Telegram in plain language: setter brain edits (with undo), the global
kill switch, reply speed, lead lookup, stage moves, record corrections,
CSV exports, team management, and notes.

Hard rules enforced in code, not just prompt:
  - OWNER ONLY: any other role is refused before the model is even called.
  - Every change/delete/send tool requires confirmed=true. The agent must
    show "Here's what I'll do — yes?" first, UNLESS the owner explicitly
    said to skip confirmation in their message.
"""

import os
import json
from datetime import datetime, timezone

from anthropic import Anthropic
from rich.console import Console

from config.settings import MODEL_HEAVY
from telegram_bot.owner import OWNER_NAME
from telegram_bot.capture_flows import BUSINESS_TZ, move_lead_stage, find_customer_by_name
from telegram_bot import admin_flows as af

console = Console()

NOT_CONFIRMED_ERROR = (
    "REFUSED: confirmed must be true. Show the owner ONE line describing exactly "
    "what will change/be deleted/be sent and wait for his yes — UNLESS he already "
    "told you to skip confirmation, in which case call again with confirmed=true."
)

GHL_STAGES = ["New Lead", "No Pickup", "Not interested/wrong number", "Call Pitched",
              "Lead Magnet Sent", "Appointment Booked", "Contacted", "Appointment Confirmed",
              "No Show - Re-Nurture", "Client Won", "Lead Lost", "Following Up On",
              "No Response After Follow Ups", "Disqualified"]


def _t(name, desc, props, required):
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props, "required": required}}


CONF = {"type": "boolean", "description": "true ONLY after the owner confirmed (or told you to skip confirmation)"}

ADMIN_TOOLS = [
    # Phase 1 — brain
    _t("get_brain_field",
       "Read one of the setter's brain fields: system_prompt (how it sells), active_rules, voice_samples, business_context.",
       {"field": {"type": "string", "enum": list(af.BRAIN_FIELDS)}}, ["field"]),
    _t("set_brain_field",
       "Save a brain field with the COMPLETE new text (not a diff). The old version is kept for undo. "
       "Workflow for ADD/CHANGE/REMOVE: get_brain_field → build the full resulting text → show the owner what changes → confirm → save.",
       {"field": {"type": "string", "enum": list(af.BRAIN_FIELDS)},
        "new_value": {"type": "string", "description": "the FULL new field text"},
        "confirmed": CONF}, ["field", "new_value", "confirmed"]),
    _t("undo_brain_field",
       "Restore the most recent previous version of a brain field ('undo that' / 'revert the rules').",
       {"field": {"type": "string", "enum": list(af.BRAIN_FIELDS)}, "confirmed": CONF}, ["field", "confirmed"]),
    # Phase 2 — kill switch
    _t("set_setter_active",
       "Turn the WHOLE setter on/off (clients.is_active). While off it replies to NOBODY and incoming "
       "lead DMs are not recorded — warn the owner. resume_at (ISO timestamp, only with active=false) "
       "schedules auto-on, e.g. 'pause until 9am' = tomorrow 09:00 Stockholm unless he says otherwise.",
       {"active": {"type": "boolean"},
        "resume_at": {"type": "string", "description": "ISO time for auto-resume (only when turning off)"},
        "confirmed": CONF}, ["active", "confirmed"]),
    # Nurture engine — system-wide on/off (separate from the setter kill switch)
    _t("set_nurture_active",
       "Turn the whole pre-call NURTURE sequence on/off (clients.nurture_enabled) — the warm-up follow-ups "
       "between a lead booking and their call (takeaway question + meet-link reminder). This is SEPARATE "
       "from set_setter_active: the setter can be on while nurture is off, and vice-versa. 'turn the nurture "
       "on/off', 'stop the follow-up sequence', 'turn the warm-up messages back on'.",
       {"active": {"type": "boolean"}, "confirmed": CONF}, ["active", "confirmed"]),
    # Follow-up engine — system-wide on/off (re-engages quiet leads)
    _t("set_followup_active",
       "Turn the whole FOLLOW-UP system on/off (clients.followup_enabled) — it re-engages leads who went "
       "quiet, either ghosting mid-conversation or getting cold feet after the call pitch. SEPARATE from "
       "set_setter_active and set_nurture_active. 'turn the follow-ups on/off', 'stop chasing leads', "
       "'start the follow-up sequence'.",
       {"active": {"type": "boolean"}, "confirmed": CONF}, ["active", "confirmed"]),
    # Voice notes — usage stats (read-only)
    _t("voice_stats",
       "READ-ONLY: how many VOICE NOTES the setter sent over a recent window. Use for 'how many voice messages did "
       "we send last 7 days', 'how often are we using voice', 'voice notes today / last 24h / last X hours'. Pass the "
       "window in HOURS (e.g. 24 for a day, 168 for 7 days). Defaults to 7 days.",
       {"hours": {"type": "number", "description": "look-back window in hours (24=day, 168=7 days)"}}, []),
    # Voice notes — reply in the operator's cloned voice on the key beats
    _t("set_voice_active",
       "Turn VOICE NOTES on/off (clients.voice_enabled). When ON, the setter can reply with a voice note in the "
       "operator's cloned voice on the human/persuasion beats; links + specific times always stay text, and it falls "
       "back to text if a clip ever fails. 'turn voice notes on/off', 'use my voice', 'stop the voice messages', "
       "'go back to text only'.",
       {"active": {"type": "boolean"}, "confirmed": CONF}, ["active", "confirmed"]),
    # Whale radar — ping the owner when a high-value lead appears
    _t("set_whale_radar_active",
       "Turn the WHALE RADAR on/off (clients.whale_radar_enabled). When ON, the setter scores every live lead on "
       "expected value (likelihood-to-close x deal size) and pings YOU the first time one scores as a high-value "
       "whale, so you can jump in personally. It only pings — never changes the conversation. 'turn whale radar "
       "on/off', 'stop the whale alerts'.",
       {"active": {"type": "boolean"}, "confirmed": CONF}, ["active", "confirmed"]),
    # Dig deeper into pain — empathy overlay on/off (trigger words/style live in the pain_protocol brain field)
    _t("set_pain_dig_active",
       "Turn the 'dig deeper into pain' overlay on/off (clients.pain_dig_enabled). When ON, the setter pauses the "
       "funnel whenever a lead shares something emotionally heavy (stressed, burned out, anxious, etc.), digs into it "
       "with empathy, then resumes where it left off. It only shapes the setter's reply — no new sends/timers. To "
       "change the trigger words or dig style, that's a brain edit to the pain_protocol field. 'turn pain digging "
       "on/off', 'start/stop digging into pain'.",
       {"active": {"type": "boolean"}, "confirmed": CONF}, ["active", "confirmed"]),
    # DM intelligence — monthly auto-run on/off, run fresh on demand, or read the latest
    _t("set_dm_intel_active",
       "Turn the automatic MONTHLY DM-intelligence run + ping on/off (clients.dm_intel_enabled). It studies winning "
       "vs losing conversations and SUGGESTS improvements — it never changes the setter. Off just stops the monthly "
       "timer; on-demand analysis still works. 'turn the monthly DM analysis on/off', 'stop the monthly DM study'.",
       {"active": {"type": "boolean"}, "confirmed": CONF}, ["active", "confirmed"]),
    _t("run_dm_analysis",
       "Run the DM-intelligence analysis ON DEMAND now. It studies winning vs losing conversations, finds where "
       "leads die, and returns a detailed report + the top 1-3 fixes (each with why it's the best lever + expected "
       "impact). Takes ~30-40s. READ-ONLY: it only produces a report, it changes NOTHING. 'analyse my DMs', "
       "'study my conversations', 'what should I fix in the setter'. Return the report text it gives back, as-is.",
       {}, []),
    _t("get_dm_report",
       "READ-ONLY: the LATEST already-run DM-intelligence report — what it did, the findings, and the pending fixes. "
       "Use this for 'show me the DM report', 'what did the last analysis find', 'what are the suggestions'. For a "
       "FRESH run use run_dm_analysis instead. Return the report text as-is.",
       {}, []),
    # Phase 3 — reply speed
    _t("set_reply_delay",
       f"Set how long the setter waits before replying: a min–max seconds range (max {af.MAX_REPLY_DELAY_SECONDS}s "
       f"— the reply runs in a 60s serverless window, longer would kill it; if the owner asks for more, offer "
       f"{af.MAX_REPLY_DELAY_SECONDS}s and explain). 'reply faster' = lower it (e.g. 3–6s). Omit both to reset to default (~8s). "
       "Reply STYLE (shorter/longer texts) is a brain edit, not this.",
       {"min_seconds": {"type": "number"}, "max_seconds": {"type": "number"}, "confirmed": CONF}, ["confirmed"]),
    # Phase 4 — lookup (read-only)
    _t("lookup_lead",
       "READ-ONLY: find a lead by name → stage, source, last message time, ai_paused, language.",
       {"name": {"type": "string"}}, ["name"]),
    _t("list_stage_leads",
       f"READ-ONLY: list real-prospect leads currently in a GHL stage. Stages: {', '.join(GHL_STAGES)}.",
       {"stage": {"type": "string"}}, ["stage"]),
    # Phase 5 — stage move
    _t("move_stage",
       f"Move a lead's GHL opportunity to a stage (lead_id from lookup_lead). 'disqualify John' = stage Disqualified. "
       f"Stages: {', '.join(GHL_STAGES)}.",
       {"lead_id": {"type": "string"}, "stage": {"type": "string"}, "confirmed": CONF},
       ["lead_id", "stage", "confirmed"]),
    # Tag control — ANY tag on a lead's GHL contact
    _t("set_lead_tag",
       "Add or remove ANY tag on a lead's GHL contact ('add the tag qualified to John', 'remove icp "
       "from this guy', 'tag X as hot lead'). Works for any tag text, not a fixed list — GHL "
       "lowercases tags. Find the lead with lookup_lead first.",
       {"lead_id": {"type": "string", "description": "From lookup_lead"},
        "tag": {"type": "string", "description": "The tag text, e.g. 'qualified'"},
        "action": {"type": "string", "enum": ["add", "remove"]},
        "confirmed": CONF}, ["lead_id", "tag", "action", "confirmed"]),
    # Weekly follower count
    _t("set_followers_gained",
       "Log how many IG followers were gained in a week ('we gained 120 followers last week'). "
       "week_start = that week's Monday (YYYY-MM-DD); omit it for last week. Upserts — saying it "
       "again corrects the number.",
       {"count": {"type": "integer"},
        "week_start": {"type": "string", "description": "Monday of the week, YYYY-MM-DD; omit for last week"},
        "confirmed": CONF}, ["count", "confirmed"]),
    # Dialing marker — the one booking method with no automatic signal
    _t("mark_dial_booking",
       "Mark that a lead was booked from a DIAL ('booked John from a dial', 'I dialed and booked "
       "John') — sets booking_method='dialing', overriding any auto-detected method. Find the lead "
       "with lookup_lead first.",
       {"lead_id": {"type": "string", "description": "From lookup_lead"},
        "confirmed": CONF}, ["lead_id", "confirmed"]),
    # Phase 6 — record corrections
    _t("find_customer", "Search customers (signed clients) by name.", {"name": {"type": "string"}}, ["name"]),
    _t("list_customer_payments", "READ-ONLY: every payment on a customer (id, amount, kind, when, who logged it).",
       {"customer_id": {"type": "string"}}, ["customer_id"]),
    _t("delete_customer_record",
       "HARD-DELETE a customer and ALL their payments (fake/test/wrong sale). Before confirming: show the customer, "
       "each payment, and — if they're tied to a real lead — that the GHL stage moves out of 'Client Won' "
       "(default Lead Lost; let the owner pick another stage). An append-only record_correction event is the audit trail.",
       {"customer_id": {"type": "string"},
        "ghl_stage": {"type": "string", "description": "stage to move the real lead to (default Lead Lost)"},
        "reason": {"type": "string", "description": "why, in the owner's words"},
        "confirmed": CONF}, ["customer_id", "reason", "confirmed"]),
    _t("delete_payment_record",
       "Delete/void ONE payment (find it via list_customer_payments). Contract value is NOT changed unless asked. "
       "Appends a record_correction audit event.",
       {"payment_id": {"type": "string"}, "reason": {"type": "string"}, "confirmed": CONF},
       ["payment_id", "reason", "confirmed"]),
    _t("update_payment_amount",
       "Fix a payment's amount (show before → after first). Appends a record_correction audit event.",
       {"payment_id": {"type": "string"}, "new_amount": {"type": "number"},
        "reason": {"type": "string"}, "confirmed": CONF}, ["payment_id", "new_amount", "reason", "confirmed"]),
    _t("update_contract_value",
       "Fix a customer's total contract value (show before → after first). Appends a record_correction audit event.",
       {"customer_id": {"type": "string"}, "new_value": {"type": "number"},
        "reason": {"type": "string"}, "confirmed": CONF}, ["customer_id", "new_value", "reason", "confirmed"]),
    # Phase 7 — export
    _t("export_csv",
       "Run ONE read-only SELECT and send the rows to the owner as a CSV document. Tables/views: reporting_leads, "
       "reporting_money (name, contract_value, cash_collected, outstanding, closer, closed_at, status), "
       "reporting_money_summary, reporting_calls, reporting_lead_timing, payments (amount, kind, collected_at, "
       "logged_by), customers, scheduled_payments, team_activity, events. NEVER deal_value. "
       "Same rules as reporting: real money only from payments/customers; SELECT-only is enforced twice.",
       {"sql": {"type": "string", "description": "one SELECT/WITH query, no semicolons"},
        "filename": {"type": "string", "description": "e.g. payments_june.csv"},
        "confirmed": CONF}, ["sql", "filename", "confirmed"]),
    # Phase 8 — team
    _t("add_team_member",
       "Add a team member (role closer|setter). Returns their one-time 6-digit access code to pass on.",
       {"name": {"type": "string"}, "role": {"type": "string", "enum": list(af.VALID_TEAM_ROLES)},
        "confirmed": CONF}, ["name", "role", "confirmed"]),
    _t("change_member_role", "Change an existing member's role (closer|setter).",
       {"member_name": {"type": "string"}, "new_role": {"type": "string", "enum": list(af.VALID_TEAM_ROLES)},
        "confirmed": CONF}, ["member_name", "new_role", "confirmed"]),
    _t("deactivate_member", "Remove a team member (active=false; history kept; their chat loses access).",
       {"member_name": {"type": "string"}, "confirmed": CONF}, ["member_name", "confirmed"]),
    # Phase 9 — notes
    _t("save_note", "Remember something the owner tells you ('remember our new offer is X').",
       {"content": {"type": "string"}, "confirmed": CONF}, ["content", "confirmed"]),
    _t("search_notes", "READ-ONLY: search saved notes by content ('what did I tell you about pricing?').",
       {"query": {"type": "string"}}, ["query"]),
]

_WRITE_TOOLS = {"set_brain_field", "undo_brain_field", "set_setter_active", "set_nurture_active",
                "set_followup_active", "set_dm_intel_active", "set_pain_dig_active", "set_voice_active",
                "set_whale_radar_active",
                "set_reply_delay", "move_stage", "delete_customer_record", "delete_payment_record",
                "update_payment_amount", "update_contract_value", "export_csv",
                "add_team_member", "change_member_role", "deactivate_member", "save_note",
                "set_lead_tag", "set_followers_gained", "mark_dial_booking"}


def execute_admin_tool(tool_name: str, tool_input: dict) -> dict:
    """Execute one admin tool. confirmed=true is hard-required on every write/send."""
    try:
        if tool_name in _WRITE_TOOLS and tool_input.get("confirmed") is not True:
            return {"error": NOT_CONFIRMED_ERROR}

        if tool_name == "get_brain_field":
            return af.get_brain_field(tool_input["field"])
        if tool_name == "set_brain_field":
            return af.set_brain_field(tool_input["field"], tool_input["new_value"])
        if tool_name == "undo_brain_field":
            return af.undo_brain_field(tool_input["field"])
        if tool_name == "set_setter_active":
            return af.set_setter_active(bool(tool_input["active"]), tool_input.get("resume_at"))
        if tool_name == "set_nurture_active":
            return af.set_nurture_active(bool(tool_input["active"]))
        if tool_name == "set_followup_active":
            return af.set_followup_active(bool(tool_input["active"]))
        if tool_name == "voice_stats":
            return af.voice_stats(int(tool_input.get("hours") or 168))
        if tool_name == "set_voice_active":
            return af.set_voice_active(bool(tool_input["active"]))
        if tool_name == "set_whale_radar_active":
            return af.set_whale_radar_active(bool(tool_input["active"]))
        if tool_name == "set_pain_dig_active":
            return af.set_pain_dig_active(bool(tool_input["active"]))
        if tool_name == "set_dm_intel_active":
            return af.set_dm_intel_active(bool(tool_input["active"]))
        if tool_name == "run_dm_analysis":
            return af.run_dm_analysis()
        if tool_name == "get_dm_report":
            return af.latest_dm_report()
        if tool_name == "set_reply_delay":
            return af.set_reply_delay(tool_input.get("min_seconds"), tool_input.get("max_seconds"))
        if tool_name == "lookup_lead":
            return af.lookup_lead(tool_input["name"])
        if tool_name == "list_stage_leads":
            return af.list_stage_leads(tool_input["stage"])
        if tool_name == "move_stage":
            from telegram_bot.capture_agent import _get_lead
            lead = _get_lead(tool_input["lead_id"])
            if not lead:
                return {"error": f"no lead with id {tool_input['lead_id']} — use lookup_lead first"}
            return move_lead_stage(lead, tool_input["stage"])
        if tool_name == "set_lead_tag":
            return af.set_lead_tag(tool_input["lead_id"], tool_input["tag"], tool_input["action"])
        if tool_name == "set_followers_gained":
            return af.set_followers_gained(tool_input["count"], tool_input.get("week_start"))
        if tool_name == "mark_dial_booking":
            return af.mark_dial_booking(tool_input["lead_id"])
        if tool_name == "find_customer":
            return {"result": find_customer_by_name(tool_input["name"])}
        if tool_name == "list_customer_payments":
            return af.list_customer_payments(tool_input["customer_id"])
        if tool_name == "delete_customer_record":
            return af.delete_customer_record(tool_input["customer_id"], tool_input["reason"],
                                             ghl_stage=tool_input.get("ghl_stage"))
        if tool_name == "delete_payment_record":
            return af.delete_payment_record(tool_input["payment_id"], tool_input["reason"])
        if tool_name == "update_payment_amount":
            return af.update_payment_amount(tool_input["payment_id"], float(tool_input["new_amount"]),
                                            tool_input["reason"])
        if tool_name == "update_contract_value":
            return af.update_contract_value(tool_input["customer_id"], float(tool_input["new_value"]),
                                            tool_input["reason"])
        if tool_name == "export_csv":
            return af.export_csv(tool_input["sql"], tool_input.get("filename") or "export.csv")
        if tool_name == "add_team_member":
            return af.add_team_member(tool_input["name"], tool_input["role"])
        if tool_name == "change_member_role":
            return af.change_member_role(tool_input["member_name"], tool_input["new_role"])
        if tool_name == "deactivate_member":
            return af.deactivate_member(tool_input["member_name"])
        if tool_name == "save_note":
            return af.save_note(tool_input["content"])
        if tool_name == "search_notes":
            return af.search_notes(tool_input["query"])
        return {"error": f"unknown tool {tool_name}"}
    except Exception as e:
        console.print_exception()
        return {"error": f"{tool_name} failed: {e}"}


def _system_prompt() -> str:
    now_utc = datetime.now(timezone.utc)
    now_local = now_utc.astimezone(BUSINESS_TZ)
    tz_label = str(BUSINESS_TZ)
    prompt = f"""You are Jarvis, {OWNER_NAME}'s right hand, running his whole system from Telegram. It is {now_local.strftime('%A %Y-%m-%d %H:%M')} in {tz_label} ({now_utc.strftime('%H:%M')} UTC).

**THE CONFIRMATION RULE (non-negotiable):** before ANY change, delete, or send, state ONE line of exactly what you'll do and ask "yes?" — then act only on his yes. EXCEPTION: if his message explicitly says to skip confirmation ("no need to confirm", "just do it"), act immediately with confirmed=true. Read-only lookups never need confirmation.

**Brain edits (system_prompt / active_rules / voice_samples / business_context):**
- SHOW: get_brain_field and send the text (long fields: send as-is, it chunks fine).
- ADD / CHANGE / REMOVE: get_brain_field first, build the FULL resulting text yourself, show him WHAT changes (for long fields show just the changed/added/removed part, not the whole wall), confirm, then set_brain_field with the complete new text. Never save a fragment.
- Every save keeps the old version — "undo that" / "revert the rules" → undo_brain_field.
- Changes are live on the setter's next reply (it reads the DB fresh per message).

**Kill switch:** "turn the setter off/on" → set_setter_active. Warn: while off, lead DMs get NO reply and are NOT recorded. "Pause until 9am" → off with resume_at = next 9am the owner's local ({tz_label}) time as ISO with the matching UTC offset (compute it from the time above).

**Nurture engine:** "turn the nurture on/off", "the pre-call warm-up messages" → set_nurture_active (system-wide). This is SEPARATE from the setter kill switch — the setter and the nurture are independent on/off switches. Per-LEAD nurture ("stop nurturing John") is the setter skill, not yours — tell him to say "turn off nurture for John".

**Follow-up engine:** "turn the follow-ups on/off", "stop/start the follow-up sequence", "stop chasing leads" → set_followup_active (system-wide). Re-engages leads who went quiet (ghosted or cold feet). SEPARATE from the setter and from nurture — three independent switches. Per-LEAD follow-up ("stop following up with John") is the setter skill, not yours.

**DM intelligence:** "analyse my DMs / study my conversations / what should I fix" → run_dm_analysis (fresh study now, ~30-40s; read-only, changes nothing). "show me the DM report / what did the last analysis find / the suggestions" → get_dm_report (the latest one). Both give you a ready report text — relay it AS-IS, don't trim it; it's meant to be the full read. It also runs automatically once a month and pings him; "turn the monthly DM analysis on/off" → set_dm_intel_active (timer only — on-demand always works). It only SUGGESTS — never changes the setter. **Applying a fix:** if Maher wants a fix made (even with his own tweak on it), that's a normal brain edit — get_brain_field → build the full new text with his tweak → show him exactly what changes → confirm → set_brain_field. Nothing changes without his yes; "undo that" reverts. He can do all this here OR in the orbit — both run it and both apply.

**Voice notes:** "turn voice notes on/off", "use my voice", "stop the voice messages" → set_voice_active (system-wide kill switch). "how many voice messages did we send last 7 days / 24h / X hours", "how often are we using voice" → voice_stats (pass hours). Turning voice on/off for ONE lead is a SETTER thing (set_lead_voice), not here. When ON, the setter replies in Maher's cloned voice on the key beats (links/times stay text; falls back to text if a clip fails).

**Whale radar:** "turn whale radar on/off", "stop the whale alerts" → set_whale_radar_active. When ON, I score every live lead and ping you the moment a high-value whale shows up so you can jump in. It only alerts you — never touches the conversation.

**Dig deeper into pain:** "turn pain digging on/off" → set_pain_dig_active. When ON, the setter pauses the funnel if a lead shares something emotionally heavy, digs into it with empathy, then resumes where it left off (it never skips a stage or sends extra messages). To change WHICH words trigger it or HOW it digs, that's a brain edit to the pain_protocol field (get_brain_field → build → confirm → set_brain_field), same as any other brain edit. Captured pain shows in a lead's facts when you look them up.

**Reply speed:** set_reply_delay (range in seconds, hard max {af.MAX_REPLY_DELAY_SECONDS}s — explain the serverless limit if he wants more and offer {af.MAX_REPLY_DELAY_SECONDS}s). Texting style/length = brain edit instead.

**Leads:** "where's John?" → lookup_lead (give stage, source, last message time, AI on/off). "who's in X?" → list_stage_leads. Stage moves/disqualify → move_stage after confirming. Per-lead AI pause/ban is the setter skill, not yours — tell him to just say "turn off AI for John" / "ban John".

**Tags:** "add the tag qualified to John" / "remove icp from this guy" / "tag X as hot lead" → lookup_lead → confirm → set_lead_tag (any tag text works). "This guy" with no name = the lead from the recent conversation context.

**Followers:** "we gained 120 followers last week" → set_followers_gained (defaults to last week's Monday; he can name another week). Jarvis also asks every Monday morning — a number replied to that question is this.

**Dial bookings:** "booked John from a dial" / "I dialed and booked John" → lookup_lead → confirm → mark_dial_booking (the only booking method with no automatic signal; overrides auto-detection).

**Money corrections (events are append-only — corrections create an audit event, never edit history):**
- Delete customer: find_customer → list_customer_payments → show everything incl. total cash being removed; if they have a lead_id say "GHL moves out of Client Won → Lead Lost (or tell me another stage)"; confirm → delete_customer_record(reason).
- Void one payment → delete_payment_record. Fix amounts → update_payment_amount / update_contract_value, ALWAYS showing before → after.
- reporting/money numbers update immediately. NEVER touch deal_value.

**Exports:** build ONE SELECT (real money = payments/customers/reporting_money; never deal_value), tell him what the file will contain, confirm, export_csv.

**Team:** add_team_member (give him the access code to forward), change_member_role, deactivate_member. Reminder times are handled by the capture flow ("set Ethan's reminder to 8pm").

**Notes:** "remember …" → save_note (confirm). "what did I tell you about …" → search_notes.

Voice: sharp, warm, short — a right-hand man, not a form. Plain text (Telegram). Numbers from tool results only."""
    # Owner-neutral: swap any remaining default-owner mentions for this owner.
    return prompt.replace("Maher", OWNER_NAME)


def handle_admin_request(user_message: str, conversation_history: list,
                         role: str, member: dict | None) -> str:
    """Owner-only entry point. Everyone else is politely refused."""
    if role != "owner":
        return f"That's owner-only — ask {OWNER_NAME}."

    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    messages = []
    for msg in (conversation_history or [])[-10:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_message})

    for _turn in range(8):
        try:
            response = client.messages.create(
                model=MODEL_HEAVY,
                max_tokens=3000,
                system=_system_prompt(),
                messages=messages,
                tools=ADMIN_TOOLS,
            )
        except Exception as e:
            console.log(f"[red]✗ admin agent API call failed: {e}[/red]")
            return f"Couldn't process that right now — {type(e).__name__}. Try again in a minute."

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    console.log(f"[cyan]Admin tool: {block.name}({str(block.input)[:200]})[/cyan]")
                    result = execute_admin_tool(block.name, block.input or {})
                    console.log(f"[dim]Result: {str(result)[:300]}[/dim]")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, default=str),
                    })
            messages.append({"role": "user", "content": tool_results})
            continue

        text_blocks = [b.text for b in response.content if hasattr(b, "text")]
        if text_blocks:
            return "\n".join(text_blocks).strip()
        return "Done."

    return "That took too many steps — say it again more directly and I'll do it."
