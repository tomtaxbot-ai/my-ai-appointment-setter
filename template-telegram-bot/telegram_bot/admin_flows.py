"""
ADMIN FLOWS — owner-only system-control primitives.

Everything Jarvis's admin layer can change runs through here:
  - the setter's brain (4 client fields) with versioned undo
  - the global kill switch (+ scheduled auto-resume)
  - reply speed (delay range the Next.js setter reads per reply)
  - lead lookup (read-only) and stage moves
  - record corrections: delete/fix customers & payments, ALWAYS appending a
    'record_correction' event (events are append-only — never edited)
  - CSV export through the read-only reporting RPC
  - team management and owner notes

Every function is called by the admin agent ONLY after the owner confirmed
(hard confirmed=true gate in admin_agent). Role gating happens at dispatch
(bot.py routes only the owner here) AND again in the agent.
"""

import csv
import io
import os
import secrets
from datetime import datetime, timezone, timedelta, date
from typing import Optional

import requests
from rich.console import Console

from telegram_bot.owner import OWNER_NAME
from telegram_bot.setter_control import get_supabase_client
from telegram_bot.capture_flows import (
    CLIENT_ID,
    BUSINESS_TZ,
    move_lead_stage,
    _log_event,
)
from telegram_bot.team_identity import OWNER_CHAT_ID

console = Console()

BRAIN_FIELDS = ("system_prompt", "active_rules", "voice_samples", "business_context", "pain_protocol")

# Vercel functions cap at 60s total, so the configured wait may never exceed
# this (the Next.js side clamps too). Surface the limit to the owner.
MAX_REPLY_DELAY_SECONDS = 30

VALID_TEAM_ROLES = ("closer", "setter")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_row(fields: str):
    res = (
        get_supabase_client().table("clients")
        .select(fields).eq("id", CLIENT_ID).limit(1).execute()
    )
    return res.data[0] if res.data else None


# ════════════════════════════════════════════════════════════════════
# Phase 1 — setter brain (4 fields) with versioned undo
# ════════════════════════════════════════════════════════════════════

def get_brain_field(field: str) -> dict:
    if field not in BRAIN_FIELDS:
        return {"success": False, "detail": f"unknown field '{field}' — one of {BRAIN_FIELDS}"}
    row = _client_row(field)
    return {"success": True, "field": field, "value": (row or {}).get(field) or "(empty)"}


def set_brain_field(field: str, new_value: str, changed_by: str = OWNER_NAME) -> dict:
    """Versioned save: old value → setter_brain_versions, then update clients."""
    if field not in BRAIN_FIELDS:
        return {"success": False, "detail": f"unknown field '{field}' — one of {BRAIN_FIELDS}"}
    if not (new_value or "").strip():
        return {"success": False, "detail": "refusing to save an empty brain field — say 'clear it' explicitly in the text if intended"}

    supabase = get_supabase_client()
    row = _client_row(field)
    old_value = (row or {}).get(field)

    supabase.table("setter_brain_versions").insert({
        "client_id": CLIENT_ID,
        "field": field,
        "old_value": old_value,
        "new_value": new_value,
        "changed_by": changed_by,
    }).execute()
    supabase.table("clients").update({field: new_value}).eq("id", CLIENT_ID).execute()

    return {"success": True,
            "detail": f"Saved {field} ({len(new_value)} chars). Previous version kept — say 'undo' to restore it. "
                      f"The setter reads this fresh on its next reply."}


def undo_brain_field(field: str, changed_by: str = OWNER_NAME) -> dict:
    """Restore the most recent prior version of a field (undo is itself undoable)."""
    if field not in BRAIN_FIELDS:
        return {"success": False, "detail": f"unknown field '{field}' — one of {BRAIN_FIELDS}"}

    supabase = get_supabase_client()
    versions = (
        supabase.table("setter_brain_versions")
        .select("id, old_value, changed_at")
        .eq("client_id", CLIENT_ID).eq("field", field)
        .order("changed_at", desc=True).limit(1).execute()
    ).data
    if not versions:
        return {"success": False, "detail": f"no saved versions of {field} to restore"}

    restored = versions[0]["old_value"]
    current = (_client_row(field) or {}).get(field)

    supabase.table("setter_brain_versions").insert({
        "client_id": CLIENT_ID,
        "field": field,
        "old_value": current,
        "new_value": restored,
        "changed_by": f"{changed_by} (undo)",
    }).execute()
    supabase.table("clients").update({field: restored}).eq("id", CLIENT_ID).execute()

    return {"success": True,
            "detail": f"Restored the previous {field} ({len(restored or '')} chars). "
                      f"Live on the setter's next reply.",
            "restored_value": restored}


