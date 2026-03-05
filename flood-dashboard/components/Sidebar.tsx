"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Map,
  Radio,
  CloudRain,
  Mountain,
  BarChart3,
  BrainCircuit,
} from "lucide-react";
import { getSupabase } from "@/lib/supabase";

const navItems = [
  { href: "/", label: "Overview", icon: Map },
  { href: "/sensors", label: "Sensors", icon: Radio },
  { href: "/flood-events", label: "Flood Events", icon: CloudRain },
  { href: "/elevation", label: "Elevation", icon: Mountain },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/ai-recommendations", label: "AI Recommendations", icon: BrainCircuit },
];

export function Sidebar() {
  const pathname = usePathname();
  const [sensorCount, setSensorCount] = useState<number | null>(null);
  const [activeAlerts, setActiveAlerts] = useState(0);

  useEffect(() => {
    async function fetchCount() {
      try {
        const [{ count }, alertRes] = await Promise.all([
          getSupabase()
            .from("devices")
            .select("device_id", { count: "exact", head: true }),
          getSupabase()
            .from("flood_events")
            .select("id", { count: "exact", head: true })
            .is("ended_at", null),
        ]);
        setSensorCount(count ?? 0);
        setActiveAlerts(alertRes.count ?? 0);
      } catch {
        setSensorCount(null);
      }
    }
    fetchCount();
    const interval = setInterval(fetchCount, 30000);

    // Realtime for flood events
    const channel = getSupabase()
      .channel("sidebar-alerts")
      .on("postgres_changes", { event: "*", schema: "public", table: "flood_events" }, () => fetchCount())
      .subscribe();

    return () => {
      clearInterval(interval);
      getSupabase().removeChannel(channel);
    };
  }, []);

  return (
    <aside className="fixed left-0 top-0 h-screen w-[220px] bg-bg-card border-r border-border-card flex flex-col z-50">
      <div className="p-4 border-b border-border-card">
        <h1 className="text-sm font-bold text-status-green tracking-wide">
          FLOOD FINDER
        </h1>
        <p className="text-xs text-text-secondary mt-0.5">City Dashboard</p>
      </div>

      <nav className="flex-1 py-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                active
                  ? "bg-status-blue/10 text-status-blue border-r-2 border-status-blue"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-card-hover"
              }`}
            >
              <Icon size={18} />
              {label}
              {label === "Flood Events" && activeAlerts > 0 && (
                <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold bg-status-red text-white rounded-full leading-none">
                  {activeAlerts}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border-card">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${sensorCount !== null ? "bg-status-green" : "bg-gray-500"}`} />
          <p className="text-xs text-text-secondary">
            <span className="text-status-green font-medium">
              {sensorCount !== null ? sensorCount : "..."}
            </span>{" "}
            sensors connected
          </p>
        </div>
        {activeAlerts > 0 && (
          <p className="text-xs text-status-red mt-1 font-medium">
            {activeAlerts} active flood{activeAlerts > 1 ? "s" : ""}
          </p>
        )}
        <p className="text-xs text-text-secondary mt-1">Aventura, FL</p>
      </div>
    </aside>
  );
}
