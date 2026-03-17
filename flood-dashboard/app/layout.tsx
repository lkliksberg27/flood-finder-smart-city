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
    "Real-time city-wide flood detection and infrastructure analysis for Golden Beach, FL. IoT sensors, NOAA weather/tide correlation, AI-powered recommendations.",
  openGraph: {
    title: "Flood Finder — Smart City Flood Monitoring",
    description:
      "Real-time flood detection with IoT sensors, NOAA data correlation, and AI infrastructure analysis for Golden Beach, FL.",
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
          {/* Mobile warning */}
          <div className="lg:hidden fixed inset-0 z-[9999] bg-bg-primary flex items-center justify-center p-8">
            <div className="text-center max-w-sm">
              <div className="text-4xl mb-4">🖥️</div>
              <h2 className="text-lg font-semibold mb-2">Desktop Required</h2>
              <p className="text-sm text-text-secondary">
                Flood Finder is a city infrastructure dashboard built for desktop displays.
                Please open on a computer or laptop for the full experience.
              </p>
            </div>
          </div>
          {/* Desktop layout */}
          <div className="hidden lg:flex min-h-screen">
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