# ════════════════════════════════════════════════════════════════════
# Phase 2 — global kill switch (+ scheduled auto-resume)
# ════════════════════════════════════════════════════════════════════

def set_setter_active(active: bool, resume_at: Optional[str] = None) -> dict:
    """
    Flip clients.is_active. resume_at (ISO, only with active=False) schedules
    the auto-resume the Railway scheduler executes (run_setter_resume_check).
    """
    fields = {"is_active": bool(active)}
    if active:
        fields["setter_resume_at"] = None  # turning on cancels any pending resume
    elif resume_at:
        try:
            datetime.fromisoformat(resume_at.replace("Z", "+00:00"))
        except Exception:
            return {"success": False, "detail": f"'{resume_at}' is not a valid ISO time"}
        fields["setter_resume_at"] = resume_at

    get_supabase_client().table("clients").update(fields).eq("id", CLIENT_ID).execute()

    if active:
        return {"success": True, "detail": "Setter is ON — replying to leads again."}
    if resume_at:
        local = datetime.fromisoformat(resume_at.replace("Z", "+00:00")).astimezone(BUSINESS_TZ)
        return {"success": True,
                "detail": f"Setter is OFF. Auto-resumes {local.strftime('%a %H:%M')} (Stockholm). "
                          f"⚠ While off, incoming lead DMs get no reply and are not recorded."}
    return {"success": True,
            "detail": "Setter is OFF until you turn it back on. "
                      "⚠ While off, incoming lead DMs get no reply and are not recorded."}


def set_nurture_active(active: bool) -> dict:
    """
    Flip clients.nurture_enabled system-wide (the pre-call warm-up engine).
    On enable, stamp nurture_enabled_at=now so it never reaches back to leads
    who booked before being switched on. Separate from set_setter_active.
    """
    fields = {"nurture_enabled": bool(active)}
    if active:
        fields["nurture_enabled_at"] = datetime.now(timezone.utc).isoformat()
    get_supabase_client().table("clients").update(fields).eq("id", CLIENT_ID).execute()
    if active:
        return {"success": True, "detail": "Nurture is ON — booked leads get the pre-call warm-up sequence."}
    return {"success": True, "detail": "Nurture is OFF — no warm-up sends. Pending touches won't fire."}


def set_followup_active(active: bool) -> dict:
    """
    Flip clients.followup_enabled system-wide (the engine that re-engages leads
    who went quiet). On enable, stamp followup_enabled_at=now so it only acts on
    stalls from now on (no retroactive blast). Separate from setter + nurture.
    """
    fields = {"followup_enabled": bool(active)}
    if active:
        fields["followup_enabled_at"] = datetime.now(timezone.utc).isoformat()
    get_supabase_client().table("clients").update(fields).eq("id", CLIENT_ID).execute()
    if active:
        return {"success": True, "detail": "Follow-ups are ON — quiet leads (ghosted or cold feet) get re-engaged automatically."}
    return {"success": True, "detail": "Follow-ups are OFF — no re-engagement sends."}


# ai-setter (Next.js) base URL — where the on-demand DM analyser lives.
# Set AISETTER_BASE_URL to your own deployment's URL in the env.
AISETTER_BASE_URL = os.getenv("AISETTER_BASE_URL", "").rstrip("/")


def _format_dm_report(summary, method, findings, suggestions, sample=None, when=None) -> str:
    """Plain-text render of a DM-intelligence report — clean and scannable for Telegram."""
    L = ["📊 DM INTELLIGENCE"]
    if when:
        L.append(f"  {when}")
    L.append("")
    L.append("— THE READ —")
    L.append(summary or "(no summary)")
    if method:
        L += ["", "— HOW I LOOKED —", method]
    sampled = [(k, v) for k, v in (sample or {}).items() if v]
    if sampled:
        L += ["", "— WHAT I READ —"]
        for k, n in sampled:
            L.append(f"• {k}: {n} convo{'' if n == 1 else 's'}")
    if findings:
        L += ["", "— WHAT I FOUND —"]
        for f in findings:
            cohort = f.get("cohort", "")
            where = f.get("where", "")
            L.append(f"▸ {cohort} ({where})" if where else f"▸ {cohort}")
            if f.get("pattern"):
                L.append(f"   {f['pattern']}")
            if f.get("evidence"):
                L.append(f"   e.g. {f['evidence']}")
    if suggestions:
        L += ["", f"— TOP {len(suggestions)} FIX{'' if len(suggestions) == 1 else 'ES'} —"]
        for i, s in enumerate(suggestions, 1):
            L.append("")
            L.append(f"{i}. {s.get('title','')}  [{s.get('confidence','medium')} confidence · {s.get('target','other')}]")
            if s.get("proposed_change"):
                L.append(f"   Change: {s['proposed_change']}")
            if s.get("why_best"):
                L.append(f"   Why this one: {s['why_best']}")
            if s.get("expected_impact"):
                L.append(f"   Expected: {s['expected_impact']}")
    else:
        L += ["", "No strong fixes yet — not enough clean signal. Nothing changes regardless until you approve it."]
    L += ["", "Nothing here is applied. Tell me which fix to make (with any tweak of yours) and I'll change it after you confirm."]
    return "\n".join(L)


