"""
TELEGRAM BOT — The Setter Remote Control

The owner's control surface for the AI Instagram-DM appointment setter:
  - Ask business questions (reporting)
  - Log call outcomes, cash, team activity (capture)
  - Control the setter brain / kill switches / leads (admin + setter)
  - Proactive reminders + tap-to-log outcome buttons

Plain-text mode (no markdown parsing → no crashes on special chars) and
robust message chunking.
"""

import os
import asyncio
import re

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)
from rich.console import Console

from config.settings import TELEGRAM_MAX_MESSAGE_LENGTH
from telegram_bot.owner import OWNER_NAME

console = Console()

AUTHORIZED_USER_ID = int(os.getenv("TELEGRAM_AUTHORIZED_USER_ID", "0") or 0)

# ────────────────────────────────────────────────────────────
# Conversation Memory (in-memory, last 10 messages per user)
# ────────────────────────────────────────────────────────────

# {user_id: [{"role": "user", "content": "..."}, ...]}
conversation_memory = {}
MAX_CONVERSATION_HISTORY = 10

# ────────────────────────────────────────────────────────────
# Conversation State (for multi-turn interactions)
# ────────────────────────────────────────────────────────────

# Reserved for future multi-turn interactions (none currently used)
conversation_state = {}


def add_to_conversation(user_id: int, role: str, content: str):
    """Add a message to the conversation history."""
    if user_id not in conversation_memory:
        conversation_memory[user_id] = []

    conversation_memory[user_id].append({
        "role": role,
        "content": content
    })

    # Keep only last MAX_CONVERSATION_HISTORY messages
    if len(conversation_memory[user_id]) > MAX_CONVERSATION_HISTORY:
        conversation_memory[user_id] = conversation_memory[user_id][-MAX_CONVERSATION_HISTORY:]


def get_conversation_history(user_id: int) -> list:
    """Get recent conversation history for a user."""
    return conversation_memory.get(user_id, [])


def clear_conversation(user_id: int):
    """Clear conversation history for a user."""
    if user_id in conversation_memory:
        del conversation_memory[user_id]


# ────────────────────────────────────────────────────────────
# Authorization
# ────────────────────────────────────────────────────────────

def is_authorized(update: Update) -> bool:
    if not AUTHORIZED_USER_ID:
        return True
    return update.effective_user.id == AUTHORIZED_USER_ID


async def reject_unauthorized(update: Update):
    await update.message.reply_text(
        f"Not authorized. This bot only responds to {OWNER_NAME}."
    )


# ────────────────────────────────────────────────────────────
# Message helpers (plain text — no markdown parsing → never crashes)
# ────────────────────────────────────────────────────────────

async def send_long(update: Update, text: str):
    """Telegram caps at ~4096 chars. Split safely. Plain text = no parse errors."""
    if not text:
        text = "(empty response)"
    chunk_size = TELEGRAM_MAX_MESSAGE_LENGTH
    for i in range(0, len(text), chunk_size):
        await update.message.reply_text(text[i:i + chunk_size])


async def send_long_to_chat(bot, chat_id: int, text: str):
    """For pushing messages from the scheduler (no Update available)."""
    chunk_size = TELEGRAM_MAX_MESSAGE_LENGTH
    for i in range(0, len(text), chunk_size):
        await bot.send_message(chat_id=chat_id, text=text[i:i + chunk_size])


# ────────────────────────────────────────────────────────────
# Command handlers
# ────────────────────────────────────────────────────────────

