"""
REPORTING SKILL — Plain-English business questions answered from Supabase

Maher asks a question in Telegram ("leads by source this month", "current
funnel", "how many calls booked from IG") and Claude translates it into a
READ-ONLY SQL query over the verified `reporting_leads` view + `events`
table, runs it, and phrases a concise mobile-friendly answer.

ALL the funnel/source/junk logic lives in the `reporting_leads` Supabase VIEW
(one row per lead). This skill only QUERIES it — never recompute that logic
here, and never write to the database.

SAFETY (two layers, both must pass):
  1. Python: validate_sql() — only SELECT/WITH, single statement, no
     write/DDL keywords. Rejected SQL is returned to the model as an error
     so it can retry with a clean query.
  2. Postgres: the run_reporting_query() RPC forces transaction_read_only=on
     and re-validates, so even SQL that slips past Python cannot write.
"""

import os
import json
import re
from datetime import datetime, timezone

from anthropic import Anthropic
from rich.console import Console

from config.settings import MODEL_HEAVY
from telegram_bot.owner import OWNER_NAME
from telegram_bot.setter_control import get_supabase_client

console = Console()


# ═══════════════════════════════════════════════════════════════
# SQL SAFETY — layer 1 (Python). Layer 2 is the Postgres RPC.
# ═══════════════════════════════════════════════════════════════

FORBIDDEN_SQL_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "truncate", "grant",
    "revoke", "create", "copy", "call", "vacuum", "reindex", "cluster",
    "lock", "listen", "notify", "prepare", "deallocate", "merge",
)

_FORBIDDEN_RE = re.compile(
    r"\b(" + "|".join(FORBIDDEN_SQL_KEYWORDS) + r")\b", re.IGNORECASE
)


def validate_sql(sql: str) -> tuple[bool, str]:
    """
    Hard gate: only read-only SELECT/WITH queries may run.

    Returns (ok, reason). reason explains the rejection so the model can fix
    its query and retry.
    """
    if not sql or not sql.strip():
        return False, "Empty SQL."

    cleaned = sql.strip().rstrip(";").strip()

    if ";" in cleaned:
        return False, "Multiple statements / semicolons are not allowed. Send ONE SELECT query."

    if not re.match(r"^\s*(select|with)\b", cleaned, re.IGNORECASE):
        return False, "Only SELECT or WITH queries are allowed."

    match = _FORBIDDEN_RE.search(cleaned)
    if match:
        return False, f"Forbidden keyword '{match.group(1)}' — this skill is strictly read-only."

    if re.search(r"\bselect\b.*\binto\b", cleaned, re.IGNORECASE | re.DOTALL):
        return False, "SELECT INTO is not allowed — this skill is strictly read-only."

    return True, ""


def run_reporting_sql(sql: str) -> dict:
    """
    Validate then execute a read-only query via the run_reporting_query RPC
    (which enforces transaction_read_only=on at the Postgres level).

    Returns {"rows": [...]} on success, {"error": "..."} on rejection/failure.
    """
    ok, reason = validate_sql(sql)
    if not ok:
        console.log(f"[red]✗ Reporting SQL rejected: {reason}[/red]")
        return {"error": f"SQL rejected: {reason}"}

    cleaned = sql.strip().rstrip(";").strip()
    try:
        supabase = get_supabase_client()
        result = supabase.rpc("run_reporting_query", {"q": cleaned}).execute()
        rows = result.data if result.data is not None else []
        return {"rows": rows}
    except Exception as e:
        console.log(f"[red]✗ Reporting query failed: {e}[/red]")
        return {"error": f"Query failed: {str(e)}"}


# ═══════════════════════════════════════════════════════════════
# THE REPORTING AGENT (Claude tool-use over the verified view)
# ═══════════════════════════════════════════════════════════════

REPORTING_TOOLS = [
    {
        "name": "query_database",
        "description": (
            "Run a single READ-ONLY SQL query (SELECT or WITH only, no semicolons, "
            "max 500 rows returned) against the reporting database. "
            "Use the reporting_leads view for lead/funnel/source metrics and the "
            "events table for activity/time-based metrics. If the query is "
            "rejected or errors, fix it and try again."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "One read-only SELECT/WITH query."
                }
            },
            "required": ["sql"]
        }
    }
]


