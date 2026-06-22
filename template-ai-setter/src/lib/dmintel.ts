/**
 * DM INTELLIGENCE (Phase 2) — a read-only sales analyst.
 *
 * It samples real conversations grouped by OUTCOME (best closers vs the ones
 * that die / ghost / no-show / don't close / don't PIF), contrasts them, and
 * writes a DETAILED REPORT: what it did, where leads die, the patterns it found
 * (with evidence), and the top 1-3 concrete fixes — each with WHY it's the best
 * lever and the impact to expect.
 *
 * HARD SAFETY: this module READS business data and WRITES ONLY to its own
 * dm_intel_reports / dm_suggestions tables. It has no code path that can change
 * the setter's brain, stages, rules, leads, or any config. Suggestions are
 * advisory — applying one is a separate, human-confirmed action elsewhere.
 *
 * ON-DEMAND anytime (orbit or Telegram), PLUS a monthly safety-net run on a
 * timer so a read never gets forgotten. Never continuous.
 */
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabase";
import { sendTelegramPing } from "./telegram";

const MODEL = "claude-opus-4-8"; // the deep-think one; on-demand only
const PER_COHORT = 5;            // sample size per cohort
const MAX_CHARS = 1400;          // transcript truncation per convo

type LeadRef = { id: string; label: string };

async function transcript(leadId: string): Promise<string> {
  const { data } = await supabase.from("messages").select("role, content").eq("lead_id", leadId).order("created_at", { ascending: true }).limit(40);
  const lines = ((data ?? []) as { role: string; content: string }[])
    .map((m) => `${m.role === "lead" ? "LEAD" : "SETTER"}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 220)}`);
  let out = "";
  for (const l of lines) { if (out.length + l.length > MAX_CHARS) break; out += l + "\n"; }
  return out.trim();
}

/** Gather the outcome cohorts (read-only). Each is best-effort; a failing query
 *  just yields an empty cohort. */
async function gatherCohorts(clientId: string): Promise<Record<string, LeadRef[]>> {
  const cohorts: Record<string, LeadRef[]> = {};
  const take = (rows: { id?: string; lead_id?: string }[] | null, label: string): LeadRef[] =>
    ((rows ?? []).map((r) => ({ id: String(r.id ?? r.lead_id), label })).filter((r) => r.id && r.id !== "undefined")).slice(0, PER_COHORT);

  try { const { data } = await supabase.from("reporting_leads").select("id").eq("is_won", true).limit(PER_COHORT); cohorts["WON / best closers"] = take(data, "won"); } catch { /* */ }
  try {
    const { data } = await supabase.from("leads").select("id").eq("client_id", clientId).eq("status", "engaged")
      .in("funnel_stage", ["opener", "transition_main_reason", "goals"]).lt("last_message_at", new Date(Date.now() - 3 * 86400_000).toISOString()).limit(PER_COHORT);
    cohorts["DIED after first replies (early stall)"] = take(data, "died_early");
  } catch { /* */ }
  try {
    const { data } = await supabase.from("leads").select("id").eq("client_id", clientId).eq("status", "engaged")
      .in("funnel_stage", ["pitch_help", "book"]).lt("last_message_at", new Date(Date.now() - 2 * 86400_000).toISOString()).limit(PER_COHORT);
    cohorts["GHOSTED after the call pitch"] = take(data, "ghosted_pitch");
  } catch { /* */ }
  try { const { data } = await supabase.from("reporting_leads").select("id").eq("is_no_show", true).limit(PER_COHORT); cohorts["NO-SHOWED the call"] = take(data, "no_show"); } catch { /* */ }
  try { const { data } = await supabase.from("reporting_leads").select("id").eq("reached_booked", true).eq("is_won", false).eq("is_no_show", false).eq("is_disqualified", false).limit(PER_COHORT); cohorts["SHOWED but didn't close"] = take(data, "show_no_close"); } catch { /* */ }
  return cohorts;
}

interface Finding { cohort: string; pattern: string; evidence: string; where: string }
interface Suggestion { title: string; finding: string; evidence: string; proposed_change: string; why_best: string; expected_impact: string; target: string; confidence: string }
interface Analysis { summary: string; what_i_did: string; findings: Finding[]; suggestions: Suggestion[] }