HELP_TEXT = """🤖 Jarvis — everything you can say, in plain English

📊 REPORTING (ask anything, read-only)
"how many calls booked this month" · "leads by source"
"what's our LTV" · "why aren't calls closing" · "what collections are coming up"

🧠 SETTER BRAIN
"show me the rules" · "add a rule: never mention price first"
"rewrite the pitch to push the workshop" · "undo that"

⚙️ SETTER CONTROLS
"turn the setter off" / "on" · "pause the setter until 9am"
"wait 20 seconds before replying" (reply speed)

👤 LEADS
"where's John?" · "who's in Appointment Booked?"
"move John to [stage]" · "disqualify John"
"add the tag qualified to John" · "remove icp from him"
"turn off AI for John" · "ban X" / "unban X" (setter skill)

💰 MONEY & RECORDS
"call with John — closed, 6k, collected 3k" (call outcomes)
"collected 3k from John" · "John extended for 2k" · "refund 500"
"remind me to collect 1.5k from John on July 20"
"booked John from a dial" (dial bookings)
"delete the Test Demo customer" · "fix John's contract to 8k"
"csv of this month's payments" (exports)

👥 TEAM
"add a closer named Sam" · "change Ethan to setter" · "remove Isaiah"
"register Ethan" (access codes) · "set Isaiah's reminder to 9pm"

📈 WEEKLY
"we gained 120 followers last week" (I also ask every Monday 8am)

📝 NOTES
"remember our new offer is X" · "what did I tell you about pricing?"

Say "back to jarvis" anytime to exit a mode. /help — this menu"""


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return await reject_unauthorized(update)
    await update.message.reply_text(HELP_TEXT)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await cmd_start(update, context)


# ────────────────────────────────────────────────────────────
# Main message handler — Jarvis routing
# ────────────────────────────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE, text_override: str = None):
    """
    Main message handler with Jarvis routing.

    Flow:
      1. Non-owner chats → team-member / registration path
      2. Exit commands (if in a mode)
      3. Global patterns (register)
      4. Owner mid-button-flow typed input
      5. Front desk → classify intent → reporting / capture / admin / setter / chat
    """
    if not is_authorized(update):
        # Not the owner → team-member / registration / no-access path
        return await _handle_team_message(update, context)

    text = (text_override or update.message.text or "").strip()
    if not text:
        return
    lowered = text.lower()
    user_id = update.effective_user.id

    # Store user message in conversation history
    add_to_conversation(user_id, "user", text)

    # Import Jarvis router
    from telegram_bot.jarvis_router import (
        classify_intent,
        get_current_mode,
        set_mode,
        clear_mode,
        is_exit_command,
        get_jarvis_greeting,
        get_jarvis_confirmation,
    )

    # ═══ 1. EXIT COMMANDS (works from any mode) ═══
    if is_exit_command(text):
        current_mode = get_current_mode(user_id, conversation_state)
        if current_mode != "front_desk":
            clear_mode(user_id, conversation_state)
            response = get_jarvis_confirmation("exiting_mode")
            add_to_conversation(user_id, "assistant", response)
            await update.message.reply_text(response)
            return
        else:
            # Already at front desk
            response = "Already at the front desk. What do you need?"
            add_to_conversation(user_id, "assistant", response)
            await update.message.reply_text(response)
            return

    # ═══ 2. GLOBAL PATTERNS (work from any mode) ═══
    # "register Ethan" — owner generates a one-time access code for a team member
    from telegram_bot.team_identity import REGISTER_RE
    register_match = REGISTER_RE.match(text)
    if register_match:
        await _handle_register_command(update, register_match.group("name"), user_id)
        return

    # "help" / "menu" / "what can you do" — the full capability menu (no writes)
    if re.match(r"^\s*(help|menu|commands|what can you do\??|what do you do\??)\s*$",
                lowered):
        add_to_conversation(user_id, "assistant", HELP_TEXT)
        await send_long(update, HELP_TEXT)
        return

    # Owner mid-button-flow typed input (if he tapped outcome buttons himself)
    if await _handle_outcome_typed(update, text, user_id):
        return

    # ═══ 3. MODE-SPECIFIC HANDLING ═══
    current_mode = get_current_mode(user_id, conversation_state)

    if current_mode == "setter":
        # In setter mode → use setter agent
        await _handle_setter_mode(update, context, text, lowered, user_id)
        return

    # ═══ 4. FRONT DESK → JARVIS ROUTER ═══
    # Not in any mode → classify intent and route

    # Classify intent using Claude (with recent context so follow-ups route right)
    history = get_conversation_history(user_id)
    intent_result = await asyncio.to_thread(classify_intent, text, history[:-1])
    intent = intent_result["intent"]
    reason = intent_result.get("reason", "")

    console.log(f"[cyan]Jarvis router: intent={intent}, reason={reason}[/cyan]")

    if intent == "reporting":
        # Reporting questions are stateless one-shots — no mode to enter/exit
        await _handle_reporting_question(update, text, user_id)
        return

    elif intent == "capture":
        # Logging results (call outcomes, money, activity) — stateless; the
        # confirm flow lives in conversation history
        await _handle_owner_capture(update, text, user_id)
        return

    elif intent == "admin":
        # Owner system controls — stateless; confirm flow on history
        await _handle_owner_admin(update, text, user_id)
        return

    elif intent == "setter":
        # Enter setter mode and handle request
        set_mode(user_id, conversation_state, "setter")
        # Handle the setter request immediately
        await _handle_setter_mode(update, context, text, lowered, user_id)
        return

    elif intent == "chat":
        # General chat → Jarvis greeting or conversation
        if any(greeting in lowered for greeting in ["hey", "hello", "hi ", "hi,", "what's up", "sup"]):
            response = get_jarvis_greeting("unclear_intent")
            add_to_conversation(user_id, "assistant", response)
            await update.message.reply_text(response)
            return
        else:
            # Use conversation agent for other chat (general Jarvis persona)
            from telegram_bot.conversation_agent import get_conversational_response
            response = await asyncio.to_thread(get_conversational_response, text, history, "general")
            add_to_conversation(user_id, "assistant", response)
            await send_long(update, response)
            return

    # Fallback (should rarely hit this)
    response = get_jarvis_greeting("unclear_intent")
    add_to_conversation(user_id, "assistant", response)
    await update.message.reply_text(response)