def set_voice_active(active: bool) -> dict:
    """
    Flip clients.voice_enabled — voice notes in the operator's cloned voice.
    When ON, the setter can reply with a voice note on the human/persuasion beats
    (rapport, empathy, pitch); links and times always stay text. Falls back to
    text on any voice failure, so it can never drop a reply. Kill switch.
    """
    get_supabase_client().table("clients").update({"voice_enabled": bool(active)}).eq("id", CLIENT_ID).execute()
    if active:
        return {"success": True, "detail": "Voice notes are ON — the setter can reply in your cloned voice on the key beats. Links and times stay as text. Falls back to text if a clip ever fails."}
    return {"success": True, "detail": "Voice notes are OFF — text only."}


def voice_stats(hours: int = 168) -> dict:
    """READ-ONLY: how many voice notes the setter sent over the last `hours`
    (default 7 days). Summed from the ai_replied events' voice_notes count."""
    sb = get_supabase_client()
    since = (datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours)))).isoformat()
    rows = (
        sb.table("events")
        .select("metadata")
        .eq("client_id", CLIENT_ID)
        .in_("event_type", ["ai_replied", "ai_reply_failed"])
        .gte("created_at", since)
        .execute()
    ).data or []
    notes = 0
    for r in rows:
        md = r.get("metadata") or {}
        try:
            notes += int(md.get("voice_notes") or 0)
        except (TypeError, ValueError):
            pass
    label = f"{hours // 24}d" if hours % 24 == 0 else f"{hours}h"
    return {"success": True, "window": label, "voice_notes_sent": notes, "ai_replies": len(rows)}


def set_whale_radar_active(active: bool) -> dict:
    """
    Flip clients.whale_radar_enabled. When ON, the setter scores every live lead
    on expected value (likelihood-to-close × deal size) and pings YOU on Telegram
    the first time a lead scores as a high-value whale, so you/Ethan can jump in.
    Read-only on the lead — it never changes the conversation. Kill switch.
    """
    get_supabase_client().table("clients").update({"whale_radar_enabled": bool(active)}).eq("id", CLIENT_ID).execute()
    if active:
        return {"success": True, "detail": "Whale radar is ON — I'll ping you the moment a high-value lead shows up in the DMs."}
    return {"success": True, "detail": "Whale radar is OFF — no whale pings."}


def set_pain_dig_active(active: bool) -> dict:
    """
    Flip clients.pain_dig_enabled — the "dig deeper into pain" empathy overlay.
    When ON, the setter pauses the funnel whenever a lead shares something
    emotionally heavy, digs into it with empathy, then resumes exactly where it
    left off. Tune the trigger words / dig style via the pain_protocol brain
    field. Ships OFF. It only shapes the setter's own reply — no new sends/timers.
    """
    get_supabase_client().table("clients").update({"pain_dig_enabled": bool(active)}).eq("id", CLIENT_ID).execute()
    if active:
        return {"success": True, "detail": "Pain-digging is ON — when a lead shares something heavy (stressed, burned out, anxious...), the setter pauses to dig into it with empathy, then picks the conversation back up. Edit the trigger words/style with the pain_protocol brain field."}
    return {"success": True, "detail": "Pain-digging is OFF — the setter runs the normal flow, no pausing to dig into emotion."}


def set_dm_intel_active(active: bool) -> dict:
    """
    Flip clients.dm_intel_enabled — governs ONLY the automatic MONTHLY DM-analysis
    run + ping. It only ever produces advisory suggestions; it never changes the
    setter. On-demand analysis (here or in Jarvis HQ) works regardless of this flag.
    """
    get_supabase_client().table("clients").update({"dm_intel_enabled": bool(active)}).eq("id", CLIENT_ID).execute()
    if active:
        return {"success": True, "detail": "Monthly DM intelligence is ON — once a month I'll study the convos and ping you the read. You can still ask me to analyse on demand any time. Nothing changes without your approval."}
    return {"success": True, "detail": "Monthly DM intelligence is OFF — no automatic run. You can still ask me to analyse on demand any time."}


