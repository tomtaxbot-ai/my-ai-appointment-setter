"""
CAPTURE AGENT — Claude tool-use agent for the human capture layer.

One agent, three role-scoped toolsets:
  - closer (Ethan):  call outcomes + his pending calls + his own numbers. Nothing else.
  - setter (Isaiah): daily outreach volume + his own numbers. Nothing else.
  - owner (Maher):   all of the above + payment logging + customer creation.

CONFIRMATION RULE (hard-enforced, not just prompted):
Every write tool requires confirmed=true. The executor refuses to write unless
the model passes it, and the system prompt forbids setting it until the user
has said yes to a one-line summary. So the worst a confused model can do is
get refused and ask again.
"""

import os
import json
from anthropic import Anthropic
from rich.console import Console

from config.settings import MODEL_HEAVY
from telegram_bot.owner import OWNER_NAME, BUSINESS_NAME
from telegram_bot.setter_control import get_supabase_client
from telegram_bot.capture_flows import (
    find_lead_by_name,
    find_customer_by_name,
    list_pending_calls,
    log_close,
    log_no_show,
    log_showed_no_close,
    log_showed_not_pitched,
    create_customer,
    log_payment,
    log_commitment,
    log_team_activity,
    get_member_activity,
    get_closer_numbers,
)

console = Console()

NOT_CONFIRMED_ERROR = (
    "REFUSED: confirmed must be true. Show the user a ONE-LINE summary of exactly "
    "what will be written and wait for their explicit yes, THEN call again with confirmed=true."
)


# ════════════════════════════════════════════════════════════════════
# Tool definitions (role-scoped)
# ════════════════════════════════════════════════════════════════════

TOOL_FIND_LEAD = {
    "name": "find_lead",
    "description": "Search leads by name in the setter database. Returns id, full_name, current stage, source. If several match, list them and ask the user which one.",
    "input_schema": {"type": "object", "properties": {
        "name": {"type": "string", "description": "Name (or part of it) to search"}
    }, "required": ["name"]},
}

TOOL_PENDING_CALLS = {
    "name": "list_pending_calls",
    "description": "List booked calls that still need an outcome: real-prospect leads in 'Appointment Booked' with no recorded outcome yet AND whose call has already happened (started 30+ min ago). Calls scheduled for a later date are intentionally NOT listed — they're asked about only after the call occurs.",
    "input_schema": {"type": "object", "properties": {}, "required": []},
}

TOOL_LOG_OUTCOME = {
    "name": "log_call_outcome",
    "description": (
        "Record a call outcome for a lead (found via find_lead). outcome must be one of: "
        "'closed' (showed, pitched AND closed — needs contract_value, collected_today, and "
        "call_duration_minutes; creates the customer, first payment, deal_won, GHL 'Client Won'), "
        "'no_show' (didn't show — call_no_show, GHL 'No Show - Re-Nurture'), "
        "'showed_not_pitched' (showed but unqualified, no pitch — needs reason; GHL 'Disqualified'), "
        "'showed_no_close' (showed AND pitched but didn't buy — needs reason; deal_lost, GHL 'Lead Lost'). "
        "ALWAYS capture the specific reason for showed_not_pitched / showed_no_close in the closer's own words. "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "lead_id": {"type": "string", "description": "The lead's id from find_lead"},
        "outcome": {"type": "string", "enum": ["closed", "no_show", "showed_not_pitched", "showed_no_close"]},
        "contract_value": {"type": "number", "description": "Total contract value in USD (closed only)"},
        "collected_today": {"type": "number", "description": "Cash collected today in USD (closed only, 0 if none)"},
        "call_duration_minutes": {"type": "integer", "description": "How long the call ran, in minutes (closed only)"},
        "reason": {"type": "string", "description": "The specific reason in the closer's words — REQUIRED for showed_not_pitched (why no pitch) and showed_no_close (why no close)"},
        "payment_terms": {"type": "string", "description": "Split-pay terms for the REMAINDER in plain language, e.g. '1.5k in 40 days' or '500/month for 3 months'. Omit for PIF. Each becomes a scheduled collection that reminds Maher on its due date."},
        "note": {"type": "string"},
        "confirmed": {"type": "boolean", "description": "true ONLY after the user explicitly confirmed the summary"},
    }, "required": ["lead_id", "outcome", "confirmed"]},
}