async def _handle_reporting_question(update: Update, text: str, user_id: int):
    """
    Answer a business-numbers question via the reporting skill
    (read-only SQL over the verified reporting_leads view + events table).
    Stateless — no mode is entered.
    """
    from telegram_bot.reporting_skill import handle_reporting_request

    await update.message.reply_text("📊 Pulling the numbers...")

    history = get_conversation_history(user_id)
    response = await asyncio.to_thread(handle_reporting_request, text, history[:-1])

    add_to_conversation(user_id, "assistant", response)
    await send_long(update, response)


async def _handle_owner_admin(update: Update, text: str, user_id: int):
    """
    Owner-only system controls (setter brain, kill switch, reply speed,
    lead lookup, stage moves, record corrections, exports, team, notes).
    Stateless — the confirm flow rides on conversation history.
    """
    from telegram_bot.admin_agent import handle_admin_request

    history = get_conversation_history(user_id)
    response = await asyncio.to_thread(
        handle_admin_request, text, history[:-1], "owner", None
    )
    add_to_conversation(user_id, "assistant", response)
    await send_long(update, response)


async def _handle_owner_capture(update: Update, text: str, user_id: int):
    """
    Owner logging results (call outcomes, payments, signings, team activity)
    via the capture agent. Stateless — the confirm flow rides on the
    conversation history.
    """
    from telegram_bot.capture_agent import handle_capture_request

    history = get_conversation_history(user_id)
    response = await asyncio.to_thread(
        handle_capture_request, text, history[:-1], "owner", None
    )
    add_to_conversation(user_id, "assistant", response)
    await send_long(update, response)


async def _handle_register_command(update: Update, name: str, user_id: int):
    """Owner 'register <name>' → one-time 6-digit access code for that member."""
    from telegram_bot.team_identity import start_registration

    result = await asyncio.to_thread(start_registration, name)
    if result["success"]:
        relink = " (replaces their current link)" if result.get("already_linked") else ""
        response = (
            f"Access code for {result['member_name']} ({result['role']}){relink}:\n\n"
            f"{result['code']}\n\n"
            f"Have them DM this bot just that code and they're in."
        )
    else:
        response = result["message"]
        if result.get("matches"):
            response += "\n" + "\n".join(f"• {n}" for n in result["matches"])
    add_to_conversation(user_id, "assistant", response)
    await update.message.reply_text(response)


# ────────────────────────────────────────────────────────────
# OUTCOME BUTTON FLOWS (proactive reminders → tap to log)
# ────────────────────────────────────────────────────────────

# chat_id -> {"lead_id","lead_name","outcome","step","contract","collected","logged_by"}
outcome_flows = {}

