"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
}

export class MapErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("[MapErrorBoundary]", error.message);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full bg-bg-card border border-border-card rounded-lg">
          <div className="text-center p-6">
            <AlertTriangle size={32} className="mx-auto mb-3 text-status-amber" />
            <p className="text-sm font-medium mb-1">
              {this.props.fallbackMessage ?? "Map failed to load"}
            </p>
            <p className="text-xs text-text-secondary mb-3">
              This can happen if WebGL is unavailable or tiles failed to load.
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false });
                window.location.reload();
              }}
              className="flex items-center gap-2 mx-auto px-4 py-2 bg-status-blue/20 text-status-blue rounded-lg hover:bg-status-blue/30 transition-colors text-sm"
            >
              <RefreshCw size={14} />
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
