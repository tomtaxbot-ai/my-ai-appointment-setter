"""
SETTER AGENT — Claude-powered tool-use agent for setter control

Takes natural language requests and uses the setter_control tools to:
- Find leads
- Pause/resume AI messaging
- Count bookings
- Get setter stats

Returns responses in Jarvis's voice.
"""

import os
import json
from anthropic import Anthropic
from config.settings import MODEL_HEAVY
from telegram_bot.owner import OWNER_NAME
from rich.console import Console

from telegram_bot.setter_control import (
    find_lead,
    pause_lead,
    resume_lead,
    set_lead_nurture,
    set_lead_followup,
    set_lead_voice,
    set_lead_whale,
    ban_lead,
    unban_lead,
    list_bans,
    count_bookings,
    setter_stats,
)

console = Console()

# ═══════════════════════════════════════════════════════════════
# TOOL DEFINITIONS (for Claude)
# ═══════════════════════════════════════════════════════════════

SETTER_TOOLS = [
    {
        "name": "find_lead",
        "description": "Search for a lead by name in GoHighLevel contacts. Returns matching contacts with their contact_id, name, and tag status (jarvis, ai off).",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Name to search for (searches contact name, first name, last name)"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "pause_lead",
        "description": "Turn the AI OFF for a specific lead. This writes BOTH systems in one shot so they never disagree: it adds the 'ai off' tag in GoHighLevel AND sets leads.ai_paused = true in the ai-setter Supabase database (matched on the GHL contact_id). Use this whenever Maher wants to stop the AI from messaging a lead. ALWAYS call this when asked to turn a lead off, even if the lead already looks off in GHL — it re-asserts the paused state in Supabase too.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {
                    "type": "string",
                    "description": "The GHL contact ID from find_lead results"
                }
            },
            "required": ["contact_id"]
        }
    },
    {
        "name": "resume_lead",
        "description": "Turn the AI ON for a specific lead. This writes BOTH systems in one shot so they never disagree: it removes the 'ai off' tag in GoHighLevel AND sets leads.ai_paused = false in the ai-setter Supabase database (matched on the GHL contact_id). Use this whenever Maher wants the AI to message a lead again. ALWAYS call this when asked to turn a lead on, even if the lead already looks on in GHL (no 'ai off' tag) — the GHL tag and Supabase can be out of sync, and only this call clears ai_paused in Supabase.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {
                    "type": "string",
                    "description": "The GHL contact ID from find_lead results"
                }
            },
            "required": ["contact_id"]
        }
    },
    {
        "name": "set_lead_nurture",
        "description": "Turn the pre-call NURTURE sequence ON or OFF for ONE lead (the warm-up follow-ups between booking and their call: the takeaway question + the meet-link reminder). This is SEPARATE from pause_lead/resume_lead (which mute the whole AI). Use when Maher says things like 'turn off nurture for John', 'stop nurturing him', 'don't follow up with her', or 'nurture him again'. Writes leads.nurture_paused in Supabase (matched on the GHL contact_id). Get the contact_id from find_lead first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string", "description": "The GHL contact ID from find_lead results"},
                "on": {"type": "boolean", "description": "true = nurture this lead, false = stop nurturing them"}
            },
            "required": ["contact_id", "on"]
        }
    },
    {
        "name": "set_lead_followup",
        "description": "Turn the FOLLOW-UP sequence ON or OFF for ONE lead (re-engaging them with messages if they go quiet - after ghosting mid-convo or getting cold feet after the call pitch). SEPARATE from pause/resume (whole AI) and from nurture (post-booking). Use when Maher says 'stop following up with John', 'don't chase her', or 'follow up with him again'. Writes leads.followup_paused (matched on the GHL contact_id). Get the contact_id from find_lead first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string", "description": "The GHL contact ID from find_lead results"},
                "on": {"type": "boolean", "description": "true = follow up this lead, false = stop following up"}
            },
            "required": ["contact_id", "on"]
        }
    },
    {
        "name": "set_lead_voice",
        "description": "Turn VOICE NOTES ON or OFF for ONE lead. on=false => this person gets TEXT only (even while the voice system is on); on=true => they can get voice notes again. SEPARATE from pause/resume, nurture, and follow-up. Use when Maher says 'turn off voice for Alex', 'no voice notes for this guy', or 'turn voice back on for Alex'. Writes leads.voice_paused (matched on the GHL contact_id). Get the contact_id from find_lead first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string", "description": "The GHL contact ID from find_lead results"},
                "on": {"type": "boolean", "description": "true = allow voice notes for this lead, false = text only"}
            },
            "required": ["contact_id", "on"]
        }
    },
    {
        "name": "set_lead_whale",
        "description": "Turn WHALE-RADAR alerts ON or OFF for ONE lead. on=false => no whale ping for this person (even while the whale radar system is on); on=true => they can trigger a whale ping again. SEPARATE from pause/resume, nurture, follow-up, and voice. Use when Maher says 'stop whale alerts for Alex', 'don't ping me about this guy', or 'turn whale radar back on for Alex'. Writes leads.whale_paused (matched on the GHL contact_id). Get the contact_id from find_lead first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string", "description": "The GHL contact ID from find_lead results"},
                "on": {"type": "boolean", "description": "true = allow whale pings for this lead, false = mute whale pings for this lead"}
            },
            "required": ["contact_id", "on"]
        }
    },
    {
        "name": "ban_lead",
        "description": "PERMANENTLY BAN a contact so they 'no longer exist' in the system. This is the HARD version of pause: it (1) deletes the contact from GoHighLevel, (2) purges their lead + all their messages from the ai-setter database, and (3) writes a ban record so the AI webhook refuses to ever engage them again — even if they DM from the same Instagram account later (GHL re-creates the contact and the webhook just deletes it again). Use this when Maher says to ban/block/remove/get-rid-of someone, or that someone is a spammer/pitcher he never wants to hear from. This is reversible with unban_lead (the ban record is kept). ALWAYS confirm you have the right person (via find_lead) before banning.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {
                    "type": "string",
                    "description": "The GHL contact ID from find_lead results"
                },
                "reason": {
                    "type": "string",
                    "description": "Optional short note on why they're banned (e.g. 'pitched SMMA after 5 msgs')"
                }
            },
            "required": ["contact_id"]
        }
    },
    {
        "name": "unban_lead",
        "description": "Lift a ban so a previously-banned person can enter the system again (they'll be treated as a brand-new lead if they DM). Matches active bans by name or @handle. If more than one active ban matches, it returns the matches so you can ask Maher which one. Use this when Maher says to unban/unblock/allow someone again.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A name or @handle to match against the active ban list"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "list_bans",
        "description": "List everyone who is currently banned (active bans only), with their name, @handle, reason, and when they were banned. Use this when Maher asks who's banned/blocked, or wants to review the ban list before unbanning someone.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "count_bookings",
        "description": "Count booked calls from GHL Opportunities (AI Sales Pipeline). Returns total booked, how many from AI setter (contact has 'jarvis' tag), and how many from other sources. Period options: 'today', 'last_7_days', 'last_90_days'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": ["today", "last_7_days", "last_90_days"],
                    "description": "Time period to check"
                }
            },
            "required": ["period"]
        }
    },
    {
        "name": "setter_stats",
        "description": "Get AI setter stats from GoHighLevel: count of contacts with 'jarvis' tag (leads AI is handling) and how many are paused ('ai off' tag). Returns current state, not time-based.",
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": ["today", "this_week"],
                    "description": "Ignored - stats are current state"
                }
            },
            "required": ["period"]
        }
    }
]


