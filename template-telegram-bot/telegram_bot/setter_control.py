"""
SETTER CONTROL — Jarvis's interface to the AI DM setter

SOURCE OF TRUTH: GoHighLevel (GHL) contacts API
- A "lead" = a GHL contact with the "jarvis" tag
- Pausing = adding "ai off" tag
- Stats = count of "jarvis" tagged contacts
- Bookings = GHL calendar appointments

DUAL-WRITE ON PAUSE/RESUME:
- Pause/resume toggle the GHL "ai off" tag AND mirror the state into the
  ai-setter Supabase leads table (leads.ai_paused, matched on ghl_contact_id)
  so GHL and the ai-setter engine never disagree about whether AI is paused.

Connects to:
- Supabase (read GHL credentials from clients table; write leads.ai_paused)
- GoHighLevel (all lead/stats/booking operations)

Tools:
1. find_lead(query) — search GHL contacts by name
2. pause_lead(contact_id) — add "ai off" tag
3. resume_lead(contact_id) — remove "ai off" tag
4. count_bookings(period) — count GHL calendar appointments
5. setter_stats(period) — count jarvis-tagged contacts
"""

import os
import json
from datetime import datetime, timedelta, timezone
from typing import Optional
import httpx
from supabase import create_client, Client
from rich.console import Console

from telegram_bot.owner import OWNER_SLUG

console = Console()

# ═══════════════════════════════════════════════════════════════
# SUPABASE CONNECTION (only for reading GHL creds)
# ═══════════════════════════════════════════════════════════════

