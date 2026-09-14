"use client";

import { useEffect, useState } from "react";

/**
 * Says plainly when the dashboard is showing generated data.
 *
 * The fallback in /api/data and lib/queries exists so this runs on Vercel with
 * no database, which is genuinely useful for a demo. But generated readings
 * shown without a label are indistinguishable from measurements, and this is a
 * project that will be put in front of judges and a city. So it gets a banner.
 *
 * It reads the `demo` flag that /api/stats sets when it had to fall back, so
 * the banner tracks reality rather than a build-time constant: point the app
 * at a live database and it disappears on its own.
 */
export function DemoBanner() {
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      fetch("/api/stats")
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setDemo(d?.demo === true); })
        .catch(() => { if (!cancelled) setDemo(true); });
    check();
    const t = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!demo) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1.5 text-[11px] leading-tight
                 border-b border-amber-500/25 bg-amber-500/10 text-amber-200/90"
    >
      <span
        aria-hidden
        className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
      />
      <span>
        <strong className="font-semibold">Demo data.</strong>{" "}
        No sensors are connected. Everything below is generated from a storm and
        terrain model of Golden Beach, not measured. Depths, battery levels and
        flow paths are illustrative.
      </span>
    </div>
  );
}
