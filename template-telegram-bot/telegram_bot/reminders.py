"""
PROACTIVE REMINDERS — Jarvis speaks first.

Runs on the existing APScheduler (run.py) every 10 minutes and does two jobs:

1. DAILY ROLE REMINDERS (run_reminder_tick)
   For each registered, reminder_enabled team member: if the member's LOCAL
   time (reminder_tz) is at/past reminder_hour:reminder_minute today and
   last_reminder_date is before today → send their role reminder and stamp
   last_reminder_date (member-local today). Never double-sends in a day.
     - closer: his pending calls, one message per call with tap-to-log buttons
       (handled by handle_outcome_callback in bot.py).
     - setter: end-of-day nudge for outreaches/dials; his typed reply flows
       through the normal capture agent (team_activity upsert, and "2 more"
       adds on top).

2. PER-CALL FOLLOW-UPS for closers (run_closer_call_followups)
   Reads today's GHL calendar appointments (Stockholm-day window) and, 30
   minutes after each call's start time, sends the closer that lead's
   outcome buttons. De-duped via a 'call_followup_prompted' event per GHL
   appointment id, and skipped once the lead has a recorded outcome.

Telegram sends use the raw Bot API over HTTPS (same pattern as
telegram_bot/notifier.py) so they're thread-safe from APScheduler — no
asyncio, never raises. All writes go through the existing capture functions;
this module itself only sends messages and stamps reminder/dedupe state.
"""

import os
import json
from datetime import datetime, timedelta, timezone, date
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
import requests
from rich.console import Console

from telegram_bot.setter_control import (
    get_supabase_client,
    get_ghl_creds,
    get_ghl_headers,
    GHL_BASE_URL,
)
from telegram_bot.capture_flows import (
    CLIENT_ID,
    BUSINESS_TZ,
    OUTCOME_EVENT_TYPES,
    CALL_GRACE_MINUTES,
    list_pending_calls,
    _fetch_appointments,
    _parse_ghl_time,
)

console = Console()

# Don't flood a closer with more than this many pending-call messages per day.
MAX_PENDING_MESSAGES = 10

OUTCOME_KEYBOARD = {
    "inline_keyboard": [
        [{"text": "✅ Showed up", "callback_data": "oc:showed:{lead_id}"}],
        [{"text": "🚫 No-show", "callback_data": "oc:ns:{lead_id}"}],
        [{"text": "⏳ Not yet", "callback_data": "oc:skip:{lead_id}"}],
    ]
}


def _outcome_keyboard(lead_id: str) -> dict:
    return {
        "inline_keyboard": [
            [{"text": btn["text"], "callback_data": btn["callback_data"].format(lead_id=lead_id)}]
            for row in OUTCOME_KEYBOARD["inline_keyboard"] for btn in row
        ]
    }