TOOL_SCHEDULE_PAYMENT = {
    "name": "schedule_payment",
    "description": (
        "Schedule a future collection on an existing customer (find_customer first): the unpaid "
        "part of a split pay or any 'remind Maher to collect X from Y on <date>'. Maher gets a "
        "Telegram reminder on the due date, and logging the matching payment ticks it off. "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "customer_id": {"type": "string", "description": "From find_customer"},
        "amount": {"type": "number"},
        "due_date": {"type": "string", "description": "YYYY-MM-DD"},
        "note": {"type": "string", "description": "Short label, e.g. 'second half'"},
        "confirmed": {"type": "boolean"},
    }, "required": ["customer_id", "amount", "due_date", "confirmed"]},
}

TOOL_MY_NUMBERS = {
    "name": "my_numbers",
    "description": "The current user's own numbers: a closer gets their closes/cash-collected/outstanding; a setter gets their recent daily activity rows.",
    "input_schema": {"type": "object", "properties": {}, "required": []},
}

TOOL_FIND_CUSTOMER = {
    "name": "find_customer",
    "description": "Search existing customers (people who signed) by name. Returns id, name, contract_value, closer, status.",
    "input_schema": {"type": "object", "properties": {
        "name": {"type": "string"}
    }, "required": ["name"]},
}

TOOL_CREATE_CUSTOMER = {
    "name": "create_customer",
    "description": (
        "Create a new customer (someone signed): e.g. 'John signed for 6k, paid 2k today'. "
        "Optionally links a lead (lead_id from find_lead) and logs a first_payment. "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "name": {"type": "string", "description": "Customer name"},
        "contract_value": {"type": "number"},
        "first_payment": {"type": "number", "description": "Cash collected now, 0 if none"},
        "lead_id": {"type": "string", "description": "Optional lead id from find_lead"},
        "closer": {"type": "string", "description": "Who closed it (defaults to the user)"},
        "note": {"type": "string"},
        "confirmed": {"type": "boolean"},
    }, "required": ["name", "contract_value", "confirmed"]},
}

TOOL_LOG_PAYMENT = {
    "name": "log_payment",
    "description": (
        "Log CASH against an EXISTING customer (find them with find_customer first) — a payment "
        "only, the contract value is NOT changed. kind: 'installment' (collected money on what "
        "they already owe) or 'refund' (money back — stored negative automatically). "
        "For extensions/renewals/upsells use log_commitment instead (those raise the contract). "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "customer_id": {"type": "string", "description": "From find_customer"},
        "amount": {"type": "number", "description": "Positive amount; refunds are made negative automatically"},
        "kind": {"type": "string", "enum": ["installment", "refund"]},
        "note": {"type": "string"},
        "confirmed": {"type": "boolean"},
    }, "required": ["customer_id", "amount", "kind", "confirmed"]},
}

TOOL_LOG_COMMITMENT = {
    "name": "log_commitment",
    "description": (
        "Log a NEW COMMITMENT on an existing customer: extension, renewal, or upsell. This ADDS "
        "amount to their total contract_value. If they paid some of it right now, pass paid_now "
        "and that cash is logged as a payment too; what's unpaid becomes outstanding. ALWAYS ask "
        "'did they pay any of it now?' if the user didn't say, BEFORE confirming. "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "customer_id": {"type": "string", "description": "From find_customer"},
        "amount": {"type": "number", "description": "The committed amount to ADD to the contract"},
        "kind": {"type": "string", "enum": ["extension", "renewal", "upsell"]},
        "paid_now": {"type": "number", "description": "Cash collected right now against this commitment, 0 if none"},
        "note": {"type": "string"},
        "confirmed": {"type": "boolean"},
    }, "required": ["customer_id", "amount", "kind", "confirmed"]},
}