def run_dm_analysis() -> dict:
    """
    Run the DM-intelligence analysis ON DEMAND via the ai-setter app (the analyser
    lives in Next.js). READ-ONLY over business data — it only writes its own report
    tables and returns advisory suggestions. It NEVER changes the setter.
    """
    secret = os.getenv("DM_INTEL_SECRET") or os.getenv("CRON_SECRET")
    headers = {"Authorization": f"Bearer {secret}"} if secret else {}
    try:
        resp = requests.post(f"{AISETTER_BASE_URL}/api/dm-intel/run", headers=headers, timeout=120)
    except Exception as e:
        return {"success": False, "detail": f"Couldn't reach the analyser: {e}"}
    if not resp.ok:
        return {"success": False, "detail": f"Analyser returned {resp.status_code}: {resp.text[:200]}"}
    data = resp.json() if resp.content else {}
    if not data.get("ok"):
        reason = data.get("reason", "unknown")
        if reason == "no_conversations_to_analyse":
            return {"success": False, "detail": "Not enough conversation data yet to analyse. Once more DMs flow through, ask me again."}
        return {"success": False, "detail": f"Analysis didn't complete ({reason})."}
    return {
        "success": True,
        "report_text": data.get("report_text") or _format_dm_report(
            data.get("summary"), None, [], [], None, None),
        "suggestions_count": data.get("suggestions", 0),
    }


def latest_dm_report() -> dict:
    """READ-ONLY: the latest DM intelligence report + its suggestions, as readable text."""
    sb = get_supabase_client()
    rep = sb.table("dm_intel_reports").select("*").eq("client_id", CLIENT_ID).order("created_at", desc=True).limit(1).execute()
    if not rep.data:
        return {"report": None, "report_text": "No DM analysis has been run yet. Say 'analyse my DMs' to run one."}
    r = rep.data[0]
    sugg = sb.table("dm_suggestions").select(
        "title, finding, evidence, proposed_change, why_best, expected_impact, target, confidence, status"
    ).eq("report_id", r["id"]).order("created_at", desc=False).execute()
    findings = r.get("findings") if isinstance(r.get("findings"), list) else []
    when = str(r.get("created_at", ""))[:16].replace("T", " ")
    report_text = _format_dm_report(
        r.get("summary"), r.get("method"), findings, sugg.data or [], r.get("sample"), when)
    return {"report_text": report_text, "suggestions_count": len(sugg.data or [])}


def run_setter_resume_check(now_utc: Optional[datetime] = None) -> dict:
    """Scheduler hook: flip is_active back on when setter_resume_at passes."""
    now_utc = now_utc or datetime.now(timezone.utc)
    summary = {"resumed": 0, "errors": 0}
    try:
        supabase = get_supabase_client()
        rows = (
            supabase.table("clients")
            .select("id, slug, setter_resume_at")
            .eq("is_active", False)
            .not_.is_("setter_resume_at", "null")
            .execute()
        ).data or []
        for row in rows:
            try:
                due = datetime.fromisoformat(str(row["setter_resume_at"]).replace("Z", "+00:00"))
                if due <= now_utc:
                    supabase.table("clients").update(
                        {"is_active": True, "setter_resume_at": None}
                    ).eq("id", row["id"]).execute()
                    summary["resumed"] += 1
                    from telegram_bot.notifier import send_telegram
                    send_telegram("🤖 Setter is back ON (scheduled resume).")
            except Exception as inner:
                summary["errors"] += 1
                console.log(f"[red]✗ setter resume failed ({row.get('slug')}): {inner}[/red]")
    except Exception as e:
        summary["errors"] += 1
        console.log(f"[red]✗ setter resume check failed: {e}[/red]")
    return summary


# ════════════════════════════════════════════════════════════════════
# Phase 3 — reply speed
# ════════════════════════════════════════════════════════════════════

def set_reply_delay(min_seconds: Optional[float], max_seconds: Optional[float]) -> dict:
    """
    Set the delay range the Next.js setter waits before replying.
    Both None = reset to the default behavior (fixed 8s burst debounce).
    """
    if min_seconds is None and max_seconds is None:
        get_supabase_client().table("clients").update(
            {"reply_delay_min_seconds": None, "reply_delay_max_seconds": None}
        ).eq("id", CLIENT_ID).execute()
        return {"success": True, "detail": "Reply delay reset to the default (~8s)."}

    lo = float(min_seconds if min_seconds is not None else max_seconds)
    hi = float(max_seconds if max_seconds is not None else min_seconds)
    if lo < 0 or hi < lo:
        return {"success": False, "detail": "delay range must be 0 <= min <= max"}
    if hi > MAX_REPLY_DELAY_SECONDS:
        return {"success": False,
                "detail": f"max is {MAX_REPLY_DELAY_SECONDS}s — the reply runs inside a 60s serverless "
                          f"window (wait + writing + sending), longer waits would kill the reply entirely"}

    get_supabase_client().table("clients").update(
        {"reply_delay_min_seconds": lo, "reply_delay_max_seconds": hi}
    ).eq("id", CLIENT_ID).execute()
    return {"success": True,
            "detail": f"Setter now waits {lo:g}–{hi:g}s before replying (live on the next reply)."}


