"use client";
// Scannable "join the game" QR code for the projector lobby.
// The URL is worked out in the browser after mount (never during render, so prerender stays deterministic):
//   NEXT_PUBLIC_JOIN_URL if set (e.g. the Vercel URL when the projector runs somewhere else), otherwise
//   <current origin>/play, which is automatically correct once the app is hosted on Vercel.
import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";

/** The full join URL (null until mounted). Shared by the QR and the "Join at …" text so they always match. */
export function useJoinUrl() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(process.env.NEXT_PUBLIC_JOIN_URL || `${window.location.origin}/play`);
  }, []);
  return url;
}

/** Drawn as React SVG rects (no innerHTML). Error correction "M" keeps it scannable from the back of a room. */
export function JoinQr({ url, size = 300, className = "" }: { url: string | null; size?: number; className?: string }) {
  const [cells, setCells] = useState<{ n: number; dark: [number, number][] } | null>(null);
  useEffect(() => {
    if (!url) return;
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([r, c]);
    setCells({ n, dark });
  }, [url]);

  const quiet = 2; // white border in modules (the card adds more padding)
  return (
    <div className={`card animate-pop grid place-items-center p-4 ${className}`} style={{ width: size + 32 }}>
      {cells ? (
        <svg viewBox={`0 0 ${cells.n + quiet * 2} ${cells.n + quiet * 2}`} width={size} height={size} role="img" aria-label={`QR code to join: ${url}`} shapeRendering="crispEdges">
          <rect width="100%" height="100%" fill="#ffffff" />
          {cells.dark.map(([r, c]) => <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width="1" height="1" fill="#1f1418" />)}
        </svg>
      ) : (
        <div style={{ width: size, height: size }} className="animate-pulse rounded-xl bg-gray-200" />
      )}
      <p className="mt-2 text-xl font-black text-court">📱 Scan to join</p>
    </div>
  );
}
