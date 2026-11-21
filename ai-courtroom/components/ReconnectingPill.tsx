/**
 * Small floating "Reconnecting…" pill shown while polls are failing but we still have a last good state to show.
 * Fixed position, so it never shifts the layout. Disappears as soon as a poll succeeds (error cleared).
 */
export function ReconnectingPill({ show, big = false }: { show: boolean; big?: boolean }) {
  if (!show) return null;
  return (
    <div role="status" aria-live="polite"
      className={`animate-pop pointer-events-none fixed left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white font-black text-court shadow-[0_4px_0_rgba(0,0,0,0.3)] ${big ? "top-3 px-5 py-2 text-xl" : "top-2 px-4 py-1.5 text-sm"}`}>
      <span className={`inline-block animate-spin rounded-full border-[3px] border-court/25 border-t-court ${big ? "h-5 w-5" : "h-4 w-4"}`} aria-hidden />
      Reconnecting…
    </div>
  );
}
