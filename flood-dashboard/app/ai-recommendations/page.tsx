"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  BrainCircuit, Loader2, TrendingDown, DollarSign, MapPin, Clock,
  Filter, RefreshCw, Search, ChevronDown, ChevronUp,
} from "lucide-react";
import { getRecommendations, getAllDevices, getFloodEventCount30d } from "@/lib/queries";
import { useAuth } from "@/components/AuthGate";
import { getSupabase } from "@/lib/supabase";
import type { Recommendation, Device } from "@/lib/types";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-status-red/20 text-status-red",
  medium: "bg-status-amber/20 text-status-amber",
  low: "bg-status-green/20 text-status-green",
};

const CATEGORY_STYLES: Record<string, string> = {
  drainage: "bg-status-blue/20 text-status-blue",
  elevation: "bg-purple-500/20 text-purple-400",
  barrier: "bg-orange-500/20 text-orange-400",
  other: "bg-gray-500/20 text-gray-400",
};

const CATEGORY_LABELS: Record<string, string> = {
  drainage: "Drainage Infrastructure",
  elevation: "Elevation / Grading",
  barrier: "Flood Barriers / Gates",
  other: "General",
};

function parseRecommendation(text: string) {
  const lines = text.split("\n");
  let title: string | null = null;
  let body = text;
  let estimatedCost: string | null = null;
  let reductionPct: number | null = null;

  if (lines[0]?.startsWith("## ")) {
    title = lines[0].replace("## ", "").replace(/^\[.*?\]\s*/, "");
    body = lines.slice(1).join("\n").trim();
  }

  const costMatch = body.match(/Estimated cost:\s*(low|medium|high)/i);
  if (costMatch) estimatedCost = costMatch[1].toLowerCase();

  const reductionMatch = body.match(/Estimated flood reduction:\s*(\d+)%/i);
  if (reductionMatch) reductionPct = parseInt(reductionMatch[1]);

  const costLineIdx = body.lastIndexOf("\n\nEstimated cost:");
  if (costLineIdx !== -1) body = body.slice(0, costLineIdx).trim();

  return { title, body, estimatedCost, reductionPct };
}

const COST_LABELS: Record<string, { label: string; color: string }> = {
  low: { label: "$10K-50K", color: "text-status-green" },
  medium: { label: "$50K-250K", color: "text-status-amber" },
  high: { label: "$250K-1M+", color: "text-status-red" },
};

interface CacheStatus {
  lastAnalysis: string | null;
  daysAgo: number | null;
  daysUntilRefresh: number | null;
  isCached: boolean;
}