TOOL_LOG_ACTIVITY = {
    "name": "log_daily_activity",
    "description": (
        "Log daily outreach volume (outreaches / dials / conversations) for today (or a given date). "
        "If a row already exists for that day it is updated. A setter can only log their OWN activity; "
        "the owner can pass member_name to log for someone. "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "outreaches": {"type": "integer"},
        "dials": {"type": "integer"},
        "conversations": {"type": "integer"},
        "followups_outreach": {"type": "integer",
                               "description": "follow-ups on outreaches; if the member didn't give it, pass 0 — never block on it"},
        "followups_dials": {"type": "integer",
                            "description": "follow-ups on dials (re-dialing leads who didn't pick up); if not given, pass 0 — never block on it"},
        "pickups": {"type": "integer",
                    "description": "how many dials actually connected / were answered; if not given, pass 0 — never block on it"},
        "mode": {"type": "string", "enum": ["set", "add"],
                 "description": "'set' (default) replaces the day's numbers; 'add' adds ON TOP — use when they say 'X more' after already logging today"},
        "note": {"type": "string"},
        "activity_date": {"type": "string", "description": "YYYY-MM-DD, defaults to today"},
        "member_name": {"type": "string", "description": "OWNER ONLY: which team member this is for"},
        "confirmed": {"type": "boolean"},
    }, "required": ["confirmed"]},
}

TOOL_SET_REMINDER = {
    "name": "set_reminder",
    "description": (
        "OWNER ONLY: change a team member's daily reminder. Pass only what changes: hour/minute "
        "(24h, in the member's reminder timezone), tz (IANA zone like 'America/New_York' or "
        "'Europe/Stockholm' — only when the owner names a place), enabled (false = turn the "
        "reminder off). '8pm New York' = hour 20 + tz America/New_York; '9pm' = hour 21, keep tz. "
        "ONLY call with confirmed=true after the user said yes to your one-line summary."
    ),
    "input_schema": {"type": "object", "properties": {
        "member_name": {"type": "string"},
        "hour": {"type": "integer", "description": "0-23 in the member's reminder tz"},
        "minute": {"type": "integer"},
        "tz": {"type": "string", "description": "IANA timezone, only when a place/zone was named"},
        "enabled": {"type": "boolean"},
        "confirmed": {"type": "boolean"},
    }, "required": ["member_name", "confirmed"]},
}

ROLE_TOOLS = {
    "closer": [TOOL_FIND_LEAD, TOOL_PENDING_CALLS, TOOL_LOG_OUTCOME, TOOL_FIND_CUSTOMER,
               TOOL_SCHEDULE_PAYMENT, TOOL_MY_NUMBERS],
    "setter": [TOOL_LOG_ACTIVITY, TOOL_MY_NUMBERS],
    "owner": [TOOL_FIND_LEAD, TOOL_PENDING_CALLS, TOOL_LOG_OUTCOME, TOOL_FIND_CUSTOMER,
              TOOL_CREATE_CUSTOMER, TOOL_LOG_PAYMENT, TOOL_LOG_COMMITMENT, TOOL_LOG_ACTIVITY,
              TOOL_SCHEDULE_PAYMENT, TOOL_SET_REMINDER],
}


# ════════════════════════════════════════════════════════════════════
# Tool execution
# ════════════════════════════════════════════════════════════════════

def _get_lead(lead_id: str) -> dict | None:
    """Re-fetch the lead by id — never trust model-passed lead fields."""
    res = (
        get_supabase_client().table("leads")
        .select("id, full_name, ghl_contact_id, ghl_opportunity_id, stage")
        .eq("id", lead_id).limit(1).execute()
    )
    return res.data[0] if res.data else None


