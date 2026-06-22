"use client";

import { useEffect, useRef, useState } from "react";

// ── Money Flow ───────────────────────────────────────────────────────────────
// A PURELY VISUAL strip that animates the pipeline turning into cash. It reads
// numbers the dashboard already computed (passed in as props) — it runs NO
// queries, writes nothing, and changes no logging or tracking. If a value is
// missing it just shows a dash. Safe to remove with zero side-effects.

const GOLD = "#a8892e";
const GOLD2 = "#c9a84c";
const MUTED = "#7d869c";

export type FlowNode = {
  label: string;
  value: number | null;
  kind?: "count" | "cash";
};

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const num = (n: number) => Math.round(n).toLocaleString("en-US");

function fmt(node: FlowNode): string {
  if (node.value == null) return "—";
  return node.kind === "cash" ? money(node.value) : num(node.value);
}

// Conversion between two adjacent stages (for the connector caption).
function rate(a: number | null, b: number | null): string | null {
  if (a == null || b == null || !b) return null;
  return `${Math.round((a / b) * 100)}%`;
}

export default function MoneyFlow({ nodes }: { nodes: FlowNode[] }) {
  // Honour reduced-motion: freeze the particles, keep the layout.
  const [animate, setAnimate] = useState(true);
  // Count the cash node up once when it scrolls into view (eye candy only).
  const cashRef = useRef<HTMLDivElement | null>(null);
  const [cashShown, setCashShown] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      setAnimate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
  }, []);

  const cashTarget = nodes.find((n) => n.kind === "cash")?.value ?? null;
  useEffect(() => {
    if (cashTarget == null) return;
    if (!animate) { setCashShown(cashTarget); return; }
    const el = cashRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setCashShown(cashTarget); return; }
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (done || !entries.some((e) => e.isIntersecting)) return;
      done = true;
      io.disconnect();
      const start = performance.now();
      const dur = 1100;
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        setCashShown(cashTarget * eased);
        if (p < 1) requestAnimationFrame(tick);
        else setCashShown(cashTarget);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [cashTarget, animate]);

  return (
    <div className="mf-wrap">
      {nodes.map((node, i) => {
        const isCash = node.kind === "cash";
        const conv = i > 0 ? rate(node.value, nodes[i - 1].value) : null;
        const displayCash = isCash && cashShown != null ? money(cashShown) : null;
        return (
          <div className="mf-seg" key={node.label}>
            {i > 0 && (
              <div className="mf-pipe" aria-hidden>
                <span className="mf-rail" />
                {animate ? (
                  <span className="mf-stream">
                    <span className="mf-orb" style={{ animationDelay: "0s" }} />
                    <span className="mf-orb" style={{ animationDelay: "-0.8s" }} />
                    <span className="mf-orb" style={{ animationDelay: "-1.6s" }} />
                  </span>
                ) : (
                  <span className="mf-orb mf-orb-static" />
                )}
                {conv && <span className="mf-conv">{conv}</span>}
              </div>
            )}
            <div
              className={`mf-node${isCash ? " mf-node-cash" : ""}`}
              ref={isCash ? cashRef : undefined}
            >
              <span className="mf-val">{displayCash ?? fmt(node)}</span>
              <span className="mf-label">{node.label}</span>
            </div>
          </div>
        );
      })}
      <style>{MF_CSS}</style>
    </div>
  );
}

