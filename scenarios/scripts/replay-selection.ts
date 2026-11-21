// OFFLINE replay (no network, no cost) of saved live benchmark dumps through the CURRENT selector.
//   npx tsx scripts/replay-selection.ts [validation/live-opinions-*.json ...]   (default: every dump in validation/)
// It re-runs ONLY the deterministic selector on the checker verdicts that were recorded. It cannot show how the updated checker
// prompt would score or flag the same opinions: a replay is not a prediction of live behaviour.
import { readdirSync, readFileSync } from "node:fs";
import { selectFinalPair } from "../src/index";
import type { CheckerReport, GeneratedOpinion } from "../src/index";

const dir = new URL("../validation/", import.meta.url);
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((f) => /^live-opinions-.*\.json$/.test(f)).map((f) => new URL(f, dir).pathname);
type Meta = { seed: number; generated?: Record<"A" | "B", GeneratedOpinion[]>; checkerOrder?: { opinionId: string; anonId: string }[]; checkerReport?: CheckerReport };
for (const f of files) {
  const d = JSON.parse(readFileSync(f, "utf8")) as { dumps: { scenario: string; seed: number; result: { ok: boolean; meta?: Meta; partial?: Meta } }[] };
  console.log(`\n${f.split("/").pop()}`);
  for (const x of d.dumps) {
    const m = x.result.ok ? x.result.meta : x.result.partial;
    if (!m?.generated || !m.checkerOrder || !m.checkerReport) { console.log(`  ${x.scenario}: no checker report saved, cannot replay`); continue; }
    for (const min of [45, 30]) {
      const r = selectFinalPair({ opinionsA: m.generated.A, opinionsB: m.generated.B, checkerOrder: m.checkerOrder, report: m.checkerReport }, { seed: m.seed, minDefensibility: min });
      const t = r.diagnostics;
      console.log(`  ${x.scenario} seed ${m.seed} | minDefensibility ${min} (recorded run: ${x.result.ok ? "success" : "failed"}) -> ${r.ok ? `SUCCESS ${r.a.id} "${r.a.title}" vs ${r.b.id} "${r.b.title}" (difference ${r.chosen.difference}, scores ${r.chosen.defensibilityA}/${r.chosen.defensibilityB})` : "FAIL"} | usable ${t.usableA}/${t.usableB}, valid pairs ${t.pairsValid}, rejected ${JSON.stringify(t.rejected)}`);
      if (min === 30) console.log(`     pair outcomes: ${t.pairStatus.map((p) => `${p.a}/${p.b}=${p.status}`).join(" ")}`);
    }
  }
}
