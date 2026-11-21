// Decorative theme-park balloons behind the whole app. Fixed, deterministic positions (no randomness, so the
// server render and client render match). Server component: no JS shipped. Styles in globals.css (.balloon).
const BALLOONS = [
  { left: "4%", top: "62%", c: "var(--color-agent-a)", d: "6s", s: 1 },
  { left: "13%", top: "18%", c: "var(--color-gold)", d: "7.5s", s: 0.8 },
  { left: "27%", top: "78%", c: "var(--color-balloon-mint)", d: "6.8s", s: 0.7 },
  { left: "71%", top: "70%", c: "var(--color-balloon-orange)", d: "7.2s", s: 0.9 },
  { left: "84%", top: "14%", c: "var(--color-agent-b)", d: "6.4s", s: 1.1 },
  { left: "93%", top: "52%", c: "var(--color-balloon-pink)", d: "8s", s: 0.75 },
];

export function Balloons() {
  return (
    <div className="balloons" aria-hidden>
      {BALLOONS.map((b, i) => (
        <span key={i} className="balloon"
          style={{ left: b.left, top: b.top, scale: String(b.s), ["--c" as string]: b.c, ["--d" as string]: b.d } as React.CSSProperties} />
      ))}
    </div>
  );
}