# ════════════════════════════════════════════════════════════════════
# Phase 4 — lead lookup (READ ONLY)
# ════════════════════════════════════════════════════════════════════

def lookup_lead(name: str) -> dict:
    """Where's John? — stage, source, last message time, ai_paused, language."""
    supabase = get_supabase_client()
    rows = (
        supabase.table("leads")
        .select("id, full_name, stage, funnel_stage, stage_data, source, last_message_at, ai_paused, conversation_language, ig_username")
        .ilike("full_name", f"%{name.strip()}%")
        .order("last_message_at", desc=True)
        .limit(8)
        .execute()
    ).data or []
    # enrich with effective_source from the reporting view
    if rows:
        try:
            ids = [r["id"] for r in rows]
            rep = (
                supabase.table("reporting_leads")
                .select("id, effective_source, is_real_prospect")
                .in_("id", ids).execute()
            ).data or []
            by_id = {r["id"]: r for r in rep}
            for r in rows:
                extra = by_id.get(r["id"], {})
                r["effective_source"] = extra.get("effective_source") or r.get("source")
                r["is_real_prospect"] = extra.get("is_real_prospect")
        except Exception as e:
            console.log(f"[yellow]⚠ lead lookup enrich failed: {e}[/yellow]")
    return {"success": True, "matches": rows}


def list_stage_leads(stage: str, limit: int = 30) -> dict:
    """Who's in <stage>? — real prospects in that GHL stage."""
    rows = (
        get_supabase_client().table("reporting_leads")
        .select("id, full_name, effective_source, lead_date, stage")
        .eq("is_real_prospect", True)
        .ilike("stage", f"%{stage.strip()}%")
        .limit(limit)
        .execute()
    ).data or []
    return {"success": True, "stage": stage, "count": len(rows), "leads": rows}


# ════════════════════════════════════════════════════════════════════
# Phase 6 — record corrections (delete / fix) with append-only audit
# ════════════════════════════════════════════════════════════════════

def _append_correction(lead_id: Optional[str], action: str, details: dict,
                       reason: Optional[str], by: str):
    """events are APPEND-ONLY: one 'record_correction' row per correction."""
    _log_event(get_supabase_client(), "record_correction", lead_id, {
        "action": action,
        **details,
        "reason": reason,
        "corrected_by": by,
        "corrected_at": _now_iso(),
    })


def list_customer_payments(customer_id: str) -> dict:
    rows = (
        get_supabase_client().table("payments")
        .select("id, amount, currency, kind, collected_at, logged_by, note")
        .eq("customer_id", customer_id)
        .order("collected_at")
        .execute()
    ).data or []
    return {"success": True, "payments": rows}


def delete_customer_record(customer_id: str, reason: str, by: str = OWNER_NAME,
                           ghl_stage: Optional[str] = None) -> dict:
    """
    Hard-delete a customer + their payments (+ scheduled payments). If the
    customer is tied to a real lead (lead_id set), also move the GHL stage out
    of 'Client Won' (caller passes the picked stage, default 'Lead Lost').
    One 'record_correction' event captures everything removed.
    """
    supabase = get_supabase_client()
    cust = (
        supabase.table("customers")
        .select("id, name, lead_id, ghl_contact_id, contract_value, currency, closer, closed_at")
        .eq("id", customer_id).limit(1).execute()
    ).data
    if not cust:
        return {"success": False, "detail": f"no customer with id {customer_id}"}
    cust = cust[0]

    payments = list_customer_payments(customer_id)["payments"]

    # children first: scheduled payments, then payments, then the customer
    supabase.table("scheduled_payments").delete().eq("customer_id", customer_id).execute()
    supabase.table("payments").delete().eq("customer_id", customer_id).execute()
    supabase.table("customers").delete().eq("id", customer_id).execute()

    ghl_txt = ""
    if cust.get("lead_id"):
        target_stage = ghl_stage or "Lead Lost"
        lead = (
            supabase.table("leads")
            .select("id, full_name, ghl_contact_id, ghl_opportunity_id")
            .eq("id", cust["lead_id"]).limit(1).execute()
        ).data
        if lead:
            ghl = move_lead_stage(lead[0], target_stage)
            ghl_txt = f" {ghl['detail']}." if ghl["success"] else f" ⚠ {ghl['detail']}."

    _append_correction(cust.get("lead_id"), "delete_customer", {
        "customer": {k: cust.get(k) for k in ("id", "name", "contract_value", "currency", "closer", "closed_at")},
        "payments_removed": [
            {k: p.get(k) for k in ("id", "amount", "kind", "collected_at", "logged_by")} for p in payments
        ],
        "ghl_stage_moved_to": (ghl_stage or "Lead Lost") if cust.get("lead_id") else None,
    }, reason, by)

    total = sum(float(p["amount"] or 0) for p in payments)
    return {"success": True,
            "detail": f"Deleted customer {cust['name']} — contract {cust['contract_value']}, "
                      f"{len(payments)} payment(s) totalling {total:g} removed.{ghl_txt} "
                      f"Audit kept as a record_correction event. Money reports update immediately."}


