"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { BrainCircuit, Loader2, TrendingDown, DollarSign, MapPin } from "lucide-react";
import { getRecommendations, getAllDevices } from "@/lib/queries";
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

  // Extract markdown title
  if (lines[0]?.startsWith("## ")) {
    title = lines[0].replace("## ", "");
    body = lines.slice(1).join("\n").trim();
  }

  // Extract cost and reduction from end
  const costMatch = body.match(/Estimated cost:\s*(low|medium|high)/i);
  if (costMatch) estimatedCost = costMatch[1].toLowerCase();

  const reductionMatch = body.match(/Estimated flood reduction:\s*(\d+)%/i);
  if (reductionMatch) reductionPct = parseInt(reductionMatch[1]);

  // Clean the trailing metadata line
  const costLineIdx = body.lastIndexOf("\n\nEstimated cost:");
  if (costLineIdx !== -1) body = body.slice(0, costLineIdx).trim();

  return { title, body, estimatedCost, reductionPct };
}

const COST_LABELS: Record<string, { label: string; color: string }> = {
  low: { label: "$10K-50K", color: "text-status-green" },
  medium: { label: "$50K-250K", color: "text-status-amber" },
  high: { label: "$250K-1M+", color: "text-status-red" },
};

export default function AIRecommendationsPage() {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);

  useEffect(() => {
    getRecommendations().then(setRecommendations).catch(console.error);
    getAllDevices().then(setDevices).catch(console.error);
  }, []);

  const runAnalysis = async () => {
    setLoading(true);
    setAnalysisMessage(null);
    try {
      const res = await fetch("/api/run-analysis", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setAnalysisMessage(data.message);
      const updated = await getRecommendations();
      setRecommendations(updated);
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

  // Group recommendations by generation date
  const grouped: Record<string, Recommendation[]> = {};
  recommendations.forEach((r) => {
    const date = new Date(r.generated_at).toLocaleDateString();
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(r);
  });

  // Stats
  const highPriority = recommendations.filter((r) => r.priority === "high").length;
  const categories = recommendations.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">AI Infrastructure Analysis</h2>
          <p className="text-sm text-text-secondary mt-1">
            Cross-references elevation, NOAA weather, tide data, and flood patterns to identify infrastructure improvements
          </p>
        </div>
        <button
          onClick={runAnalysis}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-status-blue/20 text-status-blue rounded-lg hover:bg-status-blue/30 transition-colors text-sm disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
          {loading ? "Analyzing all sensor data..." : "Run New Analysis"}
        </button>
      </div>

      {analysisMessage && (
        <div className="mb-4 p-3 bg-status-green/10 border border-status-green/20 rounded-lg text-sm text-status-green">
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

      {/* Mini map for selected recommendation */}
      {selectedRec && affectedDevices.length > 0 && (
        <div className="mb-6 h-[280px] rounded-lg overflow-hidden border border-border-card">
          <DeviceMap devices={affectedDevices} />
        </div>
      )}

      {/* Recommendations grouped by analysis date */}
      {Object.entries(grouped).map(([date, recs]) => (
        <div key={date} className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-sm font-semibold text-text-secondary">{date} Analysis</h3>
            <div className="flex-1 h-px bg-border-card" />
            <span className="text-xs text-text-secondary">{recs[0].analysis_period_days} day window</span>
          </div>

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
        </div>
      ))}

      {recommendations.length === 0 && !loading && (
        <div className="text-center py-16 text-text-secondary">
          <BrainCircuit size={56} className="mx-auto mb-4 opacity-20" />
          <p className="text-lg mb-2">No analyses yet</p>
          <p className="text-sm">
            Click &quot;Run New Analysis&quot; to analyze all sensor data, NOAA weather patterns,
            elevation gradients, and flood events from the last 30 days.
          </p>
        </div>
      )}
    </div>
  );
}