def _get_customer(customer_id: str) -> dict | None:
    res = (
        get_supabase_client().table("customers")
        .select("id, name, lead_id, ghl_contact_id, contract_value, currency")
        .eq("id", customer_id).limit(1).execute()
    )
    return res.data[0] if res.data else None


def _resolve_activity_member(tool_input: dict, role: str, member: dict) -> dict | None:
    """A setter is locked to themselves; the owner picks by member_name."""
    if role == "setter":
        return member
    name = (tool_input.get("member_name") or "").strip()
    if not name:
        return None
    res = (
        get_supabase_client().table("team_members")
        .select("id, name, role")
        .eq("active", True).ilike("name", f"%{name}%").limit(2).execute()
    )
    rows = res.data or []
    return rows[0] if len(rows) == 1 else None


def execute_capture_tool(tool_name: str, tool_input: dict, role: str,
                         member: dict, logged_by: str) -> dict:
    """Execute one capture tool with role enforcement. Never raises."""
    allowed = {t["name"] for t in ROLE_TOOLS[role]}
    if tool_name not in allowed:
        return {"error": f"Tool {tool_name} is not available for role {role}."}

    try:
        if tool_name == "find_lead":
            return {"result": find_lead_by_name(tool_input["name"])}

        if tool_name == "list_pending_calls":
            return {"result": list_pending_calls()}

        if tool_name == "my_numbers":
            if role == "closer":
                return {"result": get_closer_numbers(member["name"])}
            if role == "setter":
                return {"result": get_member_activity(member["id"], days=14)}
            return {"error": "my_numbers is for team members; the owner has full reporting instead."}

        if tool_name == "log_call_outcome":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            lead = _get_lead(tool_input["lead_id"])
            if not lead:
                return {"error": f"No lead found with id {tool_input['lead_id']} — use find_lead first."}
            outcome = tool_input["outcome"]
            if outcome == "closed":
                if tool_input.get("contract_value") is None:
                    return {"error": "closed needs contract_value (ask the user)."}
                terms_items = None
                terms_text = (tool_input.get("payment_terms") or "").strip()
                if terms_text:
                    from telegram_bot.capture_flows import parse_payment_terms
                    parsed = parse_payment_terms(terms_text)
                    if not parsed["ok"]:
                        return {"error": f"payment_terms unclear: {parsed['error']}"}
                    terms_items = parsed["items"]
                duration = tool_input.get("call_duration_minutes")
                return log_close(
                    lead,
                    contract_value=float(tool_input["contract_value"]),
                    collected_today=float(tool_input.get("collected_today") or 0),
                    closer_name=logged_by,
                    note=tool_input.get("note"),
                    payment_terms=terms_items,
                    call_duration_minutes=int(duration) if duration is not None else None,
                )
            if outcome == "no_show":
                return log_no_show(lead, logged_by)
            if outcome == "showed_not_pitched":
                reason = (tool_input.get("reason") or "").strip()
                if not reason:
                    return {"error": "showed_not_pitched needs the specific reason (ask why he wasn't pitched)."}
                return log_showed_not_pitched(lead, logged_by, reason)
            if outcome == "showed_no_close":
                reason = (tool_input.get("reason") or "").strip()
                if not reason:
                    return {"error": "showed_no_close needs the specific reason (ask why he didn't close)."}
                return log_showed_no_close(lead, logged_by, reason=reason)
            return {"error": f"unknown outcome '{outcome}'"}

        if tool_name == "find_customer":
            return {"result": find_customer_by_name(tool_input["name"])}

        if tool_name == "create_customer":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            lead = _get_lead(tool_input["lead_id"]) if tool_input.get("lead_id") else None
            return create_customer(
                name=tool_input["name"],
                contract_value=float(tool_input["contract_value"]),
                logged_by=logged_by,
                lead=lead,
                first_payment=float(tool_input.get("first_payment") or 0),
                closer=tool_input.get("closer"),
                note=tool_input.get("note"),
            )

        if tool_name == "log_payment":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            customer = _get_customer(tool_input["customer_id"])
            if not customer:
                return {"error": f"No customer with id {tool_input['customer_id']} — use find_customer first."}
            return log_payment(
                customer,
                amount=float(tool_input["amount"]),
                kind=tool_input["kind"],
                logged_by=logged_by,
                note=tool_input.get("note"),
            )

        if tool_name == "log_commitment":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            customer = _get_customer(tool_input["customer_id"])
            if not customer:
                return {"error": f"No customer with id {tool_input['customer_id']} — use find_customer first."}
            return log_commitment(
                customer,
                amount=float(tool_input["amount"]),
                kind=tool_input["kind"],
                logged_by=logged_by,
                paid_now=float(tool_input.get("paid_now") or 0),
                note=tool_input.get("note"),
            )

        if tool_name == "schedule_payment":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            customer = _get_customer(tool_input["customer_id"])
            if not customer:
                return {"error": f"No customer with id {tool_input['customer_id']} — use find_customer first."}
            from telegram_bot.capture_flows import create_scheduled_payments
            rows = create_scheduled_payments(
                customer["id"],
                [{"amount": float(tool_input["amount"]),
                  "due_date": tool_input["due_date"],
                  "note": tool_input.get("note")}],
                created_by=logged_by,
            )
            if not rows:
                return {"error": "scheduling failed — nothing written"}
            return {"success": True,
                    "detail": f"Scheduled ${float(tool_input['amount']):,.0f} from "
                              f"{customer.get('name')} on {tool_input['due_date']} — "
                              f"{OWNER_NAME} gets reminded that day."}

        if tool_name == "log_daily_activity":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            target = _resolve_activity_member(tool_input, role, member)
            if not target:
                return {"error": "Which team member is this for? (member_name didn't match exactly one person)"}
            return log_team_activity(
                member_id=target["id"],
                member_name=target["name"],
                outreaches=tool_input.get("outreaches"),
                dials=tool_input.get("dials"),
                conversations=tool_input.get("conversations"),
                followups_outreach=tool_input.get("followups_outreach"),
                followups_dials=tool_input.get("followups_dials"),
                pickups=tool_input.get("pickups"),
                note=tool_input.get("note"),
                activity_date=tool_input.get("activity_date"),
                mode=tool_input.get("mode") or "set",
            )

        if tool_name == "set_reminder":
            if tool_input.get("confirmed") is not True:
                return {"error": NOT_CONFIRMED_ERROR}
            from telegram_bot.team_identity import set_member_reminder
            return set_member_reminder(
                tool_input["member_name"],
                hour=tool_input.get("hour"),
                minute=tool_input.get("minute"),
                tz=tool_input.get("tz"),
                enabled=tool_input.get("enabled"),
            )

        return {"error": f"Unknown tool: {tool_name}"}

    except Exception as e:
        console.print_exception()
        return {"error": f"{tool_name} failed: {str(e)}"}


