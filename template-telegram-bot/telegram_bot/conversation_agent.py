"""
TELEGRAM BOT — Conversation Agent

Lightweight Haiku-based agent for conversational Q&A.
Maintains context from recent messages and provides helpful responses.
"""

import os
from anthropic import Anthropic
from config.settings import MODEL_LIGHT
from telegram_bot.owner import OWNER_NAME, BUSINESS_NAME


GENERAL_PERSONA = f"""You are Jarvis, {OWNER_NAME}'s personal AI assistant for his business ({BUSINESS_NAME}).

You can route him to two specialist skills when he wants them:
- Business numbers: just ask, e.g. "how many calls booked this month", "leads by source"
- Setter control: "turn off AI for James", "ban X", "who's banned"

**Be conversational, sharp, and concise.** No corporate speak. Talk like a smart right-hand man who knows his business. 1-3 short paragraphs max.

**Rules:**
- Answer his question or discuss what he raised.
- If he seems to want one of the specialist skills, point him to it in one line.
- Never invent business numbers — if he wants stats, tell him to ask the question plainly and the reporting skill will pull real data.
- No "I'm here to help!" filler."""


def get_conversational_response(user_message: str, conversation_history: list, persona: str = "general") -> str:
    """
    Get a conversational response using recent conversation history.

    Args:
        user_message: The current user message
        conversation_history: List of recent messages [{"role": "user/assistant", "content": "..."}]
        persona: kept for backwards compatibility; only the general
            front-desk Jarvis persona is used now.

    Returns:
        Assistant's response
    """
    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    system_prompt = GENERAL_PERSONA

    # Build messages from conversation history + new message
    messages = []

    # Add conversation history
    for msg in conversation_history[-5:]:  # Last 5 messages for context
        messages.append({
            "role": msg["role"],
            "content": msg["content"]
        })

    # Add current message
    messages.append({
        "role": "user",
        "content": user_message
    })

    try:
        response = client.messages.create(
            model=MODEL_LIGHT,  # Use Haiku for efficiency
            max_tokens=1000,    # Conversations should be concise
            system=system_prompt,
            messages=messages
        )

        return response.content[0].text

    except Exception as e:
        return f"❌ Conversation error: {str(e)}"


def should_use_conversation_agent(user_message: str) -> bool:
    """
    Determine if a message should use the conversation agent.

    Returns True if the message is conversational (not a command/intent).
    """
    message_lower = user_message.lower()

    # If it's short and looks like a follow-up question
    if len(user_message) < 200 and any(word in message_lower for word in [
        "what about", "how about", "can you", "could you", "why", "what if",
        "but", "also", "tell me", "explain", "i think", "that's", "yeah",
        "yes", "no", "maybe", "sounds", "hmm", "ok", "okay", "got it",
        "makes sense", "i see", "interesting", "thoughts", "opinion"
    ]):
        return True

    # If it's a question about ideas/concepts
    if any(word in message_lower for word in ["?", "idea", "concept", "think", "thoughts"]):
        return True

    return False