function parseAnalysis(text: string): Analysis | null {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1) return null;
  try {
    const o = JSON.parse(text.slice(s, e + 1));
    return {
      summary: String(o.summary || ""),
      what_i_did: String(o.what_i_did || "").slice(0, 1600),
      findings: (Array.isArray(o.findings) ? o.findings : []).slice(0, 8).map((x: Record<string, unknown>) => ({
        cohort: String(x.cohort || "").slice(0, 120), pattern: String(x.pattern || "").slice(0, 700),
        evidence: String(x.evidence || "").slice(0, 600), where: String(x.where || "").slice(0, 120),
      })),
      suggestions: (Array.isArray(o.suggestions) ? o.suggestions : []).slice(0, 3).map((x: Record<string, unknown>) => ({
        title: String(x.title || "").slice(0, 200), finding: String(x.finding || "").slice(0, 800),
        evidence: String(x.evidence || "").slice(0, 600), proposed_change: String(x.proposed_change || "").slice(0, 1200),
        why_best: String(x.why_best || "").slice(0, 700), expected_impact: String(x.expected_impact || "").slice(0, 400),
        target: String(x.target || "other").slice(0, 60), confidence: String(x.confidence || "medium").slice(0, 20),
      })),
    };
  } catch { return null; }
}

// ─────────────────────────── presentation ───────────────────────────
// A ready-to-render report card for the orbit. The HQ brain is told to drop
// this into `panels` VERBATIM so nothing gets paraphrased or dropped.
interface ReportSection { h: string; body: string }
interface ReportFix { n: number; title: string; body: string; why: string; impact: string; target: string; confidence: string }
export interface ReportPanel { kind: "report"; title: string; summary: string; sections: ReportSection[]; fixes: ReportFix[] }

function buildReportPanel(args: {
  summary: string; method?: string | null; findings: Finding[]; suggestions: Suggestion[];
  sample?: Record<string, number>; when?: string;
}): ReportPanel {
  const sections: ReportSection[] = [];
  const sampled = Object.entries(args.sample || {}).filter(([, n]) => n > 0);
  if (args.method) sections.push({ h: "HOW I LOOKED", body: args.method });
  if (sampled.length) sections.push({ h: "WHAT I READ", body: sampled.map(([k, n]) => `• ${k}: ${n} convo${n === 1 ? "" : "s"}`).join("\n") });
  if (args.findings.length) {
    sections.push({
      h: "WHAT I FOUND",
      body: args.findings.map((f) => {
        const head = f.where ? `${f.cohort} — ${f.where}` : f.cohort;
        const ev = f.evidence ? `\n   e.g. ${f.evidence}` : "";
        return `▸ ${head}\n   ${f.pattern}${ev}`;
      }).join("\n\n"),
    });
  }
  const fixes: ReportFix[] = args.suggestions.map((s, i) => ({
    n: i + 1, title: s.title, body: s.proposed_change,
    why: s.why_best || s.finding || "", impact: s.expected_impact || "",
    target: s.target || "other", confidence: s.confidence || "medium",
  }));
  return { kind: "report", title: "DM INTELLIGENCE", summary: args.summary, sections, fixes };
}

/** Plain-text rendering of a report (for Telegram). Clean, scannable, no markdown soup. */
export function reportToText(args: {
  summary: string; method?: string | null; findings: Finding[]; suggestions: Suggestion[];
  sample?: Record<string, number>; when?: string;
}): string {
  const L: string[] = [];
  L.push("📊 DM INTELLIGENCE");
  if (args.when) L.push(`  ${args.when}`);
  L.push("");
  L.push("— THE READ —");
  L.push(args.summary || "(no summary)");
  if (args.method) { L.push(""); L.push("— HOW I LOOKED —"); L.push(args.method); }
  const sampled = Object.entries(args.sample || {}).filter(([, n]) => n > 0);
  if (sampled.length) { L.push(""); L.push("— WHAT I READ —"); for (const [k, n] of sampled) L.push(`• ${k}: ${n} convo${n === 1 ? "" : "s"}`); }
  if (args.findings.length) {
    L.push(""); L.push("— WHAT I FOUND —");
    for (const f of args.findings) {
      L.push(`▸ ${f.where ? `${f.cohort} (${f.where})` : f.cohort}`);
      L.push(`   ${f.pattern}`);
      if (f.evidence) L.push(`   e.g. ${f.evidence}`);
    }
  }
  if (args.suggestions.length) {
    L.push(""); L.push(`— TOP ${args.suggestions.length} FIX${args.suggestions.length === 1 ? "" : "ES"} —`);
    args.suggestions.forEach((s, i) => {
      L.push("");
      L.push(`${i + 1}. ${s.title}  [${s.confidence} confidence · ${s.target}]`);
      L.push(`   Change: ${s.proposed_change}`);
      if (s.why_best) L.push(`   Why this one: ${s.why_best}`);
      if (s.expected_impact) L.push(`   Expected: ${s.expected_impact}`);
    });
  } else {
    L.push(""); L.push("No strong fixes yet — not enough clean signal. Nothing changes regardless until you approve it.");
  }
  L.push("");
  L.push("Nothing here is applied. Tell me which fix to make (with any tweak of yours) and I'll change it after you confirm.");
  return L.join("\n");
}

