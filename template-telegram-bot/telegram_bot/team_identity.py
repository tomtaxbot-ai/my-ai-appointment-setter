"""
TEAM IDENTITY — who is this Telegram chat, and what are they allowed to do?

Roles:
  - owner  : the owner (chat id = TELEGRAM_AUTHORIZED_USER_ID).
             Full access to everything.
  - closer : Ethan — ONLY the call-outcome flow + his own numbers.
  - setter : Isaiah — ONLY the daily-activity flow + his own numbers.
  - unknown: anyone else — registration-code check, otherwise no access.

Registration (secure linking of a chat id to a seeded team_members row):
  1. Owner says "register Ethan" → a random 6-digit code is stored in that
     member's team_members.registration_code and shown to the owner to pass on.
  2. The member DMs the bot just the 6-digit code → their chat id is written
     to team_members.telegram_chat_id, registered_at is stamped, and the code
     is cleared (single use).

Role resolution hits Supabase but is cached for 60s per chat id so normal
conversation doesn't add a query per message.
"""

import os
import re
import time
import secrets
from datetime import datetime, timezone

from rich.console import Console

from telegram_bot.setter_control import get_supabase_client

console = Console()

# Owner's Telegram chat id — the only chat treated as "owner". Comes from env.
OWNER_CHAT_ID = int(os.getenv("TELEGRAM_AUTHORIZED_USER_ID", "0") or 0)
# Owner's client row UUID in Supabase (clients.id). Comes from env.
CLIENT_ID = os.getenv("OWNER_CLIENT_ID", "")

# "register Ethan" / "register isaiah ross" (owner-only command)
REGISTER_RE = re.compile(r"^\s*register\s+(?P<name>[A-Za-zÀ-ÿ' .-]{2,40})\s*$", re.IGNORECASE)

# A message that is JUST a 6-digit code (unknown-chat registration attempt)
CODE_RE = re.compile(r"^\s*(?P<code>\d{6})\s*$")

# chat_id -> {"resolved_at": epoch, "result": {...}} (60s TTL)
_role_cache: dict = {}
_ROLE_CACHE_TTL = 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clear_role_cache(chat_id: int = None):
    """Drop cached role(s) — call after a registration so it takes effect now."""
    if chat_id is None:
        _role_cache.clear()
    else:
        _role_cache.pop(int(chat_id), None)


def resolve_role(chat_id: int, authorized_user_id: int = 0) -> dict:
    """
    Resolve a Telegram chat id to a role.

    Returns {"role": "owner"|"closer"|"setter"|"unknown", "member": dict|None}
    member = the team_members row (id, name, role) for closer/setter.
    """
    chat_id = int(chat_id)

    if chat_id == OWNER_CHAT_ID or (authorized_user_id and chat_id == authorized_user_id):
        return {"role": "owner", "member": None}

    cached = _role_cache.get(chat_id)
    if cached and (time.time() - cached["resolved_at"]) < _ROLE_CACHE_TTL:
        return cached["result"]

    result = {"role": "unknown", "member": None}
    try:
        supabase = get_supabase_client()
        res = (
            supabase.table("team_members")
            .select("id, name, role")
            .eq("telegram_chat_id", str(chat_id))
            .eq("active", True)
            .limit(1)
            .execute()
        )
        if res.data:
            member = res.data[0]
            if member["role"] in ("closer", "setter"):
                result = {"role": member["role"], "member": member}
    except Exception as e:
        console.log(f"[red]✗ role resolution failed for chat {chat_id}: {e}[/red]")
        # fail closed: unknown

    _role_cache[chat_id] = {"resolved_at": time.time(), "result": result}
    return result