# ════════════════════════════════════════════════════════════════════
# System prompts per role
# ════════════════════════════════════════════════════════════════════

CONFIRM_BLOCK = """**CONFIRM BEFORE EVERY WRITE (non-negotiable):**
1. Gather what's missing by asking SHORT questions (one line each).
2. Before writing, show ONE line summarizing exactly what you'll log, e.g.
   "Logging: John Smith — closed — $6k contract — $3k collected today. Yes?"
3. Only after the user explicitly says yes do you call the tool with confirmed=true.
   If they say no or correct something, adjust and re-confirm.
4. NEVER set confirmed=true on the first call. The tools will refuse anyway."""

CLOSER_PROMPT = f"""You are Jarvis, the assistant for {{name}} — the CLOSER on {OWNER_NAME}'s team ({BUSINESS_NAME}).

You do EXACTLY four things for him, nothing else:
1. Record call outcomes. Find the lead with find_lead (if several match, ask which). Walk the tree:
   - Did the lead SHOW? If not → outcome 'no_show'.
   - If he showed, did you PITCH? If not (unqualified) → outcome 'showed_not_pitched' and ASK "why didn't you pitch him? Be specific." Put his exact words in reason.
   - If he pitched, did he CLOSE? If not → outcome 'showed_no_close' and ASK "why didn't he close? What was the real reason? Be specific." Put his exact words in reason.
   - If he closed → outcome 'closed': needs total contract value, cash collected today, and call_duration_minutes ("how long was the call, in minutes?"). Amounts like "6k" mean 6000 USD.
   ON A CLOSE where cash collected < contract value: ALSO ask "was that a PIF or split pay? If split — what's left and when?" Put the answer in payment_terms (e.g. "1.5k in 40 days"); each part becomes a scheduled collection that reminds {OWNER_NAME} on its due date. If PIF, omit payment_terms.
   NEVER skip the reason on showed_not_pitched / showed_no_close — that's the whole point: {OWNER_NAME} needs the specific why in your words, not "disqualified".
2. "Which calls need outcomes" → list_pending_calls.
3. Add or fix payment terms later → find_customer + schedule_payment ("the rest of John's is due July 20").
4. His own numbers → my_numbers.

{CONFIRM_BLOCK}

If he asks for anything else — business reports, banning leads, the AI setter, other people's numbers — politely decline in one line: that's owner-only, ask {OWNER_NAME}.

Voice: sharp, warm, short. Plain text only (this is Telegram)."""