/** Run one analysis pass and persist the report. Read-only over business data;
 *  writes only the report + its suggestions. Returns rich data + a ready report panel. */
export async function runDmIntel(clientId: string, trigger: "manual" | "monthly" = "manual"): Promise<{
  ok: boolean; report_id?: string; summary?: string; suggestions?: number;
  report_panel?: ReportPanel; report_text?: string; reason?: string;
}> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, reason: "brain_not_configured" };
    const { data: clientRow } = await supabase.from("clients").select("name, business_context").eq("id", clientId).maybeSingle();
    const ctx = (clientRow as { name?: string; business_context?: string } | null) || {};

    const cohorts = await gatherCohorts(clientId);
    const sampleSizes: Record<string, number> = {};
    const blocks: string[] = [];
    for (const [label, refs] of Object.entries(cohorts)) {
      sampleSizes[label] = refs.length;
      if (!refs.length) continue;
      const ts = await Promise.all(refs.map((r) => transcript(r.id)));
      const nonEmpty = ts.filter(Boolean);
      sampleSizes[label] = nonEmpty.length;
      if (!nonEmpty.length) continue;
      blocks.push(`═══ COHORT: ${label} (${nonEmpty.length} convos) ═══\n` + nonEmpty.map((t, i) => `--- convo ${i + 1} ---\n${t}`).join("\n\n"));
    }
    if (!blocks.length) return { ok: false, reason: "no_conversations_to_analyse" };

    const system = `You are a world-class Instagram-DM sales analyst for ${ctx.name || "this coaching business"}.
BUSINESS CONTEXT:\n${(ctx.business_context || "").slice(0, 1200)}

You are given real DM conversations grouped by OUTCOME. Your job:
1) Contrast the WINNING conversations against the losing ones and find the patterns that separate them.
2) Pinpoint WHERE leads drop off (which stage/step) and WHY.
3) Propose the TOP 1-3 highest-leverage, CONCRETE changes to the setter's approach to win more of the best sales (PIF / ICP closers).

Write it so a non-technical owner can read it and instantly get it. Explain your thinking like a sharp operator walking him through what you did — what you compared, where the leaks are, and exactly why each fix is the best lever (not just what to do). Ground EVERY claim in something you actually see in the transcripts; quote or paraphrase the real lines as evidence. Be specific: name the kind of line/step to change and what to change it to.

These suggestions are ADVISORY — a human reviews and approves before anything changes. Do not assume anything will be auto-applied.

Output STRICT JSON only, no prose, no code fences:
{"summary":"3-5 sentence plain-English headline of the biggest insight and what to do about it","what_i_did":"a short narrative (3-6 sentences): which cohorts you compared, roughly how many convos, what you were looking for, and how you reasoned your way to the conclusions","findings":[{"cohort":"the cohort name","where":"the stage/step where this shows up, e.g. 'the opener', 'right after the pitch', 'booking ask'","pattern":"what's distinctive about this cohort vs the winners","evidence":"a concrete line/behaviour you actually saw"}],"suggestions":[{"title":"short imperative","finding":"the insight behind it","evidence":"what in the convos supports it (be specific)","proposed_change":"the exact concrete change to make to the setter","why_best":"why this is higher-leverage than the other options you considered","expected_impact":"what should improve and a rough sense of how much","target":"system_prompt|stage:<id>|pitch|opener|other","confidence":"high|medium|low"}]}
Max 3 suggestions, ordered best-first. If the data is too thin to be confident, SAY SO clearly in the summary and what_i_did, and return fewer (or zero) suggestions rather than inventing.`;

    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 4000, output_config: { effort: "medium" },
      system, messages: [{ role: "user", content: blocks.join("\n\n").slice(0, 60000) }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
    const analysis = parseAnalysis(text);
    if (!analysis) return { ok: false, reason: "analysis_parse_failed" };

    const { data: rep } = await supabase.from("dm_intel_reports").insert({
      client_id: clientId, trigger, summary: analysis.summary, method: analysis.what_i_did,
      findings: analysis.findings, sample: sampleSizes,
    }).select("id").single();
    const reportId = (rep as { id: string } | null)?.id;
    if (reportId && analysis.suggestions.length) {
      await supabase.from("dm_suggestions").insert(analysis.suggestions.map((s) => ({
        report_id: reportId, client_id: clientId, title: s.title, finding: s.finding, evidence: s.evidence,
        proposed_change: s.proposed_change, why_best: s.why_best, expected_impact: s.expected_impact,
        target: s.target, confidence: s.confidence,
      })));
    }
    const when = new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
    const payload = { summary: analysis.summary, method: analysis.what_i_did, findings: analysis.findings, suggestions: analysis.suggestions, sample: sampleSizes, when };
    return {
      ok: true, report_id: reportId, summary: analysis.summary, suggestions: analysis.suggestions.length,
      report_panel: buildReportPanel(payload), report_text: reportToText(payload),
    };
  } catch (err) {
    console.error("[dmintel] runDmIntel failed:", err);
    return { ok: false, reason: "error" };
  }
}