def start_registration(name_query: str) -> dict:
    """
    OWNER action: generate a 6-digit registration code for a seeded team member
    matched by name (case-insensitive substring).

    Returns:
        {"success": True, "member_name", "role", "code"}
        {"success": False, "message", "matches": [names]} on none/ambiguous
    """
    supabase = get_supabase_client()
    res = (
        supabase.table("team_members")
        .select("id, name, role, telegram_chat_id")
        .eq("active", True)
        .ilike("name", f"%{name_query.strip()}%")
        .execute()
    )
    rows = res.data or []

    if not rows:
        return {"success": False, "message": f"No active team member matches '{name_query}'.", "matches": []}
    if len(rows) > 1:
        names = [r["name"] for r in rows]
        return {"success": False, "message": f"{len(rows)} members match '{name_query}' — which one?", "matches": names}

    member = rows[0]
    code = f"{secrets.randbelow(1_000_000):06d}"
    supabase.table("team_members").update(
        {"registration_code": code}
    ).eq("id", member["id"]).execute()

    return {
        "success": True,
        "member_name": member["name"],
        "role": member["role"],
        "code": code,
        "already_linked": bool(member.get("telegram_chat_id")),
    }


def set_member_reminder(name_query: str, hour: int = None, minute: int = None,
                        tz: str = None, enabled: bool = None) -> dict:
    """
    OWNER action: update a member's daily-reminder config. Only the fields
    provided are changed ("set Isaiah's reminder to 9pm" keeps his timezone).

    Returns {"success": True, "member_name", "settings": {...}} or
            {"success": False, "message", "matches": [names]}.
    """
    supabase = get_supabase_client()
    res = (
        supabase.table("team_members")
        .select("id, name, role, reminder_enabled, reminder_hour, reminder_minute, reminder_tz")
        .eq("active", True)
        .ilike("name", f"%{name_query.strip()}%")
        .execute()
    )
    rows = res.data or []
    if not rows:
        return {"success": False, "message": f"No active team member matches '{name_query}'.", "matches": []}
    if len(rows) > 1:
        names = [r["name"] for r in rows]
        return {"success": False, "message": f"{len(rows)} members match '{name_query}' — which one?", "matches": names}
    member = rows[0]

    fields = {}
    if hour is not None:
        if not (0 <= int(hour) <= 23):
            return {"success": False, "message": f"hour must be 0-23, got {hour}", "matches": []}
        fields["reminder_hour"] = int(hour)
        fields["reminder_minute"] = int(minute or 0)
    elif minute is not None:
        fields["reminder_minute"] = int(minute)
    if tz is not None:
        from zoneinfo import ZoneInfo
        try:
            ZoneInfo(tz)
        except Exception:
            return {"success": False, "message": f"'{tz}' is not a valid IANA timezone (e.g. America/New_York).", "matches": []}
        fields["reminder_tz"] = tz
    if enabled is not None:
        fields["reminder_enabled"] = bool(enabled)
    if not fields:
        return {"success": False, "message": "Nothing to change — give a time, timezone, or on/off.", "matches": []}

    supabase.table("team_members").update(fields).eq("id", member["id"]).execute()

    merged = {**member, **fields}
    settings = {
        "enabled": merged.get("reminder_enabled"),
        "time": f"{merged.get('reminder_hour'):02d}:{(merged.get('reminder_minute') or 0):02d}",
        "tz": merged.get("reminder_tz"),
    }
    return {"success": True, "member_name": member["name"], "settings": settings}


def redeem_registration_code(code: str, chat_id: int) -> dict:
    """
    UNKNOWN-chat action: a bare 6-digit code message. If it matches an active
    member's registration_code: link the chat id, stamp registered_at, clear
    the code (single use).

    Returns {"success": True, "member_name", "role"} or {"success": False}.
    """
    supabase = get_supabase_client()
    res = (
        supabase.table("team_members")
        .select("id, name, role")
        .eq("registration_code", code.strip())
        .eq("active", True)
        .limit(1)
        .execute()
    )
    if not res.data:
        return {"success": False}

    member = res.data[0]
    supabase.table("team_members").update(
        {
            "telegram_chat_id": str(int(chat_id)),
            "registered_at": _now_iso(),
            "registration_code": None,
        }
    ).eq("id", member["id"]).execute()

    clear_role_cache(chat_id)
    console.log(f"[green]✓ registered {member['name']} ({member['role']}) → chat {chat_id}[/green]")
    return {"success": True, "member_name": member["name"], "role": member["role"]}