# ═══════════════════════════════════════════════════════════════
# TOOL EXECUTION
# ═══════════════════════════════════════════════════════════════

def execute_tool(tool_name: str, tool_input: dict) -> dict:
    """Execute a setter tool and return the result."""
    try:
        if tool_name == "find_lead":
            return {"result": find_lead(tool_input["query"])}
        elif tool_name == "pause_lead":
            return pause_lead(tool_input["contact_id"])
        elif tool_name == "resume_lead":
            return resume_lead(tool_input["contact_id"])
        elif tool_name == "set_lead_nurture":
            return set_lead_nurture(tool_input["contact_id"], bool(tool_input["on"]))
        elif tool_name == "set_lead_followup":
            return set_lead_followup(tool_input["contact_id"], bool(tool_input["on"]))
        elif tool_name == "set_lead_voice":
            return set_lead_voice(tool_input["contact_id"], bool(tool_input["on"]))
        elif tool_name == "set_lead_whale":
            return set_lead_whale(tool_input["contact_id"], bool(tool_input["on"]))
        elif tool_name == "ban_lead":
            return ban_lead(tool_input["contact_id"], tool_input.get("reason"))
        elif tool_name == "unban_lead":
            return unban_lead(tool_input["query"])
        elif tool_name == "list_bans":
            return list_bans()
        elif tool_name == "count_bookings":
            return count_bookings(tool_input["period"])
        elif tool_name == "setter_stats":
            return setter_stats(tool_input["period"])
        else:
            return {"error": f"Unknown tool: {tool_name}"}
    except Exception as e:
        console.print_exception()
        return {"error": f"{tool_name} failed: {str(e)}"}