/** The latest report + its suggestions (read-only), with a ready report panel + text. */
export async function getLatestDmReport(clientId: string) {
  const { data: rep } = await supabase.from("dm_intel_reports").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!rep) return { report: null, suggestions: [], report_panel: null, report_text: null };
  const r = rep as { id: string; summary: string; method?: string; findings: unknown; sample?: unknown; created_at: string };
  const { data: sugg } = await supabase.from("dm_suggestions")
    .select("title, finding, evidence, proposed_change, why_best, expected_impact, target, confidence, status")
    .eq("report_id", r.id).order("created_at", { ascending: true });
  const findings = (Array.isArray(r.findings) ? r.findings : []) as Finding[];
  const suggestions = ((sugg ?? []) as Record<string, unknown>[]).map((s) => ({
    title: String(s.title || ""), finding: String(s.finding || ""), evidence: String(s.evidence || ""),
    proposed_change: String(s.proposed_change || ""), why_best: String(s.why_best || ""),
    expected_impact: String(s.expected_impact || ""), target: String(s.target || "other"), confidence: String(s.confidence || "medium"),
  })) as Suggestion[];
  const when = new Date(r.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
  const sample = (r.sample && typeof r.sample === "object" ? r.sample : {}) as Record<string, number>;
  const payload = { summary: r.summary, method: r.method, findings, suggestions, sample, when };
  return {
    report: { id: r.id, summary: r.summary, method: r.method || "", findings, created_at: r.created_at },
    suggestions: sugg ?? [],
    report_panel: buildReportPanel(payload),
    report_text: reportToText(payload),
  };
}

/** Monthly safety-net run for every opted-in client (gated by dm_intel_enabled).
 *  Runs the SAME analysis as on-demand, then pings the owner that it's ready to
 *  read. Read-only — it only writes its own report tables. Safe no-op when
 *  nobody's enabled. On-demand always works regardless of this flag. */
export async function runDmIntelMonthly(): Promise<void> {
  try {
    const { data } = await supabase.from("clients").select("id, name").eq("dm_intel_enabled", true);
    for (const c of (data ?? []) as { id: string; name: string }[]) {
      const r = await runDmIntel(c.id, "monthly");
      // ALWAYS ping — Maher wants to hear from it every month, even when there's
      // nothing to chew on, so he knows the timer is alive and working.
      let msg: string;
      if (r.ok && r.summary) {
        const tail = r.suggestions
          ? `${r.suggestions} fix${r.suggestions === 1 ? "" : "es"} are waiting. Say "show me the DM report" — here or to Jarvis in the orbit — to read the full thing. Nothing changes until you approve it.`
          : "No strong fixes this month.";
        msg = `📊 DM Intelligence — your monthly read is in.\n\n${r.summary}\n\n${tail}\n— Jarvis`;
      } else if (r.reason === "no_conversations_to_analyse") {
        msg = `📊 DM Intelligence — monthly check ran fine, but there aren't enough conversations to analyse yet. Nothing's broken — I'll run it again next month, and you can ask me to analyse any time you've got more DMs flowing.\n— Jarvis`;
      } else {
        msg = `📊 DM Intelligence — monthly check ran but couldn't finish a full read this time (${r.reason || "technical hiccup"}). Nothing's broken and nothing changed; I'll try again next month, or you can ask me to analyse on demand.\n— Jarvis`;
      }
      await sendTelegramPing(msg);
    }
  } catch (err) {
    console.error("[dmintel] monthly run failed:", err);
  }
}
