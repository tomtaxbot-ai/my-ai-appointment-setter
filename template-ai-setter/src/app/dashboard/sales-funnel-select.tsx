"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * The Sales block's funnel selector (All / Outbound / Inbound). Sets the
 * `funnel` URL param while preserving period/source/custom dates — only the
 * Sales numbers change server-side; both funnel blocks always render.
 */
export default function SalesFunnelSelect({ funnel }: { funnel: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function onChange(next: string) {
    const p = new URLSearchParams(params.toString());
    if (next === "all") p.delete("funnel");
    else p.set("funnel", next);
    startTransition(() => router.push(`/dashboard?${p.toString()}`));
  }

  return (
    <select
      className="hud-select"
      value={funnel}
      onChange={(e) => onChange(e.target.value)}
      style={{ opacity: pending ? 0.55 : 1 }}
      aria-label="Sales funnel filter"
    >
      <option value="all">All funnels</option>
      <option value="outbound">Outbound</option>
      <option value="inbound">Inbound</option>
    </select>
  );
}
