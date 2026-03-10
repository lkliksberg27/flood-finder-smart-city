import type { Metadata } from "next";
import "./globals.css";
import { AuthGate } from "@/components/AuthGate";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: {
    default: "Flood Finder — City Dashboard",
    template: "%s — Flood Finder",
  },
  description:
    "Real-time city-wide flood detection and infrastructure analysis for Aventura, FL. IoT sensors, NOAA weather/tide correlation, AI-powered recommendations.",
  openGraph: {
    title: "Flood Finder — Smart City Flood Monitoring",
    description:
      "Real-time flood detection with IoT sensors, NOAA data correlation, and AI infrastructure analysis for Aventura, FL.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthGate>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="ml-[220px] flex-1 p-6 overflow-auto">
              {children}
            </main>
          </div>
        </AuthGate>
      </body>
    </html>
  );
}
