"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Map,
  Radio,
  CloudRain,
  BarChart3,
  BrainCircuit,
  Search,
  X,
  MapPin,
  Zap,
  LogOut,
  Globe,
} from "lucide-react";
import { useAuth } from "@/components/AuthGate";
import { getSupabase } from "@/lib/supabase";

const navItems = [
  { href: "/", label: "Overview", icon: Map, description: "Live sensor map & weather" },
  { href: "/sensors", label: "Sensors", icon: Radio, description: "Manage all devices" },
  { href: "/flood-events", label: "Flood Events", icon: CloudRain, description: "Event history & filters" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, description: "Neighborhood & elevation insights" },
  { href: "/ai-recommendations", label: "AI Analysis", icon: BrainCircuit, description: "Infrastructure recommendations" },
];

interface QuickResult {
  type: "neighborhood" | "device" | "page";
  label: string;
  sublabel?: string;
  href: string;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [sensorCount, setSensorCount] = useState<number | null>(null);
  const [activeAlerts, setActiveAlerts] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<QuickResult[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [deviceNames, setDeviceNames] = useState<{ id: string; name: string; neighborhood: string }[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

    async function fetchSearchData() {
      try {
        const { data } = await getSupabase()
          .from("devices")
          .select("device_id, name, neighborhood");
        if (data) {
          const hoods = [...new Set(data.map((d) => d.neighborhood).filter(Boolean))] as string[];
          setNeighborhoods(hoods.sort());
          setDeviceNames(data.map((d) => ({
            id: d.device_id,
            name: d.name ?? d.device_id,
            neighborhood: d.neighborhood ?? "",
          })));
        }
      } catch {
        // search data is optional
      }
    }

    fetchCount();
    fetchSearchData();
    const interval = setInterval(fetchCount, 30000);

    const channel = getSupabase()
      .channel("sidebar-alerts")
      .on("postgres_changes", { event: "*", schema: "public", table: "flood_events" }, () => fetchCount())
      .subscribe();

    return () => {
      clearInterval(interval);
      getSupabase().removeChannel(channel);
    };
  }, []);

  // Keyboard shortcut to open search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Update search results
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const q = searchQuery.toLowerCase();
    const results: QuickResult[] = [];

    // Search pages
    navItems.forEach((item) => {
      if (item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)) {
        results.push({
          type: "page",
          label: item.label,
          sublabel: item.description,
          href: item.href,
        });
      }
    });

    // Search neighborhoods
    neighborhoods.forEach((n) => {
      if (n.toLowerCase().includes(q)) {
        results.push({
          type: "neighborhood",
          label: n,
          sublabel: "Neighborhood",
          href: `/analytics?area=${encodeURIComponent(n)}`,
        });
      }
    });

    // Search devices
    deviceNames.forEach((d) => {
      if (d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) || d.neighborhood.toLowerCase().includes(q)) {
        results.push({
          type: "device",
          label: d.name || d.id,
          sublabel: `${d.id} ${d.neighborhood ? `- ${d.neighborhood}` : ""}`,
          href: `/sensors?search=${encodeURIComponent(d.id)}`,
        });
      }
    });

    // Always add "Search on map" option for address lookups
    if (q.length >= 3) {
      results.push({
        type: "neighborhood",
        label: `Search "${searchQuery.trim()}" on map`,
        sublabel: "Find nearby sensors for any location",
        href: `/?location=${encodeURIComponent(searchQuery.trim())}`,
      });
    }

    setSearchResults(results.slice(0, 8));
  }, [searchQuery, neighborhoods, deviceNames]);

  const handleResultClick = (result: QuickResult) => {
    setSearchOpen(false);
    setSearchQuery("");
    router.push(result.href);
  };

  return (
    <>
      <aside className="fixed left-0 top-0 h-screen w-[220px] bg-bg-card border-r border-border-card flex flex-col z-50">
        <div className="p-4 border-b border-border-card">
          <h1 className="text-sm font-bold text-status-green tracking-wide">
            FLOOD FINDER
          </h1>
          <p className="text-xs text-text-secondary mt-0.5">City Dashboard</p>
        </div>

        {/* Quick search trigger */}
        <button
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }}
          className="mx-3 mt-3 mb-1 flex items-center gap-2 px-3 py-2 bg-bg-primary border border-border-card rounded-lg text-xs text-text-secondary hover:text-text-primary hover:border-text-secondary/30 transition-colors"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Search...</span>
          <kbd className="text-[10px] bg-bg-card px-1.5 py-0.5 rounded border border-border-card">
            Ctrl+K
          </kbd>
        </button>

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
          <p className="text-xs text-text-secondary mt-1">Golden Beach, FL</p>
          {user && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-border-card">
              <p className="text-[11px] text-text-secondary truncate max-w-[130px]">
                {user.email}
              </p>
              <button
                onClick={signOut}
                className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-status-red transition-colors"
              >
                <LogOut size={11} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Search overlay */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[15vh]"
          onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
        >
          <div
            className="w-[520px] bg-bg-card border border-border-card rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border-card">
              <Search size={16} className="text-text-secondary shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search neighborhoods, sensors, pages..."
                className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
                autoFocus
              />
              <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }}>
                <X size={14} className="text-text-secondary hover:text-text-primary" />
              </button>
            </div>

            {/* Results */}
            {searchResults.length > 0 && (
              <div className="max-h-[400px] overflow-y-auto py-2">
                {searchResults.map((result, i) => (
                  <button
                    key={i}
                    onClick={() => handleResultClick(result)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-bg-card-hover transition-colors text-left"
                  >
                    {result.type === "neighborhood" && !result.href.startsWith("/?location=") && <MapPin size={14} className="text-status-blue shrink-0" />}
                    {result.href.startsWith("/?location=") && <Globe size={14} className="text-status-blue shrink-0" />}
                    {result.type === "device" && <Radio size={14} className="text-status-green shrink-0" />}
                    {result.type === "page" && <Zap size={14} className="text-status-amber shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{result.label}</p>
                      {result.sublabel && (
                        <p className="text-xs text-text-secondary truncate">{result.sublabel}</p>
                      )}
                    </div>
                    <span className="text-[10px] text-text-secondary uppercase shrink-0">
                      {result.type}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {searchQuery && searchResults.length === 0 && (
              <div className="py-8 text-center text-sm text-text-secondary">
                No results for &quot;{searchQuery}&quot;
              </div>
            )}

            {!searchQuery && (
              <div className="py-6 px-4 text-center text-xs text-text-secondary">
                <p>Type to search neighborhoods, sensors, or pages</p>
                <p className="mt-1 text-text-secondary/50">Press Esc to close</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
