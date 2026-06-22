"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const PERIODS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
  { value: "all", label: "All Time" },
  { value: "custom", label: "Custom" },
];

function localTodayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function Filters({
  period,
  source,
  sources,
  start,
  end,
}: {
  period: string;
  source: string; // "" = All sources
  sources: string[];
  start: string; // resolved YYYY-MM-DD
  end: string; // resolved YYYY-MM-DD
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [cStart, setCStart] = useState(start);
  const [cEnd, setCEnd] = useState(end);
  // Start with the server's resolved end (UTC today) to avoid a hydration
  // mismatch, then refine to the user's LOCAL today after mount.
  const [today, setToday] = useState(end);
  useEffect(() => setToday(localTodayISO()), []);

  // Preserve the Sales block's funnel selection across period/source changes.
  const funnel = searchParams.get("funnel") || "";
  // Preserve demo mode (?demo=1, driven by Jarvis HQ) so switching the timeline
  // or source never knocks the dashboard back onto real numbers mid-showcase.
  const demo = searchParams.get("demo") || "";

  function push(params: URLSearchParams) {
    if (funnel) params.set("funnel", funnel);
    if (demo) params.set("demo", demo);
    startTransition(() => router.push(`/dashboard?${params.toString()}`));
  }

  function go(nextPeriod: string, nextSource: string) {
    const params = new URLSearchParams();
    params.set("period", nextPeriod);
    if (nextSource) params.set("source", nextSource);
    if (nextPeriod === "custom") {
      params.set("start", cStart);
      params.set("end", cEnd);
    }
    push(params);
  }

  // Only fires on Apply / blur — never per keystroke. Clamps to today + order.
  function applyCustom() {
    if (!cStart || !cEnd) return;
    let s = cStart > today ? today : cStart;
    let e = cEnd > today ? today : cEnd;
    if (s > e) [s, e] = [e, s];
    const params = new URLSearchParams();
    params.set("period", "custom");
    params.set("start", s);
    params.set("end", e);
    if (source) params.set("source", source);
    push(params);
  }

  const customChanged = cStart !== start || cEnd !== end;

  return (
    <div
      className="hud-filters"
      style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", opacity: pending ? 0.55 : 1 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => go(p.value, source)}
            className={`hud-preset${p.value === period ? " active" : ""}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {period === "custom" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="date"
            className="hud-date"
            value={cStart}
            max={today}
            onChange={(e) => setCStart(e.target.value)}
            onBlur={applyCustom}
          />
          <span style={{ color: "#7d869c", fontSize: 13 }}>→</span>
          <input
            type="date"
            className="hud-date"
            value={cEnd}
            min={cStart}
            max={today}
            onChange={(e) => setCEnd(e.target.value)}
            onBlur={applyCustom}
          />
          <button
            onClick={applyCustom}
            className={`hud-preset${customChanged ? " active" : ""}`}
            disabled={!cStart || !cEnd}
          >
            Apply
          </button>
        </div>
      )}

      <select
        className="hud-select"
        value={source}
        onChange={(e) => go(period, e.target.value)}
        style={{ marginLeft: "auto", maxWidth: 280 }}
      >
        <option value="">All sources</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
