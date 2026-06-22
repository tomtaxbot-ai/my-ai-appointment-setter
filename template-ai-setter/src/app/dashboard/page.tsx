import { supabase } from "@/lib/supabase";
import Filters from "./filters";
import SalesFunnelSelect from "./sales-funnel-select";
import MoneyFlow from "./money-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── get_dashboard(p_start, p_end, p_source, p_funnel) jsonb shape ──
type Reason = { reason: string; name: string | null; date: string | null };
type Dashboard = {
  period: { start: string; end: string; source: string; funnel: string };
  outbound: {
    new_followers: number | null; outreaches: number | null; replies: number | null;
    followups_outreach: number | null; followups_convo: number | null;
    icp: number | null; qualified: number | null;
    call_pitched: number | null; followups_pitched: number | null;
    booked: number | null; pickup_rate: number | null;
    qualified_to_pitched: number | null; pitched_to_booked: number | null;
  };
  inbound: {
    new_leads: number | null; dials: number | null; followups_dials: number | null;
    pickups: number | null; icp: number | null;
    qualified: number | null; call_pitched: number | null; booked: number | null;
    dial_coverage: number | null; pickup_connect_rate: number | null; pitched_to_booked: number | null;
  };
  sales: {
    booked: number | null; showed: number | null; offer_pitched: number | null; closed: number | null;
    no_shows: number | null; losts: number | null; avg_call_minutes_on_close: number | null;
    show_rate: number | null; close_rate: number | null; booked_to_close: number | null;
    cash_collected: number | null; revenue_signed: number | null; ltv_cash: number | null;
    ltv_contract: number | null; outstanding: number | null;
    average_deal_size: number | null; average_first_payment: number | null;
    cash_per_booked_call: number | null; cash_per_outreach: number | null; pif_rate: number | null;
    disputes: number | null; money_lost_to_disputes: number | null; dispute_rate: number | null;
    ai_booked: number | null; ai_booked_pct: number | null;
  };
  by_source: { source: string | null; leads: number; booked: number; won: number }[];
  revenue_by_source: { source: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_campaign: { campaign: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_placement: { placement: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_booking_method: { method: string | null; clients: number; signed: number | null; cash: number | null }[];
  by_placement: { placement: string | null; leads: number }[];
  by_campaign: { campaign: string | null; leads: number }[];
  by_booking_method: { method: string | null; booked: number }[];
  reasons_no_close: Reason[];
  reasons_no_pitch: Reason[];
  speed: {
    median_first_reply_seconds: number | null; leads_gone_quiet: number | null;
    median_days_lead_to_booked: number | null; median_booked_to_call_days: number | null;
    median_sales_cycle_days: number | null;
  };
};

const GOLD = "#a8892e";
const GOLD2 = "#c9a84c";
const MUTED = "#7d869c";

// ── period → [start,end] (UTC) ──
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function computeRange(period: string, sp: { start?: string; end?: string }): { start: string; end: string } {
  const now = new Date();
  const end = iso(now);
  if (period === "custom") {
    let s = isDate(sp.start) ? sp.start : `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
    let e = isDate(sp.end) ? sp.end : end;
    if (s > end) s = end; // no future dates
    if (e > end) e = end;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }
  if (period === "today") return { start: end, end };
  if (period === "week") {
    const day = now.getUTCDay();
    const back = day === 0 ? 6 : day - 1;
    return { start: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back))), end };
  }
  if (period === "year") return { start: `${now.getUTCFullYear()}-01-01`, end };
  if (period === "all") return { start: "2000-01-01", end };
  return { start: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`, end };
}

// ── formatters ──
const dash = "—";
const money = (n: number | null | undefined) => (n == null ? dash : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const money2 = (n: number | null | undefined) => (n == null ? dash : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (n: number | null | undefined) => (n == null ? dash : Number(n).toLocaleString("en-US"));
const pct = (n: number | null | undefined) => (n == null ? dash : `${Math.round(Number(n))}%`);
const step = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || !b ? dash : `${Math.round((a / b) * 100)}%`;
const dec = (n: number | null | undefined, digits = 1) => (n == null ? dash : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits }));
const speedFmt = (s: number | null | undefined) => {
  if (s == null) return dash;
  const x = Math.round(Number(s));
  return x < 60 ? `${x}s` : `${Math.floor(x / 60)}m ${x % 60}s`;
};
const daysFmt = (n: number | null | undefined) => {
  if (n == null) return dash;
  const x = Number(n);
  const r = x < 10 ? Math.round(x * 10) / 10 : Math.round(x);
  return `${r} ${r === 1 ? "day" : "days"}`;
};
const dateOnly = (d: string | null) => (d ? d.slice(0, 10) : "");

const METHOD_LABELS: Record<string, string> = { manual_dm: "Manual DM", ai_dm: "AI DM", self_serve: "Self-serve", dialing: "Dialing" };
function methodLabel(m: string | null): string {
  if (!m) return "Unknown";
  if (m === "(none)") return "(none)";
  if (METHOD_LABELS[m]) return METHOD_LABELS[m];
  return m.split(/[_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// ── presentational atoms ──
function Card({ titleText, children, delay, headerRight, style, subtitle }: {
  titleText: string; children: React.ReactNode; delay: number;
  headerRight?: React.ReactNode; style?: React.CSSProperties; subtitle?: string;
}) {
  return (
    <section className="hud-card" style={{ animationDelay: `${delay}ms`, ...style }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: subtitle ? 4 : 14 }}>
        <div className="hud-title" style={{ marginBottom: 0 }}>{titleText}</div>
        {headerRight}
      </div>
      {subtitle && <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 13, lineHeight: 1.4 }}>{subtitle}</div>}
      {children}
    </section>
  );
}
function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className={big ? "metric metric-lg" : "metric"}>{value}</div>
      <div className="cap">{label}</div>
    </div>
  );
}

// A funnel stage row (or an indented follow-up sub-row).
type FunnelRow = { label: string; value: number | null; prev?: number | null; sub?: boolean };
function Funnel({ rows }: { rows: FunnelRow[] }) {
  const maxV = Math.max(1, ...rows.filter((r) => !r.sub).map((r) => Number(r.value || 0)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((r, i) =>
        r.sub ? (
          <div key={i} className="funnel-sub">
            <span style={{ color: MUTED }}>↳ {r.label}</span>
            <span style={{ fontFamily: "var(--mono)", color: "#aeb6c8" }}>{num(r.value)}</span>
          </div>
        ) : (
          <div key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 5 }}>
              <span style={{ color: "#c2c9d8" }}>{r.label}</span>
              <span style={{ color: "#fff", fontWeight: 700, fontFamily: "var(--mono)" }}>
                {num(r.value)}
                {r.prev !== undefined && (
                  <span style={{ color: GOLD2, fontWeight: 600, marginLeft: 8, fontSize: 12 }}>{step(r.value, r.prev)}</span>
                )}
              </span>
            </div>
            <div className="funnel-track">
              <div className="funnel-fill" style={{ width: `${Math.max(2, (Number(r.value || 0) / maxV) * 100)}%` }} />
            </div>
          </div>
        )
      )}
    </div>
  );
}
function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <span className="kpi-badge">
      <span className="cap" style={{ marginTop: 0 }}>{label}</span>
      <span className="metric" style={{ fontSize: 16 }}>{value}</span>
    </span>
  );
}