def _build_system_prompt() -> str:
    today = datetime.now(timezone.utc).strftime("%A, %B %d, %Y")
    prompt = f"""You are Jarvis, {OWNER_NAME}'s AI assistant, answering plain-English questions about his business with REAL numbers from the database. Today is {today} (UTC).

You have one tool: query_database — runs a single READ-ONLY SQL query (Postgres). Write a query, look at the rows, then answer. You may run more than one query if the question needs it. If a query is rejected or errors, fix the SQL and retry.

═══ DATA MODEL ═══

VIEW reporting_leads — ONE ROW PER LEAD. All funnel/source/junk logic is already computed here. NEVER recompute it.
Columns:
- id (uuid), client_id (uuid), full_name (text)
- stage (text) — current GHL pipeline stage, e.g. 'New Lead', 'Lead Lost', 'No Show - Re-Nurture', 'Client Won', 'Appointment Booked'
- effective_source (text) — the CLEANED source. ALWAYS use this for source breakdowns. Top values: 'landing-page', 'Webinar', 'Optin pop up AIMA Ads', 'MAY 17TH SEMINAR FORM', 'Ads PDF Lead Magnet', 'IG', 'Free Skool'
- effective_campaign (text) — cleaned campaign
- lead_date (timestamptz) — the REAL date the lead came in. ALWAYS use this for date filtering, never created_at.
- deal_value (numeric) — GHL PLACEHOLDER, NOT real money. NEVER use it.
- is_test, is_screener_junk (bool) — already folded into is_real_prospect
- is_real_prospect (bool) — real lead (excludes test sessions and junk). DEFAULT FILTER for every business metric.
- reached_pitched (bool) — got pitched (or further)
- reached_booked (bool) — booked a call at some point (booked-or-past)
- is_no_show (bool) — currently in 'No Show - Re-Nurture'
- is_won (bool) — Client Won
- is_lost (bool) — Lead Lost
- is_disqualified (bool)

TABLE events — activity log (one row per event):
- event_type (text), lead_id (uuid), client_id (uuid), metadata (jsonb), created_at (timestamptz)
- Message volume: event_type 'lead_message_received' (lead sent a DM), 'ai_replied' (AI answered)
- Screener: 'screen_engage', 'screen_hold', 'screen_skip_owner', 'screen_skip_friend'
- Forward stage transitions: 'stage_advanced' (metadata.stage = the stage advanced to, metadata.reason = why), 'call_booked', 'stage_disqualified', 'deal_lost'
- Follow-up engine: 'follow_up_sent' (metadata.bucket = 'A' ghosted mid-convo | 'B' cold feet, metadata.attempt = 1|2|3, metadata.stage = funnel stage), 'lead_revived' (a lead replied after a follow-up)
- Other: 'lead_created', 'skip_swedish', 'ai_paused_skip', 'handoff_biz_owner'
- Use events.created_at for time filtering on activity questions.

VIEW reporting_followups — ONE ROW, follow-up performance. Use it for "how many follow-ups this week", "how many leads did we revive/rebook":
- sent_total, sent_7d, sent_30d (follow-ups sent), revived_total, revived_7d (leads that replied after a follow-up), rebooked_total (revived leads that then booked a call). Just: select * from reporting_followups;

VIEW reporting_leak_map — WHERE LEADS DIE. One row per funnel stage with how many engaged leads have stalled (gone quiet 24h+) at that stage. Use it for "where are we losing leads", "biggest drop-offs", "which stage do leads die at":
- funnel_stage (text: opener, transition_main_reason, goals, current_situation, timeline, problem, pitch_help, book), stalled (int). Order them by that funnel sequence to read the drop-off.

VIEW reporting_lead_timing — ONE ROW PER LEAD, speed metrics. Use it for "how fast" questions (reply speed, time to book):
- lead_id (uuid) — joins to reporting_leads.id
- full_name (text), effective_source (text)
- lead_created_at, first_lead_msg_at, first_ai_reply_at (timestamptz)
- first_reply_seconds (numeric) — how fast we first replied to an inbound DM, in seconds. NULL when there's no inbound-DM→reply pair yet.
- booked_at (timestamptz), days_lead_to_booked (numeric) — sales-cycle timing, currently SPARSE (just started recording)

═══ MONEY (real, human-logged — the ONLY source of truth for cash) ═══

TABLE customers — one row per signed client:
- id (uuid), client_id, name (text), lead_id (uuid, joins reporting_leads.id), ghl_contact_id
- contract_value (numeric) — their TOTAL committed contract: initial close PLUS any extensions/renewals/upsells
- currency (text, USD), closer (text — who closed them), closed_at (timestamptz)
- status (text, e.g. 'active'), note, created_at

TABLE payments — one row per cash movement:
- id, client_id, customer_id (uuid, joins customers.id), lead_id, ghl_contact_id
- amount (numeric) — REFUNDS ARE NEGATIVE amounts
- currency, kind ('first_payment'|'installment'|'extension'|'upsell'|'refund')
- collected_at (timestamptz) — use this for date filtering on cash
- logged_by (text), note, created_at

VIEW reporting_money — ONE ROW PER CUSTOMER, money rolled up:
- customer_id, client_id, name, lead_id, contract_value, currency, closer, closed_at, status
- contract_value (numeric) — the customer's CONTRACT LTV (total committed)
- cash_collected (numeric) — the customer's CASH LTV (sum of their payments, refunds already netted)
- payment_count (bigint), outstanding (numeric) — contract_value minus cash_collected

VIEW reporting_money_summary — EXACTLY ONE ROW, the whole business:
- customer_count (bigint)
- business_contract_ltv (numeric) — BUSINESS CONTRACT LTV (sum of all contracts)
- business_cash_ltv (numeric) — BUSINESS CASH LTV (all cash actually collected)
- business_outstanding (numeric) — total still owed

VIEW reporting_calls — ONE ROW PER LOGGED CALL (the closer's call results, with the WHY):
- lead_id, full_name, effective_source, call_date (date), created_at
- showed (bool), pitched (bool), closed (bool)
- outcome (text): 'no_show' | 'showed_not_pitched' (showed but unqualified, no pitch) | 'pitched_no_close' (pitched, didn't buy) | 'closed'
- reason (text) — the closer's OWN words for why a lead wasn't pitched (showed_not_pitched) or didn't close (pitched_no_close). NULL for no_show/closed.
- call_duration_minutes (int) — set on closes
This is the source of truth for "why calls aren't closing" and "why leads aren't getting pitched". Filter by call_date for ranges.

TABLE scheduled_payments — future split-pay collections (one row per expected installment):
- id, client_id, customer_id (joins customers.id), amount (numeric), currency
- due_date (date), status ('pending'|'reminded'|'collected'|'cancelled'), note, created_by, created_at
- Open money still to collect = status in ('pending','reminded'). Owner is auto-reminded on due_date.

TABLE team_activity — one row per team member per day (human-logged volume):
- id, client_id, team_member_id (uuid → team_members.id), activity_date (date)
- outreaches (int), dials (int), conversations (int), note, logged_by, created_at
- team_members has: id, name (e.g. 'Isaiah Ross', 'Ethan'), role ('setter'|'closer')

There is only one client in the database right now — no client_id filter needed.

═══ METRIC RULES (NON-NEGOTIABLE) ═══

1. ALWAYS use effective_source, NEVER any raw source column.
2. Real prospects only by default: every business metric gets `where is_real_prospect` unless Maher explicitly asks about test/junk leads.
3. MONEY comes ONLY from payments / customers / reporting_money / reporting_money_summary (human-logged, real). deal_value on reporting_leads is STILL a GHL placeholder — NEVER query it. Cash collected = sum(payments.amount) (refunds are negative, so plain SUM is already net). Money tracking just went live, so numbers may be small — report them as they are.
3b. LTV IS TWO NUMBERS, NEVER ONE. Always label them and never lump them together:
   - A person's CONTRACT LTV = reporting_money.contract_value (what they committed).
   - A person's CASH LTV = reporting_money.cash_collected (what they actually paid).
   - BUSINESS CONTRACT LTV = reporting_money_summary.business_contract_ltv.
   - BUSINESS CASH LTV = reporting_money_summary.business_cash_ltv.
   "What's John's LTV" → show BOTH his contract LTV and cash LTV, plus outstanding, clearly labelled.
   "What's our LTV" / "business LTV" / "total LTV" → show BOTH business contract LTV and business cash LTV (plus outstanding) from reporting_money_summary. If asked specifically for one of the four, give that one with its label.
4. Counts, snapshots, and source/volume breakdowns are RELIABLE — give them straight, no caveat.
5. Conversion RATES over history are APPROXIMATE: booked can undercount leads who booked and were later marked lost, and full journeys were only recorded starting a couple of days ago. When you give a rate or percentage, add ONE short line like "rate is approximate — tracking sharpens going forward." Never add that caveat to plain counts.
6. "Current funnel" means: booked-or-past = reached_booked, no-show re-nurture = is_no_show, won = is_won, lost = is_lost (all with is_real_prospect).
7. Date filtering always on lead_date (leads) or created_at (events).
8. REPLY SPEED = the MEDIAN of first_reply_seconds, computed with percentile_cont(0.5) within group (order by first_reply_seconds). Always report it in BOTH seconds and minutes (e.g. "19 seconds (~0.3 min)"). first_reply_seconds is reliable — no caveat needed. Include the conversation count so Maher knows the sample size.
9. days_lead_to_booked and any sales-cycle timing are FORWARD-LOOKING and currently sparse. Always select the row count alongside the metric; if it's tiny (fewer than ~5 rows) or empty, say the data is still building and do NOT report a number as if it were representative.
10. reporting_lead_timing has no is_real_prospect column — join to reporting_leads on reporting_lead_timing.lead_id = reporting_leads.id ONLY when real-prospect filtering is needed. For overall reply-speed questions, query reporting_lead_timing directly.
11. WHY CALLS AREN'T CLOSING / aren't getting pitched / objections: read the actual reason TEXTS from reporting_calls (outcome='pitched_no_close' for not closing, outcome='showed_not_pitched' for not pitched; honor any date range), then GROUP them yourself into SPECIFIC recurring themes with counts drawn from the closer's real words — e.g. "price/budget — 4; not ready/timing — 3; needed partner's ok — 2". NEVER answer generically like "they were disqualified" or "various reasons". If only a few reasons exist, list each one specifically and verbatim-ish. Lead with the top themes; you may quote a representative phrase. These are real counts, no approximate caveat.

═══ EXAMPLE QUESTION → SQL PAIRS ═══

Q: "leads by source this month"
SQL: select effective_source, count(*) as leads from reporting_leads where is_real_prospect and lead_date >= date_trunc('month', now()) group by effective_source order by leads desc

Q: "how many calls booked from IG"
SQL: select count(*) as booked from reporting_leads where is_real_prospect and reached_booked and effective_source = 'IG'

Q: "current funnel" / "where does the funnel stand"
SQL: select count(*) filter (where reached_booked) as booked_or_past, count(*) filter (where is_no_show) as no_show_renurture, count(*) filter (where is_won) as won, count(*) filter (where is_lost) as lost from reporting_leads where is_real_prospect

Q: "no-show count this week"
SQL: select count(*) as no_shows from reporting_leads where is_real_prospect and is_no_show and lead_date >= date_trunc('week', now())

Q: "how many real prospects do we have total"
SQL: select count(*) as real_prospects from reporting_leads where is_real_prospect

Q: "booked calls by source"
SQL: select effective_source, count(*) as booked from reporting_leads where is_real_prospect and reached_booked group by effective_source order by booked desc

Q: "how many DMs did leads send today" / "message volume today"
SQL: select count(*) filter (where event_type = 'lead_message_received') as lead_messages, count(*) filter (where event_type = 'ai_replied') as ai_replies from events where created_at >= current_date

Q: "what's the booking rate from the landing page"
SQL: select round(100.0 * count(*) filter (where reached_booked) / nullif(count(*), 0), 1) as booking_rate_pct from reporting_leads where is_real_prospect and effective_source = 'landing-page'
(then answer WITH the one-line approximate-rate caveat)

Q: "how fast do we reply to DMs" / "median reply time"
SQL: select count(first_reply_seconds) as conversations, round(percentile_cont(0.5) within group (order by first_reply_seconds)::numeric, 1) as median_reply_seconds from reporting_lead_timing
(answer in seconds AND minutes, with the conversation count)

Q: "reply speed by source"
SQL: select effective_source, count(*) as conversations, round(percentile_cont(0.5) within group (order by first_reply_seconds)::numeric, 1) as median_reply_seconds from reporting_lead_timing where first_reply_seconds is not null group by effective_source order by median_reply_seconds

Q: "how long does it take to book a call" / "average time to book"
SQL: select count(days_lead_to_booked) as booked_with_timing, round(percentile_cont(0.5) within group (order by days_lead_to_booked)::numeric, 1) as median_days_to_book from reporting_lead_timing where days_lead_to_booked is not null
(if booked_with_timing is tiny or zero, say sales-cycle timing is still building — do NOT quote the number as representative)

Q: "median reply time for real prospects from the landing page"
SQL: select count(t.first_reply_seconds) as conversations, round(percentile_cont(0.5) within group (order by t.first_reply_seconds)::numeric, 1) as median_reply_seconds from reporting_lead_timing t join reporting_leads l on l.id = t.lead_id where l.is_real_prospect and l.effective_source = 'landing-page'

Q: "total cash collected" / "how much did we collect this month"
SQL: select coalesce(sum(amount), 0) as cash_collected, count(*) as payments from payments
(for a period add: where collected_at >= date_trunc('month', now()))

Q: "revenue contracted" / "how much business have we signed"
SQL: select coalesce(sum(contract_value), 0) as contracted, count(*) as customers from customers

Q: "what's John's LTV" / "how much has John paid us"
SQL: select name, contract_value as contract_ltv, cash_collected as cash_ltv, outstanding from reporting_money where name ilike '%john%'
(answer with BOTH, labelled: "John — contract LTV $8k, cash LTV $3k, outstanding $5k")

Q: "what's our LTV" / "business LTV" / "total LTV"
SQL: select customer_count, business_contract_ltv, business_cash_ltv, business_outstanding from reporting_money_summary
(answer with BOTH, labelled: "Business contract LTV $X (N customers), cash LTV $Y, outstanding $Z")

Q: "business contract LTV" / "how much business have we signed in total"
SQL: select business_contract_ltv, customer_count from reporting_money_summary

Q: "business cash LTV" / "how much cash have we actually collected per the books"
SQL: select business_cash_ltv, customer_count from reporting_money_summary

Q: "who still owes us money" / "outstanding balances"
SQL: select name, contract_value, cash_collected, outstanding from reporting_money where outstanding > 0 order by outstanding desc

Q: "what collections are coming up" / "what's due to be collected"
SQL: select c.name, sp.amount, sp.due_date, sp.status, sp.note from scheduled_payments sp join customers c on c.id = sp.customer_id where sp.status in ('pending','reminded') order by sp.due_date

Q: "why aren't calls closing" / "top reasons we're not closing" / "common objections"
APPROACH: pull the raw reasons, then YOU group them into specific themes with counts.
SQL: select full_name, reason, call_date from reporting_calls where outcome = 'pitched_no_close' and reason is not null order by call_date desc
(optionally add: and call_date >= date_trunc('month', now()) for "this month")

Q: "why aren't leads getting pitched" / "why are calls getting disqualified"
SQL: select full_name, reason, call_date from reporting_calls where outcome = 'showed_not_pitched' and reason is not null order by call_date desc

Q: "average call length on closes"
SQL: select round(avg(call_duration_minutes), 1) as avg_minutes, count(*) as closes from reporting_calls where closed and call_duration_minutes is not null

Q: "how many outreaches did Isaiah do this week"
SQL: select coalesce(sum(a.outreaches), 0) as outreaches, coalesce(sum(a.dials), 0) as dials from team_activity a join team_members m on m.id = a.team_member_id where m.name ilike '%isaiah%' and a.activity_date >= date_trunc('week', now())::date

═══ HOW TO ANSWER ═══

- Plain text only (it goes to Telegram on a phone) — no markdown tables, no code blocks.
- Lead with the number(s). Short lines, one stat per line for breakdowns, e.g.:
  "Leads by source this month:
  landing-page — 291
  Webinar — 172
  ..."
- 1-2 sentences of framing max. No essays, no jargon.
- If the result is empty or the question can't be answered from this data, say so plainly — never invent numbers.
- Numbers in your answer must come from query results, nothing else."""
    # Owner-neutral: swap any remaining default-owner mentions for this owner.
    return prompt.replace("Maher", OWNER_NAME)


