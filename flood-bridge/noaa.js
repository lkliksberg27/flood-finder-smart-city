const https = require('https');

// Simple in-memory cache with 10-minute TTL
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
  cache.delete(key);
  return null;
}

function setCache(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FloodFinder/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Bad JSON from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Fetch latest rainfall from nearest NOAA weather station.
 * Returns { rainfallMm, stationName, observedAt } or null on failure.
 */
async function getRainfall(lat, lng) {
  const cacheKey = `rain-${lat.toFixed(2)}-${lng.toFixed(2)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const points = await fetchJSON(`https://api.weather.gov/points/${lat},${lng}`);
    const stationUrl = points.properties.observationStations;
    const stations = await fetchJSON(stationUrl);
    const stationId = stations.features[0].properties.stationIdentifier;
    const stationName = stations.features[0].properties.name;

    const obs = await fetchJSON(
      `https://api.weather.gov/stations/${stationId}/observations/latest`
    );

    const precip = obs.properties.precipitationLastHour;
    const rainfallMm = precip && precip.value != null ? precip.value : 0;
    const observedAt = obs.properties.timestamp;

    const result = { rainfallMm, stationName, observedAt };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[NOAA] Rainfall fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch latest tide level from nearest NOAA CO-OPS station.
 * Returns { tideM, stationName, observedAt } or null on failure.
 */
async function getTideLevel(lat, lng) {
  const cacheKey = `tide-${lat.toFixed(2)}-${lng.toFixed(2)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    // Virginia Key, FL station — closest CO-OPS station to Aventura
    const stationId = '8723214';
    const stationName = 'Virginia Key, Biscayne Bay, FL';

    const now = new Date();
    const end = now.toISOString().slice(0, 10).replace(/-/g, '');
    const begin = new Date(now - 2 * 3600 * 1000)
      .toISOString().slice(0, 10).replace(/-/g, '');

    const url =
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?begin_date=${begin}&end_date=${end}` +
      `&station=${stationId}&product=water_level&datum=NAVD` +
      `&units=metric&time_zone=gmt&format=json`;

    const data = await fetchJSON(url);
    if (!data.data || data.data.length === 0) return null;

    const latest = data.data[data.data.length - 1];
    const result = {
      tideM: parseFloat(latest.v),
      stationName,
      observedAt: latest.t,
    };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[NOAA] Tide fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch current weather conditions + forecast for the area.
 * Returns full weather context for the dashboard and AI analysis.
 */
async function getWeatherConditions(lat, lng) {
  const cacheKey = `weather-${lat.toFixed(2)}-${lng.toFixed(2)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const points = await fetchJSON(`https://api.weather.gov/points/${lat},${lng}`);
    const stationUrl = points.properties.observationStations;
    const forecastUrl = points.properties.forecast;

    const [stations, forecast] = await Promise.all([
      fetchJSON(stationUrl),
      fetchJSON(forecastUrl).catch(() => null),
    ]);

    const stationId = stations.features[0].properties.stationIdentifier;
    const stationName = stations.features[0].properties.name;

    const obs = await fetchJSON(
      `https://api.weather.gov/stations/${stationId}/observations/latest`
    );

    const props = obs.properties;
    const precip = props.precipitationLastHour;

    // Extract forecast periods that mention rain
    let forecastPeriods = [];
    if (forecast?.properties?.periods) {
      forecastPeriods = forecast.properties.periods.slice(0, 6).map((p) => ({
        name: p.name,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        shortForecast: p.shortForecast,
        detailedForecast: p.detailedForecast,
        probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
      }));
    }

    const result = {
      stationName,
      observedAt: props.timestamp,
      temperature: props.temperature?.value != null
        ? Math.round(props.temperature.value * 9/5 + 32) : null,
      humidity: props.relativeHumidity?.value != null
        ? Math.round(props.relativeHumidity.value) : null,
      windSpeed: props.windSpeed?.value != null
        ? Math.round(props.windSpeed.value * 0.621371) : null, // km/h to mph
      windDirection: props.windDirection?.value ?? null,
      pressure: props.barometricPressure?.value != null
        ? Math.round(props.barometricPressure.value / 100) : null, // Pa to hPa
      rainfallMm: precip && precip.value != null ? precip.value : 0,
      description: props.textDescription ?? '',
      forecast: forecastPeriods,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[NOAA] Weather fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch tide predictions (next 24h) to identify flood risk windows.
 * Returns array of { time, predictedLevel } or null on failure.
 */
async function getTideForecast() {
  const cacheKey = 'tide-forecast';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const stationId = '8723214';
    const now = new Date();
    const begin = now.toISOString().slice(0, 10).replace(/-/g, '');
    const end = new Date(now.getTime() + 24 * 3600 * 1000)
      .toISOString().slice(0, 10).replace(/-/g, '');

    const url =
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?begin_date=${begin}&end_date=${end}` +
      `&station=${stationId}&product=predictions&datum=NAVD` +
      `&units=metric&time_zone=gmt&format=json&interval=h`;

    const data = await fetchJSON(url);
    if (!data.predictions || data.predictions.length === 0) return null;

    const result = data.predictions.map((p) => ({
      time: p.t,
      level: parseFloat(p.v),
    }));

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error('[NOAA] Tide forecast fetch failed:', err.message);
    return null;
  }
}

module.exports = { getRainfall, getTideLevel, getWeatherConditions, getTideForecast };
