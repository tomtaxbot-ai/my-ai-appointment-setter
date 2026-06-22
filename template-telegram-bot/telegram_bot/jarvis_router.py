"""
JARVIS ROUTER — The Brain

Uses Claude to intelligently route free-text messages to the right skill.
Not keyword matching — real intent classification.

Skill Registry:
  - reporting: Business numbers/stats questions (leads, bookings, funnel, sources)
  - setter: AI DM setter ACTIONS (pause/resume, ban/unban, lead lookups, alert replies)
  - chat: General conversation, greetings, ambiguous requests
"""

import os
import json
from anthropic import Anthropic
from config.settings import MODEL_LIGHT
from telegram_bot.owner import OWNER_NAME
from rich.console import Console

console = Console()


# ═══════════════════════════════════════════════════════════════
# SKILL REGISTRY — add new skills here
# ═══════════════════════════════════════════════════════════════

SKILL_REGISTRY = {
    "reporting": {
        "description": "Questions about business NUMBERS and DATA: lead counts, bookings, funnel status, sources, no-shows, wins/losses, message volume, conversion rates, any 'how many / how much / which source / show me the stats' question",
        "examples": [
            "how many calls booked this month",
            "leads by source this month",
            "what's the current funnel",
            "how many no-shows this week",
            "how many leads came from IG",
            "show me setter performance",
            "did we book any calls today",
        ]
    },
    "capture": {
        "description": "LOGGING a business result that happened: a call outcome (closed / no-show / showed but didn't close), cash collected, a refund, an upsell or extension, a new client signing, or a team member's daily outreach volume — also confirming (yes/no) a pending log summary, 'which calls need outcomes', and configuring a team member's daily reminder (time/timezone/on/off). This is SALES, CASH, CALL-OUTCOME and team OUTREACH/DIAL data ONLY — NOT Instagram follower counts (those are admin)",
        "examples": [
            "collected 3k from John",
            "call with John Smith — showed, closed, 6k contract, collected 3k",
            "refund 500 to John",
            "John signed for 6k, paid 2k today",
            "log 40 outreaches for Isaiah",
            "that 2pm call was a no-show",
            "which calls need outcomes",
            "set Ethan's reminder to 8pm New York",
            "turn off Isaiah's reminder",
        ]
    },
    "admin": {
        "description": "OWNER system controls: editing the setter's brain/rules/voice/pitch (show/add/change/remove/undo), turning the WHOLE setter on/off or pausing it, turning the whole NURTURE (pre-call warm-up) sequence on/off system-wide, turning the whole FOLLOW-UP system (re-engaging quiet/ghosted/cold-feet leads) on/off system-wide, running the DM-INTELLIGENCE analysis on demand, reading its report/suggestions, turning its monthly auto-run on/off, applying a suggested fix to the setter's brain (with your tweak), turning the DIG-DEEPER-INTO-PAIN empathy overlay on/off and editing its trigger words/style, turning VOICE NOTES (replying in the cloned voice) on/off, turning the WHALE RADAR (high-value-lead alerts) on/off, reply speed/delay, looking up a lead's status ('where's John'), listing a stage, moving stages/disqualifying, adding/removing ANY GHL tag on a lead, deleting or fixing customers/payments/contract amounts, CSV exports, team management (add/remove members, change roles), weekly follower gains ('we gained 120 followers'), marking a lead booked from a dial, and notes ('remember X', 'what did I tell you about Y')",
        "examples": [
            "show me the rules",
            "add a rule: never mention price first",
            "rewrite the pitch to push the workshop first",
            "undo that",
            "turn the setter off",
            "pause the setter until 9am",
            "turn the nurture sequence off",
            "turn the follow-up system on",
            "stop the follow-ups",
            "turn the warm-up messages back on",
            "analyse my DMs",
            "study my conversations",
            "show me the DM report",
            "what did the DM analysis find",
            "turn the monthly DM analysis off",
            "apply fix 2 from the report",
            "turn pain digging on",
            "stop digging into pain",
            "turn whale radar on",
            "stop the whale alerts",
            "turn voice notes on",
            "stop the voice messages",
            "use my voice",
            "how many voice messages did we send last 7 days",
            "how often are we using voice notes",
            "wait 20 seconds before replying",
            "where's John?",
            "who's in Appointment Booked?",
            "move John to Appointment Booked",
            "disqualify John",
            "delete the Test Demo customer, that sale was fake",
            "change John's collected payment to 3k",
            "csv of this month's payments",
            "add a closer named Sam",
            "remove Isaiah from the team",
            "remember our new offer is the 8-week sprint",
            "what did I tell you about pricing?",
            "add the tag qualified to John",
            "remove icp from this guy",
            "we gained 120 followers last week",
            "14 followers",
            "log 14 new followers in my tracker for the last 7 days",
            "log 14 followers this week",
            "booked John from a dial",
        ]
    },
    "setter": {
        "description": "ACTIONS on the AI DM setter or a specific lead: turning AI on/off, pausing/resuming, turning the NURTURE / pre-call follow-ups on/off for a SPECIFIC lead, turning VOICE NOTES on/off for a SPECIFIC lead, muting/unmuting WHALE-RADAR alerts for a SPECIFIC lead, banning/unbanning someone, finding a lead, replying to a setter handoff alert about a lead",
        "examples": [
            "turn off AI for James",
            "pause the setter for this lead",
            "stop nurturing John",
            "turn nurture back on for Sarah",
            "stop following up with John",
            "follow up with Sarah again",
            "turn off voice for Alex",
            "turn voice back on for this lead",
            "stop whale alerts for Alex",
            "don't ping me about this guy",
            "turn whale radar back on for Alex",
            "ban that guy",
            "unban @jake.smma",
            "who's banned right now",
            "find lead Sarah",
            "I'll take this one, turn the AI off for him",
        ]
    },
    "chat": {
        "description": "General conversation, greetings, unclear requests, or questions that don't fit other skills",
        "examples": [
            "hey Jarvis",
            "hello",
            "what's up",
            "thanks",
            "how are you",
        ]
    }
}