# ═══════════════════════════════════════════════════════════════
# SETTER AGENT
# ═══════════════════════════════════════════════════════════════

def handle_setter_request(user_request: str, conversation_history: list = None) -> str:
    """
    Handle a setter request using Claude tool-use.

    Args:
        user_request: Natural language request (e.g., "turn off AI for James", "how many calls today")
        conversation_history: Recent conversation history [{"role": "user/assistant", "content": "..."}]

    Returns:
        Jarvis's response (natural language)
    """
    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    system_prompt = f"""You are Jarvis, {OWNER_NAME}'s AI assistant, helping manage his AI DM setter.

You have tools to:
- find_lead: search for leads by name/username in GoHighLevel
- pause_lead: turn the AI OFF for a lead (writes BOTH GoHighLevel's "ai off" tag AND Supabase leads.ai_paused=true)
- resume_lead: turn the AI ON for a lead (writes BOTH: removes GoHighLevel's "ai off" tag AND sets Supabase leads.ai_paused=false)
- set_lead_nurture: turn the pre-call NURTURE sequence on/off for ONE lead (the warm-up follow-ups before their call). SEPARATE from pause/resume — pausing the AI mutes everything; this only stops the nurture touches. Find the lead first, then call it with on=true/false.
- set_lead_followup: turn the FOLLOW-UP sequence on/off for ONE lead (re-engaging them if they ghost mid-convo or get cold feet after the pitch). SEPARATE from pause/resume and from nurture. Find the lead first, then call it with on=true/false.
- set_lead_voice: turn VOICE NOTES on/off for ONE lead (text-only for just this person, or allow voice again). SEPARATE from everything else. Use for 'turn off voice for Alex' / 'voice back on for Alex'. Find the lead first, then call it with on=true/false.
- set_lead_whale: turn WHALE-RADAR alerts on/off for ONE lead (mute the whale ping for just this person, or allow it again). SEPARATE from everything else. Use for 'stop whale alerts for Alex' / 'don't ping me about this guy' / 'whale radar back on for Alex'. Find the lead first, then call it with on=true/false.
- ban_lead: PERMANENTLY ban a lead — delete them from GHL, purge their data, and block the webhook from ever re-engaging them
- unban_lead: lift a ban (matches by name/@handle; returns matches if ambiguous)
- list_bans: list everyone currently banned
- count_bookings: get booking count from AI Sales Pipeline with attribution
- setter_stats: get setter activity stats from GHL contacts

**How pause/resume work (READ THIS — it changes how you answer):**
The AI setter decides whether to message a lead by checking TWO places: the GoHighLevel "ai off" tag AND the Supabase `leads.ai_paused` flag. If EITHER says off, the lead is muted. So both must always agree.
- pause_lead and resume_lead ALREADY write BOTH systems in a single call. You DO have Supabase write access through these tools — never tell Maher to check or fix Supabase manually, and never say Supabase is "outside your tools." It isn't.
- ALWAYS call resume_lead when Maher asks to turn a lead ON, and pause_lead when he asks to turn one OFF — EVEN IF find_lead shows the GHL tag already looks right. The GHL tag and Supabase can be out of sync; only running the tool re-asserts BOTH. Never reply "already on/off" and skip the tool — run it to guarantee both systems match.
- The tool result tells you what happened: ghl_success, supabase_success, and supabase_rows_updated. Confirm both wrote. If supabase_rows_updated is 0, the lead isn't in the setter's Supabase database yet — say so plainly. If either write failed, tell Maher exactly which one.

**Metrics explained** (for when Maher asks follow-ups):
- "active" = contacts with the "jarvis" tag and NO "ai off" tag (AI is currently messaging them)
- "paused" = contacts with the "jarvis" tag AND the "ai off" tag (manually turned off)
- "total" or "total jarvis leads" = all contacts with the "jarvis" tag (every lead the AI has engaged)
- These numbers come from querying ALL contacts in GoHighLevel and filtering by tags
- "from_ai_setter" (bookings) = the contact who booked has the "jarvis" tag
- "from_other" (bookings) = bookings from webinars, opt-ins, etc. (no "jarvis" tag)

**Banning (pause vs ban — READ THIS):**
- pause_lead just mutes the AI; the lead stays in GHL and the database.
- ban_lead is the HARD "make them not exist" action: it DELETES them from GHL, PURGES their lead + messages from the database, and records a ban so the webhook deletes them again if they ever DM back. Use it when Maher says ban/block/remove/get rid of someone or calls them a spammer/pitcher.
- Banning DELETES data, so first run find_lead and make sure you have the right person. If find_lead returns more than one match, list them and ask which one BEFORE banning — never guess.
- unban_lead matches by name/@handle. If it returns multiple matches (success=false with a `matches` list), show them and ask which to unban. To show who's banned, use list_bans.

**Instructions:**
1. Use tools to get information or take actions
2. If find_lead returns multiple matches, list them and ask which one
3. If find_lead returns 1 match and the user wants to pause/resume/ban it, CALL pause_lead/resume_lead/ban_lead — do not just report the current tag state and stop
4. Respond in Jarvis's voice: sharp, warm, concise (1-3 sentences)
5. Don't over-explain unless asked
6. Handle follow-up questions by referencing your previous answers in the conversation

**Examples:**
- "Done — James is off in both GHL and Supabase, won't be messaged again."
- "Ethan's on — cleared the 'ai off' tag in GHL and set ai_paused=false in Supabase. He's getting messaged."
- (Already looked on in GHL) "He had no 'ai off' tag, but I still re-asserted it — ai_paused=false in Supabase too, so he's fully on."
- "Booked 2 calls in the last 7 days — 1 from the AI setter, 1 from other sources."
- "Done — banned Jake (@jake.smma). Deleted from GHL, wiped his messages, and he's blocked for good. Say the word if you ever want him back."
- "Lifted the ban on Jake (@jake.smma) — he'll come through as a fresh lead if he DMs again."
- "2 people banned right now: Jake (@jake.smma, 'pitched SMMA') and Leon (@leon.ai). Want either one back?"
- "Found 2 leads named Alex — which one? Alex Chen (@alex_ig) or Alex Smith (@asmith)?"
- "9 active, 2 paused, 11 total jarvis leads."
- (Supabase mismatch) "Turned him on in GHL, but no matching lead in Supabase yet — he's not in the setter's database, so nothing to flip there."
"""

    # Owner-neutral: swap any remaining default-owner mentions in the system
    # prompt and tool descriptions for this owner's name.
    system_prompt = system_prompt.replace("Maher", OWNER_NAME)
    tools = [
        {**t, "description": t["description"].replace("Maher", OWNER_NAME)}
        for t in SETTER_TOOLS
    ]

    # Build messages with conversation history
    messages = []

    # Add recent conversation history (last 5 exchanges for context)
    if conversation_history:
        for msg in conversation_history[-10:]:  # Last 10 messages (5 exchanges)
            messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })

    # Add current request
    messages.append({"role": "user", "content": user_request})

    # Agentic loop (max 5 turns to prevent infinite loops)
    for turn in range(5):
        response = client.messages.create(
            model=MODEL_HEAVY,  # Sonnet: reliably follows "always call the tool"
                                # for on/off (Haiku skipped it, causing GHL/Supabase drift)
            max_tokens=2000,
            system=system_prompt,
            messages=messages,
            tools=tools,
        )

        # Add assistant response to messages
        messages.append({
            "role": "assistant",
            "content": response.content
        })

        # Check stop reason
        if response.stop_reason == "end_turn":
            # Claude is done, extract text response
            text_blocks = [block.text for block in response.content if hasattr(block, "text")]
            return "\n".join(text_blocks) if text_blocks else "Done."

        elif response.stop_reason == "tool_use":
            # Execute tools
            tool_results = []

            for block in response.content:
                if block.type == "tool_use":
                    console.log(f"[cyan]Tool call: {block.name}({block.input})[/cyan]")

                    # Execute the tool
                    result = execute_tool(block.name, block.input)
                    console.log(f"[dim]Result: {result}[/dim]")

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result)
                    })

            # Add tool results to messages
            messages.append({
                "role": "user",
                "content": tool_results
            })

            # Continue the loop (Claude will see the tool results and respond)

        else:
            # Unexpected stop reason
            console.log(f"[yellow]Unexpected stop reason: {response.stop_reason}[/yellow]")
            return "Something went wrong with the setter agent."

    # If we hit max turns
    return "Setter agent took too long to respond. Try rephrasing your request."
