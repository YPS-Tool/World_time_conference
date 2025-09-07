#!/usr/bin/env node
/**
 * Build dataset from Natural Earth 1:50m Populated Places (Public Domain)
 * Input: data/ne/ne_50m_populated_places.geojson
 * Output: data/city-timezones.json (merged with existing curated entries)
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'ne', 'ne_50m_populated_places.geojson');
const OUT = path.join(__dirname, '..', 'data', 'city-timezones.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function slug(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k); out.push(x);
  }
  return out;
}

function buildFromNE(features) {
  // Group features per country
  const groups = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const country = p.ADM0NAME || 'Unknown';
    if (!groups.has(country)) groups.set(country, []);
    groups.get(country).push(f);
  }

  const all = [];
  for (const [country, arr] of groups) {
    // Use only cities that have timezone info
    const withTz = arr.filter(f => !!(f.properties && f.properties.TIMEZONE));
    // Ensure capital first if present
    const capital = withTz.find(f => Number(f.properties.ADM0CAP) === 1) || null;
    const others = withTz
      .filter(f => f !== capital)
      .sort((a, b) => (b.properties.POP_MAX || 0) - (a.properties.POP_MAX || 0));
    const target = 12; // 10±2
    const pick = [];
    if (capital) pick.push(capital);
    for (const f of others) { if (pick.length >= target) break; pick.push(f); }
    for (const f of pick) {
      const p = f.properties;
      const cityEn = p.NAME_EN || p.NAMEASCII || p.NAME;
      if (!cityEn) continue;
      const countryEn = p.ADM0NAME || '';
      const iso2 = (p.ISO_A2 || '').toLowerCase();
      const id = slug(`${cityEn}-${iso2 || countryEn}`);
      const item = {
        id,
        tzId: p.TIMEZONE,
        city_ja: p.NAME_JA || cityEn,
        city_en: cityEn,
        country_ja: countryEn, // if Japanese country names are needed, a map can be added later
        country_en: countryEn,
        aliases: uniqBy([
          p.NAME,
          p.NAMEASCII,
          p.MEGANAME,
          p.LS_NAME,
          p.NAME_EN,
          p.NAME_ZHT,
          p.NAME_ZH,
          iso2?.toUpperCase(),
          p.ADM1NAME,
        ].filter(Boolean), x => String(x).toLowerCase()),
        lat: p.LATITUDE,
        lon: p.LONGITUDE,
        source: 'NE50',
      };
      all.push(item);
    }
  }
  return all;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing source:', SRC);
    process.exit(1);
  }
  const geo = readJson(SRC);
  const neItems = buildFromNE(geo.features || []);
  // Merge with existing curated dataset if present
  let curated = [];
  if (fs.existsSync(OUT)) {
    try { curated = readJson(OUT); if (!Array.isArray(curated)) curated = []; } catch { curated = []; }
  }
  const all = [...curated.filter(x => x && x.id), ...neItems];
  const deduped = uniqBy(all, x => x.id);
  // Drop lat/lon/source fields before write to keep same schema
  const final = deduped.map(({ id, tzId, city_ja, city_en, country_ja, country_en, aliases }) => ({ id, tzId, city_ja, city_en, country_ja, country_en, aliases }));
  writeJson(OUT, final);
  console.log('Wrote', OUT, 'items:', final.length);
}

if (require.main === module) main();