def send_telegram_to(chat_id, text: str, reply_markup: Optional[dict] = None) -> bool:
    """Raw Bot-API send to ANY chat (notifier.py only reaches Maher). Never raises."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token or not chat_id or not text:
        return False
    payload = {"chat_id": str(chat_id), "text": text}
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage", json=payload, timeout=15
        )
        if not resp.ok:
            console.log(f"[yellow]⚠ reminder send failed ({chat_id}): {resp.status_code} {resp.text[:200]}[/yellow]")
            return False
        return True
    except Exception as e:
        console.log(f"[yellow]⚠ reminder send error ({chat_id}): {type(e).__name__}: {e}[/yellow]")
        return False


# ════════════════════════════════════════════════════════════════════
# 1. Daily role reminders
# ════════════════════════════════════════════════════════════════════

def is_member_due(member: dict, now_utc: datetime) -> bool:
    """
    Pure due-check: registered + enabled + member-local time at/past their
    reminder time today + not already reminded today (member-local date).
    """
    if not member.get("telegram_chat_id") or not member.get("reminder_enabled"):
        return False
    if member.get("reminder_hour") is None:
        return False
    try:
        tz = ZoneInfo(member.get("reminder_tz") or "Europe/Stockholm")
    except Exception:
        console.log(f"[yellow]⚠ bad reminder_tz for {member.get('name')}: {member.get('reminder_tz')}[/yellow]")
        return False

    local_now = now_utc.astimezone(tz)
    due_minutes = int(member["reminder_hour"]) * 60 + int(member.get("reminder_minute") or 0)
    now_minutes = local_now.hour * 60 + local_now.minute
    if now_minutes < due_minutes:
        return False

    last = member.get("last_reminder_date")
    if last:
        last_date = date.fromisoformat(last) if isinstance(last, str) else last
        if last_date >= local_now.date():
            return False  # already sent today
    return True


def get_due_members(members: list[dict], now_utc: datetime) -> list[dict]:
    return [m for m in members if is_member_due(m, now_utc)]


def _first_name(full: str) -> str:
    return (full or "").split()[0] if full else "there"


def send_closer_reminder(member: dict) -> bool:
    """Daily safety-net sweep: every call still needing an outcome, one
    tap-to-log message each. Zero calls → send NOTHING (Maher's call)."""
    chat_id = member["telegram_chat_id"]
    try:
        pending = list_pending_calls()
    except Exception as e:
        console.log(f"[red]✗ pending-calls fetch failed: {e}[/red]")
        return False

    if not pending:
        return True  # nothing to log → stay silent, still counts as done today

    name = _first_name(member.get("name"))
    ok = send_telegram_to(
        chat_id,
        f"{name} — {len(pending)} call(s) waiting on an outcome. Tap one button per call:",
    )
    for call in pending[:MAX_PENDING_MESSAGES]:
        lead_name = call.get("full_name") or "Unknown"
        sent = send_telegram_to(
            chat_id,
            f"📞 {lead_name} — how did it go?",
            reply_markup=_outcome_keyboard(call["id"]),
        )
        ok = ok and sent
    if len(pending) > MAX_PENDING_MESSAGES:
        send_telegram_to(chat_id, f"...and {len(pending) - MAX_PENDING_MESSAGES} more — they'll resurface tomorrow.")
    return ok


def send_setter_reminder(member: dict) -> bool:
    """End-of-day volume nudge. The typed reply flows through the capture agent."""
    chat_id = member["telegram_chat_id"]
    text = (
        f"End of day, {_first_name(member.get('name'))}. How many today? "
        f"Reply with your outreaches, follow-ups on outreaches, dials, follow-ups on dials, and pickups "
        f"(e.g. \"40 outreaches, 10 outreach follow-ups, 15 dials, 5 dial follow-ups, 6 pickups\").\n"
        f"If you do more later, just tell me — \"outreached 2 more\" — and I'll add it on top."
    )
    sent = send_telegram_to(chat_id, text)
    if sent:
        # Put the question in his conversation history so "40 and 15" has context.
        try:
            from telegram_bot.bot import add_to_conversation
            add_to_conversation(int(chat_id), "assistant", text)
        except Exception:
            pass
    return sent


def _stamp_last_reminder(member: dict, local_today: date):
    supabase = get_supabase_client()
    supabase.table("team_members").update(
        {"last_reminder_date": local_today.isoformat()}
    ).eq("id", member["id"]).execute()


def run_reminder_tick(now_utc: Optional[datetime] = None) -> dict:
    """The every-10-min scheduler job. Never raises."""
    now_utc = now_utc or datetime.now(timezone.utc)
    summary = {"checked": 0, "sent": 0, "errors": 0}
    try:
        members = (
            get_supabase_client().table("team_members")
            .select("id, name, role, telegram_chat_id, reminder_enabled, "
                    "reminder_hour, reminder_minute, reminder_tz, last_reminder_date")
            .eq("active", True)
            .execute()
        ).data or []
    except Exception as e:
        console.log(f"[red]✗ reminder tick: member fetch failed: {e}[/red]")
        summary["errors"] += 1
        return summary

    summary["checked"] = len(members)
    for member in get_due_members(members, now_utc):
        try:
            if member["role"] == "closer":
                sent = send_closer_reminder(member)
            elif member["role"] == "setter":
                sent = send_setter_reminder(member)
            else:
                continue
            if sent:
                tz = ZoneInfo(member.get("reminder_tz") or "Europe/Stockholm")
                _stamp_last_reminder(member, now_utc.astimezone(tz).date())
                summary["sent"] += 1
                console.log(f"[green]✓ reminder sent to {member['name']} ({member['role']})[/green]")
        except Exception as e:
            summary["errors"] += 1
            console.log(f"[red]✗ reminder for {member.get('name')} failed: {e}[/red]")
    return summary


# ════════════════════════════════════════════════════════════════════
# Collections: remind the OWNER when a split-pay installment is due
# ════════════════════════════════════════════════════════════════════

def run_collections_check(now_utc: Optional[datetime] = None) -> dict:
    """
    Scheduled split-pay collections whose due_date has arrived → DM Maher
    ("time to collect $1.5k from John"), then mark the row 'reminded' so it
    fires once. Logging the matching payment marks it 'collected'
    (log_payment auto-match). Never raises.
    """
    from telegram_bot.notifier import send_telegram  # raw-HTTP send to Maher

    now_utc = now_utc or datetime.now(timezone.utc)
    today = now_utc.astimezone(BUSINESS_TZ).date().isoformat()
    summary = {"due": 0, "reminded": 0, "errors": 0}
    try:
        supabase = get_supabase_client()
        due_rows = (
            supabase.table("scheduled_payments")
            .select("id, customer_id, amount, currency, due_date, note")
            .eq("status", "pending")
            .lte("due_date", today)
            .order("due_date")
            .execute()
        ).data or []
        summary["due"] = len(due_rows)
        if not due_rows:
            return summary

        # Names for the message
        customer_ids = list({r["customer_id"] for r in due_rows if r.get("customer_id")})
        names = {}
        if customer_ids:
            rows = (
                supabase.table("customers").select("id, name")
                .in_("id", customer_ids).execute()
            ).data or []
            names = {r["id"]: r["name"] for r in rows}

        for r in due_rows:
            try:
                who = names.get(r.get("customer_id"), "a customer")
                note = f" ({r['note']})" if r.get("note") else ""
                overdue = " (was due " + r["due_date"] + ")" if r["due_date"] < today else ""
                sent = send_telegram(
                    f"💰 Collection due: ${float(r['amount']):,.0f} from {who}{note}{overdue}.\n"
                    f"Once it's in, tell me \"collected {float(r['amount']):g} from {who}\" and I'll tick it off."
                )
                if sent:
                    supabase.table("scheduled_payments").update(
                        {"status": "reminded", "reminded_at": now_utc.isoformat()}
                    ).eq("id", r["id"]).execute()
                    summary["reminded"] += 1
            except Exception as inner:
                summary["errors"] += 1
                console.log(f"[red]✗ collection reminder {r.get('id')} failed: {inner}[/red]")
    except Exception as e:
        summary["errors"] += 1
        console.log(f"[red]✗ collections check failed: {type(e).__name__}: {e}[/red]")
    return summary


# ════════════════════════════════════════════════════════════════════
# Weekly follower ask (owner, Monday 08:00 Stockholm)
# ════════════════════════════════════════════════════════════════════

FOLLOWER_ASK_EVENT = "follower_ask"


def run_follower_ask(now_utc: Optional[datetime] = None) -> dict:
    """
    Every Monday from 08:00 Europe/Stockholm, DM the owner ONCE:
    "How many IG followers did we gain last week?". Deduped per week via a
    follower_ask event; skipped entirely if last week's count is already in
    follower_counts (the owner can volunteer it anytime). Never raises.
    """
    from telegram_bot.capture_flows import CLIENT_ID
    from telegram_bot.notifier import send_telegram

    now_utc = now_utc or datetime.now(timezone.utc)
    local = now_utc.astimezone(BUSINESS_TZ)
    summary = {"asked": 0, "skipped": 0, "errors": 0}

    if local.weekday() != 0 or local.hour < 8:
        return summary  # only Mondays, from 08:00 Stockholm

    this_monday = local.date().isoformat()
    last_monday = (local.date() - timedelta(days=7)).isoformat()

    try:
        supabase = get_supabase_client()

        # Already recorded? Then there is nothing to ask.
        have = (
            supabase.table("follower_counts")
            .select("id").eq("week_start", last_monday).limit(1).execute()
        ).data
        if have:
            summary["skipped"] += 1
            return summary

        # Already asked this Monday? (dedupe via the follower_ask event)
        asked = (
            supabase.table("events")
            .select("metadata")
            .eq("event_type", FOLLOWER_ASK_EVENT)
            .order("created_at", desc=True)
            .limit(3)
            .execute()
        ).data or []
        if any((r.get("metadata") or {}).get("week_asked") == this_monday for r in asked):
            summary["skipped"] += 1
            return summary

        text = (
            "📈 Monday check-in: how many IG followers did we gain last week?\n"
            "Reply like \"we gained 120 followers last week\" and I'll log it."
        )
        if not send_telegram(text):
            summary["errors"] += 1
            return summary  # not deduped → retries next tick

        supabase.table("events").insert({
            "event_type": FOLLOWER_ASK_EVENT,
            "lead_id": None,
            "client_id": CLIENT_ID,
            "metadata": {"week_asked": this_monday, "week_for": last_monday,
                         "source": "human_capture"},
        }).execute()
        summary["asked"] += 1

        # Put the question in the owner's conversation history so a bare-number
        # reply routes with context.
        try:
            from telegram_bot.team_identity import OWNER_CHAT_ID
            from telegram_bot.bot import add_to_conversation
            add_to_conversation(OWNER_CHAT_ID, "assistant", text)
        except Exception:
            pass
    except Exception as e:
        summary["errors"] += 1
        console.log(f"[red]✗ follower ask failed: {type(e).__name__}: {e}[/red]")
    return summary


# ════════════════════════════════════════════════════════════════════
# 2. Per-call follow-ups (closer, +30 min after each GHL appointment)
#    Dedup via the call_reminders table (ghl_appointment_id PK): a given call
#    is pinged exactly once. Appointment fetch + time parsing are reused from
#    capture_flows (single source of truth). Times shown in UK time (Ethan).
# ════════════════════════════════════════════════════════════════════

UK_TZ = ZoneInfo("Europe/London")
CALL_LOOKBACK_HOURS = 24  # how far back to scan for un-reminded calls


def run_closer_call_followups(now_utc: Optional[datetime] = None) -> dict:
    """
    For each of the closer's GHL appointments that started at least
    CALL_GRACE_MINUTES (30) ago, whose lead is a real prospect still in
    'Appointment Booked' (no outcome logged), and whose appointment is NOT yet
    in the call_reminders table → DM the closer that call's outcome buttons
    (time shown in UK time) and insert a call_reminders row so it's pinged
    once, ever. Never raises.
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    summary = {"appointments": 0, "prompted": 0, "skipped": 0, "errors": 0}
    try:
        supabase = get_supabase_client()

        closers = (
            supabase.table("team_members")
            .select("id, name, telegram_chat_id")
            .eq("active", True).eq("role", "closer")
            .not_.is_("telegram_chat_id", "null")
            .execute()
        ).data or []
        if not closers:
            return summary

        window_start = now_utc - timedelta(hours=CALL_LOOKBACK_HOURS)
        appointments = _fetch_appointments(
            int(window_start.timestamp() * 1000), int(now_utc.timestamp() * 1000)
        )
        summary["appointments"] = len(appointments)
        if not appointments:
            return summary

        # Eligible = call started >= 30 min ago, live status, has a contact.
        cutoff = now_utc - timedelta(minutes=CALL_GRACE_MINUTES)
        eligible = []
        for appt in appointments:
            appt_id = appt.get("id")
            contact_id = appt.get("contactId")
            start = _parse_ghl_time(appt.get("startTime"))
            status = (appt.get("appointmentStatus") or "").lower()
            if not appt_id or not contact_id or not start:
                continue
            if status in ("cancelled", "noshow", "invalid"):
                summary["skipped"] += 1
                continue
            if start > cutoff:
                continue  # call not 30-min old yet — a later tick will catch it
            eligible.append({"id": appt_id, "contact_id": contact_id, "start": start})
        if not eligible:
            return summary

        # Leads still pending an outcome (real prospect, 'Appointment Booked').
        pending_ids = {r["id"] for r in list_pending_calls(exclude_upcoming=False)}

        # Map the eligible appointments' contacts to leads.
        contact_ids = list({e["contact_id"] for e in eligible})
        lead_rows = (
            supabase.table("leads")
            .select("id, full_name, ghl_contact_id")
            .in_("ghl_contact_id", contact_ids)
            .execute()
        ).data or []
        lead_by_contact = {r["ghl_contact_id"]: r for r in lead_rows}

        # Appointments already reminded (call_reminders PK = ghl_appointment_id).
        reminded_rows = (
            supabase.table("call_reminders")
            .select("ghl_appointment_id")
            .in_("ghl_appointment_id", [e["id"] for e in eligible])
            .execute()
        ).data or []
        already = {r["ghl_appointment_id"] for r in reminded_rows}

        for e in eligible:
            try:
                if e["id"] in already:
                    summary["skipped"] += 1
                    continue
                lead = lead_by_contact.get(e["contact_id"])
                if not lead or lead["id"] not in pending_ids:
                    summary["skipped"] += 1   # no lead, or outcome already logged
                    continue

                uk_time = e["start"].astimezone(UK_TZ).strftime("%H:%M")
                sent_any = False
                for closer in closers:
                    sent = send_telegram_to(
                        closer["telegram_chat_id"],
                        f"📞 Your {uk_time} call with {lead.get('full_name') or 'Unknown'} — how did it go?",
                        reply_markup=_outcome_keyboard(lead["id"]),
                    )
                    sent_any = sent_any or sent

                if sent_any:
                    supabase.table("call_reminders").insert({
                        "ghl_appointment_id": e["id"],
                        "lead_id": lead["id"],
                        "ghl_contact_id": e["contact_id"],
                        "call_at": e["start"].isoformat(),
                        "reminded_at": now_utc.isoformat(),
                    }).execute()
                    summary["prompted"] += 1
            except Exception as inner:
                summary["errors"] += 1
                console.log(f"[red]✗ call follow-up for appt {e.get('id')} failed: {inner}[/red]")

    except Exception as e:
        summary["errors"] += 1
        console.log(f"[red]✗ call follow-ups failed: {type(e).__name__}: {e}[/red]")
    return summary
