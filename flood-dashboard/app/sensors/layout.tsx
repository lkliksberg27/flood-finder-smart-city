import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sensors",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
