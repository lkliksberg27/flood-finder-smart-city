"use client";

import { useEffect, useState } from "react";
import {
  UserCircle, LogIn, LogOut, Mail, Shield, Bell, MapPin,
  Download, Clock, BrainCircuit, Loader2, Check, AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/components/AuthGate";
import { getSupabase } from "@/lib/supabase";

interface Preferences {
  defaultNeighborhood: string;
  alertDepthThreshold: number;
  emailAlerts: boolean;
}

const DEFAULT_PREFS: Preferences = {
  defaultNeighborhood: "",
  alertDepthThreshold: 10,
  emailAlerts: false,
};

function loadPrefs(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem("ff-prefs");
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: Preferences) {
  localStorage.setItem("ff-prefs", JSON.stringify(prefs));
}

export default function AccountPage() {
  const { user, signOut } = useAuth();
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [signInMode, setSignInMode] = useState<"login" | "signup">("login");
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [analysisCount, setAnalysisCount] = useState<number | null>(null);
  const [lastAnalysis, setLastAnalysis] = useState<string | null>(null);

  useEffect(() => {
    setPrefs(loadPrefs());

    // Load neighborhoods
    getSupabase()
      .from("devices")
      .select("neighborhood")
      .not("neighborhood", "is", null)
      .then(({ data }) => {
        if (data) {
          const unique = [...new Set(data.map((d) => d.neighborhood).filter(Boolean))];
          setNeighborhoods(unique.sort() as string[]);
        }
      });

    // Load analysis stats
    getSupabase()
      .from("infrastructure_recommendations")
      .select("generated_at")
      .order("generated_at", { ascending: false })
      .then(({ data }) => {
        if (data) {
          setAnalysisCount(data.length);
          if (data[0]) setLastAnalysis(data[0].generated_at);
        }
      });
  }, []);

  const updatePref = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    const updated = { ...prefs, [key]: value };
    setPrefs(updated);
    savePrefs(updated);
    setPrefsSaved(true);
    setTimeout(() => setPrefsSaved(false), 2000);
  };

  const handleSignIn = async () => {
    if (!signInEmail || !signInPassword) return;
    setSignInLoading(true);
    setSignInError("");
    try {
      const supabase = getSupabase();
      if (signInMode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: signInEmail,
          password: signInPassword,
        });
        if (error) throw error;
        setSignInError("Check your email for a confirmation link.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: signInEmail,
          password: signInPassword,
        });
        if (error) throw error;
      }
      setSignInEmail("");
      setSignInPassword("");
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSignInLoading(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <UserCircle size={24} className="text-status-blue" />
        <h2 className="text-xl font-semibold">Account & Preferences</h2>
      </div>

      {/* ── Auth Section ── */}
      <div className="bg-bg-card border border-border-card rounded-lg p-5 mb-5">
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Shield size={14} />
          Authentication
        </h3>

        {user ? (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-status-blue/15 border border-status-blue/25 flex items-center justify-center">
                <Mail size={18} className="text-status-blue" />
              </div>
              <div>
                <p className="text-sm font-medium">{user.email}</p>
                <p className="text-xs text-text-secondary">
                  Signed in
                  {user.last_sign_in_at && (
                    <> &middot; Last login {new Date(user.last_sign_in_at).toLocaleDateString()}</>
                  )}
                </p>
              </div>
            </div>
            <p className="text-xs text-text-secondary mb-3">
              Signing in enables AI infrastructure analysis and protects against unauthorized API usage.
            </p>
            <button
              onClick={signOut}
              className="flex items-center gap-2 px-4 py-2 text-sm text-status-red bg-status-red/10 border border-status-red/20 rounded-lg hover:bg-status-red/20 transition-colors"
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        ) : (
          <div>
            <p className="text-xs text-text-secondary mb-4">
              Sign in to run AI infrastructure analysis. The dashboard is read-only without an account.
            </p>
            <div className="space-y-3">
              <input
                type="email"
                value={signInEmail}
                onChange={(e) => setSignInEmail(e.target.value)}
                placeholder="Email address"
                className="w-full bg-bg-primary border border-border-card rounded-lg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-status-blue transition-colors"
              />
              <input
                type="password"
                value={signInPassword}
                onChange={(e) => setSignInPassword(e.target.value)}
                placeholder="Password"
                onKeyDown={(e) => e.key === "Enter" && handleSignIn()}
                className="w-full bg-bg-primary border border-border-card rounded-lg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-status-blue transition-colors"
              />
              {signInError && (
                <p className={`text-xs ${signInError.includes("Check your email") ? "text-status-green" : "text-status-red"}`}>
                  {signInError}
                </p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={handleSignIn}
                  disabled={signInLoading || !signInEmail || !signInPassword}
                  className="flex items-center gap-2 px-4 py-2.5 bg-status-blue/20 text-status-blue rounded-lg hover:bg-status-blue/30 transition-colors text-sm disabled:opacity-40"
                >
                  {signInLoading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                  {signInMode === "signup" ? "Create Account" : "Sign In"}
                </button>
                <button
                  onClick={() => setSignInMode(signInMode === "login" ? "signup" : "login")}
                  className="text-xs text-text-secondary hover:text-text-primary transition-colors"
                >
                  {signInMode === "login" ? "Need an account? Sign up" : "Already have an account? Sign in"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Preferences ── */}
      <div className="bg-bg-card border border-border-card rounded-lg p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <MapPin size={14} />
            Preferences
          </h3>
          {prefsSaved && (
            <span className="flex items-center gap-1 text-xs text-status-green">
              <Check size={12} /> Saved
            </span>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-text-secondary block mb-1.5">Default Neighborhood</label>
            <select
              value={prefs.defaultNeighborhood}
              onChange={(e) => updatePref("defaultNeighborhood", e.target.value)}
              className="w-full bg-bg-primary border border-border-card rounded-lg px-3 py-2 text-sm text-text-primary"
            >
              <option value="">All Neighborhoods</option>
              {neighborhoods.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <p className="text-[10px] text-text-secondary mt-1">
              Pre-filter Flood Events and AI Analysis to your area
            </p>
          </div>

          <div>
            <label className="text-xs text-text-secondary block mb-1.5">
              Alert Depth Threshold: <span className="text-text-primary font-medium">{prefs.alertDepthThreshold}cm</span>
            </label>
            <input
              type="range"
              min={5}
              max={50}
              step={5}
              value={prefs.alertDepthThreshold}
              onChange={(e) => updatePref("alertDepthThreshold", Number(e.target.value))}
              className="w-full accent-status-blue"
            />
            <div className="flex justify-between text-[10px] text-text-secondary mt-0.5">
              <span>5cm (sensitive)</span>
              <span>50cm (severe only)</span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-text-primary flex items-center gap-2">
                <Bell size={14} className="text-text-secondary" />
                Email Flood Alerts
              </p>
              <p className="text-[10px] text-text-secondary mt-0.5">
                Get notified when flooding exceeds your threshold
              </p>
            </div>
            <button
              onClick={() => updatePref("emailAlerts", !prefs.emailAlerts)}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                prefs.emailAlerts ? "bg-status-blue" : "bg-bg-primary border border-border-card"
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  prefs.emailAlerts ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* ── Data & Export ── */}
      <div className="bg-bg-card border border-border-card rounded-lg p-5 mb-5">
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Download size={14} />
          Data Export
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => window.open("/api/export/sensors", "_blank")}
            className="flex items-center gap-2 px-4 py-3 bg-bg-primary border border-border-card rounded-lg hover:border-status-blue/30 transition-colors text-left"
          >
            <div>
              <p className="text-sm font-medium">Sensor Fleet</p>
              <p className="text-[10px] text-text-secondary">All devices with status, battery, elevation, flood counts</p>
            </div>
          </button>
          <button
            onClick={() => window.open("/api/export/events", "_blank")}
            className="flex items-center gap-2 px-4 py-3 bg-bg-primary border border-border-card rounded-lg hover:border-status-blue/30 transition-colors text-left"
          >
            <div>
              <p className="text-sm font-medium">Flood Events</p>
              <p className="text-[10px] text-text-secondary">All events with depth, duration, NOAA data, compound flags</p>
            </div>
          </button>
        </div>
      </div>

      {/* ── AI Analysis Stats ── */}
      <div className="bg-bg-card border border-border-card rounded-lg p-5 mb-5">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <BrainCircuit size={14} />
          AI Analysis
        </h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="bg-bg-primary rounded-lg p-3">
            <p className="text-text-secondary text-xs">Total Recommendations</p>
            <p className="text-lg font-bold text-status-blue mt-0.5">{analysisCount ?? "—"}</p>
          </div>
          <div className="bg-bg-primary rounded-lg p-3">
            <p className="text-text-secondary text-xs">Last Analysis</p>
            <p className="text-sm font-medium mt-0.5">
              {lastAnalysis ? new Date(lastAnalysis).toLocaleDateString() : "Never"}
            </p>
          </div>
        </div>
        {!user && (
          <div className="mt-3 flex items-center gap-2 text-xs text-status-amber bg-status-amber/10 border border-status-amber/20 rounded-lg p-2.5">
            <AlertTriangle size={12} />
            Sign in above to run AI infrastructure analysis
          </div>
        )}
      </div>

      {/* ── About ── */}
      <div className="bg-bg-card border border-border-card rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-3">About Flood Finder</h3>
        <div className="text-xs text-text-secondary space-y-1.5">
          <p>Real-time flood monitoring and infrastructure analysis for Golden Beach, FL.</p>
          <p>
            20 IoT sensors (ESP32 + LoRa) measuring water depth via ultrasonic distance,
            barometric elevation, and GPS. NOAA weather and tide data correlated with every flood event.
          </p>
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border-card text-text-secondary/60">
            <span>v2.0</span>
            <span>&middot;</span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              Data refreshes every 30s
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