SETTER_PROMPT = f"""You are Jarvis, the assistant for {{name}} — the SETTER on {OWNER_NAME}'s team ({BUSINESS_NAME}).

You do EXACTLY two things for him, nothing else:
1. Log his daily volume — FIVE numbers: outreaches, follow-ups on outreaches, dials, follow-ups on dials (re-dialing leads who didn't pick up), and pickups (dials that actually connected) — e.g. "40 outreaches, 10 outreach follow-ups, 15 dials, 5 dial follow-ups, 6 pickups", or just "40 and 15" when replying to the end-of-day question (first number is outreaches, second is dials). If any of the follow-ups or pickups are missing, ask ONCE for the missing ones in the same confirmation — if he doesn't give a number or says none, log them as 0 and proceed; NEVER block the log on them. A fresh total REPLACES the day's numbers (mode="set").
   TOP-UP: if he says he did MORE on top ("outreached 2 more today", "another 5 dials", "2 more dial follow-ups") use mode="add" so it's ADDED to today's row, not replaced. First call my_numbers to see today's current total, then confirm the RESULTING total before logging, e.g. "Today is now 42 outreaches, 10 outreach follow-ups, 15 dials, 5 dial follow-ups, 6 pickups. Yes?".
2. His own recent numbers → my_numbers.

{CONFIRM_BLOCK}

If he asks for anything else — reports, leads, the AI, other people's numbers — politely decline in one line: that's owner-only, ask {OWNER_NAME}.

Voice: sharp, warm, short. Plain text only (this is Telegram)."""