_AMOUNT_RE = re.compile(r"^\s*\$?\s*([\d][\d,]*\.?\d*)\s*(k)?\s*$", re.IGNORECASE)
_INT_RE = re.compile(r"^\s*(\d+)\s*(?:min|mins|minutes|m)?\s*$", re.IGNORECASE)


def _parse_amount(text: str):
    """'6k' → 6000, '$6,500' → 6500, '0' → 0. None if not an amount."""
    m = _AMOUNT_RE.match(text or "")
    if not m:
        return None
    value = float(m.group(1).replace(",", ""))
    if m.group(2):
        value *= 1000
    return value


def _parse_int(text: str):
    """'45' / '45 min' → 45. None if not a plain integer."""
    m = _INT_RE.match(text or "")
    return int(m.group(1)) if m else None


def _outcome_summary(flow: dict) -> str:
    name = flow.get("lead_name") or "Unknown"
    o = flow.get("outcome")
    if o == "closed":
        if flow.get("terms"):
            rest = " + ".join(
                f"${it['amount']:,.0f} due {it['due_date']}" for it in flow["terms"]
            )
            terms_txt = f" — split pay, rest: {rest}"
        else:
            terms_txt = " — PIF"
        dur = f" — {flow['duration']} min call" if flow.get("duration") else ""
        return (f"Logging: {name} — pitched & CLOSED — ${flow['contract']:,.0f} contract — "
                f"${flow['collected']:,.0f} collected today{terms_txt}{dur}. Yes?")
    if o == "no_show":
        return f"Logging: {name} — no-show → No Show - Re-Nurture. Yes?"
    if o == "showed_not_pitched":
        return (f"Logging: {name} — showed but NOT pitched (unqualified) → Disqualified.\n"
                f"Reason: {flow.get('reason')}\nYes?")
    if o == "pitched_no_close":
        return (f"Logging: {name} — pitched, NO close → Lead Lost.\n"
                f"Reason: {flow.get('reason')}\nYes?")
    return f"Logging: {name}. Yes?"


def _pitch_keyboard(lead_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("🎯 Pitched", callback_data=f"oc:pitched:{lead_id}"),
        InlineKeyboardButton("🙅 Didn't pitch", callback_data=f"oc:nopitch:{lead_id}"),
    ]])


def _close_keyboard(lead_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Closed", callback_data=f"oc:closed:{lead_id}"),
        InlineKeyboardButton("❌ No close", callback_data=f"oc:noclose:{lead_id}"),
    ]])


def _terms_keyboard(lead_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("💰 Paid in full", callback_data=f"oc:pif:{lead_id}"),
        InlineKeyboardButton("📅 Split pay", callback_data=f"oc:split:{lead_id}"),
    ]])


def _confirm_keyboard(lead_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Yes, log it", callback_data=f"oc:yes:{lead_id}"),
        InlineKeyboardButton("✖️ Cancel", callback_data=f"oc:cancel:{lead_id}"),
    ]])


