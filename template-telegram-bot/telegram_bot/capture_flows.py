"""
CAPTURE FLOWS — the write primitives for the human capture layer.

These log what GHL never sees: call outcomes, cash collected, and daily
outreach volume. Every function here is called by the capture agent ONLY
after the user confirmed a one-line summary (enforced in capture_agent).

Writes go to: customers, payments, events, team_activity (Supabase) and the
lead's GHL opportunity stage (exact stage names "Client Won",
"No Show - Re-Nurture", "Lead Lost"). Reporting stays read-only — money is
read back through the reporting_money view.

GHL stage moves reuse the same auth + pipeline plumbing as the rest of the
bot (get_ghl_creds/get_ghl_headers/AI_SALES_PIPELINE_ID) and the stage-map
fetch pattern from the pipeline watcher. A failed GHL move never blocks the
Supabase writes — it's reported back so the user knows to fix GHL by hand.
After a successful move we update leads.stage to the new name (last-known-
state, same as the watcher) so the watcher doesn't double-log the milestone.
"""

import os
from datetime import datetime, timezone, date, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
from rich.console import Console

from telegram_bot.owner import OWNER_NAME
from telegram_bot.setter_control import (
    get_supabase_client,
    get_ghl_creds,
    get_ghl_headers,
    GHL_BASE_URL,
    AI_SALES_PIPELINE_ID,
)

console = Console()

# The owner's client row UUID in Supabase (clients.id). Comes from the env so
# each buyer can drop in their own without touching code.
CLIENT_ID = os.getenv("OWNER_CLIENT_ID", "")

# The owner's business timezone — "today" for activity logging.
BUSINESS_TZ = ZoneInfo(os.getenv("OWNER_TIMEZONE", "UTC"))

STAGE_CLIENT_WON = "Client Won"
STAGE_NO_SHOW = "No Show - Re-Nurture"
STAGE_LEAD_LOST = "Lead Lost"
STAGE_DISQUALIFIED = "Disqualified"

# Events that mean a booked call already has a recorded outcome
OUTCOME_EVENT_TYPES = ("deal_won", "call_no_show", "deal_lost")

# COMMITMENTS raise customers.contract_value (the total the client signed for);
# CASH kinds only log a payment and NEVER touch the contract.
COMMITMENT_KINDS = ("extension", "renewal", "upsell")
CASH_PAYMENT_KINDS = ("installment", "refund")
PAYMENT_KINDS = ("first_payment",) + CASH_PAYMENT_KINDS + COMMITMENT_KINDS


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ════════════════════════════════════════════════════════════════════
# Lookups
# ════════════════════════════════════════════════════════════════════

def find_lead_by_name(name: str) -> list[dict]:
    """Search leads by full_name (case-insensitive substring). Max 8 matches."""
    supabase = get_supabase_client()
    res = (
        supabase.table("leads")
        .select("id, full_name, ghl_contact_id, ghl_opportunity_id, stage, source")
        .ilike("full_name", f"%{name.strip()}%")
        .limit(8)
        .execute()
    )
    return res.data or []


def find_customer_by_name(name: str) -> list[dict]:
    """Search customers by name (case-insensitive substring). Max 8 matches."""
    supabase = get_supabase_client()
    res = (
        supabase.table("customers")
        .select("id, name, lead_id, ghl_contact_id, contract_value, currency, closer, status, closed_at")
        .ilike("name", f"%{name.strip()}%")
        .limit(8)
        .execute()
    )
    return res.data or []