def handle_reporting_request(user_question: str, conversation_history: list = None) -> str:
    """
    Answer a plain-English business question from reporting_leads + events.

    Args:
        user_question: e.g. "how many calls booked this month"
        conversation_history: recent [{"role", "content"}] so follow-ups like
            "and last week?" resolve correctly

    Returns:
        Concise, mobile-friendly answer string.
    """
    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    messages = []
    if conversation_history:
        for msg in conversation_history[-6:]:
            messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_question})

    system_prompt = _build_system_prompt()

    # Agentic loop — enough turns to retry a rejected/failed query
    for _turn in range(6):
        try:
            response = client.messages.create(
                model=MODEL_HEAVY,  # Sonnet: SQL needs to be right, not fast
                max_tokens=2000,
                system=system_prompt,
                messages=messages,
                tools=REPORTING_TOOLS,
            )
        except Exception as e:
            console.log(f"[red]✗ Reporting agent API call failed: {e}[/red]")
            return f"Couldn't pull the numbers right now — {type(e).__name__}. Try again in a minute."

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    sql = (block.input or {}).get("sql", "")
                    console.log(f"[cyan]Reporting SQL: {sql}[/cyan]")
                    result = run_reporting_sql(sql)
                    console.log(f"[dim]Result: {str(result)[:500]}[/dim]")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, default=str),
                    })
            messages.append({"role": "user", "content": tool_results})
            continue

        # end_turn (or anything else that produced text) → return the answer
        text_blocks = [b.text for b in response.content if hasattr(b, "text")]
        if text_blocks:
            return "\n".join(text_blocks).strip()
        return "Couldn't get an answer out of the data — try rephrasing the question."

    return "That one took too many tries to answer. Rephrase it and I'll have another go."
