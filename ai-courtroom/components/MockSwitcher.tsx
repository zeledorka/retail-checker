"use client";
// MOCK MODE ONLY: jump between phases / fixtures. Rendered only when USE_MOCK is true.
import { useEffect, useState } from "react";
import {
  MOCK_PRESETS, mockApplyPreset, mockIsFrozen, mockIsNetFail, mockIsRaw, mockReset, mockSetFrozen, mockSetNetFail, mockSetRaw,
  type MockPreset,
} from "@/lib/mock/server";

export function MockSwitcher({ onChange, compact = false }: { onChange: () => void; compact?: boolean }) {
  const [frozen, setFrozen] = useState(false);
  const [netFail, setNetFail] = useState(false);
  const [raw, setRaw] = useState(false);
  useEffect(() => { setFrozen(mockIsFrozen()); setNetFail(mockIsNetFail()); setRaw(mockIsRaw()); }, []);
  const go = (p: MockPreset) => { mockApplyPreset(p, frozen); onChange(); };
  return (
    <div className="grid gap-2 text-ink">
      <p className="text-[11px] font-black uppercase tracking-widest text-court">🧪 Mock phase switcher</p>
      <div className={`grid gap-1 ${compact ? "grid-cols-3" : "grid-cols-2"}`}>
        {MOCK_PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => go(p.id)} className="rounded-lg bg-court/10 px-2 py-1 text-xs font-extrabold hover:bg-court hover:text-white">
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs font-bold">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={frozen} onChange={(e) => { setFrozen(e.target.checked); mockSetFrozen(e.target.checked); onChange(); }} /> Freeze clock
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={netFail} onChange={(e) => { setNetFail(e.target.checked); mockSetNetFail(e.target.checked); onChange(); }} /> Network error
        </label>
        <label className="flex items-center gap-1" title="Serve the mock game in the exact GET /api/state shape (types/game.ts) and run it through the real adaptState">
          <input type="checkbox" checked={raw} onChange={(e) => { setRaw(e.target.checked); mockSetRaw(e.target.checked); onChange(); }} /> Use raw-shape fixtures
        </label>
        <button type="button" className="underline" onClick={() => { if (confirm("Wipe all mock data (players, tokens)?")) { mockReset(); location.reload(); } }}>
          Reset mock
        </button>
      </div>
    </div>
  );
}