def classify_intent(user_message: str, conversation_history: list = None) -> dict:
    """
    Use Claude to classify user intent into one of the registered skills.

    Args:
        user_message: the incoming message
        conversation_history: optional recent [{"role", "content"}] so
            follow-ups ("and last week?") classify correctly

    Returns:
        {
            "intent": str,  # skill name (reporting, youtube, setter, chat)
            "reason": str,  # why this intent was chosen
        }
    """
    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    # Build skill descriptions for the prompt
    skill_descriptions = []
    for skill_name, skill_info in SKILL_REGISTRY.items():
        examples_str = "\n".join(f"    - \"{ex}\"" for ex in skill_info["examples"])
        skill_descriptions.append(
            f"- **{skill_name}**: {skill_info['description']}\n  Examples:\n{examples_str}"
        )

    system_prompt = f"""You are an intent classifier for Jarvis, {OWNER_NAME}'s AI assistant.

Your job: read the user's message and classify it into ONE of these skills:

{chr(10).join(skill_descriptions)}

**Rules:**
- INSTAGRAM FOLLOWERS → **admin** (it owns follower logging). This covers "we gained X followers", a bare "X followers", "log X (new) followers", any follower count or gain, AND a number or yes/no replied to the Monday "how many IG followers did we gain" check-in. This is the ONE "logging a number" task that is admin, NOT capture, and NEVER reporting. When the word "followers" appears (or the user is answering the follower check-in), choose admin.
- Asking for NUMBERS, stats, counts, sources, funnel, rates, or performance → reporting
- RECORDING a result that already happened (money collected, refund, a call's outcome, a signing, outreach/dial volume) → capture. Asking ABOUT numbers is reporting; LOGGING numbers is capture. EXCEPTION: Instagram follower counts are admin, not capture (see the followers rule above).
- If the assistant's last message asked the user to confirm logging something and this message is a yes/no/correction → route to the SAME skill that asked: admin if that pending log was about FOLLOWERS, otherwise capture.
- DOING something to ONE lead's AI (pause/resume AI for John, ban, unban) → setter
- SYSTEM-level control (the whole setter on/off, its rules/brain/pitch/voice, reply speed, stage moves, deleting/fixing records, exports, team members, notes/remember) → admin
- A reply about a specific lead the setter flagged/handed off → setter
- Unclear, greetings, or anything that fits nothing above → chat
- "how many / how much / show me the stats" questions are reporting, NOT setter — setter is only for actions
- Return ONLY valid JSON: {{"intent": "skill_name", "reason": "one sentence why"}}
- Be decisive — pick the BEST match

Output ONLY the JSON block, nothing else."""

    # Give the classifier a little recent context so follow-ups route right
    classify_input = user_message
    if conversation_history:
        recent = conversation_history[-4:]
        context_lines = "\n".join(
            f"{m['role']}: {str(m['content'])[:200]}" for m in recent
        )
        classify_input = (
            f"Recent conversation:\n{context_lines}\n\n"
            f"Classify this new message: {user_message}"
        )

    try:
        response = client.messages.create(
            model=MODEL_LIGHT,  # Haiku is fast enough for routing
            max_tokens=150,
            system=system_prompt,
            messages=[{
                "role": "user",
                "content": classify_input
            }]
        )

        result_text = response.content[0].text.strip()

        # Parse JSON
        # Handle possible markdown fence
        if "```json" in result_text:
            result_text = result_text.split("```json")[1].split("```")[0].strip()
        elif "```" in result_text:
            result_text = result_text.split("```")[1].split("```")[0].strip()

        result = json.loads(result_text)

        # Validate intent
        if result.get("intent") not in SKILL_REGISTRY:
            console.log(f"[yellow]⚠ Invalid intent '{result.get('intent')}', defaulting to chat[/yellow]")
            return {"intent": "chat", "reason": "Invalid intent returned by classifier"}

        return result

    except Exception as e:
        console.log(f"[yellow]⚠ Intent classification failed: {e}, defaulting to chat[/yellow]")
        return {"intent": "chat", "reason": f"Classification error: {str(e)}"}


