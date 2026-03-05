"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { BrainCircuit, Loader2 } from "lucide-react";
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

export default function AIRecommendationsPage() {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null);

  useEffect(() => {
    getRecommendations().then(setRecommendations).catch(console.error);
    getAllDevices().then(setDevices).catch(console.error);
  }, []);

  const runAnalysis = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/run-analysis", { method: "POST" });
      if (!res.ok) throw new Error("Analysis failed");
      const updated = await getRecommendations();
      setRecommendations(updated);
    } catch (err) {
      console.error("Failed to run analysis:", err);
    } finally {
      setLoading(false);
    }
  };

  const affectedDevices = selectedRec
    ? devices.filter((d) => selectedRec.affected_device_ids.includes(d.device_id))
    : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">AI Infrastructure Analysis</h2>
        <button
          onClick={runAnalysis}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-status-blue/20 text-status-blue rounded-lg hover:bg-status-blue/30 transition-colors text-sm disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}
          {loading ? "Analyzing..." : "Run New Analysis"}
        </button>
      </div>

      {/* Mini map for selected recommendation */}
      {selectedRec && affectedDevices.length > 0 && (
        <div className="mb-6 h-[250px] rounded-lg overflow-hidden border border-border-card">
          <DeviceMap devices={affectedDevices} />
        </div>
      )}

      {/* Recommendations */}
      <div className="space-y-4">
        {recommendations.map((rec) => (
          <div
            key={rec.id}
            onClick={() => setSelectedRec(selectedRec?.id === rec.id ? null : rec)}
            className={`bg-bg-card border rounded-lg p-5 cursor-pointer transition-colors ${
              selectedRec?.id === rec.id
                ? "border-status-blue"
                : "border-border-card hover:border-border-card/80"
            }`}
          >
            <div className="flex items-center gap-3 mb-3">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_STYLES[rec.priority]}`}>
                {rec.priority.toUpperCase()}
              </span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${CATEGORY_STYLES[rec.category]}`}>
                {rec.category}
              </span>
              <span className="text-xs text-text-secondary ml-auto">
                {new Date(rec.generated_at).toLocaleDateString()} — {rec.analysis_period_days} day analysis
              </span>
            </div>

            <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
              {rec.recommendation_text}
            </p>

            {rec.affected_device_ids.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {rec.affected_device_ids.map((id) => (
                  <span key={id} className="px-2 py-0.5 bg-bg-primary rounded text-xs font-mono text-text-secondary">
                    {id}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {recommendations.length === 0 && !loading && (
          <div className="text-center py-12 text-text-secondary">
            <BrainCircuit size={48} className="mx-auto mb-4 opacity-30" />
            <p>No analyses yet. Click &quot;Run New Analysis&quot; to generate recommendations.</p>
          </div>
        )}
      </div>
    </div>
  );
}
