"""
Proactive Telegram sender for scheduler jobs (no Update object, no event loop).

Uses the raw Bot API over HTTPS so it's safe to call from APScheduler threads —
no interaction with the python-telegram-bot polling loop, no asyncio at all.
Never raises: a failed ping is logged and dropped (jobs must keep running).
"""

import os

import requests
from rich.console import Console

from config.settings import TELEGRAM_MAX_MESSAGE_LENGTH

console = Console()


def send_telegram(text: str) -> bool:
    """Send a plain-text message to Maher. Returns True if every chunk sent."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_AUTHORIZED_USER_ID")
    if not token or not chat_id or not text:
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    ok = True
    for i in range(0, len(text), TELEGRAM_MAX_MESSAGE_LENGTH):
        chunk = text[i : i + TELEGRAM_MAX_MESSAGE_LENGTH]
        try:
            resp = requests.post(
                url, json={"chat_id": chat_id, "text": chunk}, timeout=15
            )
            if not resp.ok:
                console.log(f"[yellow]⚠ telegram notify failed: {resp.status_code} {resp.text[:200]}[/yellow]")
                ok = False
        except Exception as e:
            console.log(f"[yellow]⚠ telegram notify error: {type(e).__name__}: {e}[/yellow]")
            ok = False
    return ok