def delete_payment_record(payment_id: str, reason: str, by: str = OWNER_NAME) -> dict:
    """Void one payment (contract_value untouched). Appends record_correction."""
    supabase = get_supabase_client()
    pay = (
        supabase.table("payments")
        .select("id, customer_id, lead_id, amount, currency, kind, collected_at, logged_by")
        .eq("id", payment_id).limit(1).execute()
    ).data
    if not pay:
        return {"success": False, "detail": f"no payment with id {payment_id}"}
    pay = pay[0]

    # unhook any scheduled collection that this payment had auto-collected
    supabase.table("scheduled_payments").update(
        {"status": "pending", "payment_id": None}
    ).eq("payment_id", payment_id).execute()
    supabase.table("payments").delete().eq("id", payment_id).execute()

    _append_correction(pay.get("lead_id"), "delete_payment", {
        "payment": {k: pay.get(k) for k in ("id", "customer_id", "amount", "currency", "kind", "collected_at", "logged_by")},
    }, reason, by)

    return {"success": True,
            "detail": f"Removed the {pay['amount']:g} {pay['currency']} {pay['kind']} payment. "
                      f"Contract value untouched. Audit kept; money reports update immediately."}


def update_payment_amount(payment_id: str, new_amount: float, reason: str, by: str = OWNER_NAME) -> dict:
    """Fix a payment's amount. Appends record_correction with before → after."""
    supabase = get_supabase_client()
    pay = (
        supabase.table("payments")
        .select("id, lead_id, customer_id, amount, currency, kind")
        .eq("id", payment_id).limit(1).execute()
    ).data
    if not pay:
        return {"success": False, "detail": f"no payment with id {payment_id}"}
    pay = pay[0]
    if pay["kind"] == "refund" and new_amount > 0:
        new_amount = -abs(new_amount)  # refunds stay negative

    supabase.table("payments").update({"amount": new_amount}).eq("id", payment_id).execute()
    _append_correction(pay.get("lead_id"), "update_payment_amount", {
        "payment_id": payment_id, "customer_id": pay.get("customer_id"),
        "kind": pay["kind"], "before": pay["amount"], "after": new_amount,
    }, reason, by)
    return {"success": True,
            "detail": f"Payment fixed: {float(pay['amount']):g} → {new_amount:g} {pay['currency']}. "
                      f"Audit kept; money reports update immediately."}


def update_contract_value(customer_id: str, new_value: float, reason: str, by: str = OWNER_NAME) -> dict:
    """Fix customers.contract_value. Appends record_correction with before → after."""
    supabase = get_supabase_client()
    cust = (
        supabase.table("customers")
        .select("id, name, lead_id, contract_value, currency")
        .eq("id", customer_id).limit(1).execute()
    ).data
    if not cust:
        return {"success": False, "detail": f"no customer with id {customer_id}"}
    cust = cust[0]

    supabase.table("customers").update({"contract_value": new_value}).eq("id", customer_id).execute()
    _append_correction(cust.get("lead_id"), "update_contract_value", {
        "customer_id": customer_id, "name": cust["name"],
        "before": cust["contract_value"], "after": new_value,
    }, reason, by)
    return {"success": True,
            "detail": f"{cust['name']}'s contract fixed: {float(cust['contract_value']):g} → {new_value:g} "
                      f"{cust['currency']}. Audit kept; LTV/outstanding update immediately."}


# ════════════════════════════════════════════════════════════════════
# Phase 7 — CSV export (read-only query → Telegram document to the owner)
# ════════════════════════════════════════════════════════════════════

