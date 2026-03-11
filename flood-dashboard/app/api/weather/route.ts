import { NextResponse } from "next/server";

const CACHE_TTL_MS = 10 * 60 * 1000;
let weatherCache: { data: WeatherData; ts: number } | null = null;

interface ForecastPeriod {
  name: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  shortForecast: string;
  detailedForecast: string;
  probabilityOfPrecipitation: { value: number | null } | null;
}

interface WeatherData {
  stationName: string;
  observedAt: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  rainfallMm: number;
  description: string;
  forecast: {
    name: string;
    temperature: number;
    shortForecast: string;
    rainChance: number | null;
  }[];
  tideLevel: number | null;
  tideStation: string;
  tideForecast: { time: string; level: number }[];
}

async function fetchJSON(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { "User-Agent": "FloodFinder/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchWeather(): Promise<WeatherData> {
  // Golden Beach, FL center coordinates
  const lat = 25.9670, lng = -80.1205;

  // Get weather station + forecast in parallel
  const points = await fetchJSON(`https://api.weather.gov/points/${lat},${lng}`) as {
    properties: { observationStations: string; forecast: string };
  };

  const [stationsData, forecastData] = await Promise.all([
    fetchJSON(points.properties.observationStations) as Promise<{
      features: { properties: { stationIdentifier: string; name: string } }[];
    }>,
    fetchJSON(points.properties.forecast).catch(() => null) as Promise<{
      properties: { periods: ForecastPeriod[] };
    } | null>,
  ]);

  const stationId = stationsData.features[0].properties.stationIdentifier;
  const stationName = stationsData.features[0].properties.name;

  // Get current observation + tide in parallel
  const [obsData, tideData, tideForecastData] = await Promise.all([
    fetchJSON(`https://api.weather.gov/stations/${stationId}/observations/latest`) as Promise<{
      properties: {
        timestamp: string;
        temperature: { value: number | null };
        relativeHumidity: { value: number | null };
        windSpeed: { value: number | null };
        precipitationLastHour: { value: number | null };
        textDescription: string;
      };
    }>,
    fetchTide().catch(() => null),
    fetchTideForecast().catch(() => null),
  ]);

  const props = obsData.properties;

  const forecast = forecastData?.properties?.periods?.slice(0, 6).map((p: ForecastPeriod) => ({
    name: p.name,
    temperature: p.temperature,
    shortForecast: p.shortForecast,
    rainChance: p.probabilityOfPrecipitation?.value ?? null,
  })) ?? [];

  return {
    stationName,
    observedAt: props.timestamp,
    temperature: props.temperature?.value != null
      ? Math.round(props.temperature.value * 9 / 5 + 32) : null,
    humidity: props.relativeHumidity?.value != null
      ? Math.round(props.relativeHumidity.value) : null,
    windSpeed: props.windSpeed?.value != null
      ? Math.round(props.windSpeed.value * 0.621371) : null,
    rainfallMm: props.precipitationLastHour?.value ?? 0,
    description: props.textDescription ?? "",
    forecast,
    tideLevel: tideData?.tideM ?? null,
    tideStation: "Virginia Key, Biscayne Bay",
    tideForecast: tideForecastData ?? [],
  };
}

async function fetchTide(): Promise<{ tideM: number; stationName: string }> {
  const stationId = "8723214";
  const now = new Date();
  const end = now.toISOString().slice(0, 10).replace(/-/g, "");
  const begin = new Date(now.getTime() - 2 * 3600 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, "");

  const data = await fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${begin}&end_date=${end}` +
    `&station=${stationId}&product=water_level&datum=NAVD` +
    `&units=metric&time_zone=gmt&format=json`
  ) as { data: { v: string; t: string }[] };

  const latest = data.data[data.data.length - 1];
  return { tideM: parseFloat(latest.v), stationName: "Virginia Key" };
}

async function fetchTideForecast(): Promise<{ time: string; level: number }[]> {
  const stationId = "8723214";
  const now = new Date();
  const begin = now.toISOString().slice(0, 10).replace(/-/g, "");
  const end = new Date(now.getTime() + 24 * 3600 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, "");

  const data = await fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${begin}&end_date=${end}` +
    `&station=${stationId}&product=predictions&datum=NAVD` +
    `&units=metric&time_zone=gmt&format=json&interval=h`
  ) as { predictions: { t: string; v: string }[] };

  return (data.predictions ?? []).map((p) => ({
    time: p.t,
    level: parseFloat(p.v),
  }));
}

export async function GET() {
  try {
    if (weatherCache && Date.now() - weatherCache.ts < CACHE_TTL_MS) {
      return NextResponse.json(weatherCache.data);
    }
    const data = await fetchWeather();
    weatherCache = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[API] Weather fetch error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