# ═══════════════════════════════════════════════════════════════
# JARVIS PERSONALITY — The Voice
# ═══════════════════════════════════════════════════════════════

JARVIS_PERSONALITY = f"""You are Jarvis, {OWNER_NAME}'s personal AI assistant.

**Tone:**
- Sharp but warm. Professional but never corporate.
- Concise. Get to the point in 1-3 sentences.
- A little character — like a real right-hand man who knows him well.
- Natural, not corny. No emojis unless {OWNER_NAME} uses them.

**What you do:**
- Route {OWNER_NAME} to the right place (reporting, setter management, etc.)
- Confirm what you're doing or about to do
- Clarify when needed, but don't over-explain

**What you DON'T do:**
- No "I'm here to help!" corporate speak
- No long explanations unless asked
- No guessing what {OWNER_NAME} wants — ask if unclear"""


def get_jarvis_greeting(context: str = "") -> str:
    """
    Get a Jarvis-style greeting or clarification.

    Args:
        context: Optional context (e.g., "unclear_intent", "welcome_back", etc.)
    """
    if context == "unclear_intent":
        return "Yes? Are we pulling numbers or managing the setter?"
    elif context == "welcome_back":
        return "Back to the front desk. What do you need?"
    elif context == "setter_stub":
        return "I'll be able to handle the setter — pausing leads, pulling booking numbers — once we wire it up. That's our next build."
    else:
        # Generic greeting
        return "Yes? What do you need?"


def get_jarvis_confirmation(action: str, details: str = "") -> str:
    """
    Get a Jarvis-style confirmation message.

    Args:
        action: What Jarvis is about to do (e.g., "exiting_mode")
        details: Optional details to include
    """
    confirmations = {
        "exiting_mode": "Back to the front desk. What's next?",
    }
    return confirmations.get(action, f"{details}")


# ═══════════════════════════════════════════════════════════════
# MODE MANAGEMENT — Skill Switching
# ═══════════════════════════════════════════════════════════════

def get_current_mode(user_id: int, conversation_state: dict) -> str:
    """Get the current mode for a user. Default: 'front_desk'"""
    if user_id not in conversation_state:
        conversation_state[user_id] = {}
    return conversation_state[user_id].get("mode", "front_desk")


def set_mode(user_id: int, conversation_state: dict, mode: str):
    """Set the mode for a user."""
    if user_id not in conversation_state:
        conversation_state[user_id] = {}
    conversation_state[user_id]["mode"] = mode


def clear_mode(user_id: int, conversation_state: dict):
    """Clear mode (return to front desk)."""
    if user_id in conversation_state:
        conversation_state[user_id]["mode"] = "front_desk"


def is_exit_command(text: str) -> bool:
    """Check if the message is an exit command."""
    exit_phrases = [
        "back to jarvis",
        "exit",
        "stop",
        "never mind",
        "nevermind",
        "cancel",
        "go back",
        "return to jarvis",
        "front desk",
    ]
    text_lower = text.lower().strip()
    return any(phrase in text_lower for phrase in exit_phrases)