def export_csv(sql: str, filename: str = "export.csv") -> dict:
    """
    Run a READ-ONLY query through the existing reporting path (SELECT-only
    validator + run_reporting_query RPC) and send the rows to the OWNER as a
    Telegram CSV document.
    """
    from telegram_bot.reporting_skill import run_reporting_sql

    result = run_reporting_sql(sql)
    if "error" in result:
        return {"success": False, "detail": result["error"]}
    rows = result["rows"]
    if not rows:
        return {"success": False, "detail": "query returned no rows — nothing to export"}

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    csv_bytes = buf.getvalue().encode("utf-8")

    if not filename.endswith(".csv"):
        filename += ".csv"

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_AUTHORIZED_USER_ID") or str(OWNER_CHAT_ID)
    if not token:
        return {"success": False, "detail": "TELEGRAM_BOT_TOKEN not set — can't send the file"}
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendDocument",
            data={"chat_id": chat_id},
            files={"document": (filename, csv_bytes, "text/csv")},
            timeout=30,
        )
        if not resp.ok:
            return {"success": False, "detail": f"Telegram sendDocument failed: {resp.status_code} {resp.text[:200]}"}
    except Exception as e:
        return {"success": False, "detail": f"sendDocument error: {e}"}

    return {"success": True, "detail": f"Sent {filename} — {len(rows)} rows."}


# ════════════════════════════════════════════════════════════════════
# Phase 8 — team management
# ════════════════════════════════════════════════════════════════════

def add_team_member(name: str, role: str, by: str = OWNER_NAME) -> dict:
    """Create a team member with a one-time registration code."""
    if role not in VALID_TEAM_ROLES:
        return {"success": False, "detail": f"role must be one of {VALID_TEAM_ROLES}"}
    name = (name or "").strip()
    if not name:
        return {"success": False, "detail": "need a name"}

    supabase = get_supabase_client()
    existing = (
        supabase.table("team_members").select("id, name")
        .eq("active", True).ilike("name", name).execute()
    ).data
    if existing:
        return {"success": False, "detail": f"an active member named {existing[0]['name']} already exists"}

    code = f"{secrets.randbelow(1_000_000):06d}"
    supabase.table("team_members").insert({
        "client_id": CLIENT_ID,
        "name": name,
        "role": role,
        "active": True,
        "registration_code": code,
    }).execute()
    return {"success": True, "code": code,
            "detail": f"Added {name} as {role}. One-time access code: {code} — "
                      f"have them DM this bot just that code."}


def change_member_role(member_name: str, new_role: str, by: str = OWNER_NAME) -> dict:
    if new_role not in VALID_TEAM_ROLES:
        return {"success": False, "detail": f"role must be one of {VALID_TEAM_ROLES}"}
    supabase = get_supabase_client()
    rows = (
        supabase.table("team_members").select("id, name, role")
        .eq("active", True).ilike("name", f"%{member_name.strip()}%").execute()
    ).data or []
    if not rows:
        return {"success": False, "detail": f"no active member matches '{member_name}'"}
    if len(rows) > 1:
        return {"success": False, "detail": f"{len(rows)} members match — which one? " + ", ".join(r["name"] for r in rows)}
    member = rows[0]
    supabase.table("team_members").update({"role": new_role}).eq("id", member["id"]).execute()
    return {"success": True, "detail": f"{member['name']} is now a {new_role} (was {member['role']}). "
                                       f"Their chat now gets the {new_role} flows."}


def deactivate_member(member_name: str, by: str = OWNER_NAME) -> dict:
    supabase = get_supabase_client()
    rows = (
        supabase.table("team_members").select("id, name, role")
        .eq("active", True).ilike("name", f"%{member_name.strip()}%").execute()
    ).data or []
    if not rows:
        return {"success": False, "detail": f"no active member matches '{member_name}'"}
    if len(rows) > 1:
        return {"success": False, "detail": f"{len(rows)} members match — which one? " + ", ".join(r["name"] for r in rows)}
    member = rows[0]
    supabase.table("team_members").update({"active": False}).eq("id", member["id"]).execute()
    return {"success": True, "detail": f"Removed {member['name']} ({member['role']}) — their chat no longer has access. "
                                       f"Their logged history is kept."}


# ════════════════════════════════════════════════════════════════════
# Tag control — add/remove ANY tag on a lead's GHL contact (owner only)
# ════════════════════════════════════════════════════════════════════