const MF_CSS = `
.mf-wrap{ display:flex; align-items:stretch; flex-wrap:nowrap; gap:0;
  overflow-x:auto; padding:4px 2px 6px; -webkit-overflow-scrolling:touch; }
.mf-seg{ display:flex; align-items:center; flex:1 1 0; min-width:0; }
.mf-node{ flex:0 0 auto; min-width:104px; padding:12px 16px; border-radius:12px; text-align:center;
  background: linear-gradient(155deg, rgba(22,29,52,.7), rgba(11,16,30,.7));
  border:1px solid rgba(168,137,46,.30);
  box-shadow: inset 0 1px 0 rgba(201,168,76,.08), 0 6px 18px rgba(0,0,0,.3);
  display:flex; flex-direction:column; gap:3px; }
.mf-val{ font-family: var(--mono); font-size:19px; font-weight:800; color:#fff; line-height:1.05;
  text-shadow: 0 0 12px rgba(201,168,76,.30); white-space:nowrap; }
.mf-label{ font-size:10px; letter-spacing:.7px; text-transform:uppercase; color:${MUTED}; white-space:nowrap; }
.mf-node-cash{ min-width:128px;
  background: linear-gradient(135deg, rgba(168,137,46,.30), rgba(201,168,76,.10));
  border-color: rgba(201,168,76,.65);
  box-shadow: inset 0 1px 0 rgba(201,168,76,.18), 0 0 26px rgba(168,137,46,.35);
  animation: mfCashPulse 2.6s ease-in-out infinite; }
.mf-node-cash .mf-val{ color:${GOLD2}; font-size:22px; text-shadow: 0 0 20px rgba(201,168,76,.6); }
.mf-node-cash .mf-label{ color:${GOLD2}; }
/* The pipe is the gap between two boxes. Money is born at the left box, travels
   as a glowing orb, and is absorbed into the right box. The ::before/::after are
   the glowing "ports" where the pipe meets each box (output left, intake right). */
.mf-pipe{ position:relative; flex:1 1 auto; min-width:40px; height:18px; margin:0 6px; overflow:visible; }
.mf-pipe::before, .mf-pipe::after{ content:""; position:absolute; top:50%; width:13px; height:13px;
  transform:translateY(-50%); border-radius:50%; pointer-events:none; }
.mf-pipe::before{ left:-5px; background:radial-gradient(circle, rgba(201,168,76,.55), transparent 68%);
  animation: mfPort 2.4s ease-in-out infinite; }
.mf-pipe::after{ right:-5px; background:radial-gradient(circle, rgba(201,168,76,.7), transparent 68%);
  animation: mfPort 2.4s ease-in-out infinite; animation-delay:-1.1s; }
/* faint base rail so the path reads even between orbs */
.mf-rail{ position:absolute; top:50%; left:0; right:0; height:2px; transform:translateY(-50%); border-radius:2px;
  background:linear-gradient(90deg, rgba(168,137,46,.04), rgba(168,137,46,.2) 22%, rgba(168,137,46,.2) 78%, rgba(168,137,46,.04)); }
.mf-stream{ position:absolute; inset:0; }
/* the travelling money orb (core + ::after tail) */
.mf-orb{ position:absolute; top:50%; left:0; width:9px; height:9px; border-radius:50%;
  transform:translate(-50%,-50%) scale(.2); opacity:0;
  background:radial-gradient(circle, #fff 0%, #f3dc8c 32%, ${GOLD2} 66%, transparent 72%);
  box-shadow:0 0 10px 2px rgba(201,168,76,.85);
  animation: mfTravel 2.4s cubic-bezier(.5,0,.5,1) infinite; }
.mf-orb::after{ content:""; position:absolute; top:50%; right:55%; transform:translateY(-50%);
  width:20px; height:3px; border-radius:3px;
  background:linear-gradient(90deg, transparent, rgba(201,168,76,.6)); }
.mf-orb-static{ left:50%; opacity:.9; transform:translate(-50%,-50%) scale(1); animation:none; }
.mf-conv{ position:absolute; top:-15px; left:50%; transform:translateX(-50%);
  font-family: var(--mono); font-size:10.5px; font-weight:700; color:${GOLD2}; white-space:nowrap;
  text-shadow: 0 0 8px rgba(0,0,0,.6); z-index:2; }
/* born small/dim at the source box -> blooms out -> swells + fades as it's drunk into the next box */
@keyframes mfTravel{
  0%   { left:2%;   opacity:0; transform:translate(-50%,-50%) scale(.15); }
  12%  { opacity:1;            transform:translate(-50%,-50%) scale(1); }
  50%  { left:50%;  opacity:1; transform:translate(-50%,-50%) scale(1); }
  84%  { left:88%;  opacity:1; transform:translate(-50%,-50%) scale(1.35); }
  100% { left:99%;  opacity:0; transform:translate(-50%,-50%) scale(.15); }
}
@keyframes mfPort{ 0%,100%{ opacity:.2; transform:translateY(-50%) scale(.85); }
  50%{ opacity:.9; transform:translateY(-50%) scale(1.15); } }
@keyframes mfCashPulse{ 0%,100%{ box-shadow: inset 0 1px 0 rgba(201,168,76,.18), 0 0 22px rgba(168,137,46,.30); }
  50%{ box-shadow: inset 0 1px 0 rgba(201,168,76,.22), 0 0 34px rgba(168,137,46,.5); } }
@media (prefers-reduced-motion: reduce){
  .mf-node-cash{ animation:none; } .mf-orb{ animation:none; }
  .mf-pipe::before, .mf-pipe::after{ animation:none; } }
`;
