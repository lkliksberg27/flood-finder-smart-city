import type { ReactNode } from "react";

interface Props {
  label: string;
  value: string | number;
  icon?: ReactNode;
  color?: string;
}

export function StatCard({ label, value, icon, color = "text-text-primary" }: Props) {
  return (
    <div className="bg-bg-card border border-border-card rounded-lg p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-secondary uppercase tracking-wider">{label}</p>
        {icon && <span className="text-text-secondary">{icon}</span>}
      </div>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}