async def handle_outcome_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Taps on the reminder buttons: oc:<won|lost|ns|skip|yes|cancel>:<lead_id>."""
    from telegram_bot.team_identity import resolve_role
    from telegram_bot.capture_agent import _get_lead
    from telegram_bot.capture_flows import (
        log_close, log_no_show, log_showed_no_close, log_showed_not_pitched,
    )

    query = update.callback_query
    await query.answer()
    chat_id = update.effective_user.id

    identity = await asyncio.to_thread(resolve_role, chat_id, AUTHORIZED_USER_ID)
    role = identity["role"]
    if role not in ("closer", "owner"):
        await query.edit_message_text(f"That's not for you — ask {OWNER_NAME} for an access code.")
        return
    logged_by = OWNER_NAME if role == "owner" else identity["member"]["name"]

    parts = (query.data or "").split(":")
    if len(parts) != 3:
        return
    _, action, lead_id = parts

    if action == "skip":
        outcome_flows.pop(chat_id, None)
        await query.edit_message_text("⏳ Left pending — I'll ask again next reminder.")
        return

    if action == "cancel":
        outcome_flows.pop(chat_id, None)
        await query.edit_message_text("✖️ Cancelled — the call stays pending.")
        return

    if action == "pif":
        flow = outcome_flows.get(chat_id)
        if not flow or flow.get("lead_id") != lead_id or flow.get("step") != "terms":
            await query.edit_message_text("Nothing pending — tap an outcome button first.")
            return
        flow["terms"] = None
        flow["step"] = "confirm"
        await query.edit_message_text(
            _outcome_summary(flow), reply_markup=_confirm_keyboard(lead_id))
        return

    if action == "split":
        flow = outcome_flows.get(chat_id)
        if not flow or flow.get("lead_id") != lead_id or flow.get("step") != "terms":
            await query.edit_message_text("Nothing pending — tap an outcome button first.")
            return
        flow["step"] = "terms_text"
        await query.edit_message_text(
            "📅 Split pay — what's left and when? Type it like:\n"
            "\"1.5k in 40 days\" · \"1500 on 2026-07-20\" · \"500/month for 3 months\""
        )
        return

    if action == "yes":
        flow = outcome_flows.get(chat_id)
        if not flow or flow.get("lead_id") != lead_id or flow.get("step") != "confirm":
            await query.edit_message_text("Nothing pending to confirm — tap an outcome button first.")
            return
        lead = await asyncio.to_thread(_get_lead, lead_id)
        if not lead:
            outcome_flows.pop(chat_id, None)
            await query.edit_message_text(f"Couldn't find that lead anymore — ask {OWNER_NAME}.")
            return
        o = flow["outcome"]
        if o == "closed":
            result = await asyncio.to_thread(
                log_close, lead, flow["contract"], flow["collected"], logged_by,
                payment_terms=flow.get("terms"), call_duration_minutes=flow.get("duration"))
        elif o == "showed_not_pitched":
            result = await asyncio.to_thread(log_showed_not_pitched, lead, logged_by, flow.get("reason"))
        elif o == "pitched_no_close":
            result = await asyncio.to_thread(log_showed_no_close, lead, logged_by, reason=flow.get("reason"))
        else:  # no_show
            result = await asyncio.to_thread(log_no_show, lead, logged_by)
        outcome_flows.pop(chat_id, None)
        prefix = "✅ " if result.get("success") else "⚠️ "
        await query.edit_message_text(prefix + result.get("detail", "Done."))
        return

    # ─── Branch taps (need an active flow for this lead) ───
    if action in ("pitched", "nopitch", "closed", "noclose"):
        flow = outcome_flows.get(chat_id)
        if not flow or flow.get("lead_id") != lead_id:
            await query.edit_message_text("Nothing pending — tap an outcome button on the call message first.")
            return
        if action == "nopitch":
            flow["outcome"] = "showed_not_pitched"
            flow["step"] = "reason_nopitch"
            await query.edit_message_text(
                f"Why didn't you pitch {flow['lead_name']}? Be specific.")
            return
        if action == "pitched":
            flow["step"] = "close_q"
            await query.edit_message_text("Did you close?", reply_markup=_close_keyboard(lead_id))
            return
        if action == "noclose":
            flow["outcome"] = "pitched_no_close"
            flow["step"] = "reason_noclose"
            await query.edit_message_text(
                f"Why didn't {flow['lead_name']} close? What was the real reason? Be specific.")
            return
        # closed
        flow["outcome"] = "closed"
        flow["step"] = "contract"
        await query.edit_message_text(
            f"📞 {flow['lead_name']} — closed, nice. What's the TOTAL contract amount? (type it, e.g. 6k)")
        return

    # ─── Entry taps: Showed up / No-show (won/lost kept for stale messages) ───
    if action not in ("showed", "ns", "won", "lost"):
        return

    lead = await asyncio.to_thread(_get_lead, lead_id)
    if not lead:
        await query.edit_message_text(f"Couldn't find that lead anymore — ask {OWNER_NAME}.")
        return
    lead_name = lead.get("full_name") or "Unknown"
    base = {"lead_id": lead_id, "lead_name": lead_name, "logged_by": logged_by}

    if action == "showed":
        outcome_flows[chat_id] = {**base, "step": "pitch_q"}
        await query.edit_message_text(
            f"📞 {lead_name} showed up. Did you pitch the offer?",
            reply_markup=_pitch_keyboard(lead_id))
        return

    if action == "won":  # stale "Showed & closed" button → jump into close path
        outcome_flows[chat_id] = {**base, "outcome": "closed", "step": "contract"}
        await query.edit_message_text(
            f"📞 {lead_name} — closed, nice. What's the TOTAL contract amount? (type it, e.g. 6k)")
        return

    if action == "lost":  # stale "Showed, no close" button → ask the reason
        outcome_flows[chat_id] = {**base, "outcome": "pitched_no_close", "step": "reason_noclose"}
        await query.edit_message_text(
            f"Why didn't {lead_name} close? What was the real reason? Be specific.")
        return

    # ns → straight to one-line confirmation
    outcome_flows[chat_id] = {**base, "outcome": "no_show", "step": "confirm"}
    await query.edit_message_text(
        _outcome_summary(outcome_flows[chat_id]),
        reply_markup=_confirm_keyboard(lead_id),
    )


async def _handle_outcome_typed(update: Update, text: str, chat_id: int) -> bool:
    """
    Typed input while an outcome button flow is collecting amounts.
    Returns True if the message was consumed by the flow.
    """
    flow = outcome_flows.get(chat_id)
    typed_steps = ("contract", "collected", "duration", "terms_text",
                   "reason_nopitch", "reason_noclose")
    if not flow or flow.get("step") not in typed_steps:
        return False

    stripped = text.strip()

    # Free-text reason steps (no length limit) — only explicit cancel/stop aborts,
    # so a reason like "no budget" is never mistaken for a cancel.
    if flow["step"] in ("reason_nopitch", "reason_noclose"):
        if stripped.lower() in ("cancel", "stop"):
            outcome_flows.pop(chat_id, None)
            await update.message.reply_text("✖️ Cancelled — the call stays pending.")
            return True
        if not stripped:
            await update.message.reply_text("Give me a sentence or two on the real reason.")
            return True
        flow["reason"] = stripped
        flow["step"] = "confirm"
        await update.message.reply_text(
            _outcome_summary(flow), reply_markup=_confirm_keyboard(flow["lead_id"])
        )
        return True

    if stripped.lower() in ("cancel", "stop", "never mind", "nevermind", "no"):
        outcome_flows.pop(chat_id, None)
        await update.message.reply_text("✖️ Cancelled — the call stays pending.")
        return True

    if flow["step"] == "terms_text":
        from telegram_bot.capture_flows import parse_payment_terms
        parsed = await asyncio.to_thread(parse_payment_terms, text)
        if not parsed["ok"]:
            await update.message.reply_text(f"🤔 {parsed['error']}")
            return True
        flow["terms"] = parsed["items"]
        flow["step"] = "confirm"
        await update.message.reply_text(
            _outcome_summary(flow), reply_markup=_confirm_keyboard(flow["lead_id"])
        )
        return True

    if flow["step"] == "duration":
        minutes = _parse_int(stripped)
        if minutes is None:
            await update.message.reply_text("How many minutes was the call? Just a number, e.g. 45.")
            return True
        flow["duration"] = minutes
        # Everything paid → straight to confirm; otherwise ask PIF/split.
        if flow["collected"] >= flow["contract"]:
            flow["terms"] = None
            flow["step"] = "confirm"
            await update.message.reply_text(
                _outcome_summary(flow), reply_markup=_confirm_keyboard(flow["lead_id"]))
        else:
            flow["step"] = "terms"
            await update.message.reply_text(
                f"${flow['contract'] - flow['collected']:,.0f} left on the contract — "
                f"was this a PIF or split pay?",
                reply_markup=_terms_keyboard(flow["lead_id"]))
        return True

    amount = _parse_amount(stripped)
    if amount is None:
        await update.message.reply_text("Didn't catch a number — type it like 6k or 6000.")
        return True

    if flow["step"] == "contract":
        flow["contract"] = amount
        flow["step"] = "collected"
        await update.message.reply_text("And how much cash was collected today? (0 if none)")
        return True

    # collected → ask the call length next
    flow["collected"] = amount
    flow["step"] = "duration"
    await update.message.reply_text("How long was the call, in minutes?")
    return True


async def _handle_team_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Identity layer for every non-owner chat.

      closer  → capture agent (call outcomes + own numbers ONLY)
      setter  → capture agent (daily activity + own numbers ONLY)
      unknown → 6-digit registration code check, else polite no-access
    """
    from telegram_bot.team_identity import resolve_role, redeem_registration_code, CODE_RE
    from telegram_bot.capture_agent import handle_capture_request

    text = (update.message.text or "").strip()
    chat_id = update.effective_user.id

    identity = await asyncio.to_thread(resolve_role, chat_id, AUTHORIZED_USER_ID)
    role = identity["role"]

    # Mid-button-flow typed input (contract / cash amounts) takes priority
    if role == "closer" and await _handle_outcome_typed(update, text, chat_id):
        return

    if role in ("closer", "setter"):
        add_to_conversation(chat_id, "user", text)
        history = get_conversation_history(chat_id)
        response = await asyncio.to_thread(
            handle_capture_request, text, history[:-1], role, identity["member"]
        )
        add_to_conversation(chat_id, "assistant", response)
        await send_long(update, response)
        return

    # Unknown chat: a bare 6-digit code is a registration attempt
    code_match = CODE_RE.match(text)
    if code_match:
        result = await asyncio.to_thread(redeem_registration_code, code_match.group("code"), chat_id)
        if result["success"]:
            role_label = {"closer": "the closer", "setter": "the setter"}.get(result["role"], result["role"])
            await update.message.reply_text(
                f"You're set up as {role_label}, {result['member_name']}. "
                f"Text me in plain English and I'll log your results."
            )
        else:
            await update.message.reply_text(f"I don't recognize you, ask {OWNER_NAME} for an access code.")
        return

    await update.message.reply_text(f"I don't recognize you, ask {OWNER_NAME} for an access code.")