export default function AIRecommendationsPage() {
  const { user } = useAuth();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [selectedNeighborhood, setSelectedNeighborhood] = useState("");
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Check cache status
  const checkCache = async (neighborhood = "") => {
    try {
      const params = new URLSearchParams({ table: "last_analysis" });
      if (neighborhood) params.set("neighborhood", neighborhood);
      const res = await fetch(`/api/data?${params}`);
      if (res.ok) setCacheStatus(await res.json());
    } catch {
      // cache check is optional
    }
  };

  useEffect(() => {
    Promise.all([
      getRecommendations().then(setRecommendations),
      getAllDevices().then(setDevices),
      getFloodEventCount30d().then(setFloodCounts),
    ]).catch(console.error).finally(() => setInitialLoading(false));

    getAllDevices().then((devs) => {
      const hoods = [...new Set(devs.map((d) => d.neighborhood).filter(Boolean))] as string[];
      setNeighborhoods(hoods.sort());
    });

    checkCache();
  }, []);

  // Update cache status when neighborhood changes
  useEffect(() => {
    checkCache(selectedNeighborhood);
  }, [selectedNeighborhood]);

  const runAnalysis = async (force = false) => {
    setLoading(true);
    setAnalysisMessage(null);
    try {
      // Get fresh session token for auth
      const { data: { session } } = await getSupabase().auth.getSession();
      if (!session) {
        setAnalysisMessage("Sign in required to run AI analysis");
        return;
      }

      const params = new URLSearchParams();
      if (selectedNeighborhood) params.set("neighborhood", selectedNeighborhood);
      if (force) params.set("force", "true");

      const url = `/api/run-analysis${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (res.status === 401) throw new Error("Sign in required to run analysis");
      if (res.status === 429) throw new Error(data.error || "Rate limit — try again later");
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      if (data.cached) {
        setAnalysisMessage(data.message);
      } else {
        setAnalysisMessage(data.summary ? `${data.message}\n\n${data.summary}` : data.message);
        const updated = await getRecommendations();
        setRecommendations(updated);
      }
      checkCache(selectedNeighborhood);
    } catch (err) {
      console.error("Failed to run analysis:", err);
      setAnalysisMessage(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  };

  const affectedDevices = selectedRec
    ? devices.filter((d) => selectedRec.affected_device_ids.includes(d.device_id))
    : [];

  // Filter and search recommendations
  let filteredRecs = recommendations;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredRecs = filteredRecs.filter((r) =>
      r.recommendation_text.toLowerCase().includes(q) ||
      r.affected_device_ids.some((id) => id.toLowerCase().includes(q))
    );
  }
  if (filterPriority) {
    filteredRecs = filteredRecs.filter((r) => r.priority === filterPriority);
  }
  if (filterCategory) {
    filteredRecs = filteredRecs.filter((r) => r.category === filterCategory);
  }

  // Group by date
  const grouped: Record<string, Recommendation[]> = {};
  filteredRecs.forEach((r) => {
    const date = new Date(r.generated_at).toLocaleDateString();
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(r);
  });

  // Default first group to expanded
  const groupKeys = Object.keys(grouped);

  // Stats
  const highPriority = recommendations.filter((r) => r.priority === "high").length;
  const categories = recommendations.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const toggleGroup = (date: string) => {
    setExpandedGroups((prev) => ({ ...prev, [date]: !prev[date] }));
  };

  // A group is expanded if explicitly set or if it's the first group and not explicitly collapsed
  const isGroupExpanded = (date: string, index: number) => {
    if (expandedGroups[date] !== undefined) return expandedGroups[date];
    return index === 0; // first group expanded by default
  };

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin text-status-blue mx-auto mb-3" />
          <p className="text-sm text-text-secondary">Loading AI analysis...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">AI Infrastructure Analysis</h2>
          <p className="text-sm text-text-secondary mt-1">
            Cross-references elevation, NOAA weather, tide data, and flood patterns to identify infrastructure improvements
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-text-secondary" />
            <select
              value={selectedNeighborhood}
              onChange={(e) => setSelectedNeighborhood(e.target.value)}
              className="bg-bg-card border border-border-card rounded-lg px-3 py-2 text-sm text-text-primary min-w-[160px]"
            >
              <option value="">All Neighborhoods</option>
              {neighborhoods.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          {user ? (
            <>
              <button
                onClick={() => runAnalysis(false)}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-status-blue/20 text-status-blue rounded-lg hover:bg-status-blue/30 transition-colors text-sm disabled:opacity-50"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
                {loading
                  ? `Analyzing ${selectedNeighborhood || "all"} sensor data...`
                  : selectedNeighborhood
                    ? `Analyze ${selectedNeighborhood}`
                    : "Run Full Analysis"}
              </button>
              {cacheStatus?.isCached && (
                <button
                  onClick={() => runAnalysis(true)}
                  disabled={loading}
                  title="Bypass the 14-day cache (available after 7 days)"
                  className="flex items-center gap-2 px-3 py-2 bg-status-amber/15 text-status-amber rounded-lg hover:bg-status-amber/25 transition-colors text-sm disabled:opacity-50"
                >
                  <RefreshCw size={14} />
                  Force Refresh
                </button>
              )}
            </>
          ) : (
            <span className="text-xs text-text-secondary px-3 py-2 bg-bg-primary rounded-lg border border-border-card">
              Sign in to run AI analysis
            </span>
          )}
        </div>
      </div>

      {/* Cache status banner */}
      {cacheStatus?.isCached && !analysisMessage && (
        <div className="mb-4 p-3 bg-status-blue/10 border border-status-blue/20 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-status-blue">
            <Clock size={14} />
            <span>
              Analysis from{" "}
              <strong>
                {cacheStatus.daysAgo === 0
                  ? "today"
                  : `${cacheStatus.daysAgo} day${cacheStatus.daysAgo! > 1 ? "s" : ""} ago`}
              </strong>
              {" "}&mdash; next auto-refresh in{" "}
              <strong>
                {cacheStatus.daysUntilRefresh} day{cacheStatus.daysUntilRefresh! > 1 ? "s" : ""}
              </strong>
            </span>
          </div>
          <span className="text-xs text-text-secondary">
            {cacheStatus.lastAnalysis
              ? new Date(cacheStatus.lastAnalysis).toLocaleString()
              : ""}
          </span>
        </div>
      )}

      {analysisMessage && (
        <div className={`mb-4 p-3 rounded-lg text-sm whitespace-pre-wrap ${
          analysisMessage.includes("Sign in") || analysisMessage.includes("Rate limit") || analysisMessage.includes("failed") || analysisMessage.includes("error")
            ? "bg-status-red/10 border border-status-red/20 text-status-red"
            : analysisMessage.includes("cached") || analysisMessage.includes("Using cached")
              ? "bg-status-blue/10 border border-status-blue/20 text-status-blue"
              : "bg-status-green/10 border border-status-green/20 text-status-green"
        }`}>
          {analysisMessage}
        </div>
      )}

      {/* Stats bar */}
      {recommendations.length > 0 && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Total Recommendations</p>
            <p className="text-2xl font-bold text-status-blue mt-1">{recommendations.length}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">High Priority</p>
            <p className="text-2xl font-bold text-status-red mt-1">{highPriority}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Drainage Issues</p>
            <p className="text-2xl font-bold text-status-blue mt-1">{categories["drainage"] ?? 0}</p>
          </div>
          <div className="bg-bg-card border border-border-card rounded-lg p-4">
            <p className="text-xs text-text-secondary uppercase">Analyses Run</p>
            <p className="text-2xl font-bold mt-1">{Object.keys(grouped).length}</p>
          </div>
        </div>
      )}

      {/* Search and filters for recommendations */}
      {recommendations.length > 0 && (
        <div className="flex gap-3 mb-4 flex-wrap items-center">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search recommendations..."
              className="bg-bg-card border border-border-card rounded-lg pl-8 pr-3 py-2 text-sm text-text-primary w-64"
            />
          </div>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className="bg-bg-card border border-border-card rounded-lg px-3 py-2 text-sm text-text-primary"
          >
            <option value="">All Priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="bg-bg-card border border-border-card rounded-lg px-3 py-2 text-sm text-text-primary"
          >
            <option value="">All Categories</option>
            <option value="drainage">Drainage</option>
            <option value="elevation">Elevation</option>
            <option value="barrier">Barriers</option>
            <option value="other">Other</option>
          </select>
          {(searchQuery || filterPriority || filterCategory) && (
            <button
              onClick={() => { setSearchQuery(""); setFilterPriority(""); setFilterCategory(""); }}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Clear filters
            </button>
          )}
          <span className="text-xs text-text-secondary ml-auto">
            {filteredRecs.length} of {recommendations.length} recommendations
          </span>
        </div>
      )}

      {/* Mini map for selected recommendation */}
      {selectedRec && affectedDevices.length > 0 && (
        <div className="mb-6 h-[280px] rounded-lg overflow-hidden border border-border-card">
          <DeviceMap devices={affectedDevices} floodCounts={floodCounts} />
        </div>
      )}

      {/* Recommendations grouped by analysis date */}
      {groupKeys.map((date, groupIdx) => {
        const recs = grouped[date];
        const expanded = isGroupExpanded(date, groupIdx);

        return (
          <div key={date} className="mb-6">
            <button
              onClick={() => toggleGroup(date)}
              className="flex items-center gap-3 mb-3 w-full text-left group"
            >
              <h3 className="text-sm font-semibold text-text-secondary">{date} Analysis</h3>
              <div className="flex-1 h-px bg-border-card" />
              <span className="text-xs text-text-secondary">{recs.length} rec{recs.length !== 1 ? "s" : ""}</span>
              <span className="text-xs text-text-secondary">
                {recs[0].analysis_period_days}d window
              </span>
              {expanded ? <ChevronUp size={14} className="text-text-secondary" /> : <ChevronDown size={14} className="text-text-secondary" />}
            </button>

            {expanded && (
              <div className="space-y-4">
                {recs.map((rec) => {
                  const { title, body, estimatedCost, reductionPct } = parseRecommendation(rec.recommendation_text);
                  const isSelected = selectedRec?.id === rec.id;

                  return (
                    <div
                      key={rec.id}
                      onClick={() => setSelectedRec(isSelected ? null : rec)}
                      className={`bg-bg-card border rounded-lg p-5 cursor-pointer transition-all ${
                        isSelected
                          ? "border-status-blue shadow-lg shadow-status-blue/5"
                          : "border-border-card hover:border-border-card/80"
                      }`}
                    >
                      {/* Header */}
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_STYLES[rec.priority]}`}>
                          {rec.priority.toUpperCase()}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${CATEGORY_STYLES[rec.category]}`}>
                          {CATEGORY_LABELS[rec.category] ?? rec.category}
                        </span>
                        {estimatedCost && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-bg-primary">
                            <DollarSign size={10} />
                            <span className={COST_LABELS[estimatedCost]?.color ?? ""}>
                              {COST_LABELS[estimatedCost]?.label ?? estimatedCost}
                            </span>
                          </span>
                        )}
                        {reductionPct && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-status-green/10 text-status-green">
                            <TrendingDown size={10} />
                            {reductionPct}% reduction
                          </span>
                        )}
                      </div>

                      {/* Title */}
                      {title && (
                        <h4 className="text-base font-semibold mb-2">{title}</h4>
                      )}

                      {/* Body */}
                      <p className="text-sm text-text-primary/90 leading-relaxed whitespace-pre-wrap">
                        {body}
                      </p>

                      {/* Affected sensors */}
                      {rec.affected_device_ids.length > 0 && (
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <MapPin size={12} className="text-text-secondary" />
                          {rec.affected_device_ids.map((id) => {
                            const dev = devices.find((d) => d.device_id === id);
                            return (
                              <span key={id} className="px-2 py-0.5 bg-bg-primary rounded text-xs font-mono text-text-secondary" title={dev?.name ?? undefined}>
                                {id}
                                {dev?.neighborhood && <span className="text-text-secondary/50 ml-1">({dev.neighborhood})</span>}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Last analysis timestamp */}
      {recommendations.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-text-secondary mt-2">
          <Clock size={12} />
          Last analysis: {new Date(recommendations[0].generated_at).toLocaleString()}
          <span className="text-text-secondary/50">&bull;</span>
          {recommendations.length} total recommendation{recommendations.length !== 1 ? "s" : ""} across {Object.keys(grouped).length} analysis run{Object.keys(grouped).length !== 1 ? "s" : ""}
        </div>
      )}

      {recommendations.length === 0 && !loading && (
        <div className="text-center py-16 text-text-secondary">
          <BrainCircuit size={56} className="mx-auto mb-4 opacity-20" />
          <p className="text-lg mb-2">No analyses yet</p>
          <p className="text-sm max-w-md mx-auto">
            Click &quot;Run Full Analysis&quot; to have Claude analyze all sensor data, NOAA weather patterns,
            elevation gradients, water flow direction, compound events, and flood history from the last 30 days.
            The AI will generate specific infrastructure recommendations with cost estimates and flood reduction projections.
          </p>
        </div>
      )}
    </div>
  );
}
