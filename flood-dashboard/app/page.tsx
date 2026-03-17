"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  Radio,
  AlertTriangle,
  Battery,
  Clock,
  CloudRain,
  Waves,
  Thermometer,
  Droplets,
  Loader2,
  Wind,
  MapPin,
  X,
  ArrowLeft,
  Search,
} from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { getAllDevices, getActiveFloodEvents, getFloodEventCount30d } from "@/lib/queries";
import { StatCard } from "@/components/StatCard";
import { MapErrorBoundary } from "@/components/ErrorBoundary";
import { haversineKm, formatDistance } from "@/lib/geo";
import type { Device, FloodEvent } from "@/lib/types";

const DeviceMap = dynamic(
  () => import("@/components/MapContainer").then((m) => m.DeviceMap),
  { ssr: false }
);

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

interface WeatherData {
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  rainfallMm: number;
  description: string;
  tideLevel: number | null;
  forecast: {
    name: string;
    shortForecast: string;
    rainChance: number | null;
  }[];
  tideForecast: { time: string; level: number }[];
}

interface GeocodingResult {
  name: string;
  fullName: string;
  lng: number;
  lat: number;
}

function OverviewContent() {
  useEffect(() => { document.title = "Overview — Flood Finder"; }, []);
  const searchParams = useSearchParams();
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeEvents, setActiveEvents] = useState<FloodEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [floodCounts, setFloodCounts] = useState<Record<string, number>>({});
  const [initialLoading, setInitialLoading] = useState(true);

  // Location search state
  const [locationSearch, setLocationSearch] = useState("");
  const [locationResults, setLocationResults] = useState<GeocodingResult[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<{
    lng: number;
    lat: number;
    name: string;
    fullName: string;
  } | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeError, setGeocodeError] = useState("");

  // Read ?location= param from URL (from Ctrl+K "Search on map")
  useEffect(() => {
    const locationParam = searchParams.get("location");
    if (locationParam) {
      setLocationSearch(locationParam);
      // Trigger geocoding
      (async () => {
        setGeocoding(true);
        try {
          const res = await fetch(
            `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(locationParam)}.json?access_token=${MAPBOX_TOKEN}&limit=1`
          );
          const data = await res.json();
          const feature = data.features?.[0];
          if (feature) {
            setSelectedLocation({
              name: feature.text,
              fullName: feature.place_name,
              lng: feature.center[0],
              lat: feature.center[1],
            });
          }
        } catch {
          // geocoding failed
        } finally {
          setGeocoding(false);
        }
      })();
    }
  }, [searchParams]);

  const fetchData = useCallback(async () => {
    try {
      const [devs, events, counts] = await Promise.all([
        getAllDevices(),
        getActiveFloodEvents(),
        getFloodEventCount30d(),
      ]);
      setDevices(devs);
      setActiveEvents(events);
      setFloodCounts(counts);
      setLastUpdated(new Date());
      setInitialLoading(false);
    } catch (err) {
      console.error("Failed to fetch overview data:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Fetch weather
  useEffect(() => {
    async function loadWeather() {
      try {
        const res = await fetch("/api/weather");
        if (res.ok) setWeather(await res.json());
      } catch {
        // weather is optional
      }
    }
    loadWeather();
    const interval = setInterval(loadWeather, 600000);
    return () => clearInterval(interval);
  }, []);

  // Realtime subscription
  useEffect(() => {
    const channel = getSupabase()
      .channel("overview-devices")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "devices" },
        () => fetchData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "flood_events" },
        () => fetchData()
      )
      .subscribe();
    return () => {
      getSupabase().removeChannel(channel);
    };
  }, [fetchData]);

  // Geocoding effect (debounced)
  useEffect(() => {
    if (selectedLocation) return; // Don't search while viewing a location
    if (!locationSearch.trim() || locationSearch.length < 3) {
      setLocationResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      setGeocodeError("");
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(locationSearch)}.json?access_token=${MAPBOX_TOKEN}&limit=5`
        );
        const data = await res.json();
        const results =
          data.features?.map((f: Record<string, unknown>) => ({
            name: (f as { text: string }).text,
            fullName: (f as { place_name: string }).place_name,
            lng: (f as { center: number[] }).center[0],
            lat: (f as { center: number[] }).center[1],
          })) ?? [];
        setLocationResults(results);
        if (results.length === 0) setGeocodeError("No places found");
      } catch {
        setLocationResults([]);
        setGeocodeError("Search failed — check your connection");
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [locationSearch, selectedLocation]);

  const handleLocationSelect = (result: GeocodingResult) => {
    setSelectedLocation({
      name: result.name,
      fullName: result.fullName,
      lng: result.lng,
      lat: result.lat,
    });
    setLocationResults([]);
    setLocationSearch(result.fullName);
  };

  const clearLocationSearch = () => {
    setSelectedLocation(null);
    setLocationSearch("");
    setLocationResults([]);
    setGeocodeError("");
    // Clear URL param if present
    if (searchParams.get("location")) {
      window.history.replaceState(null, "", "/");
    }
  };

  // Nearby sensors calculation
  const nearbySensors = selectedLocation
    ? devices
        .map((d) => ({
          ...d,
          distance: haversineKm(
            selectedLocation.lat,
            selectedLocation.lng,
            d.lat,
            d.lng
          ),
        }))
        .sort((a, b) => a.distance - b.distance)
    : [];

  const closeSensors = nearbySensors.filter((s) => s.distance <= 10);

  // Build flood depths map for map visualization
  const floodDepths: Record<string, number> = {};
  activeEvents.forEach((e) => {
    floodDepths[e.device_id] = Math.max(floodDepths[e.device_id] ?? 0, e.peak_depth_cm);
  });

  const online = devices.filter((d) => d.status !== "offline").length;
  const offline = devices.filter((d) => d.status === "offline").length;
  const avgBattery =
    devices.length > 0
      ? (
          devices.reduce((s, d) => s + (d.battery_v ?? 0), 0) / devices.length
        ).toFixed(1)
      : "N/A";

  const rainForecast = weather?.forecast?.find(
    (f) => (f.rainChance ?? 0) > 30
  );

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-48px)]">
        <div className="text-center">
          <Loader2
            size={32}
            className="animate-spin text-status-blue mx-auto mb-3"
          />
          <p className="text-sm text-text-secondary">
            Loading sensor network...
          </p>
        </div>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-48px)]">
        <div className="text-center max-w-md">
          <Radio
            size={48}
            className="mx-auto mb-4 text-text-secondary opacity-30"
          />
          <h2 className="text-lg font-semibold mb-2">No Sensors Connected</h2>
          <p className="text-sm text-text-secondary">
            No devices found in the database. Run the simulator (
            <code className="text-status-blue">node simulate.js</code>) to seed
            test devices, or add real sensors by inserting device records into
            Supabase and flashing the firmware.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-6 h-[calc(100vh-48px)]">
      {/* Map with search overlay */}
      <div className="flex-1 rounded-lg overflow-hidden border border-border-card relative">
        {/* Location search bar */}
        <div className="absolute top-3 left-3 z-10" style={{ maxWidth: "400px", width: "calc(100% - 24px)" }}>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
            />
            <input
              type="text"
              value={locationSearch}
              onChange={(e) => {
                setLocationSearch(e.target.value);
                if (selectedLocation) setSelectedLocation(null);
              }}
              placeholder="Search any address or place..."
              className="w-full pl-9 pr-9 py-2.5 bg-bg-card/95 backdrop-blur-sm border border-border-card rounded-lg text-sm text-text-primary outline-none focus:border-status-blue transition-colors placeholder:text-text-secondary/60"
            />
            {(locationSearch || selectedLocation) && (
              <button
                onClick={clearLocationSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2"
              >
                <X
                  size={14}
                  className="text-text-secondary hover:text-text-primary"
                />
              </button>
            )}
          </div>

          {/* Autocomplete dropdown */}
          {locationResults.length > 0 && !selectedLocation && (
            <div className="mt-1 bg-bg-card/95 backdrop-blur-sm border border-border-card rounded-lg shadow-xl overflow-hidden">
              {locationResults.map((result, i) => (
                <button
                  key={i}
                  onClick={() => handleLocationSelect(result)}
                  className="w-full text-left px-3 py-2.5 hover:bg-bg-card-hover transition-colors border-b border-border-card last:border-b-0 flex items-center gap-2.5"
                >
                  <MapPin
                    size={13}
                    className="text-status-blue shrink-0 mt-0.5"
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary">{result.name}</p>
                    <p className="text-xs text-text-secondary truncate">
                      {result.fullName}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {geocoding && (
            <div className="mt-1 bg-bg-card/95 backdrop-blur-sm border border-border-card rounded-lg p-3 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-status-blue" />
              <span className="text-xs text-text-secondary">
                Searching...
              </span>
            </div>
          )}

          {geocodeError && !selectedLocation && !geocoding && locationResults.length === 0 && (
            <div className="mt-1 bg-bg-card/95 backdrop-blur-sm border border-border-card rounded-lg p-3">
              <p className="text-xs text-text-secondary">{geocodeError}</p>
            </div>
          )}
        </div>

        <MapErrorBoundary>
          <DeviceMap
            devices={devices}
            onDeviceClick={(d) => setSelectedDevice(d.device_id)}
            highlightDeviceId={selectedDevice}
            searchLocation={selectedLocation}
            floodDepths={floodDepths}
            floodCounts={floodCounts}
            floodConditions={weather ? { rainfallMm: weather.rainfallMm, tideLevelM: weather.tideLevel ?? 0 } : undefined}
          />
        </MapErrorBoundary>
      </div>

      {/* Sidebar - switches between overview and location info */}
      <div className="w-[320px] flex flex-col gap-4 overflow-y-auto">
        {selectedLocation ? (
          /* ── Location Search Results Panel ── */
          <>
            <button
              onClick={clearLocationSearch}
              className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors self-start"
            >
              <ArrowLeft size={14} />
              Back to overview
            </button>

            <div className="bg-bg-card border border-border-card rounded-lg p-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-status-blue/10 border border-status-blue/20 flex items-center justify-center shrink-0">
                  <MapPin size={18} className="text-status-blue" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">
                    {selectedLocation.name}
                  </h3>
                  <p className="text-xs text-text-secondary mt-0.5 break-words">
                    {selectedLocation.fullName}
                  </p>
                  <p className="text-[10px] text-text-secondary/60 mt-1 font-mono">
                    {selectedLocation.lat.toFixed(5)},{" "}
                    {selectedLocation.lng.toFixed(5)}
                  </p>
                </div>
              </div>
            </div>

            {/* Nearby sensors */}
            <div className="bg-bg-card border border-border-card rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Radio size={14} />
                Nearby Sensors
              </h3>

              {closeSensors.length > 0 ? (
                <>
                  <p className="text-xs text-text-secondary mb-3">
                    <span className="text-status-green font-medium">
                      {closeSensors.length}
                    </span>{" "}
                    sensor{closeSensors.length !== 1 ? "s" : ""} within 10km
                  </p>
                  <div className="space-y-2">
                    {closeSensors.slice(0, 10).map((sensor) => {
                      const battV = sensor.battery_v ?? 0;
                      const battPct = Math.max(
                        0,
                        Math.min(100, ((battV - 2.8) / 1.4) * 100)
                      );
                      return (
                        <button
                          key={sensor.device_id}
                          onClick={() =>
                            setSelectedDevice(sensor.device_id)
                          }
                          className="w-full text-left p-2.5 bg-bg-primary rounded-lg hover:bg-bg-card-hover transition-colors border border-transparent hover:border-border-card"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <div
                                className={`w-2 h-2 rounded-full ${
                                  sensor.status === "alert"
                                    ? "bg-status-red"
                                    : sensor.status === "online"
                                      ? "bg-status-green"
                                      : "bg-gray-500"
                                }`}
                              />
                              <span className="text-sm font-medium">
                                {sensor.name || sensor.device_id}
                              </span>
                            </div>
                            <span className="text-xs text-status-blue font-medium">
                              {formatDistance(sensor.distance)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-text-secondary">
                            <span>
                              {sensor.neighborhood ?? "Unknown area"}
                            </span>
                            <span>
                              {battPct.toFixed(0)}% battery
                            </span>
                          </div>
                          {sensor.status === "alert" && (
                            <div className="mt-1 text-[10px] text-status-red font-medium flex items-center gap-1">
                              <AlertTriangle size={10} />
                              Active flood alert
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : nearbySensors.length > 0 ? (
                <div className="text-center py-4">
                  <Radio
                    size={24}
                    className="mx-auto mb-2 text-text-secondary opacity-30"
                  />
                  <p className="text-sm text-text-secondary">
                    No sensors within 10km
                  </p>
                  <p className="text-xs text-text-secondary/60 mt-1">
                    Nearest sensor is{" "}
                    <span className="text-status-blue font-medium">
                      {formatDistance(nearbySensors[0].distance)}
                    </span>{" "}
                    away
                    {nearbySensors[0].neighborhood &&
                      ` in ${nearbySensors[0].neighborhood}`}
                  </p>
                </div>
              ) : (
                <div className="text-center py-4">
                  <Radio
                    size={24}
                    className="mx-auto mb-2 text-text-secondary opacity-30"
                  />
                  <p className="text-sm text-text-secondary">
                    No sensors connected here
                  </p>
                </div>
              )}
            </div>

            {/* Area overview for nearby sensors */}
            {closeSensors.length > 0 && (() => {
              const alertCount = closeSensors.filter(
                (s) => s.status === "alert"
              ).length;
              const onlineCount = closeSensors.filter(
                (s) => s.status !== "offline"
              ).length;
              const neighborhoods = [
                ...new Set(
                  closeSensors
                    .map((s) => s.neighborhood)
                    .filter(Boolean)
                ),
              ];
              const nearbyFloods = activeEvents.filter((e) =>
                closeSensors.some((s) => s.device_id === e.device_id)
              );

              return (
                <div className="bg-bg-card border border-border-card rounded-lg p-4">
                  <h3 className="text-sm font-semibold mb-3">
                    Area Overview
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="bg-bg-primary rounded-lg p-2.5">
                      <p className="text-text-secondary">Online</p>
                      <p className="text-lg font-semibold text-status-green">
                        {onlineCount}
                        <span className="text-text-secondary text-xs font-normal">
                          /{closeSensors.length}
                        </span>
                      </p>
                    </div>
                    <div className="bg-bg-primary rounded-lg p-2.5">
                      <p className="text-text-secondary">Alerts</p>
                      <p
                        className={`text-lg font-semibold ${alertCount > 0 ? "text-status-red" : "text-status-green"}`}
                      >
                        {alertCount}
                      </p>
                    </div>
                    {neighborhoods.length > 0 && (
                      <div className="bg-bg-primary rounded-lg p-2.5 col-span-2">
                        <p className="text-text-secondary mb-1">
                          Neighborhoods
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {neighborhoods.map((n) => (
                            <span
                              key={n}
                              className="px-2 py-0.5 bg-bg-card rounded text-text-primary text-[11px]"
                            >
                              {n}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {nearbyFloods.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-border-card">
                      <p className="text-xs text-status-red font-medium mb-2">
                        {nearbyFloods.length} Active Flood
                        {nearbyFloods.length > 1 ? "s" : ""} Nearby
                      </p>
                      {nearbyFloods.map((event) => (
                        <div
                          key={event.id}
                          className="text-xs bg-status-red/10 border border-status-red/20 rounded p-2 mb-1.5 last:mb-0"
                        >
                          <div className="flex justify-between">
                            <span>{event.device_id}</span>
                            <span className="text-status-red font-medium">
                              {event.peak_depth_cm}cm
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Weather for reference */}
            {weather && (
              <div className="bg-bg-card border border-border-card rounded-lg p-3">
                <p className="text-xs text-text-secondary mb-2">
                  Current Weather (Golden Beach)
                </p>
                <div className="flex items-center gap-4 text-xs">
                  {weather.temperature != null && (
                    <span className="flex items-center gap-1">
                      <Thermometer size={11} className="text-status-amber" />
                      {weather.temperature}°F
                    </span>
                  )}
                  {weather.rainfallMm > 0 && (
                    <span className="flex items-center gap-1 text-status-amber">
                      <CloudRain size={11} />
                      {weather.rainfallMm}mm/hr
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Waves size={11} className="text-status-green" />
                    {weather.tideLevel?.toFixed(2) ?? "—"}m
                  </span>
                </div>
              </div>
            )}
          </>
        ) : (
          /* ── Normal Overview Sidebar ── */
          <>
            <h2 className="text-lg font-semibold">Live Overview</h2>

            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="Online"
                value={online}
                icon={<Radio size={16} />}
                color="text-status-green"
              />
              <StatCard
                label="Offline"
                value={offline}
                icon={<Radio size={16} />}
                color={
                  offline > 0 ? "text-status-red" : "text-text-secondary"
                }
              />
              <StatCard
                label="Active Floods"
                value={activeEvents.length}
                icon={<AlertTriangle size={16} />}
                color={
                  activeEvents.length > 0
                    ? "text-status-red"
                    : "text-status-green"
                }
              />
              <StatCard
                label="Avg Battery"
                value={`${avgBattery}V`}
                icon={<Battery size={16} />}
              />
            </div>

            {/* Weather panel */}
            {weather && (
              <div className="bg-bg-card border border-border-card rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <CloudRain size={14} /> Current Weather
                </h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Thermometer size={12} className="text-status-amber" />
                    <span>
                      {weather.temperature != null
                        ? `${weather.temperature}°F`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Droplets size={12} className="text-status-blue" />
                    <span>
                      {weather.humidity != null
                        ? `${weather.humidity}%`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CloudRain size={12} className="text-status-blue" />
                    <span
                      className={
                        weather.rainfallMm > 0
                          ? "text-status-amber font-medium"
                          : ""
                      }
                    >
                      {weather.rainfallMm > 0
                        ? `${weather.rainfallMm}mm/hr`
                        : "No rain"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Waves size={12} className="text-status-green" />
                    <span
                      className={
                        (weather.tideLevel ?? 0) > 0.3
                          ? "text-status-amber font-medium"
                          : ""
                      }
                    >
                      {weather.tideLevel != null
                        ? `${weather.tideLevel.toFixed(2)}m`
                        : "—"}
                    </span>
                  </div>
                  {weather.windSpeed != null && (
                    <div className="flex items-center gap-2 col-span-2">
                      <Wind size={12} className="text-text-secondary" />
                      <span>{weather.windSpeed} mph</span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-text-secondary mt-2">
                  {weather.description}
                </p>

                {/* Tide forecast sparkline */}
                {weather.tideForecast &&
                  weather.tideForecast.length > 2 &&
                  (() => {
                    const levels = weather.tideForecast.map((t) => t.level);
                    const min = Math.min(...levels);
                    const max = Math.max(...levels);
                    const range = max - min || 1;
                    const w = 260,
                      h = 32;
                    const points = levels
                      .map((v, i) => {
                        const x = (i / (levels.length - 1)) * w;
                        const y =
                          h - ((v - min) / range) * (h - 4) - 2;
                        return `${x},${y}`;
                      })
                      .join(" ");
                    const peakTide = Math.max(...levels);
                    return (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                          <span>24h Tide Forecast</span>
                          <span>Peak: {peakTide.toFixed(2)}m</span>
                        </div>
                        <svg width={w} height={h} className="w-full">
                          {peakTide > 0.3 && (
                            <line
                              x1="0"
                              y1={
                                h -
                                ((0.3 - min) / range) * (h - 4) -
                                2
                              }
                              x2={w}
                              y2={
                                h -
                                ((0.3 - min) / range) * (h - 4) -
                                2
                              }
                              stroke="#f87171"
                              strokeWidth="0.5"
                              strokeDasharray="3 3"
                              opacity={0.5}
                            />
                          )}
                          <polyline
                            points={points}
                            fill="none"
                            stroke="#34d399"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    );
                  })()}

                {/* Forecast summary */}
                {weather.forecast && weather.forecast.length > 0 && (
                  <div className="mt-3 border-t border-border-card pt-2">
                    <p className="text-xs text-text-secondary mb-1.5">
                      Forecast
                    </p>
                    <div className="space-y-1">
                      {weather.forecast.slice(0, 3).map((f, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-text-secondary truncate max-w-[140px]">
                            {f.name}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-text-primary">
                              {f.shortForecast.length > 18
                                ? f.shortForecast.slice(0, 18) + "..."
                                : f.shortForecast}
                            </span>
                            {f.rainChance != null && f.rainChance > 0 && (
                              <span
                                className={`font-medium ${f.rainChance > 50 ? "text-status-red" : f.rainChance > 30 ? "text-status-amber" : "text-status-blue"}`}
                              >
                                {f.rainChance}%
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Rain alert */}
                {rainForecast && (
                  <div className="mt-3 p-2 bg-status-amber/10 border border-status-amber/20 rounded text-xs">
                    <span className="text-status-amber font-medium">
                      Rain expected:{" "}
                    </span>
                    <span className="text-text-secondary">
                      {rainForecast.name} — {rainForecast.shortForecast} (
                      {rainForecast.rainChance}% chance)
                    </span>
                  </div>
                )}

                {/* Compound event warning */}
                {rainForecast &&
                  weather.tideForecast &&
                  Math.max(
                    ...weather.tideForecast.map((t) => t.level)
                  ) > 0.3 && (
                    <div className="mt-2 p-2 bg-status-red/10 border border-status-red/20 rounded text-xs">
                      <span className="text-status-red font-medium">
                        Compound flood risk:{" "}
                      </span>
                      <span className="text-text-secondary">
                        Rain + high tide expected simultaneously — storm
                        drains may not discharge
                      </span>
                    </div>
                  )}
              </div>
            )}

            {/* Active flood events */}
            {activeEvents.length > 0 && (
              <div className="bg-bg-card border border-border-card rounded-lg p-4">
                <h3 className="text-sm font-semibold text-status-red mb-3">
                  Active Flood Events
                </h3>
                <div className="space-y-2">
                  {activeEvents.map((event) => (
                    <button
                      key={event.id}
                      onClick={() => setSelectedDevice(event.device_id)}
                      className="w-full text-left bg-status-red/10 border border-status-red/20 rounded p-2 hover:bg-status-red/20 transition-colors"
                    >
                      <div className="flex justify-between text-sm">
                        <span className="font-medium">
                          {event.device_id}
                        </span>
                        <span className="text-status-red">
                          {event.peak_depth_cm}cm
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary mt-0.5">
                        Started{" "}
                        {new Date(event.started_at).toLocaleTimeString()}
                        {event.devices?.neighborhood &&
                          ` — ${event.devices.neighborhood}`}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Neighborhood quick status */}
            {devices.length > 0 &&
              (() => {
                const nData: Record<
                  string,
                  { total: number; alerting: number; offline: number }
                > = {};
                devices.forEach((d) => {
                  const n = d.neighborhood ?? "Other";
                  if (!nData[n])
                    nData[n] = { total: 0, alerting: 0, offline: 0 };
                  nData[n].total++;
                  if (d.status === "alert") nData[n].alerting++;
                  if (d.status === "offline") nData[n].offline++;
                });
                const areas = Object.entries(nData).sort(
                  (a, b) => b[1].alerting - a[1].alerting
                );
                if (areas.length === 0) return null;
                return (
                  <div className="bg-bg-card border border-border-card rounded-lg p-4">
                    <h3 className="text-sm font-semibold mb-3">
                      Neighborhoods
                    </h3>
                    <div className="space-y-2">
                      {areas.slice(0, 6).map(([name, data]) => (
                        <div
                          key={name}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-text-secondary truncate max-w-[140px]">
                            {name}
                          </span>
                          <div className="flex items-center gap-2">
                            {data.alerting > 0 && (
                              <span className="text-status-red font-medium">
                                {data.alerting} alert
                              </span>
                            )}
                            <span className="text-text-secondary">
                              {data.total - data.offline}/{data.total}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

            {/* Network health */}
            {devices.length > 0 &&
              (() => {
                const staleCount = devices.filter((d) => {
                  if (!d.last_seen) return true;
                  return (
                    Date.now() - new Date(d.last_seen).getTime() >
                    2 * 3600 * 1000
                  );
                }).length;
                const healthPct = Math.round(
                  ((devices.length - staleCount) / devices.length) * 100
                );
                return (
                  <div className="bg-bg-card border border-border-card rounded-lg p-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text-secondary">
                        Network Health
                      </span>
                      <span
                        className={
                          healthPct > 90
                            ? "text-status-green"
                            : healthPct > 70
                              ? "text-status-amber"
                              : "text-status-red"
                        }
                      >
                        {healthPct}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-bg-primary rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${healthPct > 90 ? "bg-status-green" : healthPct > 70 ? "bg-status-amber" : "bg-status-red"}`}
                        style={{ width: `${healthPct}%` }}
                      />
                    </div>
                    {staleCount > 0 && (
                      <p className="text-[10px] text-text-secondary mt-1">
                        {staleCount} sensor{staleCount > 1 ? "s" : ""}{" "}
                        offline &gt;2h
                      </p>
                    )}
                  </div>
                );
              })()}

            {/* Data freshness */}
            {devices.length > 0 &&
              (() => {
                const now = Date.now();
                const within1h = devices.filter(
                  (d) =>
                    d.last_seen &&
                    now - new Date(d.last_seen).getTime() < 3600000
                ).length;
                const within10m = devices.filter(
                  (d) =>
                    d.last_seen &&
                    now - new Date(d.last_seen).getTime() < 600000
                ).length;
                return (
                  <div className="bg-bg-card border border-border-card rounded-lg p-3">
                    <p className="text-xs text-text-secondary mb-1.5">
                      Data Freshness
                    </p>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-text-secondary">
                        Last 10 min
                      </span>
                      <span className="text-status-green font-medium">
                        {within10m}/{devices.length}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs mt-1">
                      <span className="text-text-secondary">
                        Last 1 hour
                      </span>
                      <span
                        className={`font-medium ${within1h === devices.length ? "text-status-green" : "text-status-amber"}`}
                      >
                        {within1h}/{devices.length}
                      </span>
                    </div>
                  </div>
                );
              })()}

            <div className="flex items-center gap-2 text-xs text-text-secondary mt-auto">
              <Clock size={12} />
              Updated {lastUpdated.toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-[calc(100vh-48px)]">
          <Loader2
            size={32}
            className="animate-spin text-status-blue"
          />
        </div>
      }
    >
      <OverviewContent />
    </Suspense>
  );
}