async def _handle_setter_mode(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str, lowered: str, user_id: int):
    """
    Handle messages when in setter mode.
    Uses the setter agent (Claude tool-use) to handle natural language requests.
    Passes conversation history so Jarvis can handle follow-up questions.

    One exception: pure NUMBERS questions ("how many calls booked this month")
    divert to the reporting skill — its answers come from the verified
    reporting_leads view, not GHL tag-counting. Every setter ACTION (pause,
    resume, ban, unban, find, alert replies) goes to the setter agent
    exactly as before.
    """
    from telegram_bot.jarvis_router import classify_intent
    from telegram_bot.setter_agent import handle_setter_request

    # Get conversation history for context
    history = get_conversation_history(user_id)

    # Divert reporting questions to the reporting skill; everything else is
    # setter business as usual (classification failures default to "chat",
    # which also falls through to the setter agent — unchanged behavior).
    intent_result = await asyncio.to_thread(classify_intent, text, history[:-1])
    if intent_result.get("intent") == "reporting":
        console.log("[cyan]Setter mode: diverting numbers question to reporting skill[/cyan]")
        await _handle_reporting_question(update, text, user_id)
        return
    if intent_result.get("intent") == "capture":
        console.log("[cyan]Setter mode: diverting result-logging to capture agent[/cyan]")
        await _handle_owner_capture(update, text, user_id)
        return
    if intent_result.get("intent") == "admin":
        console.log("[cyan]Setter mode: diverting system control to admin agent[/cyan]")
        await _handle_owner_admin(update, text, user_id)
        return

    # Use setter agent to handle the request (with history)
    response = await asyncio.to_thread(handle_setter_request, text, history)

    # Reply with Jarvis's response
    add_to_conversation(user_id, "assistant", response)
    await send_long(update, response)


# ────────────────────────────────────────────────────────────
# Bot bootstrap
# ────────────────────────────────────────────────────────────

def build_bot() -> Application:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN not set. Create a bot via @BotFather and put the token in .env")

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CallbackQueryHandler(handle_outcome_callback, pattern="^oc:"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    return app


def run_bot():
    """Blocking — runs the bot polling loop."""
    app = build_bot()
    console.log("[bold green]Jarvis Telegram bot online. Listening...[/bold green]")
    app.run_polling(allowed_updates=Update.ALL_TYPES)