def set_lead_tag(lead_id: str, tag: str, action: str) -> dict:
    """
    Add or remove ANY tag on the lead's GHL contact (same endpoint the
    pause/resume helpers use; GHL lowercases tags). action: 'add' | 'remove'.
    """
    import httpx
    from telegram_bot.setter_control import get_ghl_creds, get_ghl_headers, GHL_BASE_URL

    tag = (tag or "").strip().lower()
    if not tag:
        return {"success": False, "detail": "need a tag"}
    if action not in ("add", "remove"):
        return {"success": False, "detail": "action must be add or remove"}

    lead = (
        get_supabase_client().table("leads")
        .select("id, full_name, ghl_contact_id")
        .eq("id", lead_id).limit(1).execute()
    ).data
    if not lead:
        return {"success": False, "detail": f"no lead with id {lead_id} — use lookup_lead first"}
    lead = lead[0]
    if not lead.get("ghl_contact_id"):
        return {"success": False, "detail": f"{lead.get('full_name')} has no GHL contact id"}

    try:
        creds = get_ghl_creds()
        url = f"{GHL_BASE_URL}/contacts/{lead['ghl_contact_id']}/tags"
        with httpx.Client(headers=get_ghl_headers(creds["api_key"]), timeout=30) as client:
            if action == "add":
                resp = client.post(url, json={"tags": [tag]})
            else:
                resp = client.request(method="DELETE", url=url, json={"tags": [tag]})
            resp.raise_for_status()
    except Exception as e:
        return {"success": False, "detail": f"GHL tag {action} failed: {e}"}

    verb = "Added" if action == "add" else "Removed"
    prep = "to" if action == "add" else "from"
    return {"success": True,
            "detail": f"{verb} tag '{tag}' {prep} {lead.get('full_name') or 'the lead'} in GHL."}


# ════════════════════════════════════════════════════════════════════
# Weekly follower count (owner)
# ════════════════════════════════════════════════════════════════════

def _last_week_monday() -> str:
    """The Monday of LAST week, Stockholm time (what Monday's ask refers to)."""
    today = datetime.now(BUSINESS_TZ).date()
    this_monday = today - timedelta(days=today.weekday())
    return (this_monday - timedelta(days=7)).isoformat()


def set_followers_gained(count: int, week_start: Optional[str] = None,
                         by: str = OWNER_NAME) -> dict:
    """Upsert follower_counts for a week (default: last week's Monday)."""
    try:
        count = int(count)
    except Exception:
        return {"success": False, "detail": f"'{count}' is not a number"}
    if count < 0:
        return {"success": False, "detail": "follower count can't be negative"}

    week = week_start or _last_week_monday()
    try:
        date.fromisoformat(week)
    except Exception:
        return {"success": False, "detail": f"'{week}' is not a date (YYYY-MM-DD)"}

    get_supabase_client().table("follower_counts").upsert(
        {"week_start": week, "followers_gained": count,
         "recorded_at": _now_iso(), "recorded_by": by},
        on_conflict="week_start",
    ).execute()
    return {"success": True,
            "detail": f"Logged {count} followers gained for the week of {week}."}


# ════════════════════════════════════════════════════════════════════
# Dialing marker (owner) — the one booking method with no automatic signal
# ════════════════════════════════════════════════════════════════════

def mark_dial_booking(lead_id: str, by: str = OWNER_NAME) -> dict:
    """Set a lead's booking_method to 'dialing' (explicit owner statement —
    overrides any auto-detected method)."""
    supabase = get_supabase_client()
    lead = (
        supabase.table("leads")
        .select("id, full_name, booking_method")
        .eq("id", lead_id).limit(1).execute()
    ).data
    if not lead:
        return {"success": False, "detail": f"no lead with id {lead_id} — use lookup_lead first"}
    lead = lead[0]
    supabase.table("leads").update({"booking_method": "dialing"}).eq("id", lead_id).execute()
    prev = lead.get("booking_method")
    note = f" (was {prev})" if prev and prev != "dialing" else ""
    return {"success": True,
            "detail": f"{lead.get('full_name') or 'Lead'} marked as booked from a dial{note}."}

def save_note(content: str, by: str = OWNER_NAME) -> dict:
    content = (content or "").strip()
    if not content:
        return {"success": False, "detail": "nothing to remember"}
    get_supabase_client().table("notes").insert({
        "client_id": CLIENT_ID,
        "content": content,
        "created_by": by,
    }).execute()
    return {"success": True, "detail": f"Noted: \"{content[:120]}{'…' if len(content) > 120 else ''}\""}


def search_notes(query: str, limit: int = 10) -> dict:
    rows = (
        get_supabase_client().table("notes")
        .select("content, created_at, created_by")
        .ilike("content", f"%{(query or '').strip()}%")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    ).data or []
    return {"success": True, "count": len(rows), "notes": rows}