// ── DEMO data: a believable, impressive snapshot built fresh each load ──
function fakeDashboard(start: string, end: string, source: string, funnel: string): Dashboard {
  const R = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
  const leads = R(420, 680), reps = R(180, 320), icp = R(90, 160), qual = R(48, 90);
  const pitched = R(30, 55), booked = R(22, 40), showed = Math.round(booked * 0.72), closed = Math.round(showed * 0.42);
  const aiBooked = Math.round(booked * 0.64);
  const cash = R(38, 72) * 1000, signed = cash + R(20, 60) * 1000;
  const srcs = ["YouTube", "IG", "Referrals", "Ads", "TikTok"];
  return {
    period: { start, end, source: source || "all sources", funnel },
    outbound: {
      new_followers: R(800, 1600), outreaches: reps + R(120, 260), replies: reps, followups_outreach: R(60, 140),
      followups_convo: R(40, 90), icp, qualified: qual, call_pitched: pitched, followups_pitched: R(10, 30),
      booked, pickup_rate: R(38, 62), qualified_to_pitched: R(55, 78), pitched_to_booked: R(60, 82),
    },
    inbound: {
      new_leads: R(120, 260), dials: R(80, 180), followups_dials: R(30, 70), pickups: R(40, 90), icp: R(40, 80),
      qualified: R(30, 60), call_pitched: R(20, 40), booked: R(10, 22), dial_coverage: R(70, 95),
      pickup_connect_rate: R(35, 60), pitched_to_booked: R(55, 80),
    },
    sales: {
      booked, showed, offer_pitched: showed, closed, no_shows: booked - showed, losts: showed - closed,
      avg_call_minutes_on_close: R(34, 52), show_rate: Math.round((showed / booked) * 100),
      close_rate: Math.round((closed / showed) * 100), booked_to_close: Math.round((closed / booked) * 100),
      cash_collected: cash, revenue_signed: signed, ltv_cash: R(2400, 4200), ltv_contract: R(4200, 7200),
      outstanding: signed - cash, average_deal_size: Math.round(signed / Math.max(1, closed)),
      average_first_payment: R(1500, 3200), cash_per_booked_call: Math.round(cash / Math.max(1, booked)),
      cash_per_outreach: Math.round((cash / Math.max(1, reps)) * 100) / 100, pif_rate: R(30, 55),
      disputes: R(0, 2), money_lost_to_disputes: R(0, 1) * 1500, dispute_rate: R(0, 3),
      ai_booked: aiBooked, ai_booked_pct: Math.round((aiBooked / booked) * 100),
    },
    by_source: srcs.map((s) => ({ source: s, leads: R(40, 180), booked: R(3, 14), won: R(1, 6) })),
    revenue_by_source: srcs.map((s) => ({ source: s, clients: R(1, 6), signed: R(8, 30) * 1000, cash: R(5, 22) * 1000 })),
    revenue_by_campaign: [{ campaign: "Q2 Push", clients: R(2, 8), signed: R(20, 50) * 1000, cash: R(14, 36) * 1000 }],
    revenue_by_placement: [{ placement: "Reels", clients: R(2, 7), signed: R(16, 44) * 1000, cash: R(10, 30) * 1000 }],
    revenue_by_booking_method: [
      { method: "ai_dm", clients: R(3, 8), signed: R(24, 52) * 1000, cash: R(16, 38) * 1000 },
      { method: "manual_dm", clients: R(1, 4), signed: R(8, 20) * 1000, cash: R(5, 14) * 1000 },
    ],
    by_placement: [{ placement: "Reels", leads: R(120, 300) }, { placement: "Stories", leads: R(60, 160) }],
    by_campaign: [{ campaign: "Q2 Push", leads: R(150, 380) }],
    by_booking_method: [{ method: "ai_dm", booked: aiBooked }, { method: "manual_dm", booked: booked - aiBooked }],
    reasons_no_close: [{ reason: "Needs to talk to partner", name: "Demo Lead", date: end }],
    reasons_no_pitch: [{ reason: "Not qualified yet", name: "Demo Lead", date: end }],
    speed: {
      median_first_reply_seconds: R(8, 45), leads_gone_quiet: R(10, 40),
      median_days_lead_to_booked: R(1, 4), median_booked_to_call_days: R(1, 3), median_sales_cycle_days: R(3, 9),
    },
  };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; source?: string; start?: string; end?: string; funnel?: string; demo?: string }>;
}) {
  const sp = await searchParams;
  const period = ["today", "week", "month", "year", "all", "custom"].includes(sp.period || "")
    ? (sp.period as string)
    : "month";
  const source = (sp.source || "").trim();
  const funnel = ["all", "outbound", "inbound"].includes(sp.funnel || "") ? (sp.funnel as string) : "all";
  const { start, end } = computeRange(period, sp);

  // DEMO VIEW (?demo=1, driven by Jarvis HQ): fabricated impressive numbers,
  // zero real data — safe to show on a sales call.
  const demoView = sp.demo === "1" || sp.demo === "true";

  // The period's data (4th arg = the Sales block's funnel filter).
  const { data, error } = demoView
    ? { data: fakeDashboard(start, end, source, funnel) as Dashboard, error: null }
    : await supabase.rpc("get_dashboard", {
      p_start: start, p_end: end, p_source: source || null, p_funnel: funnel,
    });

  // Jarvis-booked money — deals whose booking came from the AI setter (all time).
  let aiCash = 0, aiSigned = 0;
  if (demoView) {
    aiCash = 41200; aiSigned = 78500;
  } else {
    const { data: aiDeals } = await supabase.from("customers").select("id, contract_value").eq("booking_method", "ai_dm");
    const aiIds = (aiDeals ?? []).map((c) => c.id);
    if (aiIds.length) {
      const { data: aiPays } = await supabase.from("payments").select("amount").in("customer_id", aiIds);
      aiCash = (aiPays ?? []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    }
    aiSigned = (aiDeals ?? []).reduce((sum, c) => sum + (Number(c.contract_value) || 0), 0);
  }

  // Follow-up engine performance + the leak map (where leads stall in the DMs).
  const FUNNEL_SEQ = ["opener", "transition_main_reason", "goals", "current_situation", "timeline", "problem", "pitch_help", "book"];
  const STAGE_LABELS: Record<string, string> = {
    opener: "Opener", transition_main_reason: "Main reason", goals: "Goals", current_situation: "Situation",
    timeline: "Timeline", problem: "Problem", pitch_help: "Pitch", book: "Booking", post_book: "Post-book", proof: "Proof", nurture: "Nurture",
  };
  let fu = { sent_7d: 0, sent_30d: 0, sent_total: 0, revived_7d: 0, revived_total: 0, rebooked_total: 0 };
  let leak: { funnel_stage: string; stalled: number }[] = [];
  if (demoView) {
    fu = { sent_7d: 34, sent_30d: 121, sent_total: 121, revived_7d: 9, revived_total: 31, rebooked_total: 7 };
    leak = [{ funnel_stage: "problem", stalled: 11 }, { funnel_stage: "pitch_help", stalled: 7 }, { funnel_stage: "goals", stalled: 5 }, { funnel_stage: "book", stalled: 3 }];
  } else {
    const [fuRow, leakRows] = await Promise.all([
      supabase.from("reporting_followups").select("*").maybeSingle(),
      supabase.from("reporting_leak_map").select("*"),
    ]);
    if (fuRow.data) fu = fuRow.data as typeof fu;
    leak = (leakRows.data ?? []) as { funnel_stage: string; stalled: number }[];
  }
  leak = leak.sort((a, b) => FUNNEL_SEQ.indexOf(a.funnel_stage) - FUNNEL_SEQ.indexOf(b.funnel_stage));
  const leakMax = Math.max(1, ...leak.map((l) => l.stalled));

  // Fixed source list (always shown, even at zero leads). "All sources" is the
  // dropdown's built-in default; a selection passes through as p_source as-is.
  const sourceOptions = ["YouTube", "IG", "Referrals", "Affiliates", "Ads",
    "TikTok", "LinkedIn", "X", "Threads", "Facebook"];
  // Keep a non-list source (e.g. from an old URL) visible as the selection.
  if (source && !sourceOptions.includes(source)) sourceOptions.push(source);

  if (error || !data) {
    return (
      <main className="hud-main" style={pageStyle}>
        <div className="hud-card" style={{ maxWidth: 640, margin: "40px auto", color: "#ef6a6a", animationDelay: "0ms" }}>
          Couldn&apos;t load the dashboard{error ? `: ${error.message}` : "."}
        </div>
        <style>{HUD_CSS}</style>
      </main>
    );
  }

  const d = data as Dashboard;
  const ob = d.outbound;
  const ib = d.inbound;
  const s = d.sales;
  // Derived call-quality gaps (the "didn't happen" side of each step).
  const notPitched = s.showed != null && s.offer_pitched != null ? s.showed - s.offer_pitched : null;
  const notClosed = s.offer_pitched != null && s.closed != null ? s.offer_pitched - s.closed : null;
  const noCalls = !s.showed; // 0 or null → flag that figures are all zero this period

  const outboundRows: FunnelRow[] = [
    { label: "New followers", value: ob.new_followers },
    { label: "Outreaches", value: ob.outreaches, prev: ob.new_followers },
    { label: "Follow-ups on outreaches", value: ob.followups_outreach, sub: true },
    { label: "Replies", value: ob.replies, prev: ob.outreaches },
    { label: "Follow-ups on conversations", value: ob.followups_convo, sub: true },
    { label: "ICP", value: ob.icp, prev: ob.replies },
    { label: "Qualified", value: ob.qualified, prev: ob.icp },
    { label: "Call pitched", value: ob.call_pitched, prev: ob.qualified },
    { label: "Follow-ups on calls pitched", value: ob.followups_pitched, sub: true },
    { label: "Booked", value: ob.booked, prev: ob.call_pitched },
  ];
  const inboundRows: FunnelRow[] = [
    { label: "New leads", value: ib.new_leads },
    { label: "Dials", value: ib.dials, prev: ib.new_leads },
    { label: "Follow-ups on dials", value: ib.followups_dials, sub: true },
    { label: "Pickups", value: ib.pickups, prev: ib.dials },
    { label: "ICP", value: ib.icp, prev: ib.pickups },
    { label: "Qualified", value: ib.qualified, prev: ib.icp },
    { label: "Call pitched", value: ib.call_pitched, prev: ib.qualified },
    { label: "Booked", value: ib.booked, prev: ib.call_pitched },
  ];

  return (
    <main className="hud-main" style={pageStyle}>
      <div style={{ position: "relative", zIndex: 1, maxWidth: 1260, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* HEADER */}
        <header style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span className="hud-brand">{process.env.NEXT_PUBLIC_BRAND_NAME || "AI SETTER"}</span>
            <span style={{ fontSize: 13, color: MUTED, fontFamily: "var(--mono)" }}>
              {d.period.start} → {d.period.end} · {d.period.source}
            </span>
          </div>
          <Filters period={period} source={source} sources={sourceOptions} start={start} end={end} />
        </header>

        {/* TWO FUNNELS */}
        <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card
            titleText="Outbound — IG DMs"
            delay={60}
            headerRight={<Kpi label="Pickup rate" value={pct(ob.pickup_rate)} />}
          >
            <Funnel rows={outboundRows} />
          </Card>

          <Card
            titleText="Inbound — opt-ins + dials"
            delay={110}
            headerRight={
              <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Kpi label="Dial coverage" value={pct(ib.dial_coverage)} />
                <Kpi label="Pickup connect" value={pct(ib.pickup_connect_rate)} />
              </span>
            }
          >
            <Funnel rows={inboundRows} />
          </Card>
        </div>

        {/* MONEY FLOW — purely-visual pipeline → cash strip. Reads numbers
            already computed above; runs no queries, changes no data/logging. */}
        <Card titleText="Money flow — DMs → cash" delay={140}>
          <MoneyFlow nodes={[
            { label: "Outreaches", value: ob.outreaches },
            { label: "Replies", value: ob.replies },
            { label: "Booked", value: s.booked },
            { label: "Closed", value: s.closed },
            { label: "Cash collected", value: s.cash_collected, kind: "cash" },
          ]} />
        </Card>

        {/* FOLLOW-UPS — re-engagement performance + where leads die */}
        <Card titleText="Follow-ups — re-engaging quiet leads" delay={150}
          headerRight={<Kpi label="Sent · 7d" value={num(fu.sent_7d)} />}>
          <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1.25fr", gap: 22 }}>
            <div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <Stat big label="Leads revived" value={num(fu.revived_total)} />
                <Stat big label="Rebooked from follow-ups" value={num(fu.rebooked_total)} />
              </div>
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid rgba(168,137,46,.18)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Follow-ups sent · 7d" value={num(fu.sent_7d)} />
                <Stat label="Follow-ups sent · 30d" value={num(fu.sent_30d)} />
                <Stat label="Revived · 7d" value={num(fu.revived_7d)} />
              </div>
            </div>
            <div>
              <span className="cap" style={{ color: GOLD2 }}>Where leads die (stalled 24h+ by stage)</span>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                {leak.length === 0 ? (
                  <span style={{ color: MUTED, fontSize: 13 }}>No stalled leads right now.</span>
                ) : leak.map((l) => (
                  <div key={l.funnel_stage} style={{ display: "grid", gridTemplateColumns: "92px 1fr 32px", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span style={{ color: "#cfc8b4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{STAGE_LABELS[l.funnel_stage] || l.funnel_stage}</span>
                    <span style={{ height: 8, background: "rgba(255,255,255,.06)", borderRadius: 6, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${(l.stalled / leakMax) * 100}%`, background: "linear-gradient(90deg,#8b6914,#c9a84c)" }} />
                    </span>
                    <span style={{ textAlign: "right", color: "#f5f0e1", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{l.stalled}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* SALES (full width, own funnel dropdown) */}
        <Card
          titleText={`Sales — ${funnel === "all" ? "all funnels" : funnel}`}
          delay={160}
          headerRight={<SalesFunnelSelect funnel={funnel} />}
        >
          <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1.25fr", gap: 22 }}>
            {/* money */}
            <div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <Stat big label="Cash collected" value={money(s.cash_collected)} />
                <Stat big label="Revenue contracted" value={money(s.revenue_signed)} />
              </div>
              {/* deal economics */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid rgba(168,137,46,.18)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Avg deal size" value={money(s.average_deal_size)} />
                <Stat label="Avg first payment" value={money(s.average_first_payment)} />
                <Stat label="PIF rate (paid in full)" value={pct(s.pif_rate)} />
              </div>
              {/* cash efficiency */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid rgba(168,137,46,.18)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Cash / booked call" value={money(s.cash_per_booked_call)} />
                <Stat label="Cash / outreach" value={money2(s.cash_per_outreach)} />
              </div>
              {/* lifetime value */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid rgba(168,137,46,.18)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Avg LTV / customer (cash)" value={money(s.ltv_cash)} />
                <Stat label="Avg LTV / customer (contract)" value={money(s.ltv_contract)} />
                <Stat label="Outstanding (contracted − collected)" value={money(s.outstanding)} />
              </div>
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid rgba(168,137,46,.18)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Disputes" value={num(s.disputes)} />
                <Stat label="Lost to disputes" value={money(s.money_lost_to_disputes)} />
                <Stat label="Dispute rate" value={pct(s.dispute_rate)} />
              </div>
            </div>

            {/* calls */}
            <div>
              {/* Booked by AI — hero metric, per the selected funnel filter */}
              <div className="kpi-badge" style={{ display: "flex", gap: 14, alignItems: "baseline", padding: "12px 16px", marginBottom: 10 }}>
                <span className="cap" style={{ color: GOLD2, marginTop: 0 }}>Booked by Jarvis</span>
                <span className="metric metric-lg" style={{ color: GOLD2, textShadow: "0 0 22px rgba(201,168,76,.6)" }}>{num(s.ai_booked)}</span>
                <span className="cap" style={{ marginTop: 0 }}>({pct(s.ai_booked_pct)} of bookings)</span>
              </div>
              {/* Jarvis-booked deals that turned into MONEY (all time) */}
              <div className="kpi-badge" style={{ display: "flex", gap: 14, alignItems: "baseline", padding: "12px 16px", marginBottom: 14 }}>
                <span className="cap" style={{ color: GOLD2, marginTop: 0 }}>Jarvis → cash</span>
                <span className="metric metric-lg" style={{ color: GOLD2, textShadow: "0 0 22px rgba(201,168,76,.6)" }}>{money(aiCash)}</span>
                <span className="cap" style={{ marginTop: 0 }}>collected · {money(aiSigned)} signed · all time</span>
              </div>
              {/* call-quality counts — always shown (0s are real data, not "missing") */}
              <div style={{ display: "flex", gap: 18, rowGap: 14, flexWrap: "wrap" }}>
                <Stat label="Booked" value={num(s.booked)} />
                <Stat label="Showed" value={num(s.showed)} />
                <Stat label="No-shows" value={num(s.no_shows)} />
                <Stat label="Pitched" value={num(s.offer_pitched)} />
                <Stat label="Not pitched" value={num(notPitched)} />
                <Stat label="Closed" value={num(s.closed)} />
                <Stat label="Not closed" value={num(notClosed)} />
                <Stat label="Losts" value={num(s.losts)} />
              </div>
              <div style={{ marginTop: 13, paddingTop: 12, borderTop: "1px solid rgba(168,137,46,.18)", display: "flex", gap: 18, rowGap: 14, flexWrap: "wrap" }}>
                <Stat label="Show rate" value={pct(s.show_rate)} />
                <Stat label="Pitch rate" value={step(s.offer_pitched, s.showed)} />
                <Stat label="Close rate" value={pct(s.close_rate)} />
                <Stat label="Booked → close" value={pct(s.booked_to_close)} />
              </div>
              {noCalls && (
                <div style={{ color: MUTED, fontSize: 12.5, marginTop: 10 }}>
                  No calls have shown up in this period yet — every figure above is a real zero.
                </div>
              )}
              <div style={{ marginTop: 13, paddingTop: 12, borderTop: "1px solid rgba(168,137,46,.18)" }}>
                <Stat label="Avg call length (closes)" value={s.avg_call_minutes_on_close == null ? dash : `${dec(s.avg_call_minutes_on_close)} min`} />
              </div>
            </div>
          </div>
        </Card>

        {/* BREAKDOWNS — lead acquisition (counts of people, from tracked leads) */}
        <div style={grid(4)}>
          <Card titleText="By source" delay={220}
            subtitle="Leads we tracked, by where they came from. Counts of people — not money.">
            <Table head={["Source", "Leads", "Booked", "Won"]} align={["l", "r", "r", "r"]}
              rows={[...d.by_source].sort((a, b) => b.leads - a.leads).map((x) => [x.source ?? "Unknown", num(x.leads), num(x.booked), num(x.won)])} />
          </Card>
          <Card titleText="By placement" delay={260}>
            <Table head={["Placement", "Leads"]} align={["l", "r"]}
              rows={[...d.by_placement].sort((a, b) => b.leads - a.leads).map((x) => [x.placement ?? "Unknown", num(x.leads)])} />
          </Card>
          <Card titleText="By campaign" delay={300}>
            <Table head={["Campaign", "Leads"]} align={["l", "r"]}
              rows={[...d.by_campaign].sort((a, b) => b.leads - a.leads).map((x) => [x.campaign ?? "Unknown", num(x.leads)])} />
          </Card>
          <Card titleText="By booking method" delay={340}>
            <Table head={["Method", "Booked"]} align={["l", "r"]}
              rows={[...d.by_booking_method].sort((a, b) => b.booked - a.booked).map((x) => [methodLabel(x.method), num(x.booked)])} />
          </Card>
        </div>

        {/* REVENUE BREAKDOWNS — money (clients closed + $, from the customer records).
            2-up so the wide $ figures never overflow the card. */}
        <div style={grid(2)}>
          <Card titleText="Revenue by source" delay={360}
            subtitle="Paying clients and their money, by source. Signed = total deal value · Cash = collected so far.">
            <Table head={["Source", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_source ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.source ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by campaign" delay={380}
            subtitle="Paying clients and their money, by campaign.">
            <Table head={["Campaign", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_campaign ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.campaign ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by placement" delay={400}
            subtitle="Paying clients and their money, by placement.">
            <Table head={["Placement", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_placement ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.placement ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by booking method" delay={420}
            subtitle="Paying clients and their money, by how the call was booked.">
            <Table head={["Method", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_booking_method ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [methodLabel(x.method), num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
        </div>

        {/* SPEED */}
        <Card titleText="Speed" delay={380}
          subtitle="How fast leads move through the machine. Medians (the typical lead), not averages.">
          <div style={{ display: "flex", gap: 26, rowGap: 16, flexWrap: "wrap" }}>
            <Stat label="Time to first reply" value={speedFmt(d.speed.median_first_reply_seconds)} />
            <Stat label="Lead → booked" value={daysFmt(d.speed.median_days_lead_to_booked)} />
            <Stat label="Booked → call" value={daysFmt(d.speed.median_booked_to_call_days)} />
            <Stat label="Sales cycle (1st contact → close)" value={daysFmt(d.speed.median_sales_cycle_days)} />
            <Stat label="Leads gone quiet" value={num(d.speed.leads_gone_quiet)} />
          </div>
        </Card>

        {/* REASONS */}
        <div style={grid(2)}>
          <Card titleText="Why calls aren't closing" delay={420}><Reasons rows={d.reasons_no_close} /></Card>
          <Card titleText="Why leads weren't pitched" delay={460}><Reasons rows={d.reasons_no_pitch} /></Card>
        </div>

        <div style={{ textAlign: "center", color: "#454d63", fontSize: 11, padding: "6px 0 28px", fontFamily: "var(--mono)", letterSpacing: 0.5 }}>
          ALL FIGURES FROM get_dashboard · READ-ONLY
        </div>
      </div>

      <style>{HUD_CSS}</style>
    </main>
  );
}

function Table({ head, rows, align, empty = "No data this period." }: {
  head: string[]; rows: (string | number)[][]; align: ("l" | "r")[]; empty?: string;
}) {
  return (
    <table className="hud-table">
      <thead>
        <tr>{head.map((h, i) => <th key={h} style={{ textAlign: align[i] === "r" ? "right" : "left" }}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={head.length}><span style={{ color: MUTED }}>{empty}</span></td></tr>
        ) : (
          rows.map((row, ri) => (
            <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ textAlign: align[ci] === "r" ? "right" : "left", fontFamily: ci === 0 ? undefined : "var(--mono)" }}>{c}</td>)}</tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function Reasons({ rows }: { rows: { reason: string; name: string | null; date: string | null }[] }) {
  if (!rows || rows.length === 0) return <div style={{ color: MUTED }}>{dash}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ borderLeft: `2px solid ${GOLD}`, paddingLeft: 10 }}>
          <div style={{ fontSize: 14, color: "#d9dfeb" }}>{row.reason}</div>
          <div style={{ fontSize: 12, color: MUTED }}>{(row.name || "Unknown") + (row.date ? ` · ${dateOnly(row.date)}` : "")}</div>
        </div>
      ))}
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  color: "#e8ecf5",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  padding: "26px 22px",
  position: "relative",
  overflow: "hidden",
};
function grid(cols: number): React.CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: 16 };
}

// ── HUD theme (gradients, glow, glass, grid/scanline texture, animations) ──
const HUD_CSS = `
:root{ --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace; }
.hud-main{
  background:
    radial-gradient(1200px 620px at 12% -12%, rgba(168,137,46,.12), transparent 60%),
    radial-gradient(1000px 540px at 105% -5%, rgba(201,168,76,.07), transparent 55%),
    radial-gradient(900px 700px at 50% 120%, rgba(168,137,46,.05), transparent 60%),
    #0a0e1a;
}
.hud-main::before{
  content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
  background-image:
    linear-gradient(rgba(168,137,46,.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(168,137,46,.06) 1px, transparent 1px);
  background-size: 46px 46px;
  -webkit-mask-image: radial-gradient(circle at 50% -10%, #000, transparent 78%);
  mask-image: radial-gradient(circle at 50% -10%, #000, transparent 78%);
}
.hud-main::after{
  content:""; position:fixed; inset:0; z-index:0; pointer-events:none; opacity:.45;
  background: repeating-linear-gradient(0deg, rgba(255,255,255,.018) 0 1px, transparent 1px 3px);
}
.hud-brand{
  font-family: var(--mono); font-size: 24px; font-weight: 800; letter-spacing: 3px; color:#fff;
  text-shadow: 0 0 18px rgba(201,168,76,.45), 0 0 2px rgba(201,168,76,.6);
}
.hud-card{
  position: relative;
  background: linear-gradient(155deg, rgba(22,29,52,.62), rgba(11,16,30,.62));
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border: 1px solid rgba(168,137,46,.26); border-radius: 14px; padding: 18px;
  box-shadow: inset 0 1px 0 rgba(201,168,76,.08), 0 8px 30px rgba(0,0,0,.35);
  opacity: 0; transform: translateY(14px);
  animation: hudIn .5s cubic-bezier(.22,.61,.36,1) forwards;
  transition: border-color .25s ease, box-shadow .25s ease, transform .25s ease;
}
.hud-card:hover{
  border-color: rgba(201,168,76,.55);
  box-shadow: inset 0 1px 0 rgba(201,168,76,.12), 0 0 0 1px rgba(168,137,46,.25), 0 0 28px rgba(168,137,46,.18), 0 10px 34px rgba(0,0,0,.4);
  transform: translateY(-2px);
}
@keyframes hudIn{ to{ opacity:1; transform:none; } }
.hud-title{ font-size:11px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; color:${GOLD2}; margin-bottom:14px; }
.cap{ font-size:11px; letter-spacing:.8px; text-transform:uppercase; color:${MUTED}; margin-top:4px; }
.metric{ font-family: var(--mono); font-size:18px; font-weight:700; color:#fff; line-height:1.08; text-shadow: 0 0 12px rgba(201,168,76,.28); }
.metric-lg{ font-size:30px; font-weight:800; text-shadow: 0 0 16px rgba(201,168,76,.40); }
.funnel-track{ height:8px; background:#0c1324; border:1px solid rgba(168,137,46,.12); border-radius:6px; overflow:hidden; }
.funnel-fill{ height:100%; border-radius:6px; background:linear-gradient(90deg, ${GOLD}, ${GOLD2}); box-shadow: 0 0 12px rgba(201,168,76,.55); }
.funnel-sub{ display:flex; justify-content:space-between; align-items:center; font-size:12.5px;
  margin: -2px 0 0 18px; padding: 4px 10px; border-left: 2px solid rgba(168,137,46,.30);
  background: rgba(168,137,46,.04); border-radius: 0 8px 8px 0; }
.kpi-badge{ display:inline-flex; align-items:center; gap:10px; padding:6px 12px; border-radius:9px;
  background: linear-gradient(135deg, rgba(168,137,46,.18), rgba(201,168,76,.06));
  border:1px solid rgba(201,168,76,.5); box-shadow: 0 0 18px rgba(168,137,46,.22); }
.hud-table{ width:100%; border-collapse:collapse; font-size:13px; }
.hud-table th{ padding:6px 8px; font-weight:600; color:${MUTED}; border-bottom:1px solid rgba(168,137,46,.22); text-transform:uppercase; letter-spacing:.5px; font-size:11px; }
.hud-table td{ padding:7px 8px; border-bottom:1px solid rgba(255,255,255,.04); color:#cdd4e3; }
.hud-table tr:hover td{ background: rgba(168,137,46,.05); }
.hud-preset{ font-family: var(--mono); padding:8px 14px; font-size:13px; font-weight:600; border-radius:8px; cursor:pointer; white-space:nowrap;
  border:1px solid rgba(168,137,46,.25); background: rgba(16,22,42,.6); color:#aeb6c8; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); transition: all .18s ease; }
.hud-preset:hover{ border-color: rgba(201,168,76,.55); color:#e8ecf5; box-shadow:0 0 14px rgba(168,137,46,.2); }
.hud-preset.active{ border-color:${GOLD}; background: rgba(168,137,46,.18); color:${GOLD2}; box-shadow:0 0 16px rgba(168,137,46,.25); }
.hud-preset:disabled{ opacity:.45; cursor:not-allowed; box-shadow:none; }
.hud-date, .hud-select{ font-family: var(--mono); padding:7px 11px; font-size:13px; border-radius:8px; color:#e8ecf5; color-scheme:dark;
  border:1px solid rgba(168,137,46,.25); background: rgba(16,22,42,.7); }
.hud-date:focus, .hud-select:focus{ outline:none; border-color: rgba(201,168,76,.6); box-shadow:0 0 14px rgba(168,137,46,.22); }
@media (max-width: 920px){ .dash-2col{ grid-template-columns:1fr !important; } }
@media (prefers-reduced-motion: reduce){ .hud-card{ animation:none; opacity:1; transform:none; } }
`;
