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

module.exports = { getRainfall, getTideLevel };