def get_supabase_client() -> Client:
    """Get Supabase client for ai-setter database."""
    url = os.getenv("AISETTER_SUPABASE_URL")
    key = os.getenv("AISETTER_SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise RuntimeError("AISETTER_SUPABASE_URL or AISETTER_SUPABASE_SERVICE_KEY not set in .env")

    return create_client(url, key)


def set_lead_nurture(contact_id: str, on: bool) -> dict:
    """
    Turn the pre-call NURTURE sequence on/off for ONE lead, in the ai-setter
    Supabase leads table (matched on ghl_contact_id). on=True => nurtured;
    on=False => leads.nurture_paused=true (engine skips them).

    Returns {"success": bool, "rows_updated": int, "nurture": "on"|"off", "error": str|None}
    """
    try:
        supabase = get_supabase_client()
        result = (
            supabase.table("leads")
            .update({"nurture_paused": (not on)})
            .eq("ghl_contact_id", contact_id)
            .execute()
        )
        rows = len(result.data) if result.data else 0
        console.log(f"[green]✓ Supabase: nurture {'on' if on else 'off'} on {rows} lead(s) (contact={contact_id})[/green]")
        return {"success": True, "rows_updated": rows, "nurture": "on" if on else "off", "error": None}
    except Exception as e:
        console.log(f"[red]✗ Supabase nurture update failed (contact={contact_id}): {e}[/red]")
        return {"success": False, "rows_updated": 0, "nurture": "on" if on else "off", "error": str(e)}


def set_lead_followup(contact_id: str, on: bool) -> dict:
    """
    Turn the FOLLOW-UP sequence on/off for ONE lead (re-engaging them if they
    go quiet), in Supabase leads.followup_paused (matched on ghl_contact_id).
    on=True => followed up; on=False => followup_paused=true (engine skips them).

    Returns {"success": bool, "rows_updated": int, "followup": "on"|"off", "error": str|None}
    """
    try:
        supabase = get_supabase_client()
        result = (
            supabase.table("leads")
            .update({"followup_paused": (not on)})
            .eq("ghl_contact_id", contact_id)
            .execute()
        )
        rows = len(result.data) if result.data else 0
        console.log(f"[green]✓ Supabase: follow-ups {'on' if on else 'off'} on {rows} lead(s) (contact={contact_id})[/green]")
        return {"success": True, "rows_updated": rows, "followup": "on" if on else "off", "error": None}
    except Exception as e:
        console.log(f"[red]✗ Supabase follow-up update failed (contact={contact_id}): {e}[/red]")
        return {"success": False, "rows_updated": 0, "followup": "on" if on else "off", "error": str(e)}


def set_lead_voice(contact_id: str, on: bool) -> dict:
    """
    Turn VOICE NOTES on/off for ONE lead, in Supabase leads.voice_paused
    (matched on ghl_contact_id). on=True => can get voice notes; on=False =>
    voice_paused=true (text only for this person). Separate from the system-wide
    voice switch.

    Returns {"success": bool, "rows_updated": int, "voice": "on"|"off", "error": str|None}
    """
    try:
        supabase = get_supabase_client()
        result = (
            supabase.table("leads")
            .update({"voice_paused": (not on)})
            .eq("ghl_contact_id", contact_id)
            .execute()
        )
        rows = len(result.data) if result.data else 0
        console.log(f"[green]✓ Supabase: voice {'on' if on else 'off'} on {rows} lead(s) (contact={contact_id})[/green]")
        return {"success": True, "rows_updated": rows, "voice": "on" if on else "off", "error": None}
    except Exception as e:
        console.log(f"[red]✗ Supabase voice update failed (contact={contact_id}): {e}[/red]")
        return {"success": False, "rows_updated": 0, "voice": "on" if on else "off", "error": str(e)}


def set_lead_whale(contact_id: str, on: bool) -> dict:
    """
    Turn WHALE-RADAR alerts on/off for ONE lead, in Supabase leads.whale_paused
    (matched on ghl_contact_id). on=True => can ping for this person; on=False =>
    whale_paused=true (no whale ping for this lead). Separate from the system-wide
    whale radar switch — silences just this person while the radar keeps running.

    Returns {"success": bool, "rows_updated": int, "whale": "on"|"off", "error": str|None}
    """
    try:
        supabase = get_supabase_client()
        result = (
            supabase.table("leads")
            .update({"whale_paused": (not on)})
            .eq("ghl_contact_id", contact_id)
            .execute()
        )
        rows = len(result.data) if result.data else 0
        console.log(f"[green]✓ Supabase: whale radar {'on' if on else 'off'} on {rows} lead(s) (contact={contact_id})[/green]")
        return {"success": True, "rows_updated": rows, "whale": "on" if on else "off", "error": None}
    except Exception as e:
        console.log(f"[red]✗ Supabase whale update failed (contact={contact_id}): {e}[/red]")
        return {"success": False, "rows_updated": 0, "whale": "on" if on else "off", "error": str(e)}


def _set_ai_paused_in_supabase(contact_id: str, paused: bool) -> dict:
    """
    Mirror the AI pause state into the ai-setter Supabase leads table.

    Matches the lead on ghl_contact_id and sets leads.ai_paused so the
    ai-setter engine and GHL never disagree about whether AI is paused.

    Args:
        contact_id: GHL contact ID (matched against leads.ghl_contact_id)
        paused: True to pause AI (ai_paused=true), False to resume (ai_paused=false)

    Returns:
        {"success": bool, "rows_updated": int, "error": str | None}
    """
    try:
        supabase = get_supabase_client()
        result = (
            supabase.table("leads")
            .update({"ai_paused": paused})
            .eq("ghl_contact_id", contact_id)
            .execute()
        )
        rows_updated = len(result.data) if result.data else 0

        if rows_updated == 0:
            console.log(
                f"[yellow]⚠ Supabase: no lead matched ghl_contact_id={contact_id} "
                f"— ai_paused={paused} NOT written[/yellow]"
            )
        else:
            console.log(
                f"[green]✓ Supabase: set ai_paused={paused} on {rows_updated} "
                f"lead(s) (ghl_contact_id={contact_id})[/green]"
            )

        return {"success": True, "rows_updated": rows_updated, "error": None}

    except Exception as e:
        console.log(
            f"[red]✗ Supabase ai_paused update failed "
            f"(ghl_contact_id={contact_id}, ai_paused={paused}): {e}[/red]"
        )
        return {"success": False, "rows_updated": 0, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
# GHL CLIENT (creds from Supabase, all operations on GHL)
# ═══════════════════════════════════════════════════════════════

def get_ghl_creds() -> dict:
    """
    Read GHL credentials from Supabase clients table (active client = OWNER_SLUG).

    Returns:
        {
            "api_key": str (~40 chars, v2 token),
            "location_id": str
        }
    """
    supabase = get_supabase_client()

    # Get active client (slug = OWNER_SLUG)
    result = supabase.table("clients").select("ghl_api_key, ghl_location_id").eq("slug", OWNER_SLUG).execute()

    if not result.data or len(result.data) == 0:
        raise RuntimeError(f"No active client found in Supabase (slug='{OWNER_SLUG}')")

    client = result.data[0]
    return {
        "api_key": client["ghl_api_key"],
        "location_id": client["ghl_location_id"]
    }


def get_ghl_headers(api_key: str) -> dict:
    """GHL v2 API headers."""
    return {
        "Authorization": f"Bearer {api_key}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
    }


GHL_BASE_URL = "https://services.leadconnectorhq.com"


# ═══════════════════════════════════════════════════════════════
# TOOL 1: find_lead (search GHL contacts)
# ═══════════════════════════════════════════════════════════════

def find_lead(query: str) -> list[dict]:
    """
    Search GHL contacts by name.

    Args:
        query: name to search for (searches contactName, firstName, lastName)

    Returns:
        List of matching contacts:
        [
            {
                "contact_id": str,
                "name": str,
                "ig_handle": str | None,
                "has_jarvis_tag": bool,
                "has_ai_off_tag": bool
            },
            ...
        ]
    """
    ghl_creds = get_ghl_creds()

    try:
        with httpx.Client(headers=get_ghl_headers(ghl_creds["api_key"]), timeout=30) as client:
            # GHL v2 contact search
            url = f"{GHL_BASE_URL}/contacts/"
            params = {
                "locationId": ghl_creds["location_id"],
                "query": query,
                "limit": 20  # Return up to 20 matches
            }

            response = client.get(url, params=params)
            response.raise_for_status()

            data = response.json()
            contacts = data.get("contacts", [])

            results = []
            for contact in contacts:
                tags = contact.get("tags", [])

                # Extract IG handle from custom fields if present
                ig_handle = None
                custom_fields = contact.get("customFields", [])
                for cf in custom_fields:
                    if cf.get("id") == "instagram_handle" or "instagram" in cf.get("key", "").lower():
                        ig_handle = cf.get("value")
                        break

                results.append({
                    "contact_id": contact["id"],
                    "name": contact.get("contactName") or contact.get("firstName", "Unknown"),
                    "ig_handle": ig_handle,
                    "has_jarvis_tag": "jarvis" in tags,
                    "has_ai_off_tag": "ai off" in tags
                })

            return results

    except Exception as e:
        console.log(f"[red]✗ GHL contact search failed: {e}[/red]")
        raise


# ═══════════════════════════════════════════════════════════════
# TOOL 2: pause_lead (add "ai off" tag)
# ═══════════════════════════════════════════════════════════════

def pause_lead(contact_id: str) -> dict:
    """
    Pause AI messaging for a lead.

    Writes BOTH sides so GHL and the ai-setter engine never disagree:
      1. GHL: add the "ai off" tag
      2. Supabase: set leads.ai_paused = True (matched on ghl_contact_id)

    Both writes are attempted; if either fails it is logged clearly and
    reflected in the result.

    Args:
        contact_id: GHL contact ID

    Returns:
        {
            "success": bool,            # True only if BOTH writes succeeded
            "contact_name": str,
            "message": str,
            "ghl_success": bool,
            "supabase_success": bool,
            "supabase_rows_updated": int
        }
    """
    ghl_creds = get_ghl_creds()
    contact_name = "Unknown"
    ghl_success = False
    ghl_error = None

    # ─── Write 1: GHL "ai off" tag ───
    try:
        with httpx.Client(headers=get_ghl_headers(ghl_creds["api_key"]), timeout=30) as client:
            # Get contact name first
            contact_url = f"{GHL_BASE_URL}/contacts/{contact_id}"
            contact_response = client.get(contact_url)
            contact_response.raise_for_status()
            contact_data = contact_response.json()
            contact_name = contact_data.get("contact", {}).get("contactName", "Unknown")

            # Add "ai off" tag
            tag_url = f"{GHL_BASE_URL}/contacts/{contact_id}/tags"
            tag_response = client.post(tag_url, json={"tags": ["ai off"]})
            tag_response.raise_for_status()
            ghl_success = True

    except Exception as e:
        ghl_error = str(e)
        console.log(f"[red]✗ GHL pause failed: {e}[/red]")

    # ─── Write 2: Supabase leads.ai_paused = True ───
    supa = _set_ai_paused_in_supabase(contact_id, True)

    success = ghl_success and supa["success"]
    if success:
        message = (
            f"Paused {contact_name} — 'ai off' tag added "
            f"+ Supabase ai_paused=true ({supa['rows_updated']} row(s))"
        )
    else:
        parts = []
        if not ghl_success:
            parts.append(f"GHL tag add failed: {ghl_error}")
        if not supa["success"]:
            parts.append(f"Supabase ai_paused update failed: {supa['error']}")
        message = f"Pause incomplete for {contact_name} — " + "; ".join(parts)

    return {
        "success": success,
        "contact_name": contact_name,
        "message": message,
        "ghl_success": ghl_success,
        "supabase_success": supa["success"],
        "supabase_rows_updated": supa["rows_updated"],
    }


# ═══════════════════════════════════════════════════════════════
# TOOL 3: resume_lead (remove "ai off" tag)
# ═══════════════════════════════════════════════════════════════

def resume_lead(contact_id: str) -> dict:
    """
    Resume AI messaging for a lead.

    Writes BOTH sides so GHL and the ai-setter engine never disagree:
      1. GHL: remove the "ai off" tag
      2. Supabase: set leads.ai_paused = False (matched on ghl_contact_id)

    Both writes are attempted; if either fails it is logged clearly and
    reflected in the result.

    Args:
        contact_id: GHL contact ID

    Returns:
        {
            "success": bool,            # True only if BOTH writes succeeded
            "contact_name": str,
            "message": str,
            "ghl_success": bool,
            "supabase_success": bool,
            "supabase_rows_updated": int
        }
    """
    ghl_creds = get_ghl_creds()
    contact_name = "Unknown"
    ghl_success = False
    ghl_error = None

    # ─── Write 1: remove GHL "ai off" tag ───
    try:
        with httpx.Client(headers=get_ghl_headers(ghl_creds["api_key"]), timeout=30) as client:
            # Get contact name first
            contact_url = f"{GHL_BASE_URL}/contacts/{contact_id}"
            contact_response = client.get(contact_url)
            contact_response.raise_for_status()
            contact_data = contact_response.json()
            contact_name = contact_data.get("contact", {}).get("contactName", "Unknown")

            # Remove "ai off" tag
            # Use request() method for DELETE with body (httpx.delete() doesn't support body)
            tag_url = f"{GHL_BASE_URL}/contacts/{contact_id}/tags"
            tag_response = client.request(
                method="DELETE",
                url=tag_url,
                json={"tags": ["ai off"]}
            )
            tag_response.raise_for_status()
            ghl_success = True

    except Exception as e:
        ghl_error = str(e)
        console.log(f"[red]✗ GHL resume failed: {e}[/red]")

    # ─── Write 2: Supabase leads.ai_paused = False ───
    supa = _set_ai_paused_in_supabase(contact_id, False)

    success = ghl_success and supa["success"]
    if success:
        message = (
            f"Resumed {contact_name} — 'ai off' tag removed "
            f"+ Supabase ai_paused=false ({supa['rows_updated']} row(s))"
        )
    else:
        parts = []
        if not ghl_success:
            parts.append(f"GHL tag removal failed: {ghl_error}")
        if not supa["success"]:
            parts.append(f"Supabase ai_paused update failed: {supa['error']}")
        message = f"Resume incomplete for {contact_name} — " + "; ".join(parts)

    return {
        "success": success,
        "contact_name": contact_name,
        "message": message,
        "ghl_success": ghl_success,
        "supabase_success": supa["success"],
        "supabase_rows_updated": supa["rows_updated"],
    }


# ═══════════════════════════════════════════════════════════════
# BAN LIST (manual "make this person not exist") — ban / unban / list
# ───────────────────────────────────────────────────────────────
# A ban is the hard version of pause: the person is deleted from GHL AND
# purged from the ai-setter database, and a row is written to the
# `banned_contacts` table so the webhook refuses to ever re-engage them (it
# deletes the GHL contact GHL re-creates the moment they DM again). The row is
# KEPT after an unban (active=false) so there's a full history Maher can review.
#
# Durable identity: GHL mints a NEW contact_id when a deleted contact DMs again,
# so the Instagram handle is the key that survives. We store + match on it
# (normalized) alongside the contact_id.
# ═══════════════════════════════════════════════════════════════


def _normalize_handle(handle: Optional[str]) -> Optional[str]:
    """Lowercase, trim, drop a leading '@'. MUST match the TypeScript side
    (ai-setter/src/lib/bans.ts normalizeHandle) so handles compare equal."""
    if not handle:
        return None
    h = handle.strip().lstrip("@").strip().lower()
    return h or None


def _get_client_id(supabase: Client) -> str:
    """Resolve the active client's UUID (slug=OWNER_SLUG) for ban-row writes."""
    result = supabase.table("clients").select("id").eq("slug", OWNER_SLUG).execute()
    if not result.data:
        raise RuntimeError(f"No active client found in Supabase (slug='{OWNER_SLUG}')")
    return result.data[0]["id"]


def _fetch_ghl_contact_identity(creds: dict, contact_id: str) -> dict:
    """Best-effort read of a GHL contact's name + Instagram handle. Returns
    {"name": str|None, "ig_handle": str|None}; never raises."""
    out = {"name": None, "ig_handle": None}
    try:
        with httpx.Client(headers=get_ghl_headers(creds["api_key"]), timeout=30) as client:
            r = client.get(f"{GHL_BASE_URL}/contacts/{contact_id}")
            r.raise_for_status()
            contact = r.json().get("contact", {})
            out["name"] = contact.get("contactName") or contact.get("firstName")
            for cf in contact.get("customFields", []):
                key = (cf.get("key") or "").lower()
                if cf.get("id") == "instagram_handle" or "instagram" in key:
                    out["ig_handle"] = cf.get("value")
                    break
    except Exception as e:
        console.log(f"[yellow]⚠ GHL contact identity fetch failed ({contact_id}): {e}[/yellow]")
    return out


def _delete_ghl_contact(creds: dict, contact_id: str) -> bool:
    """Permanently delete a contact from GHL. Returns True on success."""
    try:
        with httpx.Client(headers=get_ghl_headers(creds["api_key"]), timeout=30) as client:
            r = client.delete(f"{GHL_BASE_URL}/contacts/{contact_id}")
            r.raise_for_status()
            return True
    except Exception as e:
        console.log(f"[red]✗ GHL contact delete failed ({contact_id}): {e}[/red]")
        return False


def _purge_lead_in_supabase(supabase: Client, contact_id: str) -> int:
    """Delete the ai-setter lead(s) for a GHL contact and all their child rows
    (messages, ai_decisions, events) so nothing about them remains. Children are
    removed first to satisfy foreign keys. Returns the number of lead rows
    deleted. Each step is best-effort and logged."""
    leads = (
        supabase.table("leads").select("id").eq("ghl_contact_id", contact_id).execute()
    )
    lead_ids = [row["id"] for row in (leads.data or [])]
    for lead_id in lead_ids:
        for table in ("messages", "ai_decisions", "events"):
            try:
                supabase.table(table).delete().eq("lead_id", lead_id).execute()
            except Exception as e:
                console.log(f"[yellow]⚠ purge: delete from {table} failed (lead {lead_id}): {e}[/yellow]")
    if lead_ids:
        try:
            supabase.table("leads").delete().eq("ghl_contact_id", contact_id).execute()
        except Exception as e:
            console.log(f"[red]✗ purge: delete lead failed ({contact_id}): {e}[/red]")
            return 0
    return len(lead_ids)


def ban_lead(contact_id: str, reason: Optional[str] = None) -> dict:
    """
    Permanently ban a contact: delete them from GHL, purge them from the
    ai-setter database, and write a ban row so the webhook keeps them out for
    good. Reversible via unban_lead (the row is kept, just marked inactive).

    Args:
        contact_id: GHL contact ID (from find_lead)
        reason: optional note for the ban log

    Returns:
        {"success": bool, "contact_name": str, "ig_username": str|None,
         "message": str, "ghl_deleted": bool, "leads_purged": int}
    """
    creds = get_ghl_creds()
    supabase = get_supabase_client()
    client_id = _get_client_id(supabase)

    # Gather identity (Supabase lead first — most reliable — then GHL contact).
    full_name = None
    ig_username = None
    try:
        lead = (
            supabase.table("leads")
            .select("ig_username, full_name")
            .eq("ghl_contact_id", contact_id)
            .limit(1)
            .execute()
        )
        if lead.data:
            ig_username = lead.data[0].get("ig_username")
            full_name = lead.data[0].get("full_name")
    except Exception as e:
        console.log(f"[yellow]⚠ ban: lead identity read failed: {e}[/yellow]")

    if not full_name or not ig_username:
        ghl_identity = _fetch_ghl_contact_identity(creds, contact_id)
        full_name = full_name or ghl_identity["name"]
        ig_username = ig_username or ghl_identity["ig_handle"]

    contact_name = full_name or "Unknown"
    norm_handle = _normalize_handle(ig_username)

    # 1. Record the ban FIRST so it's enforced even if a delete step fails.
    ban_written = False
    ban_error = None
    try:
        supabase.table("banned_contacts").insert(
            {
                "client_id": client_id,
                "ghl_contact_id": contact_id,
                "ig_username": norm_handle,
                "full_name": full_name,
                "reason": reason,
                "banned_by": "telegram",
                "active": True,
            }
        ).execute()
        ban_written = True
    except Exception as e:
        ban_error = str(e)
        console.log(f"[red]✗ ban: banned_contacts insert failed: {e}[/red]")

    # 2. Delete from GHL. 3. Purge from the ai-setter DB.
    ghl_deleted = _delete_ghl_contact(creds, contact_id)
    leads_purged = _purge_lead_in_supabase(supabase, contact_id)

    success = ban_written  # the ban itself is the thing that must stick
    if success:
        bits = [f"banned {contact_name}"]
        if norm_handle:
            bits.append(f"@{norm_handle}")
        bits.append("deleted from GHL" if ghl_deleted else "GHL delete FAILED")
        bits.append(f"purged {leads_purged} lead row(s)")
        message = " — ".join(bits)
    else:
        message = f"Ban FAILED for {contact_name}: {ban_error}"

    return {
        "success": success,
        "contact_name": contact_name,
        "ig_username": norm_handle,
        "message": message,
        "ghl_deleted": ghl_deleted,
        "leads_purged": leads_purged,
    }


def list_bans() -> dict:
    """List currently active bans so Maher can review them / pick one to unban.

    Returns:
        {"count": int, "bans": [{"id","name","ig_username","ghl_contact_id",
                                 "reason","banned_at"}]}
    """
    supabase = get_supabase_client()
    client_id = _get_client_id(supabase)
    result = (
        supabase.table("banned_contacts")
        .select("id, full_name, ig_username, ghl_contact_id, reason, created_at")
        .eq("client_id", client_id)
        .eq("active", True)
        .order("created_at", desc=True)
        .execute()
    )
    bans = [
        {
            "id": row["id"],
            "name": row.get("full_name") or "Unknown",
            "ig_username": row.get("ig_username"),
            "ghl_contact_id": row.get("ghl_contact_id"),
            "reason": row.get("reason"),
            "banned_at": row.get("created_at"),
        }
        for row in (result.data or [])
    ]
    return {"count": len(bans), "bans": bans}


def unban_lead(query: str) -> dict:
    """
    Lift a ban so the person can enter the system again (treated as a brand-new
    lead next time they DM). Matches active bans by Instagram handle or name.
    The ban row is kept as history (active=false, unbanned_at set).

    Args:
        query: a name or @handle to match against active bans

    Returns:
        {"success": bool, "message": str, "matches": [...]} — when more than one
        active ban matches, success is False and `matches` lists them so Maher
        can pick.
    """
    supabase = get_supabase_client()
    client_id = _get_client_id(supabase)
    norm = _normalize_handle(query) or ""
    q_lower = query.strip().lower()

    active = (
        supabase.table("banned_contacts")
        .select("id, full_name, ig_username, ghl_contact_id, reason, created_at")
        .eq("client_id", client_id)
        .eq("active", True)
        .execute()
    )
    rows = active.data or []

    def matches(row: dict) -> bool:
        handle = (row.get("ig_username") or "").lower()
        name = (row.get("full_name") or "").lower()
        return (norm and norm in handle) or (q_lower and q_lower in name)

    hits = [r for r in rows if matches(r)]

    if not hits:
        return {"success": False, "message": f"No active ban matches '{query}'.", "matches": []}

    if len(hits) > 1:
        return {
            "success": False,
            "message": f"{len(hits)} active bans match '{query}' — which one?",
            "matches": [
                {"id": r["id"], "name": r.get("full_name") or "Unknown", "ig_username": r.get("ig_username")}
                for r in hits
            ],
        }

    target = hits[0]
    try:
        supabase.table("banned_contacts").update(
            {"active": False, "unbanned_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", target["id"]).execute()
    except Exception as e:
        console.log(f"[red]✗ unban update failed: {e}[/red]")
        return {"success": False, "message": f"Unban failed: {e}", "matches": []}

    name = target.get("full_name") or "Unknown"
    handle = target.get("ig_username")
    who = f"{name}" + (f" (@{handle})" if handle else "")
    return {
        "success": True,
        "message": f"Unbanned {who}. They'll be treated as a new lead if they DM again.",
        "matches": [],
    }


# ═══════════════════════════════════════════════════════════════
# TOOL 4: count_bookings (GHL Opportunities - AI Sales Pipeline)
# ═══════════════════════════════════════════════════════════════

# AI Sales Pipeline configuration
AI_SALES_PIPELINE_ID = "guHUTUQU0FaKR1xfTfwT"
BOOKED_STAGE_IDS = [
    "024e4a1c-5b02-40cc-b0f6-751bfc75dd0d",  # Appointment Booked
    "0babb64e-4d6f-4f30-916a-1b6a3036d179",  # Contacted
    "cde26e03-7c92-4f19-9186-fa6b316654d1",  # Appointment Confirmed
]


def count_bookings(period: str = "today") -> dict:
    """
    Count booked calls from GHL Opportunities (AI Sales Pipeline).

    A "booked call" = opportunity in AI Sales Pipeline in a booked stage
    (Appointment Booked, Contacted, or Appointment Confirmed).

    Attribution: AI setter gets credit when contact has "jarvis" tag.

    Args:
        period: "today", "last_7_days", "last_90_days"

    Returns:
        {
            "total_booked": int,       # Total booked in period
            "from_ai_setter": int,     # Contact has "jarvis" tag
            "from_other": int,         # Other sources
            "bookings": [              # Details
                {
                    "name": str,
                    "booked_at": str,  # When entered booked stage
                    "source": str      # "AI Setter" or "Other"
                }
            ]
        }
    """
    ghl_creds = get_ghl_creds()

    # Calculate date range
    now = datetime.now(timezone.utc)
    if period == "today":
        start_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "last_7_days":
        start_date = now - timedelta(days=7)
    elif period == "last_90_days":
        start_date = now - timedelta(days=90)
    else:
        return {
            "total_booked": 0,
            "from_ai_setter": 0,
            "from_other": 0,
            "bookings": [],
            "error": f"Invalid period: {period}"
        }

    start_date_str = start_date.isoformat()

    try:
        with httpx.Client(headers=get_ghl_headers(ghl_creds["api_key"]), timeout=60) as client:
            # Get all opportunities from AI Sales Pipeline
            opps_url = f"{GHL_BASE_URL}/opportunities/search"
            params = {
                "location_id": ghl_creds["location_id"],
                "pipeline_id": AI_SALES_PIPELINE_ID,
                "limit": 100
            }

            response = client.get(opps_url, params=params)
            response.raise_for_status()

            opportunities = response.json().get("opportunities", [])

            # Filter for booked stages + booked in period
            bookings = []
            for opp in opportunities:
                # Check if in a booked stage
                if opp.get("pipelineStageId") not in BOOKED_STAGE_IDS:
                    continue

                # Check if booked in the period
                # Use lastStageChangeAt (when it entered current stage)
                last_stage_change = opp.get("lastStageChangeAt")
                if not last_stage_change:
                    continue

                # Parse date
                try:
                    booked_dt = datetime.fromisoformat(last_stage_change.replace('Z', '+00:00'))
                except:
                    continue

                # Check if in period
                if booked_dt < start_date:
                    continue

                # Check for AI setter attribution (contact has "jarvis" tag)
                contact = opp.get("contact", {})
                contact_tags = contact.get("tags", [])
                is_ai_setter = "jarvis" in contact_tags

                bookings.append({
                    "name": opp.get("name", "Unknown"),
                    "booked_at": booked_dt.strftime("%b %d at %I:%M %p"),
                    "source": "AI Setter" if is_ai_setter else "Other",
                    "is_ai_setter": is_ai_setter
                })

            # Count totals
            total_booked = len(bookings)
            from_ai_setter = sum(1 for b in bookings if b["is_ai_setter"])
            from_other = total_booked - from_ai_setter

            # Clean up bookings for return (remove is_ai_setter flag)
            clean_bookings = [
                {"name": b["name"], "booked_at": b["booked_at"], "source": b["source"]}
                for b in bookings
            ]

            return {
                "total_booked": total_booked,
                "from_ai_setter": from_ai_setter,
                "from_other": from_other,
                "bookings": clean_bookings,
                "period": period,
                "date_field_used": "lastStageChangeAt"
            }

    except Exception as e:
        console.log(f"[yellow]⚠ GHL opportunities query failed: {e}[/yellow]")
        return {
            "total_booked": 0,
            "from_ai_setter": 0,
            "from_other": 0,
            "bookings": [],
            "error": str(e)
        }


# ═══════════════════════════════════════════════════════════════
# TOOL 5: setter_stats (count jarvis-tagged contacts in GHL)
# ═══════════════════════════════════════════════════════════════

def setter_stats(period: str = "today") -> dict:
    """
    Get setter stats from GHL contacts.

    Returns count of contacts with "jarvis" tag (= leads AI is handling)
    and how many of those are paused ("ai off" tag).

    Args:
        period: ignored (stats are current state, not time-based)

    Returns:
        {
            "leads_active": int,  # jarvis tag, no ai off tag
            "leads_paused": int,  # jarvis tag + ai off tag
            "total_jarvis_leads": int
        }
    """
    ghl_creds = get_ghl_creds()

    try:
        with httpx.Client(headers=get_ghl_headers(ghl_creds["api_key"]), timeout=60) as client:
            # Get all contacts and filter for jarvis tag
            # Need to paginate through all contacts
            jarvis_contacts = []
            url = f"{GHL_BASE_URL}/contacts/"
            params = {
                "locationId": ghl_creds["location_id"],
                "limit": 100
            }

            page = 1
            while url and page <= 15:  # Max 15 pages (1500 contacts)
                response = client.get(url, params=params if page == 1 else None)
                response.raise_for_status()
                data = response.json()

                contacts = data.get("contacts", [])
                for contact in contacts:
                    tags = contact.get("tags", [])
                    if "jarvis" in tags:
                        jarvis_contacts.append({
                            "has_ai_off": "ai off" in tags
                        })

                # Check for next page
                url = data.get("meta", {}).get("nextPageUrl")
                page += 1
                params = None  # Next page URL has params already

            # Count active vs paused
            total = len(jarvis_contacts)
            paused = sum(1 for c in jarvis_contacts if c["has_ai_off"])
            active = total - paused

            return {
                "leads_active": active,
                "leads_paused": paused,
                "total_jarvis_leads": total,
                "period": "current"  # Stats are current state
            }

    except Exception as e:
        console.log(f"[red]✗ GHL stats query failed: {e}[/red]")
        return {
            "leads_active": 0,
            "leads_paused": 0,
            "total_jarvis_leads": 0,
            "error": str(e)
        }
