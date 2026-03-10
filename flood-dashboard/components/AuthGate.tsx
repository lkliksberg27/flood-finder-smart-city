"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import { Waves, Loader2, AlertCircle } from "lucide-react";

interface AuthContextValue {
  user: User | null;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthContextValue>({
  user: null,
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthCtx);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [submitting, setSubmitting] = useState(false);
  const [signUpSuccess, setSignUpSuccess] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await getSupabase().auth.signOut();
    setUser(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    setSignUpSuccess(false);

    try {
      const supabase = getSupabase();
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setSignUpSuccess(true);
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Authentication failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-primary">
        <Loader2 size={24} className="animate-spin text-status-blue" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
        <div className="w-full max-w-[380px]">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-status-blue/10 border border-status-blue/20 mb-4">
              <Waves size={28} className="text-status-blue" />
            </div>
            <h1 className="text-2xl font-bold text-status-green tracking-wide">
              FLOOD FINDER
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              Smart City Flood Monitoring
            </p>
          </div>

          {/* Form */}
          <form
            onSubmit={handleSubmit}
            className="bg-bg-card border border-border-card rounded-xl p-6 space-y-4"
          >
            <h2 className="text-lg font-semibold text-text-primary">
              {mode === "signup" ? "Create Account" : "Sign In"}
            </h2>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-status-red/10 border border-status-red/20 rounded-lg text-sm text-status-red">
                <AlertCircle size={14} className="shrink-0" />
                {error}
              </div>
            )}

            {signUpSuccess && (
              <div className="p-3 bg-status-green/10 border border-status-green/20 rounded-lg text-sm text-status-green">
                Account created! Check your email to confirm, then sign in.
              </div>
            )}

            <div>
              <label className="text-xs text-text-secondary block mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2.5 bg-bg-primary border border-border-card rounded-lg text-sm text-text-primary outline-none focus:border-status-blue transition-colors placeholder:text-text-secondary/50"
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label className="text-xs text-text-secondary block mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="w-full px-3 py-2.5 bg-bg-primary border border-border-card rounded-lg text-sm text-text-primary outline-none focus:border-status-blue transition-colors placeholder:text-text-secondary/50"
                placeholder="••••••••"
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-status-blue text-white rounded-lg text-sm font-semibold hover:bg-status-blue/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting
                ? mode === "signup"
                  ? "Creating..."
                  : "Signing in..."
                : mode === "signup"
                  ? "Create Account"
                  : "Sign In"}
            </button>

            <div className="text-center">
              <p className="text-xs text-text-secondary">
                {mode === "signup"
                  ? "Already have an account?"
                  : "Don't have an account?"}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === "signup" ? "signin" : "signup");
                    setError("");
                    setSignUpSuccess(false);
                  }}
                  className="text-status-blue hover:underline font-medium"
                >
                  {mode === "signup" ? "Sign in" : "Sign up"}
                </button>
              </p>
            </div>
          </form>

          <p className="text-[11px] text-text-secondary/50 text-center mt-6">
            Aventura, FL — Smart City Infrastructure
          </p>
        </div>
      </div>
    );
  }

  return (
    <AuthCtx.Provider value={{ user, signOut }}>{children}</AuthCtx.Provider>
  );
}