OWNER_PROMPT = f"""You are Jarvis, logging business results for {OWNER_NAME} (the owner).

**THE ONE RULE OF MONEY — commitments vs cash:**
- A COMMITMENT (signed / closed / extended / renewed / upsold) RAISES the customer's total contract_value.
- CASH (collected / paid / installment / refund) only logs a payment — the contract NEVER changes.
- One sentence can be both: "extended for 2k and paid 1k now" = +2000 contract AND a 1000 payment.

What you can log for him:
- Call outcomes (same flow his closer uses): find_lead → confirm → log_call_outcome.
- New signings: "John signed for 6k, paid 2k today" → create_customer (contract 6000, first_payment 2000). If they exist as a lead, link with find_lead. If a CUSTOMER by that name already exists, that's not a new signing — it's a renewal: use log_commitment.
- Commitments on existing customers: "extended for 2k" / "renewed 2k" / "upsell 1k" → find_customer → log_commitment (ADDS to the contract). If {OWNER_NAME} didn't say whether any of it was paid now, ASK "did he pay any of it now?" — then paid_now logs that cash too; unpaid becomes outstanding.
- Cash on existing customers: "collected 3k from John" = log_payment kind installment · "refund 500" = log_payment kind refund (auto-negative). Contract untouched. If the customer doesn't exist, offer to create them. Logging cash that matches an open scheduled collection ticks that collection off automatically.
- Split-pay collections: on a close where collected < contract, ask PIF or split and capture the terms (payment_terms on log_call_outcome). Standalone: "remind me to collect 1.5k from John on July 20" → find_customer + schedule_payment. {OWNER_NAME} gets a Telegram reminder on each due date.
- Team activity: "log 40 outreaches for Isaiah" → log_daily_activity with member_name ("2 more" on top of an existing day → mode="add").
- Daily reminders: "set Ethan's reminder to 8pm New York" → set_reminder(hour 20, tz America/New_York) · "set Isaiah's reminder to 9pm" → hour 21 only, keep his timezone · "turn off Isaiah's reminder" → enabled false.

Amounts like "6k" mean 6000 USD. Default currency USD.

{CONFIRM_BLOCK}

**Your confirmation line must state BOTH effects (contract and cash), e.g.:**
- "Adds $2k to John's contract (now $8k) and logs $1k collected today. Yes?"
- "Adds $2k to John's contract (now $8k), nothing paid yet — $2k more outstanding. Yes?"
- "Logs $3k collected from John (cash only, contract unchanged). Yes?"
- "Logs a $500 refund to John (cash only, contract unchanged). Yes?"

Voice: sharp, warm, short. Plain text only (this is Telegram)."""

ROLE_PROMPTS = {"closer": CLOSER_PROMPT, "setter": SETTER_PROMPT, "owner": OWNER_PROMPT}


# ════════════════════════════════════════════════════════════════════
# Entry point
# ════════════════════════════════════════════════════════════════════

def handle_capture_request(user_message: str, conversation_history: list,
                           role: str, member: dict | None) -> str:
    """
    Run the capture agent for one message.

    Args:
        user_message: the incoming text
        conversation_history: recent [{"role","content"}] (the confirmation
            flow lives in this history)
        role: "owner" | "closer" | "setter"
        member: team_members row for closer/setter, None for owner
    """
    if role not in ROLE_TOOLS:
        return f"I don't recognize you. Ask {OWNER_NAME} for an access code."

    member = member or {"id": None, "name": OWNER_NAME, "role": "owner"}
    logged_by = OWNER_NAME if role == "owner" else member["name"]

    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    system_prompt = ROLE_PROMPTS[role].format(name=member.get("name", OWNER_NAME))

    # Owner-neutral: swap any default-owner mentions in tool descriptions.
    tools = [
        {**t, "description": t["description"].replace("Maher", OWNER_NAME)}
        if isinstance(t.get("description"), str) else t
        for t in ROLE_TOOLS[role]
    ]

    messages = []
    for msg in (conversation_history or [])[-10:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_message})

    for _turn in range(8):
        try:
            response = client.messages.create(
                model=MODEL_HEAVY,
                max_tokens=1500,
                system=system_prompt,
                messages=messages,
                tools=tools,
            )
        except Exception as e:
            console.log(f"[red]✗ capture agent API call failed: {e}[/red]")
            return f"Couldn't process that right now — {type(e).__name__}. Try again in a minute."

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    console.log(f"[cyan]Capture tool ({role}): {block.name}({block.input})[/cyan]")
                    result = execute_capture_tool(block.name, block.input or {}, role, member, logged_by)
                    console.log(f"[dim]Result: {str(result)[:400]}[/dim]")
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

    return "That took too many steps — say it again in one message and I'll log it."
