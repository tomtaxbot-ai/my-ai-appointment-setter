"""
Central config for the Setter Remote Control bot.

Only the constants the Telegram bot actually imports live here. Secrets are
NEVER hardcoded — they come from the environment (see .env.example).
"""

# ── CLAUDE MODEL CHOICE ──
# Heavy lifting (reporting, capture, admin, setter agents): Sonnet
# Light lifting (intent router, conversation, parsers): Haiku
MODEL_HEAVY = "claude-sonnet-4-6"
MODEL_LIGHT = "claude-haiku-4-5-20251001"

# ── TELEGRAM ──
TELEGRAM_MAX_MESSAGE_LENGTH = 4000  # split longer messages
