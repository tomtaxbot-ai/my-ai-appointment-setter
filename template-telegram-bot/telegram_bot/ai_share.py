"""
AI-BOOKED MAJORITY CALC — who actually handled the conversation?

When a lead becomes booked with booking_method='ai_dm', compute from the
messages up to the booking whether the AI or a human carried the thread:

  - Count REPLY TURNS: consecutive messages from the SAME sender collapse to
    ONE turn (an AI 4-burst = 1 AI turn). Any intervening message from a
    different sender (including the lead) ends the run.
  - Only roles 'ai' and 'human' count as turns; 'lead' messages never count
    (but they do break a run).
  - leads.ai_message_share = ai_turns / (ai_turns + human_turns)
  - leads.ai_booked = ai_turns >= human_turns

booking_method != 'ai_dm' leaves ai_booked null ("calls booked by Jarvis" =
bookings where ai_booked is true). Runs on the existing scheduler tick,
idempotent: only processes ai_dm leads whose ai_booked is still null.
"""

from datetime import datetime, timezone
from typing import Optional

from rich.console import Console

from telegram_bot.setter_control import get_supabase_client

console = Console()


def compute_ai_share(messages: list[dict]) -> Optional[dict]:
    """
    Pure turn-counting over chronologically-ordered messages
    [{"role": "ai"|"human"|"lead", ...}].

    Returns {"ai_turns", "human_turns", "share", "ai_booked"} or None when
    there are no AI/human turns at all (nothing to judge).
    """
    ai_turns = 0
    human_turns = 0
    prev_role = None
    for m in messages:
        role = m.get("role")
        if role in ("ai", "human") and role != prev_role:
            if role == "ai":
                ai_turns += 1
            else:
                human_turns += 1
        prev_role = role

    total = ai_turns + human_turns
    if total == 0:
        return None
    share = ai_turns / total
    return {
        "ai_turns": ai_turns,
        "human_turns": human_turns,
        "share": round(share, 4),
        "ai_booked": ai_turns >= human_turns,
    }


def run_ai_booked_calc(now_utc: Optional[datetime] = None) -> dict:
    """
    Scheduler hook: for every lead with booking_method='ai_dm' and ai_booked
    still null, compute the share from messages up to the booking (the
    call_booked / booking_method_set event time when available, else all
    messages) and persist ai_message_share + ai_booked. Never raises.
    """
    summary = {"processed": 0, "skipped": 0, "errors": 0}
    try:
        supabase = get_supabase_client()
        leads = (
            supabase.table("leads")
            .select("id, full_name")
            .eq("booking_method", "ai_dm")
            .is_("ai_booked", "null")
            .limit(50)
            .execute()
        ).data or []

        for lead in leads:
            try:
                # Booking moment: prefer the explicit booking events.
                booked_at = None
                ev = (
                    supabase.table("events")
                    .select("created_at")
                    .eq("lead_id", lead["id"])
                    .in_("event_type", ["call_booked", "booking_method_set"])
                    .order("created_at")
                    .limit(1)
                    .execute()
                ).data
                if ev:
                    booked_at = ev[0]["created_at"]

                q = (
                    supabase.table("messages")
                    .select("role, created_at")
                    .eq("lead_id", lead["id"])
                    .order("created_at")
                )
                if booked_at:
                    q = q.lte("created_at", booked_at)
                msgs = q.execute().data or []

                result = compute_ai_share(msgs)
                if result is None:
                    summary["skipped"] += 1  # no ai/human turns yet — retry next tick
                    continue

                supabase.table("leads").update(
                    {"ai_message_share": result["share"], "ai_booked": result["ai_booked"]}
                ).eq("id", lead["id"]).execute()
                summary["processed"] += 1
                console.log(
                    f"[green]✓ ai-share {lead.get('full_name')}: "
                    f"{result['ai_turns']}v{result['human_turns']} → share {result['share']}, "
                    f"ai_booked={result['ai_booked']}[/green]"
                )
            except Exception as inner:
                summary["errors"] += 1
                console.log(f"[red]✗ ai-share for lead {lead.get('id')} failed: {inner}[/red]")
    except Exception as e:
        summary["errors"] += 1
        console.log(f"[red]✗ ai-booked calc failed: {type(e).__name__}: {e}[/red]")
    return summary