def get_money_snapshot(customer_id: str) -> Optional[dict]:
    """Read a customer's money state from the reporting_money view."""
    supabase = get_supabase_client()
    res = (
        supabase.table("reporting_money")
        .select("customer_id, name, contract_value, cash_collected, payment_count, outstanding")
        .eq("customer_id", customer_id)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def _parse_ghl_time(value) -> Optional[datetime]:
    """GHL start times arrive as ISO strings or epoch-millis — accept both."""
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
        text = str(value).strip()
        if text.isdigit():
            return datetime.fromtimestamp(int(text) / 1000, tz=timezone.utc)
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


def _fetch_calendar_ids(client: httpx.Client, location_id: str) -> list[str]:
    """List the location's calendar ids (GHL /calendars/events needs one)."""
    resp = client.get(f"{GHL_BASE_URL}/calendars/", params={"locationId": location_id})
    resp.raise_for_status()
    return [c["id"] for c in (resp.json().get("calendars") or []) if c.get("id")]


def _fetch_appointments(start_ms: int, end_ms: int) -> list[dict]:
    """
    All GHL calendar events in [start_ms, end_ms] for the location.

    GHL's GET /calendars/events requires a calendarId (or userId/groupId) on
    top of locationId + window — locationId alone is rejected — so we enumerate
    the location's calendars and union their events (deduped by event id).
    Per-calendar failures are logged and skipped so one bad calendar can't
    blank the whole fetch.

    NOTE: this exact endpoint/shape cannot be reached from the build sandbox
    (egress to GHL is blocked by the network allowlist); it runs against live
    GHL on Railway. If it ever returns nothing, the daily safety-net sweep
    still catches every booked call.
    """
    creds = get_ghl_creds()
    out: list[dict] = []
    seen: set = set()

    def _collect(events):
        for ev in events or []:
            eid = ev.get("id")
            if eid and eid not in seen:
                seen.add(eid)
                out.append(ev)

    # The closers' GHL user ids (e.g. Ethan) — querying by userId is the most
    # direct read of "his calendar" and works even if calendar enumeration
    # misses one.
    user_ids = []
    try:
        rows = (
            get_supabase_client().table("team_members")
            .select("ghl_user_id")
            .eq("active", True).eq("role", "closer")
            .execute()
        ).data or []
        user_ids = [r["ghl_user_id"] for r in rows if r.get("ghl_user_id")]
    except Exception as e:
        console.log(f"[yellow]⚠ closer ghl_user_id lookup failed: {e}[/yellow]")

    with httpx.Client(headers=get_ghl_headers(creds["api_key"]), timeout=30) as client:
        base = {"locationId": creds["location_id"], "startTime": start_ms, "endTime": end_ms}
        for uid in user_ids:
            try:
                resp = client.get(f"{GHL_BASE_URL}/calendars/events", params={**base, "userId": uid})
                resp.raise_for_status()
                _collect(resp.json().get("events"))
            except Exception as e:
                console.log(f"[yellow]⚠ GHL events fetch failed (user {uid}): {e}[/yellow]")
        try:
            calendar_ids = _fetch_calendar_ids(client, creds["location_id"])
        except Exception as e:
            console.log(f"[yellow]⚠ GHL calendar list failed: {e}[/yellow]")
            calendar_ids = []
        for cal_id in calendar_ids:
            try:
                resp = client.get(f"{GHL_BASE_URL}/calendars/events", params={**base, "calendarId": cal_id})
                resp.raise_for_status()
                _collect(resp.json().get("events"))
            except Exception as e:
                console.log(f"[yellow]⚠ GHL events fetch failed (calendar {cal_id}): {e}[/yellow]")
    return out


# A call counts as "not yet loggable" until it has been over for this long —
# same 30-minute grace the per-call follow-up uses.
CALL_GRACE_MINUTES = 30


def _contacts_with_upcoming_calls(now_utc: datetime, window_days: int = 120) -> set:
    """
    GHL contact ids whose call is still in the FUTURE or only just started
    (started < CALL_GRACE_MINUTES ago). These leads should NOT be asked
    "how did it go?" yet — e.g. a call booked for a later date.
    """
    cutoff = now_utc - timedelta(minutes=CALL_GRACE_MINUTES)
    events = _fetch_appointments(
        int(cutoff.timestamp() * 1000),
        int((now_utc + timedelta(days=window_days)).timestamp() * 1000),
    )
    upcoming = set()
    for appt in events:
        if (appt.get("appointmentStatus") or "").lower() in ("cancelled", "invalid"):
            continue
        start = _parse_ghl_time(appt.get("startTime"))
        contact_id = appt.get("contactId")
        if contact_id and start and start > cutoff:
            upcoming.add(contact_id)
    return upcoming


def list_pending_calls(now_utc: Optional[datetime] = None, exclude_upcoming: bool = True) -> list[dict]:
    """
    Real-prospect leads currently in 'Appointment Booked' that have NO
    recorded outcome event (deal_won / call_no_show / deal_lost) yet AND whose
    call has actually happened (started at least 30 min ago).

    A lead booked for a FUTURE date (its GHL appointment is upcoming) is held
    back so Jarvis never asks "how did it go?" before the call. The per-call
    follow-up still prompts 30 min after the real call time. Time-filtering is
    best-effort: if the GHL calendar can't be read, all pending calls are
    shown (fail-open) rather than going silent.
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    supabase = get_supabase_client()
    booked = (
        supabase.table("reporting_leads")
        .select("id, full_name, effective_source, lead_date")
        .eq("is_real_prospect", True)
        .eq("stage", "Appointment Booked")
        .execute()
    ).data or []
    if not booked:
        return []

    lead_ids = [r["id"] for r in booked]
    outcomes = (
        supabase.table("events")
        .select("lead_id")
        .in_("lead_id", lead_ids)
        .in_("event_type", list(OUTCOME_EVENT_TYPES))
        .execute()
    ).data or []
    done = {r["lead_id"] for r in outcomes}
    pending = [r for r in booked if r["id"] not in done]

    if not pending or not exclude_upcoming:
        return pending

    # Hold back calls scheduled for later (or in progress right now).
    try:
        rows = (
            supabase.table("leads")
            .select("id, ghl_contact_id")
            .in_("id", [r["id"] for r in pending])
            .execute()
        ).data or []
        contact_by_lead = {r["id"]: r.get("ghl_contact_id") for r in rows}
        upcoming = _contacts_with_upcoming_calls(now_utc)
        if upcoming:
            pending = [r for r in pending if contact_by_lead.get(r["id"]) not in upcoming]
    except Exception as e:
        console.log(f"[yellow]⚠ pending-call time filter failed, showing all: {e}[/yellow]")

    return pending


# ════════════════════════════════════════════════════════════════════
# GHL stage move (reuses the watcher's stage-map pattern)
# ════════════════════════════════════════════════════════════════════

def _fetch_stage_id(client: httpx.Client, location_id: str, stage_name: str) -> Optional[str]:
    """Map a stage NAME to its id in the AI Sales Pipeline."""
    resp = client.get(f"{GHL_BASE_URL}/opportunities/pipelines", params={"locationId": location_id})
    resp.raise_for_status()
    for pipeline in resp.json().get("pipelines", []) or []:
        if pipeline.get("id") != AI_SALES_PIPELINE_ID:
            continue
        for stage in pipeline.get("stages", []) or []:
            if (stage.get("name") or "").strip().lower() == stage_name.strip().lower():
                return stage.get("id")
    return None


def move_lead_stage(lead: dict, stage_name: str) -> dict:
    """
    Move a lead's GHL opportunity to the named stage (exact names:
    'Client Won', 'No Show - Re-Nurture', 'Lead Lost').

    Never raises. On success also updates leads.stage (last-known-state,
    watcher-style) so the pipeline watcher doesn't re-log the milestone.

    Returns {"success": bool, "detail": str}
    """
    opp_id = lead.get("ghl_opportunity_id")
    if not opp_id:
        return {"success": False, "detail": "lead has no GHL opportunity id — move the stage in GHL manually"}

    try:
        creds = get_ghl_creds()
        with httpx.Client(headers=get_ghl_headers(creds["api_key"]), timeout=30) as client:
            stage_id = _fetch_stage_id(client, creds["location_id"], stage_name)
            if not stage_id:
                return {"success": False, "detail": f"stage '{stage_name}' not found in the AI Sales Pipeline"}

            resp = client.put(
                f"{GHL_BASE_URL}/opportunities/{opp_id}",
                json={"pipelineId": AI_SALES_PIPELINE_ID, "pipelineStageId": stage_id},
            )
            resp.raise_for_status()
    except Exception as e:
        console.log(f"[red]✗ GHL stage move failed (opp {opp_id} → {stage_name}): {e}[/red]")
        return {"success": False, "detail": f"GHL stage move failed: {e}"}

    # Keep leads.stage in sync (watcher-style) so the watcher stays idempotent.
    try:
        supabase = get_supabase_client()
        supabase.table("leads").update({"stage": stage_name}).eq("id", lead["id"]).execute()
    except Exception as e:
        console.log(f"[yellow]⚠ leads.stage sync failed after GHL move ({lead.get('id')}): {e}[/yellow]")

    return {"success": True, "detail": f"GHL stage → {stage_name}"}


# ════════════════════════════════════════════════════════════════════
# Events
# ════════════════════════════════════════════════════════════════════

def _log_event(supabase, event_type: str, lead_id: Optional[str], metadata: dict):
    row = {
        "event_type": event_type,
        "lead_id": lead_id,
        "client_id": CLIENT_ID,
        "metadata": {**metadata, "source": "human_capture"},
    }
    supabase.table("events").insert(row).execute()


def _has_outcome_event(supabase, lead_id: str, event_type: str) -> bool:
    res = (
        supabase.table("events")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("event_type", event_type)
        .limit(1)
        .execute()
    )
    return bool(res.data)


# ════════════════════════════════════════════════════════════════════
# call_outcomes — one row per logged call (showed / pitched / closed + why)
# ════════════════════════════════════════════════════════════════════

def _write_call_outcome(supabase, lead: dict, *, showed: bool, pitched: bool,
                        closed: bool, outcome: str, reason: Optional[str] = None,
                        call_duration_minutes: Optional[int] = None,
                        customer_id: Optional[str] = None,
                        logged_by: Optional[str] = None,
                        note: Optional[str] = None) -> Optional[str]:
    """
    Insert one call_outcomes row capturing the full call result. Best-effort:
    a failure here is logged but never blocks the primary outcome write
    (stage move / event / customer). Returns the new row id or None.
    """
    try:
        row = {
            "client_id": CLIENT_ID,
            "lead_id": lead["id"],
            "ghl_contact_id": lead.get("ghl_contact_id"),
            "showed": showed,
            "pitched": pitched,
            "closed": closed,
            "outcome": outcome,
            "reason": (reason or None),
            "call_duration_minutes": call_duration_minutes,
            "customer_id": customer_id,
            "logged_by": logged_by,
            "note": note,
        }
        res = supabase.table("call_outcomes").insert(row).execute()
        return res.data[0]["id"] if res.data else None
    except Exception as e:
        console.log(f"[red]✗ call_outcomes write failed ({outcome}, lead {lead.get('id')}): {e}[/red]")
        return None


# ════════════════════════════════════════════════════════════════════
# Payment terms (split pay) → scheduled_payments
# ════════════════════════════════════════════════════════════════════

_TERMS_REL_RE = None  # compiled lazily


def _business_today() -> date:
    return datetime.now(BUSINESS_TZ).date()


def parse_payment_terms(text: str) -> dict:
    """
    Turn plain-language split-pay terms into schedule items:
      "1.5k in 40 days"                → [{amount 1500, due today+40}]
      "1500 on 2026-07-20"             → [{amount 1500, due 2026-07-20}]
      "500/month for 3 months"         → 3 items, 30 days apart
    Claude (MODEL_LIGHT) does the parsing; a regex fallback covers
    "X in N days" if the API is unavailable. Returns
    {"ok": bool, "items": [{"amount", "due_date", "note"}], "error": str}.
    """
    import re as _re

    text = (text or "").strip()
    if not text:
        return {"ok": False, "items": [], "error": "empty terms"}

    today = _business_today()

    try:
        import os as _os
        import json as _json
        from anthropic import Anthropic
        from config.settings import MODEL_LIGHT

        client = Anthropic(api_key=_os.getenv("ANTHROPIC_API_KEY"))
        resp = client.messages.create(
            model=MODEL_LIGHT,
            max_tokens=400,
            system=(
                f"Today is {today.isoformat()}. Parse payment terms into JSON: "
                '{"items": [{"amount": <number, "1.5k"=1500>, "due_date": "YYYY-MM-DD", "note": "<short label>"}]} '
                'Relative terms count from today ("in 40 days"); "monthly for N months" = N items 30 days apart '
                "starting 30 days from today unless stated. Output ONLY the JSON. "
                'If you cannot parse it, output {"items": []}.'
            ),
            messages=[{"role": "user", "content": text}],
        )
        raw = resp.content[0].text.strip()
        if "```" in raw:
            raw = raw.split("```")[1].replace("json", "", 1).strip()
        items = _json.loads(raw).get("items") or []
        clean = []
        for it in items:
            amount = float(it["amount"])
            due = date.fromisoformat(str(it["due_date"]))
            if amount > 0 and due >= today:
                clean.append({"amount": amount, "due_date": due.isoformat(),
                              "note": str(it.get("note") or "")[:120]})
        if clean:
            return {"ok": True, "items": clean, "error": None}
    except Exception as e:
        console.log(f"[yellow]⚠ terms LLM parse failed ({type(e).__name__}: {e}) — trying regex[/yellow]")

    # Fallback: "X in N days" (possibly several, comma/and-separated)
    matches = _re.findall(
        r"\$?\s*([\d][\d,]*\.?\d*)\s*(k)?\s*(?:in|after)\s*(\d+)\s*days?",
        text, _re.IGNORECASE,
    )
    items = []
    for num, k, days in matches:
        amount = float(num.replace(",", "")) * (1000 if k else 1)
        due = today + timedelta(days=int(days))
        items.append({"amount": amount, "due_date": due.isoformat(), "note": text[:120]})
    if items:
        return {"ok": True, "items": items, "error": None}
    return {"ok": False, "items": [],
            "error": "couldn't parse the terms — try e.g. '1.5k in 40 days' or '500/month for 3 months'"}


def create_scheduled_payments(customer_id: str, items: list[dict], created_by: str,
                              currency: str = "USD") -> list[dict]:
    """Insert scheduled_payments rows (the split-pay remainder). Returns rows."""
    if not items:
        return []
    supabase = get_supabase_client()
    rows = [{
        "client_id": CLIENT_ID,
        "customer_id": customer_id,
        "amount": float(it["amount"]),
        "currency": currency,
        "due_date": it["due_date"],
        "status": "pending",
        "note": it.get("note"),
        "created_by": created_by,
    } for it in items]
    return supabase.table("scheduled_payments").insert(rows).execute().data or []


def _describe_schedule(items: list[dict]) -> str:
    return ", ".join(f"{it['amount']:g} due {it['due_date']}" for it in items)


# ════════════════════════════════════════════════════════════════════
# Phase 2 — call outcomes
# ════════════════════════════════════════════════════════════════════

def log_close(lead: dict, contract_value: float, collected_today: float,
              closer_name: str, currency: str = "USD", note: Optional[str] = None,
              payment_terms: Optional[list[dict]] = None,
              call_duration_minutes: Optional[int] = None) -> dict:
    """
    SHOWED + PITCHED + CLOSED: customers row + first_payment + deal_won event +
    GHL stage → 'Client Won' + a call_outcomes row
    (showed/pitched/closed=true, outcome='closed', customer_id, duration).
    payment_terms (split pay) = [{amount, due_date, note}] — each becomes a
    scheduled_payments row so the owner gets a collection reminder on its due
    date.

    Returns {"success", "customer_id", "payment_id", "ghl": {...}, "detail"}.
    """
    supabase = get_supabase_client()

    if _has_outcome_event(supabase, lead["id"], "deal_won"):
        return {"success": False, "detail": f"{lead.get('full_name')} already has a recorded close (deal_won) — not logging twice."}

    customer_row = {
        "client_id": CLIENT_ID,
        "name": lead.get("full_name") or "Unknown",
        "lead_id": lead["id"],
        "ghl_contact_id": lead.get("ghl_contact_id"),
        "contract_value": contract_value,
        "currency": currency,
        "closer": closer_name,
        "closed_at": _now_iso(),
        "status": "active",
        "note": note,
    }
    customer = supabase.table("customers").insert(customer_row).execute().data[0]

    payment_id = None
    if collected_today and collected_today > 0:
        payment_row = {
            "client_id": CLIENT_ID,
            "customer_id": customer["id"],
            "lead_id": lead["id"],
            "ghl_contact_id": lead.get("ghl_contact_id"),
            "amount": collected_today,
            "currency": currency,
            "kind": "first_payment",
            "collected_at": _now_iso(),
            "logged_by": closer_name,
            "note": note,
        }
        payment_id = supabase.table("payments").insert(payment_row).execute().data[0]["id"]

    _log_event(supabase, "deal_won", lead["id"], {
        "contract_value": contract_value,
        "collected_today": collected_today,
        "currency": currency,
        "closer": closer_name,
        "customer_id": customer["id"],
        "payment_terms": payment_terms or "PIF",
    })

    scheduled = []
    if payment_terms:
        try:
            scheduled = create_scheduled_payments(customer["id"], payment_terms, closer_name, currency)
        except Exception as e:
            console.log(f"[red]✗ scheduling split payments failed: {e}[/red]")

    _write_call_outcome(
        supabase, lead, showed=True, pitched=True, closed=True, outcome="closed",
        call_duration_minutes=call_duration_minutes, customer_id=customer["id"],
        logged_by=closer_name, note=note,
    )

    ghl = move_lead_stage(lead, STAGE_CLIENT_WON)

    terms_txt = ""
    if scheduled:
        terms_txt = f" Split pay — rest scheduled: {_describe_schedule(payment_terms)} ({OWNER_NAME} gets reminded on each due date)."
    elif payment_terms:
        terms_txt = f" ⚠ Split-pay schedule could NOT be saved — tell {OWNER_NAME} the terms directly."

    return {
        "success": True,
        "customer_id": customer["id"],
        "payment_id": payment_id,
        "scheduled_payments": len(scheduled),
        "ghl": ghl,
        "detail": (
            f"Logged close for {customer['name']}: contract {contract_value} {currency}, "
            f"collected {collected_today} {currency}"
            + (f", {call_duration_minutes} min call" if call_duration_minutes else "")
            + f".{terms_txt} " + ghl["detail"]
        ),
    }


def log_no_show(lead: dict, member_name: str) -> dict:
    """NO-SHOW: call_no_show event + GHL → 'No Show - Re-Nurture' +
    call_outcomes(showed=false, pitched=false, closed=false, outcome='no_show')."""
    supabase = get_supabase_client()
    _log_event(supabase, "call_no_show", lead["id"], {"logged_by": member_name})
    _write_call_outcome(supabase, lead, showed=False, pitched=False, closed=False,
                        outcome="no_show", logged_by=member_name)
    ghl = move_lead_stage(lead, STAGE_NO_SHOW)
    return {"success": True, "ghl": ghl,
            "detail": f"Logged no-show for {lead.get('full_name')}. " + ghl["detail"]}


def log_showed_not_pitched(lead: dict, member_name: str, reason: str) -> dict:
    """
    SHOWED but NOT pitched (unqualified): deal_lost-style event noting
    unqualified + GHL → 'Disqualified' + call_outcomes(showed=true,
    pitched=false, closed=false, outcome='showed_not_pitched', reason).
    """
    supabase = get_supabase_client()
    _log_event(supabase, "deal_lost", lead["id"], {
        "note": "showed, not pitched (unqualified)",
        "reason": reason,
        "logged_by": member_name,
    })
    _write_call_outcome(supabase, lead, showed=True, pitched=False, closed=False,
                        outcome="showed_not_pitched", reason=reason, logged_by=member_name)
    ghl = move_lead_stage(lead, STAGE_DISQUALIFIED)
    return {"success": True, "ghl": ghl,
            "detail": f"Logged {lead.get('full_name')} as showed-but-unqualified (no pitch). "
                      f"Reason: {reason}. " + ghl["detail"]}


def log_showed_no_close(lead: dict, member_name: str, note: Optional[str] = None,
                        reason: Optional[str] = None) -> dict:
    """
    SHOWED + PITCHED but NOT closed: deal_lost event + GHL → 'Lead Lost' +
    call_outcomes(showed=true, pitched=true, closed=false,
    outcome='pitched_no_close', reason). `reason` is the closer's real "why";
    `note` kept for the agent's older callers.
    """
    why = reason or note
    supabase = get_supabase_client()
    _log_event(supabase, "deal_lost", lead["id"], {
        "note": "pitched, no close",
        "reason": why,
        "logged_by": member_name,
    })
    _write_call_outcome(supabase, lead, showed=True, pitched=True, closed=False,
                        outcome="pitched_no_close", reason=why, logged_by=member_name)
    ghl = move_lead_stage(lead, STAGE_LEAD_LOST)
    detail = f"Logged pitched-no-close for {lead.get('full_name')}."
    if why:
        detail += f" Reason: {why}."
    return {"success": True, "ghl": ghl, "detail": detail + " " + ghl["detail"]}


# ════════════════════════════════════════════════════════════════════
# Phase 3 — customers & payments (owner)
# ════════════════════════════════════════════════════════════════════

def create_customer(name: str, contract_value: float, logged_by: str,
                    lead: Optional[dict] = None, currency: str = "USD",
                    first_payment: float = 0, closer: Optional[str] = None,
                    note: Optional[str] = None) -> dict:
    """
    Owner path "John signed for 6k, paid 2k today" — customers row plus an
    optional first_payment. Same shape as the Phase-2 close path.
    """
    supabase = get_supabase_client()
    customer_row = {
        "client_id": CLIENT_ID,
        "name": name.strip(),
        "lead_id": (lead or {}).get("id"),
        "ghl_contact_id": (lead or {}).get("ghl_contact_id"),
        "contract_value": contract_value,
        "currency": currency,
        "closer": closer or logged_by,
        "closed_at": _now_iso(),
        "status": "active",
        "note": note,
    }
    customer = supabase.table("customers").insert(customer_row).execute().data[0]

    payment_id = None
    if first_payment and first_payment > 0:
        payment_id = supabase.table("payments").insert({
            "client_id": CLIENT_ID,
            "customer_id": customer["id"],
            "lead_id": (lead or {}).get("id"),
            "ghl_contact_id": (lead or {}).get("ghl_contact_id"),
            "amount": first_payment,
            "currency": currency,
            "kind": "first_payment",
            "collected_at": _now_iso(),
            "logged_by": logged_by,
            "note": note,
        }).execute().data[0]["id"]

    return {"success": True, "customer_id": customer["id"], "payment_id": payment_id,
            "detail": f"Created customer {customer['name']} (contract {contract_value} {currency}"
                      + (f", first payment {first_payment}" if payment_id else "") + ")"}


def log_payment(customer: dict, amount: float, kind: str, logged_by: str,
                currency: str = "USD", note: Optional[str] = None) -> dict:
    """
    Log CASH against an existing customer — a payment row only, NEVER touches
    contract_value. kinds: installment, refund (refunds are NEGATIVE).
    Commitments (extension / renewal / upsell) go through log_commitment.
    """
    if kind in COMMITMENT_KINDS:
        return {"success": False,
                "detail": f"'{kind}' is a COMMITMENT (raises the contract) — use log_commitment, not log_payment"}
    if kind not in PAYMENT_KINDS:
        return {"success": False, "detail": f"unknown payment kind '{kind}' — use one of {PAYMENT_KINDS}"}

    # Refunds are stored negative, whatever sign the caller passed.
    if kind == "refund":
        amount = -abs(amount)

    supabase = get_supabase_client()
    payment = supabase.table("payments").insert({
        "client_id": CLIENT_ID,
        "customer_id": customer["id"],
        "lead_id": customer.get("lead_id"),
        "ghl_contact_id": customer.get("ghl_contact_id"),
        "amount": amount,
        "currency": currency,
        "kind": kind,
        "collected_at": _now_iso(),
        "logged_by": logged_by,
        "note": note,
    }).execute().data[0]

    # Auto-close a matching scheduled collection (exact amount, oldest first)
    matched_txt = ""
    if amount > 0:
        try:
            open_rows = (
                supabase.table("scheduled_payments")
                .select("id, amount, due_date")
                .eq("customer_id", customer["id"])
                .in_("status", ["pending", "reminded"])
                .order("due_date")
                .execute()
            ).data or []
            hit = next((r for r in open_rows if float(r["amount"]) == float(amount)), None)
            if hit:
                supabase.table("scheduled_payments").update(
                    {"status": "collected", "payment_id": payment["id"]}
                ).eq("id", hit["id"]).execute()
                matched_txt = f" Scheduled collection ({hit['amount']:g} due {hit['due_date']}) marked collected."
        except Exception as e:
            console.log(f"[yellow]⚠ schedule auto-match failed: {e}[/yellow]")

    snapshot = get_money_snapshot(customer["id"])
    snap_txt = ""
    if snapshot:
        snap_txt = (f" {snapshot['name']} now: collected {snapshot['cash_collected']}, "
                    f"outstanding {snapshot['outstanding']}.")
    return {"success": True, "payment_id": payment["id"],
            "detail": f"Logged {kind} of {amount} {currency} for {customer.get('name')}.{matched_txt}{snap_txt}"}


def log_commitment(customer: dict, amount: float, kind: str, logged_by: str,
                   paid_now: float = 0, currency: str = "USD",
                   note: Optional[str] = None) -> dict:
    """
    Log a NEW COMMITMENT (extension / renewal / upsell): ADDS amount to the
    customer's contract_value. If they paid some of it now (paid_now > 0),
    also logs that cash as a payment of the same kind. Unpaid commitment
    becomes outstanding automatically (reporting_money).
    """
    if kind not in COMMITMENT_KINDS:
        return {"success": False,
                "detail": f"unknown commitment kind '{kind}' — use one of {COMMITMENT_KINDS}"}
    if amount <= 0:
        return {"success": False, "detail": "commitment amount must be positive"}

    supabase = get_supabase_client()

    old_total = float(customer.get("contract_value") or 0)
    new_total = old_total + amount
    supabase.table("customers").update(
        {"contract_value": new_total}
    ).eq("id", customer["id"]).execute()

    payment_id = None
    if paid_now and paid_now > 0:
        payment_id = supabase.table("payments").insert({
            "client_id": CLIENT_ID,
            "customer_id": customer["id"],
            "lead_id": customer.get("lead_id"),
            "ghl_contact_id": customer.get("ghl_contact_id"),
            "amount": paid_now,
            "currency": currency,
            "kind": kind,
            "collected_at": _now_iso(),
            "logged_by": logged_by,
            "note": note,
        }).execute().data[0]["id"]

    snapshot = get_money_snapshot(customer["id"])
    snap_txt = ""
    if snapshot:
        snap_txt = (f" Now: contract {snapshot['contract_value']}, collected "
                    f"{snapshot['cash_collected']}, outstanding {snapshot['outstanding']}.")
    cash_txt = f", {paid_now} {currency} paid now" if payment_id else ", nothing paid yet (all outstanding)"
    return {"success": True, "payment_id": payment_id, "new_contract_value": new_total,
            "detail": f"Logged {kind} of {amount} {currency} for {customer.get('name')} "
                      f"(contract {old_total} → {new_total}{cash_txt}).{snap_txt}"}


# ════════════════════════════════════════════════════════════════════
# Phase 4 — daily activity (setter)
# ════════════════════════════════════════════════════════════════════

def log_team_activity(member_id: str, member_name: str,
                      outreaches: Optional[int] = None, dials: Optional[int] = None,
                      conversations: Optional[int] = None,
                      followups_outreach: Optional[int] = None,
                      pickups: Optional[int] = None,
                      followups_dials: Optional[int] = None,
                      note: Optional[str] = None,
                      activity_date: Optional[str] = None, mode: str = "set") -> dict:
    """
    Insert or update team_activity for (member, date). Date defaults to today
    in Stockholm time. Only the fields provided are touched on an existing row
    (followups_outreach omitted on a fresh row falls back to the column's
    DEFAULT 0 — never blocks the log).

    mode:
      "set" — the given numbers REPLACE the day's values (normal end-of-day log)
      "add" — the given numbers are ADDED on top ("outreached 2 more today")
    """
    day = activity_date or datetime.now(BUSINESS_TZ).date().isoformat()

    supabase = get_supabase_client()
    existing = (
        supabase.table("team_activity")
        .select("id, outreaches, dials, conversations, followups_outreach, pickups, followups_dials")
        .eq("team_member_id", member_id)
        .eq("activity_date", day)
        .limit(1)
        .execute()
    ).data

    given = {"outreaches": outreaches, "dials": dials, "conversations": conversations,
             "followups_outreach": followups_outreach, "pickups": pickups,
             "followups_dials": followups_dials}
    fields = {"logged_by": member_name}
    for col, val in given.items():
        if val is None:
            continue
        if mode == "add" and existing:
            fields[col] = int(existing[0].get(col) or 0) + int(val)
        else:
            fields[col] = int(val)
    if note:
        fields["note"] = note

    if existing:
        supabase.table("team_activity").update(fields).eq("id", existing[0]["id"]).execute()
        action = "Added to" if mode == "add" else "Updated"
    else:
        supabase.table("team_activity").insert({
            "client_id": CLIENT_ID,
            "team_member_id": member_id,
            "activity_date": day,
            **fields,
        }).execute()
        action = "Logged"

    bits = []
    for col, label in (("outreaches", "outreaches"), ("dials", "dials"),
                       ("conversations", "conversations"),
                       ("followups_outreach", "outreach follow-ups"),
                       ("followups_dials", "dial follow-ups"),
                       ("pickups", "pickups")):
        if given[col] is not None:
            now_val = fields.get(col)
            extra = f" (+{given[col]} → {now_val})" if mode == "add" and existing else ""
            bits.append(f"{given[col]} {label}{extra}" if not extra else f"{label}{extra}")
    return {"success": True, "detail": f"{action} {' + '.join(bits) or 'activity'} for {member_name} on {day}."}


def get_member_activity(member_id: str, days: int = 7) -> list[dict]:
    """A member's recent activity rows (most recent first)."""
    supabase = get_supabase_client()
    res = (
        supabase.table("team_activity")
        .select("activity_date, outreaches, dials, conversations, followups_outreach, pickups, followups_dials, note")
        .eq("team_member_id", member_id)
        .order("activity_date", desc=True)
        .limit(days)
        .execute()
    )
    return res.data or []


def get_closer_numbers(closer_name: str) -> dict:
    """A closer's own results from reporting_money (their closes only)."""
    supabase = get_supabase_client()
    rows = (
        supabase.table("reporting_money")
        .select("name, contract_value, cash_collected, outstanding, closed_at, status")
        .eq("closer", closer_name)
        .execute()
    ).data or []
    return {
        "closes": len(rows),
        "contracted": sum(float(r["contract_value"] or 0) for r in rows),
        "cash_collected": sum(float(r["cash_collected"] or 0) for r in rows),
        "outstanding": sum(float(r["outstanding"] or 0) for r in rows),
        "customers": rows,
    }
