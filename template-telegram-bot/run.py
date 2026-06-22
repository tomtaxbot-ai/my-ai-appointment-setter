"""
SETTER REMOTE CONTROL — Main Entry Point

Runs:
  1. Telegram bot (the interface)
  2. APScheduler background jobs:
     - Team reminders every 10 min (daily role nudges, post-call follow-ups,
       collections due, weekly follower ask, setter auto-resume, ai-share calc)
"""

import os

from dotenv import load_dotenv

load_dotenv()  # MUST be first, before any imports that read env vars

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from rich.console import Console

console = Console()


# ────────────────────────────────────────────────────────────
# Background jobs
# ────────────────────────────────────────────────────────────

def team_reminders():
    """Proactive team reminders (every 10 min): daily role nudges at each
    member's local time, per-call follow-ups after appointments, collections
    due, the weekly follower ask, setter auto-resume, and the ai-share calc."""
    try:
        from telegram_bot.reminders import (
            run_reminder_tick,
            run_closer_call_followups,
            run_collections_check,
            run_follower_ask,
        )
        from telegram_bot.admin_flows import run_setter_resume_check
        from telegram_bot.ai_share import run_ai_booked_calc
        tick = run_reminder_tick()
        followups = run_closer_call_followups()
        collections = run_collections_check()
        resume = run_setter_resume_check()
        followers = run_follower_ask()
        ai_share = run_ai_booked_calc()
        if (tick.get("sent") or followups.get("prompted") or collections.get("reminded")
                or resume.get("resumed") or followers.get("asked") or ai_share.get("processed")
                or tick.get("errors") or followups.get("errors") or collections.get("errors")
                or resume.get("errors") or followers.get("errors") or ai_share.get("errors")):
            console.log(
                f"[scheduler] Team reminders: {tick} | call follow-ups: {followups} | "
                f"collections: {collections} | setter resume: {resume} | "
                f"follower ask: {followers} | ai-share: {ai_share}"
            )
    except Exception as e:
        console.log(f"[scheduler] Team reminders failed: {e}")


# ────────────────────────────────────────────────────────────
# Schedule everything
# ────────────────────────────────────────────────────────────

def start_scheduler():
    """Configure and start the background scheduler."""
    sched = BackgroundScheduler(timezone="UTC")

    # Team reminders: every 10 minutes (daily role nudges + post-call follow-ups)
    sched.add_job(team_reminders, CronTrigger(minute="*/10"), id="team_reminders")

    sched.start()
    console.log("[bold green]Scheduler running.[/bold green]")
    console.log("[dim]Team reminders: every 10 min[/dim]")
    return sched


# ────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────

def main():
    console.rule("[bold magenta]SETTER REMOTE CONTROL — Starting Up[/bold magenta]")

    # Verify essentials
    if not os.getenv("ANTHROPIC_API_KEY"):
        console.print("[red]ANTHROPIC_API_KEY not set. Aborting.[/red]")
        return
    if not os.getenv("TELEGRAM_BOT_TOKEN"):
        console.print("[red]TELEGRAM_BOT_TOKEN not set. Aborting.[/red]")
        return

    # Start scheduler
    start_scheduler()

    # Run Telegram bot (blocking)
    from telegram_bot.bot import run_bot
    run_bot()


if __name__ == "__main__":
    main()
