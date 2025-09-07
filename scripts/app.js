/* World Time Tool - Vanilla JS implementation
 * - Cities management (add/search/reorder/delete, persist)
 * - Candidates with 1-day grid, selection, output
 * - Settings: granularity 15/30/60, persist
 * - URL params: cities, from, to
 * - Timezone-safe using Intl APIs (no external libs)
 */

(() => {
  const KEYS = {
    cities: 'wt-cities',
    view: 'wt-view',
    blocks: 'wt-blocks',
  };

  const MAX_BLOCKS = 5;
  const DEFAULT_VIEW = { granularity: 60 };
  const DAY_MIN = 1440;

  const els = {};
  const state = {
    dataset: [],
    cities: [],
    view: { ...DEFAULT_VIEW },
    blocks: [],
    currentTZ: null,
  };

  // ---------- Utilities ----------
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const jpWeekdays = ['日', '月', '火', '水', '木', '金', '土'];

  function formatJPDateParts(parts) {
    // parts: {year, month, day, weekday}
    return `${parts.month}月${parts.day}日(${jpWeekdays[parts.weekday]})`;
  }
  function formatTimeHHmm(parts) {
    return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  }

  function parseISOToMs(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }

  function getDTF(tz) {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    });
  }

  function partsFromTs(ts, tz) {
    const parts = getDTF(tz).formatToParts(new Date(ts));
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    // weekday short like "(金)" or Japanese short; we compute weekday from UTC easily:
    // We'll derive using toLocaleString in that tz but easier: generate Date from parts: but not necessary
    const year = Number(m.year);
    const month = Number(m.month);
    const day = Number(m.day);
    const hour = Number(m.hour);
    const minute = Number(m.minute);
    const second = Number(m.second);
    // Compute weekday by creating a Date from asUTC and using getUTCDay
    const asUTC = Date.UTC(year, month - 1, day, hour, minute, second);
    const weekday = new Date(asUTC).getUTCDay();
    return { year, month, day, hour, minute, second, weekday };
  }

  function tzOffsetMinutes(ts, tz) {
    // Offset = local(asUTC) - UTC in minutes
    const p = partsFromTs(ts, tz);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUTC - ts) / 60000;
  }

  function tzOffsetLabel(ts, tz) {
    const off = tzOffsetMinutes(ts, tz); // minutes
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    const hh = Math.floor(abs / 60);
    const mm = Math.floor(abs % 60);
    return `UTC${sign}${pad2(hh)}:${pad2(mm)}`;
  }

  function zonedMidnightUtcMs(dateObj, tz) {
    // Find UTC timestamp whose formatting in tz is exactly Y-M-D 00:00:00.
    // Robust implementation using a bounded minute-scan around the target day.
    const DAY_MS = 24 * 3600 * 1000;
    const center = Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day, 12, 0, 0);
    const start = center - 36 * 3600 * 1000; // -36h window
    const end = center + 36 * 3600 * 1000;   // +36h window
    for (let ts = start; ts <= end; ts += 60000) {
      const p = partsFromTs(ts, tz);
      if (p.year === dateObj.year && p.month === dateObj.month && p.day === dateObj.day && p.hour === 0 && p.minute === 0) {
        return ts;
      }
    }
    // Fallback: if not found (shouldn't happen), approximate via offset method
    const guess = Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day, 0, 0, 0);
    return guess - tzOffsetMinutes(guess, tz) * 60000;
  }

  function formatJP(ts, tz) {
    const p = partsFromTs(ts, tz);
    return `${p.month}月${p.day}日(${jpWeekdays[p.weekday]}) ${pad2(p.hour)}:${pad2(p.minute)}`;
  }

  function sameLocalDay(tsA, tsB, tz) {
    const a = partsFromTs(tsA, tz);
    const b = partsFromTs(tsB, tz);
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }

  function cityLabelJA(city) {
    return city.city_ja ? `${city.city_ja}（${city.country_ja || ''}）` : city.tzId;
  }

  function tzSuffix(tzId) {
    const s = tzId.split('/').pop() || tzId;
    return s.replaceAll('_', ' ');
  }

  // ---------- Persistence ----------
  function loadPersisted() {
    try {
      const v = JSON.parse(localStorage.getItem(KEYS.view) || 'null');
      if (v && (v.granularity === 15 || v.granularity === 30 || v.granularity === 60)) state.view = v;
    } catch {}
    try {
      const c = JSON.parse(localStorage.getItem(KEYS.cities) || '[]');
      if (Array.isArray(c)) state.cities = c;
    } catch {}
    try {
      const b = JSON.parse(localStorage.getItem(KEYS.blocks) || '[]');
      if (Array.isArray(b)) state.blocks = b;
    } catch {}
  }
  const saveView = () => localStorage.setItem(KEYS.view, JSON.stringify(state.view));
  const saveCities = () => localStorage.setItem(KEYS.cities, JSON.stringify(state.cities));
  const saveBlocks = () => localStorage.setItem(KEYS.blocks, JSON.stringify(state.blocks));

  // ---------- Dataset & current TZ ----------
  async function loadDataset() {
    state.dataset = [];
    // Try HTTP fetch first
    try {
      const res = await fetch('data/city-timezones.json', { cache: 'no-cache' });
      if (res.ok) {
        const arr = await res.json();
        if (Array.isArray(arr) && arr.length) {
          state.dataset = arr.map(x => ({ ...x, isCurated: true }));
        }
      }
    } catch (e) {
      console.warn('Failed to load dataset via fetch', e);
    }
    // Fallback to embedded dataset (works on file://)
    if (!state.dataset.length) {
      try {
        const el = document.getElementById('city-dataset');
        if (el && el.textContent) {
          const json = JSON.parse(el.textContent);
          const arr = Array.isArray(json?.cities) ? json.cities : [];
          state.dataset = arr.map(x => ({ ...x, isCurated: true }));
          console.info('Loaded embedded dataset fallback:', state.dataset.length);
        }
      } catch (e) { console.warn('Failed to parse embedded dataset', e); }
    }
    // Augment with the full IANA timezone list so we have 300+ candidates
    try { augmentWithIanaTimezones(); } catch (e) { console.warn('augmentWithIanaTimezones failed', e); }
    // Build search index once dataset is ready
    try { buildSearchIndex(); } catch (e) { console.warn('buildSearchIndex failed', e); }
  }

  function detectCurrentTZ() {
    try {
      state.currentTZ = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      state.currentTZ = null;
    }
  }

  function datasetById(id) {
    return state.dataset.find(x => x.id === id);
  }
  function datasetByTz(tz) {
    return state.dataset.find(x => x.tzId === tz);
  }

  function augmentWithIanaTimezones() {
    if (!(Intl && typeof Intl.supportedValuesOf === 'function')) return;
    const tzs = Intl.supportedValuesOf('timeZone');
    if (!Array.isArray(tzs) || tzs.length === 0) return;
    const existing = new Set(state.dataset.map(x => x.tzId));
    const added = [];
    for (const tz of tzs) {
      if (existing.has(tz)) continue;
      const parts = tz.split('/');
      const city = (parts[parts.length - 1] || tz).replaceAll('_', ' ');
      const region = (parts.length > 1 ? parts[0] : '').replaceAll('_', ' ');
      const id = 'tz-' + tz.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      added.push({
        id,
        tzId: tz,
        city_ja: city, // 日本語未整備: 代表名として都市名（英語）を表示
        city_en: city,
        country_ja: region,
        country_en: region,
        aliases: parts,
        isCurated: false,
      });
    }
    if (added.length) {
      state.dataset.push(...added);
      // console.info(`Augmented dataset with ${added.length} IANA zones`);
    }
  }

  // ------ Multilingual search index ------
  // Normalize to ASCII-friendly base (diacritics removed, spacing unified)
  function normalize(str) {
    return (str || '')
      .toString()
      .normalize('NFKC')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-') // dashes
      .replace(/[\u3000]/g, ' ') // ideographic space -> normal space
      .replace(/[_\s]+/g, ' ') // unify separators
      .trim();
  }

  // Convert katakana -> hiragana (keep hiragana), drop prolonged sound mark
  function toHiragana(s) {
    let out = '';
    for (const ch of (s || '')) {
      const code = ch.codePointAt(0);
      if (code >= 0x30A1 && code <= 0x30F6) {
        out += String.fromCodePoint(code - 0x60); // カタカナ -> ひらがな
      } else if (ch === 'ー') {
        // Skip long sound mark for lenient matching
      } else {
        out += ch;
      }
    }
    return out;
  }
  function normalizeKana(str) {
    return normalize(toHiragana(str))
      .replace(/[\u3099\u309A]/g, '') // remove combining marks for kana
      .replace(/[^\p{sc=Hiragana}a-z0-9\s/-]+/giu, ' ') // strip symbols but keep ascii for mix
      .replace(/\s+/g, ' ') // collapse spaces
      .trim();
  }

  function hasKana(s) { return /[\u3041-\u3096\u30A1-\u30FA]/.test(s || ''); }

  function tokenize(q) {
    const n = normalize(q);
    if (!n) return [];
    return n.split(/\s+/).filter(Boolean);
  }

  // Lightweight Levenshtein for fuzzy matching small tokens
  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n; if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = i - 1;
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(
          dp[j] + 1,        // deletion
          dp[j - 1] + 1,    // insertion
          prev + cost       // substitution
        );
        prev = tmp;
      }
    }
    return dp[n];
  }

  // Build per-item search index for fast matching
  function buildIndexForItem(it) {
    const fields = [it.city_ja, it.city_en, it.country_ja, it.country_en, it.tzId, ...(it.aliases || [])];
    const base = normalize(fields.join(' '));
    const kana = normalizeKana(fields.join(' '));
    // Token sets for fuzzy
    const baseTokens = new Set(base.split(/\s+|\//g).filter(Boolean));
    const kanaTokens = new Set(kana.split(/\s+|\//g).filter(Boolean));
    return { base, kana, baseTokens, kanaTokens };
  }

  let searchIndex = null; // Map id -> index
  function buildSearchIndex() {
    searchIndex = new Map();
    for (const it of state.dataset) searchIndex.set(it.id, buildIndexForItem(it));
  }

  function scoreItem(it, tokens, kanaTokens) {
    if (!searchIndex) buildSearchIndex();
    const idx = searchIndex.get(it.id);
    if (!idx) return 0;
    let score = 0;
    for (const t of tokens) {
      // Strong priority on city/country prefix matches (base)
      if (idx.base.startsWith(t)) score += 15;
      if (idx.baseTokens.has(t)) score += 12;
      if (idx.base.includes(' ' + t)) score += 10; else if (idx.base.includes(t)) score += 6;
    }
    for (const kt of kanaTokens) {
      if (!kt) continue;
      if (idx.kana.startsWith(kt)) score += 14;
      if (idx.kanaTokens.has(kt)) score += 11;
      if (idx.kana.includes(' ' + kt)) score += 9; else if (idx.kana.includes(kt)) score += 5;
    }
    // Fuzzy boost for short tokens when nothing else matched well
    if (score < 10) {
      const candidates = Array.from(idx.baseTokens).filter(w => w.length >= 3 && w.length <= 12);
      for (const t of tokens) {
        let best = Infinity;
        for (const w of candidates) {
          const d = levenshtein(t, w);
          if (d < best) best = d;
        }
        if (best <= 1) score += 6; else if (best === 2) score += 3;
      }
    }
    if (it.isCurated) score += 3; // curated boost
    return score;
  }

  // ---------- Cities UI ----------
  function renderCurrentTZReco() {
    const box = document.getElementById('current-tz-reco');
    box.innerHTML = '';
    if (!state.currentTZ) { box.classList.add('hidden'); return; }
    const already = state.cities.some(c => c.tzId === state.currentTZ);
    if (already) { box.classList.add('hidden'); return; }
    const rep = datasetByTz(state.currentTZ);
    const label = rep ? `${rep.city_ja}（${rep.country_ja}）` : tzSuffix(state.currentTZ);
    const p = document.createElement('div');
    p.className = 'reco';
    p.innerHTML = `
      <div class="reco-title">現在地タイムゾーンを追加: <span class="pill">${state.currentTZ}</span></div>
      <div class="small-muted">代表表示: ${label}</div>
      <div class="reco-actions" style="margin-top:8px;">
        <button class="btn btn-primary" id="btn-add-current">追加</button>
      </div>
    `;
    box.replaceWith(p);
    p.id = 'current-tz-reco';
    p.querySelector('#btn-add-current').addEventListener('click', () => {
      const city = rep ? { ...rep } : { id: 'current', tzId: state.currentTZ, city_ja: '現在地', city_en: 'Current Location', country_ja: '', country_en: '', aliases: [], isCurrent: true };
      addCity(city);
    });
  }

  function addCity(city) {
    if (state.cities.some(c => c.id === city.id)) return;
    // keep only fields we need
    const c = { id: city.id, tzId: city.tzId, city_ja: city.city_ja, city_en: city.city_en, country_ja: city.country_ja, country_en: city.country_en, aliases: city.aliases || [], isCurrent: !!city.isCurrent };
    state.cities.push(c);
    saveCities();
    ensureAtLeastOneBlock();
    render();
  }

  function removeCity(id) {
    state.cities = state.cities.filter(c => c.id !== id);
    saveCities();
    render();
  }

  function renderCityList() {
    const ul = document.getElementById('city-list');
    ul.innerHTML = '';
    if (state.cities.length === 0) {
      const li = document.createElement('li');
      li.className = 'small-muted';
      li.textContent = '都市がまだありません。右上の「都市を追加」から検索してください。';
      ul.appendChild(li);
    }
    const nowTs = Date.now();
    state.cities.forEach((c, idx) => {
      const li = document.createElement('li');
      li.className = 'city-item';
      li.draggable = true;
      li.dataset.id = c.id;
      li.innerHTML = `
        <div>
          <div class="city-title">${c.city_ja || tzSuffix(c.tzId)}<span class="small-muted"> ${c.country_ja || ''}</span></div>
          <div class="city-sub"><span class="utc">${tzOffsetLabel(nowTs, c.tzId)}</span> ・ <span class="clock" data-tz="${c.tzId}"></span></div>
        </div>
        <div class="city-actions">
          <span class="pill">${c.tzId}</span>
          <button class="btn btn-surface btn-del">削除</button>
        </div>
      `;
      li.querySelector('.btn-del').addEventListener('click', () => removeCity(c.id));
      ul.appendChild(li);
      // drag events
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.id); });
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const srcId = e.dataTransfer.getData('text/plain');
        const srcIdx = state.cities.findIndex(x => x.id === srcId);
        const dstIdx = idx;
        if (srcIdx >= 0 && dstIdx >= 0 && srcIdx !== dstIdx) {
          const [moved] = state.cities.splice(srcIdx, 1);
          state.cities.splice(dstIdx, 0, moved);
          saveCities();
          render();
        }
      });
    });
    // live clocks
    updateClocks();
  }

  function updateClocks() {
    const nodes = document.querySelectorAll('.clock');
    nodes.forEach(n => {
      const tz = n.dataset.tz;
      const p = partsFromTs(Date.now(), tz);
      n.textContent = `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}  ${p.month}/${p.day}`;
    });
  }

  // ---------- Blocks (candidates) ----------
  function ensureAtLeastOneBlock() {
    if (state.blocks.length === 0) {
      const topTz = (state.cities[0]?.tzId) || 'UTC';
      const nowParts = partsFromTs(Date.now(), topTz);
      state.blocks.push({ id: uid(), name: '候補1', date: { year: nowParts.year, month: nowParts.month, day: nowParts.day }, selection: null });
      saveBlocks();
    }
  }

  function addBlock() {
    if (state.blocks.length >= MAX_BLOCKS) return;
    const prev = state.blocks[state.blocks.length - 1];
    const name = `候補${state.blocks.length + 1}`;
    const copy = { id: uid(), name, date: { ...prev.date }, selection: prev.selection ? { ...prev.selection } : null };
    state.blocks.push(copy);
    saveBlocks();
    renderBlocks();
  }

  function deleteBlock(id) {
    state.blocks = state.blocks.filter(b => b.id !== id);
    // reindex names
    state.blocks.forEach((b, i) => b.name = `候補${i + 1}`);
    saveBlocks();
    ensureAtLeastOneBlock();
    renderBlocks();
  }

  function renderBlocks() {
    const container = document.getElementById('blocks');
    container.innerHTML = '';
    if (state.cities.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'small-muted';
      hint.textContent = '中央のグリッドは、都市を追加すると表示されます。';
      container.appendChild(hint);
      return;
    }
    state.blocks.forEach((block, idx) => {
      container.appendChild(renderBlock(block, idx));
    });
  }

  function renderBlock(block, index) {
    const topTz = state.cities[0]?.tzId || 'UTC';
    const anchorUtc = zonedMidnightUtcMs(block.date, topTz);
    const hourWidth = computeHourWidth();
    const gran = state.view.granularity;
    const slotsPerHour = 60 / gran;
    const totalSlots = 24 * slotsPerHour;

    const wrap = document.createElement('div');
    wrap.className = 'block';
    wrap.dataset.blockId = block.id;

    // Toolbar
    const header = document.createElement('div');
    header.className = 'block-toolbar';
    header.innerHTML = `
      <div>
        <div class="block-title">${block.name}</div>
        <div class="week-strip">
          ${['日','月','火','水','木','金','土'].map((d,i)=>`<button class=\"day\" data-weekday=\"${i}\"><span class=\"wd\">${d}</span><span class=\"md\" data-md></span></button>`).join('')}
        </div>
      </div>
      <div class="block-right">
        <button class="btn-icon" data-prev title="前日">◀</button>
        <div class="date-field">
          <input type="date" class="input" data-date />
          <span class="date-overlay" data-date-label></span>
        </div>
        <button class="btn-icon" data-next title="翌日">▶</button>
        <button class="btn danger" data-del title="候補を削除">候補を削除</button>
      </div>
    `;
    wrap.appendChild(header);
    const dateInput = header.querySelector('[data-date]');
    dateInput.value = `${block.date.year}-${pad2(block.date.month)}-${pad2(block.date.day)}`;
    // Open native date picker when clicking anywhere in the field
    const dateField = header.querySelector('.date-field');
    if (dateField) {
      dateField.addEventListener('click', (e) => {
        try { dateInput.showPicker && dateInput.showPicker(); } catch {}
        dateInput.focus();
      });
      // Prevent text selection/drag in the field (Chrome ignores user-select for inputs)
      dateField.addEventListener('mousedown', (e) => {
        e.preventDefault();
        try { dateInput.showPicker && dateInput.showPicker(); } catch {}
      });
      dateField.addEventListener('selectstart', (e) => e.preventDefault());
    }
    header.querySelector('[data-prev]').addEventListener('click', () => changeBlockDay(block, -1));
    header.querySelector('[data-next]').addEventListener('click', () => changeBlockDay(block, +1));
    header.querySelector('[data-del]').addEventListener('click', () => deleteBlock(block.id));
    dateInput.addEventListener('change', (e) => {
      const v = e.target.value; // yyyy-mm-dd
      const [y,m,d] = v.split('-').map(Number);
      if (y && m && d) { block.date = { year: y, month: m, day: d }; saveBlocks(); renderBlocks(); }
    });
    // week indicator activation
    const weekBtns = header.querySelectorAll('.day');
    const anchorPartsTop = partsFromTs(anchorUtc, topTz);
    const dateOverlay = header.querySelector('[data-date-label]');
    // Day-of-week should be derived from the calendar date itself (timezone independent)
    const curW = new Date(Date.UTC(block.date.year, block.date.month - 1, block.date.day)).getUTCDay();
    if (dateOverlay) {
      const y = block.date.year;
      const m = pad2(block.date.month);
      const d = pad2(block.date.day);
      dateOverlay.textContent = `${y}/${m}/${d} (${jpWeekdays[curW]})`;
    }
    // Fill m/d for each weekday button using calendar-day math from the block date (DST-safe)
    weekBtns.forEach((btn) => {
      const wd = Number(btn.dataset.weekday);
      const delta = wd - curW; // [-6..+6]
      const dUtc = new Date(Date.UTC(block.date.year, block.date.month - 1, block.date.day + delta));
      const ymd = { year: dUtc.getUTCFullYear(), month: dUtc.getUTCMonth() + 1, day: dUtc.getUTCDate() };
      // Week strip is a calendar view; use pure calendar date for m/d to avoid TZ/DST shifts
      const md = `${ymd.month}/${ymd.day}`;
      const mdSpan = btn.querySelector('[data-md]');
      if (mdSpan) mdSpan.textContent = md;
      btn.classList.toggle('active', wd === curW);
      btn.addEventListener('click', () => jumpToWeekday(block, wd));
    });

    // Grid
    const gridWrap = document.createElement('div');
    gridWrap.className = 'grid-wrap';
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.style.setProperty('--hour-width', `${hourWidth}px`);

    // (top hour ruler removed; each row will display its own hours)

    const rows = document.createElement('div');
    rows.className = 'grid-rows';

    // city rows
    state.cities.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('div');
      label.className = 'row-label';
      label.innerHTML = `<div>${c.city_ja || tzSuffix(c.tzId)}</div><div class="small-muted">${tzOffsetLabel(anchorUtc, c.tzId)}</div>`;
      const cells = document.createElement('div');
      cells.className = 'row-cells';

      const inner = document.createElement('div');
      inner.className = 'grid-inner';
      inner.style.width = `${hourWidth * 24}px`;

      // dayparts background blocks per city
      const dp = document.createElement('div');
      dp.className = 'dayparts';
      addDayparts(dp, c.tzId, anchorUtc, hourWidth);
      inner.appendChild(dp);

      // rounded visual layer (middle)
      const round = document.createElement('div');
      round.className = 'round-layer';
      addRoundPill(round, c.tzId, anchorUtc, hourWidth);
      addPillHourLines(round, c.tzId, anchorUtc, hourWidth);
      addNightOverlay(round, c.tzId, anchorUtc, hourWidth);
      addEarlyOverlay(round, c.tzId, anchorUtc, hourWidth);
      addEveningOverlay(round, c.tzId, anchorUtc, hourWidth);
      addDateChip(round, c.tzId, anchorUtc, hourWidth);
      inner.appendChild(round);

      // per-row hour labels
      const rh = document.createElement('div');
      rh.className = 'row-hours';
      addRowHours(rh, c.tzId, anchorUtc, hourWidth);
      inner.appendChild(rh);

      // simplified: remove per-row hour numbers to reduce clutter

      cells.appendChild(inner);
      row.appendChild(label);
      row.appendChild(cells);
      rows.appendChild(row);
    });

    // Selection overlay shared across all rows (full height)
    const sel = document.createElement('div');
    sel.className = 'selection';
    sel.style.display = block.selection ? 'block' : 'none';
    const handleStart = document.createElement('div'); handleStart.className = 'handle start';
    const handleEnd = document.createElement('div'); handleEnd.className = 'handle end';
    sel.appendChild(handleStart); sel.appendChild(handleEnd);

    // place selection in the first row's inner (position relative) and then absolute spans all rows via top/bottom:0 as grid-inner heights equal
    // Actually we want a single selection overlay per block spanning entire rows height; place after rows so it overlays all

    // Now line
    const nowLine = document.createElement('div');
    nowLine.className = 'now-line';

    // (old) selection info bubble removed; we'll show per-row chips instead

    // A container to overlay selection and nowline across the scrolling area
    const overlayContainer = document.createElement('div');
    overlayContainer.style.position = 'absolute';
    overlayContainer.style.left = getLabelWidth() + 'px';
    overlayContainer.style.top = '0';
    overlayContainer.style.right = '0';
    overlayContainer.style.bottom = '0';
    // Vertical hour grid lines across all rows
    const vlines = document.createElement('div');
    vlines.className = 'vlines';
    addVLines(vlines, hourWidth);
    overlayContainer.appendChild(vlines);
    overlayContainer.appendChild(sel);
    overlayContainer.appendChild(nowLine);

    grid.appendChild(rows);
    grid.appendChild(overlayContainer);
    gridWrap.appendChild(grid);
    wrap.appendChild(gridWrap);

    // Outputs (collapsible)
    const outputsCard = document.createElement('div');
    outputsCard.className = 'outputs-card';
    const pre = document.createElement('pre');
    pre.className = 'outputs';
    pre.textContent = blockOutputsText(block, anchorUtc);
    outputsCard.appendChild(pre);
    wrap.appendChild(outputsCard);

    // Selection positions
    function updateSelPos() {
      const slotW = hourWidth / slotsPerHour;
      if (block.selection) {
        const left = block.selection.start * slotW;
        const width = (block.selection.end - block.selection.start) * slotW;
        sel.style.left = `${left}px`;
        sel.style.width = `${width}px`;
      } else {
        // no-op
      }
      // now line position
      const now = Date.now();
      const deltaMin = (now - anchorUtc) / 60000;
      if (deltaMin >= 0 && deltaMin <= DAY_MIN) {
        nowLine.style.display = 'block';
        nowLine.style.left = `${(deltaMin / 60) * hourWidth}px`;
      } else {
        nowLine.style.display = 'none';
      }
    }
    updateSelPos();

    // Selection interactions
    let dragging = null; // 'range' | 'start' | 'end'
    let dragAnchorStart = 0; // start index at drag start
    function posToSlot(clientX) {
      const rect = overlayContainer.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 0, hourWidth * 24);
      const slotW = hourWidth / slotsPerHour;
      const slot = Math.round(x / slotW);
      return clamp(slot, 0, totalSlots);
    }

    // Use Pointer Events for smooth dragging (follows cursor while moving)
    let activePointerId = null;
    overlayContainer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.target === handleStart) { dragging = 'start'; }
      else if (e.target === handleEnd) { dragging = 'end'; }
      else { dragging = 'range'; }
      if (dragging === 'range') {
        const s = posToSlot(e.clientX);
        block.selection = { start: s, end: s };
        dragAnchorStart = s;
      } else if (block.selection) {
        dragAnchorStart = block.selection.start;
      }
      sel.style.display = 'block';
      activePointerId = e.pointerId;
      overlayContainer.setPointerCapture(activePointerId);
      onPointerMove(e);
    });
    overlayContainer.addEventListener('pointermove', onPointerMove);
    overlayContainer.addEventListener('pointerup', onPointerUp);
    overlayContainer.addEventListener('pointercancel', onPointerUp);

    function onPointerMove(e) {
      if (!dragging) return;
      const slot = posToSlot(e.clientX);
      if (!block.selection) block.selection = { start: slot, end: slot };
      if (dragging === 'range') {
        block.selection.end = slot;
      } else if (dragging === 'start') {
        block.selection.start = Math.min(slot, block.selection.end - 1);
      } else if (dragging === 'end') {
        block.selection.end = Math.max(slot, block.selection.start + 1);
      }
      if (block.selection.end < block.selection.start) {
        const t = block.selection.start; block.selection.start = block.selection.end; block.selection.end = t;
      }
      updateSelPos();
    }
    function onPointerUp(e) {
      if (activePointerId !== null) {
        try { overlayContainer.releasePointerCapture(activePointerId); } catch {}
        activePointerId = null;
      }
      dragging = null;
      saveBlocks();
      pre.textContent = blockOutputsText(block, anchorUtc);
    }

    // Consensus overlay across all rows
    const consensus = document.createElement('div');
    consensus.className = 'consensus';
    overlayContainer.insertBefore(consensus, sel);
    renderConsensus(consensus, anchorUtc, hourWidth, gran, slotsPerHour);

    // Hover guide line for easier reading
    const hoverLine = document.createElement('div');
    hoverLine.className = 'hover-line';
    overlayContainer.appendChild(hoverLine);
    overlayContainer.addEventListener('mousemove', (e) => {
      const rect = overlayContainer.getBoundingClientRect();
      const x = clamp(e.clientX - rect.left, 0, hourWidth * 24);
      hoverLine.style.left = `${x}px`;
    });

    // Update clocks and now line periodically
    const nowTimer = setInterval(() => { updateClocks(); updateSelPos(); renderConsensus(consensus, anchorUtc, hourWidth, gran, slotsPerHour); }, 1000 * 30);
    // Clean up timer when block is removed from DOM (not strictly necessary in SPA lifetime)

    return wrap;
  }

  function changeBlockDay(block, deltaDays) {
    // Change day using calendar arithmetic (DST-safe)
    const topTz = state.cities[0]?.tzId || 'UTC';
    // Start from the current local calendar date in the top TZ
    const startUtc = zonedMidnightUtcMs(block.date, topTz);
    const start = partsFromTs(startUtc, topTz);
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + deltaDays));
    const ymd = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    // Snap back to exact local midnight after calendar shift
    zonedMidnightUtcMs(ymd, topTz); // compute once for correctness (value unused)
    block.date = ymd;
    saveBlocks();
    renderBlocks();
  }

  function jumpToWeekday(block, weekday) {
    // Move to the weekday within the same displayed week (calendar-based, DST-safe)
    const curW = new Date(Date.UTC(block.date.year, block.date.month - 1, block.date.day)).getUTCDay();
    const delta = weekday - curW; // [-6..+6]
    changeBlockDay(block, delta);
  }

  function addDayparts(container, tz, anchorUtc, hourWidth) {
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute; // local minutes at anchor
    const segments = [
      { start: 0, len: 6 * 60, cls: 'dp-night' },
      { start: 6 * 60, len: 3 * 60, cls: 'dp-early' },
      { start: 9 * 60, len: 9 * 60, cls: 'dp-day' },
      { start: 18 * 60, len: 6 * 60, cls: 'dp-evening' },
    ];
    for (const seg of segments) {
      const leftMin = seg.start - anchorMin; // may be negative or > 1440
      makeWrappedRect(leftMin, seg.len).forEach(([l, w]) => {
        const d = document.createElement('div');
        d.className = `daypart ${seg.cls}`;
        d.style.left = `${(l / 60) * hourWidth}px`;
        d.style.width = `${(w / 60) * hourWidth}px`;
        container.appendChild(d);
      });
    }
  }

  function addRowHours(container, tz, anchorUtc, hourWidth) {
    // Place hour labels at each LOCAL hour's midpoint (hh:30) relative to the
    // top anchor window. This makes half/quarter-hour zones align correctly.
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute; // local minutes at anchor
    for (let h = 0; h < 24; h++) {
      const localMid = h * 60 + 30; // midpoint of local hour h
      let leftMin = localMid - anchorMin;
      leftMin = ((leftMin % 1440) + 1440) % 1440; // wrap into [0,1440)
      const d = document.createElement('div');
      d.className = 'h';
      if (h >= 22 || h <= 5) d.classList.add('night');
      if (h === 0) {
        d.classList.add('date');
        d.textContent = '';
      } else {
        d.textContent = `${h}`;
      }
      d.style.left = `${(leftMin / 60) * hourWidth}px`;
      container.appendChild(d);
    }
  }

  function addDateChip(container, tz, anchorUtc, hourWidth) {
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute;
    const parts = makeWrappedRect(0 - anchorMin, 60);
    for (const [l, w] of parts) {
      const ts = anchorUtc + l * 60000;
      const p = partsFromTs(ts, tz);
      const chip = document.createElement('div');
      chip.className = 'date-chip';
      chip.innerHTML = `<span class="d1">${p.month}/${p.day}</span><span class="d2">(${jpWeekdays[p.weekday]})</span>`;
      chip.style.left = `${(l / 60) * hourWidth + (hourWidth / 2)}px`;
      container.appendChild(chip);
    }
  }

  function addRoundPill(container, tz, anchorUtc, hourWidth) {
    // Create a pill spanning local 0:00 -> 23:00.
    // If this range wraps across the 24h window, split into two pieces
    // and round the outer ends: left at 0:00, right at 23:00.
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute;
    // Cover the entire local day so that hour 23 is included
    const parts = makeWrappedRect(0 - anchorMin, 24 * 60);
    const radius = '14px';
    const zero = '0px';
    parts.forEach(([l, w], i) => {
      const el = document.createElement('div');
      el.className = 'pill';
      el.style.left = `${(l / 60) * hourWidth}px`;
      el.style.width = `${(w / 60) * hourWidth}px`;
      if (parts.length === 1) {
        // both ends rounded (default border-radius applies)
      } else if (i === 0) {
        // first segment: round start (left), square end (right)
        el.style.borderTopLeftRadius = radius;
        el.style.borderBottomLeftRadius = radius;
        el.style.borderTopRightRadius = zero;
        el.style.borderBottomRightRadius = zero;
      } else {
        // second segment: square start (left), round end (right)
        el.style.borderTopLeftRadius = zero;
        el.style.borderBottomLeftRadius = zero;
        el.style.borderTopRightRadius = radius;
        el.style.borderBottomRightRadius = radius;
      }
      container.appendChild(el);
    });
  }

  function addPillHourLines(container, tz, anchorUtc, hourWidth) {
    // Draw dashed hour boundaries inside each rounded pill segment only.
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute; // local minutes at anchor
    const pills = Array.from(container.querySelectorAll('.pill'));
    if (!pills.length) return;
    // Precompute global x position for each local hour boundary (1..23)
    const xs = [];
    for (let h = 1; h < 24; h++) {
      let leftMin = h * 60 - anchorMin;
      leftMin = ((leftMin % 1440) + 1440) % 1440; // wrap
      xs.push((leftMin / 60) * hourWidth);
    }
    pills.forEach(p => {
      const pLeft = parseFloat(p.style.left) || 0;
      const pWidth = parseFloat(p.style.width) || 0;
      const pRight = pLeft + pWidth;
      xs.forEach(x => {
        if (x > pLeft + 0.5 && x < pRight - 0.5) {
          const line = document.createElement('div');
          line.className = 'ph';
          line.style.left = `${x - pLeft}px`;
          p.appendChild(line);
        }
      });
    });
  }

  function addNightOverlay(container, tz, anchorUtc, hourWidth) {
    // Render night bands (22:00-24:00, 00:00-06:00) clipped inside pill segments.
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute;
    const intervals = [
      { start: 22 * 60, len: 2 * 60 }, // 22:00 - 24:00
      { start: 0, len: 6 * 60 },       // 00:00 - 06:00
    ];

    // Precompute global overlay segments in pixels
    const segPixels = [];
    intervals.forEach(seg => {
      makeWrappedRect(seg.start - anchorMin, seg.len).forEach(([l, w]) => {
        const leftPx = (l / 60) * hourWidth;
        const rightPx = ((l + w) / 60) * hourWidth;
        segPixels.push([leftPx, rightPx]);
      });
    });

    // For each pill segment, clip overlay to its bounds by placing as a child
    container.querySelectorAll('.pill').forEach(p => {
      const pLeft = parseFloat(p.style.left) || 0;
      const pWidth = parseFloat(p.style.width) || 0;
      const pRight = pLeft + pWidth;
      segPixels.forEach(([sLeft, sRight]) => {
        const left = Math.max(pLeft, sLeft);
        const right = Math.min(pRight, sRight);
        if (right > left) {
          const el = document.createElement('div');
          el.className = 'night';
          el.style.left = `${left - pLeft}px`;
          el.style.width = `${right - left}px`;
          p.appendChild(el);
        }
      });
    });
  }

  function addEarlyOverlay(container, tz, anchorUtc, hourWidth) {
    // Render early morning band (06:00-08:00) clipped inside pill segments.
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute;
    const intervals = [ { start: 6 * 60, len: 2 * 60 } ];

    const segPixels = [];
    intervals.forEach(seg => {
      makeWrappedRect(seg.start - anchorMin, seg.len).forEach(([l, w]) => {
        const leftPx = (l / 60) * hourWidth;
        const rightPx = ((l + w) / 60) * hourWidth;
        segPixels.push([leftPx, rightPx]);
      });
    });

    container.querySelectorAll('.pill').forEach(p => {
      const pLeft = parseFloat(p.style.left) || 0;
      const pWidth = parseFloat(p.style.width) || 0;
      const pRight = pLeft + pWidth;
      segPixels.forEach(([sLeft, sRight]) => {
        const left = Math.max(pLeft, sLeft);
        const right = Math.min(pRight, sRight);
        if (right > left) {
          const el = document.createElement('div');
          el.className = 'early';
          el.style.left = `${left - pLeft}px`;
          el.style.width = `${right - left}px`;
          p.appendChild(el);
        }
      });
    });
  }

  function addEveningOverlay(container, tz, anchorUtc, hourWidth) {
    // Render evening band (18:00-21:00) clipped inside pill segments.
    const anchor = partsFromTs(anchorUtc, tz);
    const anchorMin = anchor.hour * 60 + anchor.minute;
    // Cover 18:00 - 22:00 so that 21時台も含む
    const intervals = [ { start: 18 * 60, len: 4 * 60 } ];

    const segPixels = [];
    intervals.forEach(seg => {
      makeWrappedRect(seg.start - anchorMin, seg.len).forEach(([l, w]) => {
        const leftPx = (l / 60) * hourWidth;
        const rightPx = ((l + w) / 60) * hourWidth;
        segPixels.push([leftPx, rightPx]);
      });
    });

    container.querySelectorAll('.pill').forEach(p => {
      const pLeft = parseFloat(p.style.left) || 0;
      const pWidth = parseFloat(p.style.width) || 0;
      const pRight = pLeft + pWidth;
      segPixels.forEach(([sLeft, sRight]) => {
        const left = Math.max(pLeft, sLeft);
        const right = Math.min(pRight, sRight);
        if (right > left) {
          const el = document.createElement('div');
          el.className = 'evening';
          el.style.left = `${left - pLeft}px`;
          el.style.width = `${right - left}px`;
          p.appendChild(el);
        }
      });
    });
  }

  function addVLines(container, hourWidth) {
    for (let h = 0; h <= 24; h++) {
      const v = document.createElement('div');
      v.className = 'v' + (h % 24 === 0 ? ' v-day' : '');
      v.style.left = `${h * hourWidth}px`;
      container.appendChild(v);
    }
  }

  function comfortWeight(hour) {
    if (hour >= 9 && hour < 18) return 3; // working day
    if ((hour >= 7 && hour < 9) || (hour >= 18 && hour < 21)) return 2; // shoulder
    if (hour === 6 || (hour >= 21 && hour < 23)) return 1; // fringe
    return 0; // night
  }

  function renderConsensus(container, anchorUtc, hourWidth, gran, slotsPerHour) {
    container.innerHTML = '';
    const totalSlots = 24 * slotsPerHour;
    const maxPerSlot = 3 * Math.max(1, state.cities.length);
    const slotW = hourWidth / slotsPerHour;
    const segments = [];
    let current = null;
    for (let s = 0; s < totalSlots; s++) {
      const ts = anchorUtc + (s + 0.5) * gran * 60000;
      let score = 0;
      for (const c of state.cities) {
        const h = partsFromTs(ts, c.tzId).hour;
        score += comfortWeight(h);
      }
      // quantize alpha to reduce visual noise
      const alpha = score <= 0 ? 0 : Math.min(0.25, 0.05 + 0.2 * (score / maxPerSlot));
      const q = Math.round(alpha * 10) / 10; // 0.0 / 0.1 / ...
      if (!current) current = { q, start: s, end: s + 1 };
      else if (current.q === q) current.end = s + 1;
      else { segments.push(current); current = { q, start: s, end: s + 1 }; }
    }
    if (current) segments.push(current);
    // render only visible/meaningful segments
    segments.forEach(seg => {
      if (seg.q <= 0) return;
      const w = (seg.end - seg.start) * slotW;
      if (w < slotW * 2) return; // skip tiny blocks
      const el = document.createElement('div');
      el.className = 'cs-slot';
      el.style.left = `${seg.start * slotW}px`;
      el.style.width = `${w}px`;
      el.style.setProperty('--alpha', String(seg.q));
      container.appendChild(el);
    });
  }

  function makeWrappedRect(leftMin, widthMin) {
    // returns list of [left,width] within [0,1440]
    let l = leftMin;
    while (l < 0) l += DAY_MIN;
    const res = [];
    if (l + widthMin <= DAY_MIN) {
      res.push([l, widthMin]);
    } else {
      const first = DAY_MIN - l;
      res.push([l, first]);
      res.push([0, widthMin - first]);
    }
    return res;
  }

  function blockOutputsText(block, anchorUtc) {
    if (!block.selection) return '選択範囲が未設定です。グリッドをドラッグして選択してください。';
    const gran = state.view.granularity;
    const startTs = anchorUtc + block.selection.start * gran * 60000;
    const endTs = anchorUtc + block.selection.end * gran * 60000; // end-exclusive
    let out = `${block.name}\n`;
    for (const c of state.cities) {
      const label = c.isCurrent ? (datasetByTz(c.tzId)?.city_ja || tzSuffix(c.tzId)) : (c.city_ja || tzSuffix(c.tzId));
      const startTxt = formatJP(startTs, c.tzId);
      const endTxt = sameLocalDay(startTs, endTs, c.tzId) ? formatTimeHHmm(partsFromTs(endTs, c.tzId)) : formatJP(endTs, c.tzId);
      out += `・${label}: ${startTxt} 〜 ${endTxt}\n`;
    }
    return out.trim();
  }

  function getLabelWidth() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--label-w').trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 160;
  }

  function computeHourWidth() {
    // Fit 24h into the visible frame as much as possible
    const center = document.getElementById('panel-center');
    const total = center ? center.clientWidth : 1024;
    const label = getLabelWidth();
    // subtract left label and generous paddings/borders/scrollbar (~64px)
    const usable = Math.max(0, total - label - 64);
    // subtract a couple pixels to guarantee fit
    const perHour = clamp(Math.floor((usable - 2) / 24), 10, 120);
    return perHour;
  }

  // ---------- Search Modal ----------
  function openSearch() {
    const modal = document.getElementById('search-modal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('search-input');
    input.value = '';
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('search-status').textContent = '都市データを検索します…';
    // default to text pane
    switchPane('text');
    input.focus();
  }
  function closeSearch() {
    const modal = document.getElementById('search-modal');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }
  function doSearch(q) {
    const list = document.getElementById('search-results');
    list.innerHTML = '';
    const tokens = tokenize(q);
    const kanaTokens = hasKana(q) ? normalizeKana(q).split(/\s+/).filter(Boolean) : [];
    let items = [];
    if (tokens.length) {
      items = state.dataset
        .map(it => ({ it, score: scoreItem(it, tokens, kanaTokens) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || Number(b.it.isCurated) - Number(a.it.isCurated) || normalize(a.it.city_ja).localeCompare(normalize(b.it.city_ja)))
        .slice(0, 10)
        .map(x => x.it);
    }
    document.getElementById('search-status').textContent = items.length ? `${items.length} 件` : tokens.length ? '該当なし' : 'キーワードを入力してください';
    renderSearchItems(list, items);
  }
  // matchCity removed; now using scored search

  function renderSearchItems(listEl, items) {
    listEl.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'search-item';
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      li.innerHTML = `
        <div>
          <div><strong>${it.city_ja}</strong>（${it.country_ja}）</div>
          <div class="small-muted">${it.city_en}, ${it.country_en} ・ ${it.tzId}</div>
        </div>
        <div><button class="btn btn-primary">追加</button></div>
      `;
      const add = () => { addCity(it); closeSearch(); };
      li.addEventListener('click', (e) => { if (e.target instanceof HTMLElement && e.target.closest('button')) return; add(); });
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } });
      li.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); add(); });
      listEl.appendChild(li);
    }
  }

  // ---------- URL params ----------
  function applyUrlParams() {
    const sp = new URLSearchParams(location.search);
    if ([...sp.keys()].length === 0) return;
    const citiesParam = sp.get('cities');
    if (citiesParam) {
      const ids = citiesParam.split(',').map(s => s.trim()).filter(Boolean);
      ids.forEach(id => { const it = datasetById(id); if (it && !state.cities.some(c => c.id === id)) addCity(it); });
    }
    const from = sp.get('from');
    const to = sp.get('to');
    if (from && to && state.blocks.length) {
      const fromMs = parseISOToMs(from);
      const toMs = parseISOToMs(to);
      if (fromMs && toMs) {
        const b = state.blocks[0];
        const topTz = state.cities[0]?.tzId || 'UTC';
        const p = partsFromTs(fromMs, topTz);
        b.date = { year: p.year, month: p.month, day: p.day };
        const anchor = zonedMidnightUtcMs(b.date, topTz);
        const gran = state.view.granularity;
        const start = Math.round((fromMs - anchor) / (gran * 60000));
        const end = Math.round((toMs - anchor) / (gran * 60000));
        b.selection = { start: clamp(start, 0, (24 * 60) / gran), end: clamp(end, 0, (24 * 60) / gran) };
        saveBlocks();
      }
    }
  }

  // ---------- Misc ----------
  function uid() { return Math.random().toString(36).slice(2, 9); }

  function render() {
    // Left
    renderCurrentTZReco();
    renderCityList();
    // Right segmented
    document.querySelectorAll('.seg').forEach(btn => {
      const g = Number(btn.dataset.gran);
      btn.setAttribute('aria-pressed', String(state.view.granularity === g));
    });
    // Center
    renderBlocks();
  }

  function bindEvents() {
    document.getElementById('btn-open-search').addEventListener('click', openSearch);
    document.querySelectorAll('[data-modal-close]').forEach(el => el.addEventListener('click', closeSearch));
    document.getElementById('search-modal').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeSearch(); });
    document.getElementById('search-input').addEventListener('input', (e) => doSearch(e.target.value));
    // Tabs for search/map
    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchPane(btn.dataset.pane)));
    document.querySelectorAll('.seg').forEach(btn => btn.addEventListener('click', () => {
      state.view.granularity = Number(btn.dataset.gran);
      saveView();
      render();
    }));
    document.getElementById('btn-add-block').addEventListener('click', addBlock);
    document.getElementById('btn-copy-all').addEventListener('click', copyAll);
    window.addEventListener('resize', () => renderBlocks());
    setInterval(updateClocks, 1000);
  }

  function copyAll() {
    const out = state.blocks.map((b, i) => {
      const topTz = state.cities[0]?.tzId || 'UTC';
      const anchor = zonedMidnightUtcMs(b.date, topTz);
      return blockOutputsText(b, anchor);
    }).join('\n\n');
    navigator.clipboard?.writeText(out).catch(() => {});
  }

  async function init() {
    els.left = document.getElementById('panel-left');
    els.center = document.getElementById('panel-center');
    els.right = document.getElementById('panel-right');

    detectCurrentTZ();
    loadPersisted();
    await loadDataset();
    ensureAtLeastOneBlock();
    bindEvents();
    render();
    // apply URL params after a tick to allow cities auto-add
    setTimeout(() => { applyUrlParams(); render(); }, 300);
  }

  document.addEventListener('DOMContentLoaded', init);

  // --------- Map search ---------
  let mapInitialized = false;
  function switchPane(pane) {
    const tabText = document.querySelector('.tab[data-pane="text"]');
    const tabMap = document.querySelector('.tab[data-pane="map"]');
    const pText = document.getElementById('pane-text');
    const pMap = document.getElementById('pane-map');
    const isMap = pane === 'map';
    tabText.classList.toggle('active', !isMap);
    tabMap.classList.toggle('active', isMap);
    pText.classList.toggle('hidden', isMap);
    pMap.classList.toggle('hidden', !isMap);
    pMap.setAttribute('aria-hidden', String(!isMap));
    if (isMap && !mapInitialized) { renderWorldMap(); mapInitialized = true; }
    if (!isMap) document.getElementById('search-input').focus();
  }

  async function renderWorldMap() {
    const wrap = document.getElementById('map-wrap');
    wrap.innerHTML = '';
    // Ensure local vendor libs are loaded
    await ensureScript('/scripts/vendor/d3.min.js', 'd3');
    await ensureScript('/scripts/vendor/topojson-client.min.js', 'topojson');
    const width = wrap.clientWidth || 640;
    const height = wrap.clientHeight || 360;

    const svg = d3.select(wrap).append('svg')
      .attr('class', 'worldmap')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const projection = d3.geoEquirectangular();
    const path = d3.geoPath(projection);

    // Load local TopoJSON
    const topo = await (await fetch('data/world/countries-110m.json', { cache: 'no-cache' })).json();
    const features = topojson.feature(topo, topo.objects.countries).features;

    // Fit projection
    projection.fitExtent([[10, 10], [width - 10, height - 10]], { type: 'FeatureCollection', features });

    svg.append('g')
      .selectAll('path')
      .data(features)
      .join('path')
      .attr('class', 'region')
      .attr('d', path)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .append('title')
      .text(d => d.properties?.name || '');

    // Click interaction
    svg.selectAll('path.region').on('click', function (event, d) {
      const name = d.properties?.name || '';
      svg.selectAll('path.region').attr('aria-pressed', null);
      d3.select(this).attr('aria-pressed', 'true');
      showCountryItems(name);
    }).on('keydown', function (event, d) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const name = d.properties?.name || '';
        svg.selectAll('path.region').attr('aria-pressed', null);
        d3.select(this).attr('aria-pressed', 'true');
        showCountryItems(name);
      }
    });
  }

  function highlightRegion(el) {
    document.querySelectorAll('.region[aria-pressed]')
      .forEach(n => n.setAttribute('aria-pressed', 'false'));
    el.setAttribute('aria-pressed', 'true');
  }

  function showCountryItems(countryName) {
    const norm = normalize(countryName);
    const mapped = mapCountryName(norm);
    const items = state.dataset.filter(it => normalize(it.country_en) === mapped || normalize(it.country_ja) === mapped)
      .sort((a, b) => Number(b.isCurated) - Number(a.isCurated) || normalize(a.city_ja).localeCompare(normalize(b.city_ja)));
    document.getElementById('map-status').textContent = items.length ? `${countryName} - ${items.length} 件` : `${countryName} - 該当なし`;
    renderSearchItems(document.getElementById('map-results'), items.slice(0, 30));
  }

  function regionKeyForCity(it) {
    const tz = it.tzId || '';
    const c = (it.country_en || '').toLowerCase();
    const r = tz.split('/')[0];
    if (r === 'Europe') return 'europe';
    if (r === 'Africa') return 'africa';
    if (r === 'America' || r === 'Atlantic') return 'americas';
    if (r === 'Australia' || r === 'Pacific' || c.includes('new zealand')) return 'oceania';
    if (r === 'Asia') {
      if (['united arab emirates','saudi arabia','qatar','bahrain','kuwait','oman','israel','turkey','jordan','lebanon','iraq','iran'].some(s => c.includes(s))) return 'middleeast';
      if (['india','pakistan','sri lanka','bangladesh','nepal','maldives','bhutan'].some(s => c.includes(s))) return 'southasia';
      if (['japan','south korea','korea','china','hong kong','taiwan','mongolia'].some(s => c.includes(s))) return 'eastasia';
      if (['singapore','thailand','vietnam','indonesia','malaysia','philippines','cambodia','laos','myanmar','brunei','timor'].some(s => c.includes(s))) return 'seasia';
      // fallback for Asia
      return 'eastasia';
    }
    // Fallback
    return 'americas';
  }

  // Country name normalization map from TopoJSON -> dataset country_en
  function mapCountryName(normName) {
    const m = new Map([
      ['united states of america','united states'],
      ['russian federation','russia'],
      ['cote d’ivoire','cote d ivoire'],
      ['côte d’ivoire','cote d ivoire'],
      ['cote d\'ivoire','cote d ivoire'],
      ['kyrgyzstan','kyrgyzstan'],
      ['north macedonia','macedonia'],
      ['myanmar','myanmar'],
      ['democratic republic of the congo','congo (kinshasa)'],
      ['congo','congo (brazzaville)'],
      ['south korea','south korea'],
      ['north korea','north korea'],
      ['laos','laos'],
      ['czechia','czech republic'],
      ['eswatini','swaziland'],
      ['united republic of tanzania','tanzania'],
      ['são tomé and príncipe','sao tome and principe'],
    ]);
    const direct = m.get(normName);
    return direct || normName;
  }

  // Dynamically ensure external script (local vendor) is loaded
  function ensureScript(src, globalKey) {
    return new Promise((resolve, reject) => {
      if (globalKey && window[globalKey]) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = () => resolve(); s.onerror = (e) => reject(e);
      document.head.appendChild(s);
    });
  }
})();
