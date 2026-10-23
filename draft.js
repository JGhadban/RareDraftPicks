(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const frontName = (name) => name.split(' // ')[0];
  function nameNode(name, cls) {
    const [front, ...rest] = name.split(' // ');
    const span = el('span', cls, front);
    if (rest.length) span.append(el('span', 'alt', ` // ${rest.join(' // ')}`));
    return span;
  }

  const STATE_KEY = 'rdp_live_draft';
  const TOP_N = 8;
  const POOL_LIMIT = 60;
  const UPNEXT_N = 10;

  const state = {
    cards: [],
    byName: new Map(),
    players: [],         // { id, name, rating, allowed, prefs }; array order = pick order
    log: [],             // { playerId, card } in pick order
    phase: 'setup',      // 'setup' | 'draft'  ('done' is derived)
    selected: null,
    showAll: false,
  };

  // ------------------------------------------------------------------ storage (best effort)

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function save() {
    store.set(STATE_KEY, JSON.stringify({ players: state.players, log: state.log, phase: state.phase }));
  }

  function restore() {
    try {
      const s = JSON.parse(store.get(STATE_KEY) || 'null');
      if (!s || !Array.isArray(s.players)) return;
      state.players = s.players;
      state.log = Array.isArray(s.log) ? s.log : [];
      state.phase = s.phase === 'draft' ? 'draft' : 'setup';
    } catch { /* ignore bad state */ }
  }

  // ------------------------------------------------------------------ CSV

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim()));
  }

  // Results export -> [{ id, name, prefs }], prefs in rank order.
  function playersFromCsv(text) {
    const [header, ...rows] = parseCsv(text);
    if (!header) throw new Error('The file is empty.');
    const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
    for (const c of ['name', 'rank', 'card_name']) {
      if (!(c in col)) throw new Error(`Missing column "${c}". Is this the picks_flat export?`);
    }
    const groups = new Map();
    for (const r of rows) {
      const name = (r[col.name] || '').trim();
      const id = ('submission_id' in col && r[col.submission_id]) || name;
      if (!groups.has(id)) groups.set(id, { id, name, entries: [] });
      groups.get(id).entries.push({ rank: Number(r[col.rank]), card: (r[col.card_name] || '').trim() });
    }
    return [...groups.values()].map((g) => ({
      id: g.id,
      name: g.name,
      prefs: g.entries.filter((e) => e.card).sort((a, b) => a.rank - b.rank).map((e) => e.card),
    }));
  }

  const csvField = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

  // ------------------------------------------------------------------ name matching

  const normalize = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function levenshtein(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 1 = same name, 0.9 = "Jamie" / "Jamie R." / "Jamie Robinson", otherwise edit-distance similarity.
  function nameScore(a, b) {
    const na = normalize(a), nb = normalize(b);
    if (!na || !nb) return 0;
    const sa = na.replace(/ /g, ''), sb = nb.replace(/ /g, '');
    if (sa === sb) return 1;
    const ta = na.split(' '), tb = nb.split(' ');
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (short.every((t) => long.includes(t))) return 0.9;
    if (ta.length > 1 && tb.length > 1 && ta[0] === tb[0] && ta[ta.length - 1][0] === tb[tb.length - 1][0]) return 0.9;
    const sim = (x, y) => 1 - levenshtein(x, y) / Math.max(x.length, y.length);
    return Math.max(sim(na, nb), sim(sa, sb));
  }

  // One-to-one, best scores first. Returns, per left index, { j, score } or null.
  function matchNames(nLeft, nRight, score, threshold = 0.6) {
    const pairs = [];
    for (let i = 0; i < nLeft; i++) {
      for (let j = 0; j < nRight; j++) {
        const s = score(i, j);
        if (s >= threshold) pairs.push({ i, j, s });
      }
    }
    pairs.sort((x, y) => y.s - x.s);
    const out = new Array(nLeft).fill(null);
    const taken = new Set();
    for (const { i, j, s } of pairs) {
      if (out[i] || taken.has(j)) continue;
      out[i] = { j, score: s };
      taken.add(j);
    }
    return out;
  }

  // ------------------------------------------------------------------ draft logic

  const allowedOf = (p) => Math.max(0, Math.floor(Number(p.allowed)) || 0);
  const playerById = (id) => state.players.find((p) => p.id === id);

  // Copies left in the pool. Cards missing from cards.json are never available.
  function remainingMap() {
    const rem = new Map(state.cards.map((c) => [c.name, c.qty || 1]));
    for (const { card } of state.log) rem.set(card, (rem.get(card) || 0) - 1);
    return rem;
  }

  // Snake order: forward, then backward, ...; players out of picks are skipped.
  function turnSequence() {
    const used = state.players.map(() => 0);
    const seq = [];
    for (let round = 0; state.players.some((p, i) => used[i] < allowedOf(p)); round++) {
      const idx = [...state.players.keys()];
      if (round % 2) idx.reverse();
      for (const i of idx) {
        if (used[i] >= allowedOf(state.players[i])) continue;
        used[i]++;
        seq.push({ player: state.players[i], round });
      }
    }
    return seq;
  }

  const draftedBy = (id) => state.log.filter((l) => l.playerId === id).map((l) => l.card);

  // The player's list minus entries already filled by cards they drafted, keeping only
  // entries the pool can still cover (a card listed twice needs two copies left).
  function availablePrefs(player, rem) {
    const mine = new Map();
    for (const c of draftedBy(player.id)) mine.set(c, (mine.get(c) || 0) + 1);
    const left = new Map(rem);
    const out = [];
    player.prefs.forEach((name, i) => {
      if (mine.get(name) > 0) { mine.set(name, mine.get(name) - 1); return; }
      if ((left.get(name) || 0) > 0) {
        left.set(name, left.get(name) - 1);
        out.push({ name, rank: i + 1 });
      }
    });
    return out;
  }

  // Rank on the player's list of each card they drafted (nth copy -> nth listing), or null.
  function draftedWithRanks(player) {
    const seen = new Map();
    return draftedBy(player.id).map((card) => {
      const n = seen.get(card) || 0;
      seen.set(card, n + 1);
      let hit = -1;
      for (let i = 0, k = 0; i < player.prefs.length; i++) {
        if (player.prefs[i] === card && k++ === n) { hit = i; break; }
      }
      return { card, rank: hit < 0 ? null : hit + 1 };
    });
  }

  function current() {
    const seq = turnSequence();
    const rem = remainingMap();
    const poolLeft = [...rem.values()].reduce((a, b) => a + Math.max(0, b), 0);
    const turn = poolLeft > 0 ? seq[state.log.length] : undefined;
    return { seq, rem, turn, done: !turn };
  }

  function makePick() {
    const { turn, rem } = current();
    const card = state.selected;
    if (!turn || !card) return;
    if ((rem.get(card) || 0) <= 0) return setStatus(`${frontName(card)} is no longer available.`);
    state.log.push({ playerId: turn.player.id, card });
    state.selected = null;
    state.showAll = false;
    $('#pool-search').value = '';
    save();
    render();
  }

  function undo() {
    if (!state.log.length) return;
    const last = state.log.pop();
    state.selected = last.card;
    save();
    render();
  }

  // ------------------------------------------------------------------ shared UI

  function setStatus(msg, kind, target = '#csv-status') {
    const s = $(target);
    s.textContent = msg || '';
    s.dataset.kind = kind || '';
    if (msg && state.phase === 'draft') alert(msg);
  }

  function openZoom(name) {
    const card = state.byName.get(name);
    const box = $('#zoom .zoom-imgs');
    box.replaceChildren();
    for (const src of [card && card.img, card && card.back]) {
      if (!src) continue;
      const img = el('img');
      img.src = src;
      img.alt = name;
      box.append(img);
    }
    $('#zoom').showModal();
  }

  function tile(name, { rank, left, small }) {
    const card = state.byName.get(name);
    const t = el('button', 'tile');
    t.type = 'button';
    t.dataset.name = name;
    t.title = `Select ${frontName(name)}`;
    t.classList.toggle('sel', state.selected === name);

    const img = el('img');
    img.src = (card && (small ? card.small : card.img)) || '';
    img.alt = name;
    img.loading = 'lazy';
    t.append(img);

    if (rank) t.append(el('span', 'badge rank-badge', `#${rank}`));
    if (left > 1) t.append(el('span', 'qty', `${left} left`));
    const zoom = el('span', 'zoom', '⤢');
    zoom.title = 'View larger';
    zoom.setAttribute('role', 'button');
    t.append(zoom);
    return t;
  }

  function onTileClick(e) {
    const t = e.target.closest('.tile');
    if (!t) return;
    if (e.target.closest('.zoom')) return openZoom(t.dataset.name);
    state.selected = state.selected === t.dataset.name ? null : t.dataset.name;
    renderDraft();
  }

  // ------------------------------------------------------------------ setup view

  function renderSetup() {
    const tbody = $('#player-rows');
    tbody.replaceChildren(...state.players.map((p, i) => {
      const tr = el('tr');
      tr.dataset.i = i;

      const order = el('td', 'order');
      order.append(el('span', 'rank', `${i + 1}`));
      const up = el('button', 'icon', '▲');
      up.type = 'button'; up.title = 'Move up'; up.dataset.act = 'up'; up.disabled = i === 0;
      const down = el('button', 'icon', '▼');
      down.type = 'button'; down.title = 'Move down'; down.dataset.act = 'down';
      down.disabled = i === state.players.length - 1;
      order.append(up, down);

      const input = (field, type, value, cls) => {
        const td = el('td');
        const inp = el('input', cls);
        inp.type = type;
        inp.value = value == null ? '' : value;
        inp.dataset.f = field;
        if (type === 'number') { inp.min = field === 'allowed' ? 0 : ''; inp.step = 'any'; }
        if (field === 'allowed') inp.step = 1;
        td.append(inp);
        return td;
      };

      const del = el('button', 'icon danger', '✕');
      del.type = 'button'; del.title = 'Remove player'; del.dataset.act = 'del';
      const tdDel = el('td');
      tdDel.append(del);

      tr.append(order,
        input('name', 'text', p.name, 'pname'),
        el('td', 'muted', String(p.prefs.length)),
        input('rating', 'number', p.rating, 'num'),
        input('allowed', 'number', p.allowed, 'num'),
        tdDel);
      return tr;
    }));
    $('#no-players').hidden = state.players.length > 0;
    $('#start').textContent = state.log.length ? 'Resume draft' : 'Start draft';
    renderWarnings();
  }

  function renderWarnings() {
    const warn = [];
    const ps = state.players;
    if (state.log.length) {
      warn.push(`Draft in progress (${state.log.length} picks made). Changing the order or pick counts re-plans the remaining turns.`);
    }
    const noRating = ps.filter((p) => p.rating === '' || p.rating == null);
    if (noRating.length) warn.push(`No rating for: ${noRating.map((p) => p.name || '(unnamed)').join(', ')}.`);
    const noPicks = ps.filter((p) => !allowedOf(p));
    if (noPicks.length) warn.push(`No picks allowed for: ${noPicks.map((p) => p.name || '(unnamed)').join(', ')}. They'll be skipped.`);

    const byRating = new Map();
    for (const p of ps) if (p.rating !== '' && p.rating != null) {
      const k = Number(p.rating);
      byRating.set(k, [...(byRating.get(k) || []), p.name]);
    }
    for (const [r, names] of byRating) if (names.length > 1) {
      warn.push(`${names.join(', ')} share rating ${r}. They pick in the order shown; use ▲/▼ to change it.`);
    }
    const unsorted = ps.some((p, i) => i && Number(p.rating) < Number(ps[i - 1].rating));
    if (unsorted) warn.push('Players are not in rating order. Click "Sort by rating" if that wasn\'t intended.');

    const total = ps.reduce((a, p) => a + allowedOf(p), 0);
    const pool = state.cards.reduce((a, c) => a + (c.qty || 1), 0);
    if (total > pool) warn.push(`${total} picks allowed but only ${pool} cards in the pool. The draft ends when the pool runs out.`);

    const unknown = new Set();
    for (const p of ps) for (const c of p.prefs) if (!state.byName.has(c)) unknown.add(c);
    if (unknown.size) warn.push(`Not in cards.json (will never be offered): ${[...unknown].join(', ')}.`);

    $('#warnings').replaceChildren(...warn.map((w) => el('li', '', w)));
    $('#start').disabled = total === 0;
  }

  function sortByRating() {
    const key = (p) => (p.rating === '' || p.rating == null ? Infinity : Number(p.rating));
    state.players.sort((a, b) => key(a) - key(b)); // stable: ties keep their order
  }

  function setupSetup() {
    const tbody = $('#player-rows');
    tbody.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const p = state.players[Number(e.target.closest('tr').dataset.i)];
      p[f] = f === 'name' ? e.target.value : (e.target.value === '' ? '' : Number(e.target.value));
      save();
      renderWarnings();
    });
    tbody.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const i = Number(b.closest('tr').dataset.i);
      const ps = state.players;
      if (b.dataset.act === 'up') [ps[i - 1], ps[i]] = [ps[i], ps[i - 1]];
      if (b.dataset.act === 'down') [ps[i + 1], ps[i]] = [ps[i], ps[i + 1]];
      if (b.dataset.act === 'del') {
        if (draftedBy(ps[i].id).length) return alert(`${ps[i].name} has already drafted cards. Undo those picks first.`);
        ps.splice(i, 1);
      }
      save();
      renderSetup();
    });

    $('#add-player').addEventListener('click', () => {
      state.players.push({ id: 'p' + Date.now().toString(36), name: '', rating: '', allowed: '', prefs: [] });
      save();
      renderSetup();
      const inputs = document.querySelectorAll('#player-rows .pname');
      inputs[inputs.length - 1].focus();
    });

    $('#sort-rating').addEventListener('click', () => {
      sortByRating();
      save();
      renderSetup();
    });

    $('#start').addEventListener('click', () => {
      state.phase = 'draft';
      save();
      render();
    });

    $('#csv').addEventListener('change', (e) => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
      e.target.value = '';
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f && state.phase === 'setup') loadFile(f);
    });
  }

  async function loadFile(file) {
    let incoming;
    try {
      incoming = playersFromCsv(await file.text());
    } catch (err) {
      return setStatus(err.message, 'error');
    }
    if (state.log.length) {
      return setStatus('A draft is in progress. Reset the draft before loading a new file.', 'error');
    }
    if (state.players.length && !confirm('Replace the current players with this file? Ratings and pick counts are kept for matching players.')) return;
    const old = new Map(state.players.map((p) => [p.id, p]));
    state.players = incoming.map((p) => ({
      ...p,
      rating: old.has(p.id) ? old.get(p.id).rating : '',
      allowed: old.has(p.id) ? old.get(p.id).allowed : '',
    }));
    save();
    setStatus(`Loaded ${incoming.length} players from ${file.name}.`, 'ok');
    renderSetup();
  }

  // ------------------------------------------------------------------ Google Sheet import

  const SHEET_KEY = 'rdp_sheet_cfg';
  const ALIAS_KEY = 'rdp_name_aliases';
  const SHARE_MSG = 'Couldn\'t read the sheet. Make sure it\'s shared as "Anyone with the link can view" and the link is for the right tab.';
  const COLS = {
    pName: ['picks', /name|player/],
    pPicks: ['picks', /token|pick|count|#/],
    rName: ['rank', /name|player/],
    rRating: ['rank', /rank|rating|elo|seed|score/],
  };
  const loadJson = (k) => { try { return JSON.parse(store.get(k) || 'null') || {}; } catch { return {}; } };
  const toNum = (v) => (v == null || String(v).trim() === '' || isNaN(Number(v)) ? '' : Number(v));

  // Any sheet link with the tab open -> CSV for that tab (gviz sends CORS headers).
  function sheetCsvUrl(link) {
    const id = (link.match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1];
    if (!id) throw new Error('That doesn\'t look like a Google Sheets link.');
    const gid = (link.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&gid=${gid}`;
  }

  async function fetchSheetTab(link) {
    const url = sheetCsvUrl(link);
    let text = '';
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) text = await res.text();
    } catch { /* private sheets fail CORS */ }
    if (!text.trim() || text.trimStart().startsWith('<')) throw new Error(SHARE_MSG);
    const [header, ...rows] = parseCsv(text);
    return { header: header.map((h) => h.trim()), rows };
  }

  async function importSheet() {
    const cfgSheet = loadJson(SHEET_KEY);
    cfgSheet.picksLink = $('#sheet-picks').value.trim();
    cfgSheet.rankLink = $('#sheet-rank').value.trim();
    store.set(SHEET_KEY, JSON.stringify(cfgSheet));
    if (!cfgSheet.picksLink || !cfgSheet.rankLink) {
      return setStatus('Paste a link for each tab.', 'error', '#sheet-status');
    }
    $('#sheet-import').disabled = true;
    setStatus('Reading the sheet…', '', '#sheet-status');
    try {
      const [picks, rank] = await Promise.all([fetchSheetTab(cfgSheet.picksLink), fetchSheetTab(cfgSheet.rankLink)]);
      state.sheet = { picks, rank };
      setStatus('', '', '#sheet-status');
      buildColumnSelects();
      renderReview();
      $('#sheet-review').showModal();
    } catch (err) {
      setStatus(err.message, 'error', '#sheet-status');
    } finally {
      $('#sheet-import').disabled = false;
    }
  }

  // Remembered column, else the first header matching the pattern, else the first column.
  function buildColumnSelects() {
    const saved = loadJson(SHEET_KEY).cols || {};
    for (const [key, [tab, re]] of Object.entries(COLS)) {
      const header = state.sheet[tab].header;
      const sel = $(`#col-${key[0]}-${key.slice(1).toLowerCase()}`);
      sel.replaceChildren(...header.map((h, i) => (h ? new Option(h, i) : null)).filter(Boolean));
      const pick = [header.indexOf(saved[key]), header.findIndex((h) => re.test(h.toLowerCase()))].find((i) => i >= 0 && header[i]);
      if (pick != null) sel.value = pick;
    }
  }

  function columnChoice() {
    const out = {};
    for (const key of Object.keys(COLS)) out[key] = Number($(`#col-${key[0]}-${key.slice(1).toLowerCase()}`).value);
    return out;
  }

  // Join the two tabs into one roster; ranking names are matched to pick-count names.
  function sheetRoster() {
    const c = columnChoice();
    const cell = (r, i) => (r[i] || '').trim();
    const roster = state.sheet.picks.rows
      .map((r) => ({ name: cell(r, c.pName), allowed: toNum(cell(r, c.pPicks)), rating: '' }))
      .filter((r) => r.name);
    const ranks = state.sheet.rank.rows
      .map((r) => ({ name: cell(r, c.rName), rating: toNum(cell(r, c.rRating)) }))
      .filter((r) => r.name);
    const m = matchNames(ranks.length, roster.length, (i, j) => nameScore(ranks[i].name, roster[j].name), 0.75);
    const unpaired = [];
    ranks.forEach((r, i) => (m[i] ? (roster[m[i].j].rating = r.rating) : unpaired.push(r.name)));
    for (const r of roster) if (r.allowed !== '') r.allowed = Math.max(0, Math.floor(r.allowed));
    return { roster, unpaired };
  }

  function renderReview() {
    const { roster, unpaired } = sheetRoster();
    const aliases = loadJson(ALIAS_KEY);
    const ps = state.players;
    const score = (i, j) => (aliases[normalize(roster[i].name)] === ps[j].id ? 1 : nameScore(roster[i].name, ps[j].name));
    const m = matchNames(roster.length, ps.length, score);
    const inProgress = state.log.length > 0;
    state.review = roster.map((r, i) => ({ ...r, match: m[i] }));

    $('#review-rows').replaceChildren(...state.review.map((r, i) => {
      const tr = el('tr');
      tr.dataset.i = i;
      const sel = el('select');
      sel.append(new Option(inProgress ? 'Skip (draft in progress)' : 'New player (no list)', inProgress ? 'skip' : 'new'));
      if (!inProgress) sel.append(new Option('Skip', 'skip'));
      for (const p of ps) sel.append(new Option(`${p.name} (${p.prefs.length} ranked)`, p.id));
      sel.value = r.match ? ps[r.match.j].id : sel.options[0].value;
      const status = !r.match ? ['new', ''] : r.match.score >= 1 ? ['✓ exact', 'ok'] : ['check', 'warn'];
      const tdSel = el('td');
      tdSel.append(sel);
      const st = el('td', 'status', status[0]);
      st.dataset.kind = status[1];
      tr.classList.toggle('guess', status[1] === 'warn');
      tr.append(el('td', '', r.name), el('td', '', String(r.rating)), el('td', '', String(r.allowed)), tdSel, st);
      return tr;
    }));

    const notes = [];
    const matched = new Set(m.filter(Boolean).map((x) => ps[x.j].id));
    const orphans = ps.filter((p) => !matched.has(p.id));
    if (orphans.length) notes.push(`Not in the sheet (rank and picks unchanged): ${orphans.map((p) => p.name).join(', ')}.`);
    if (unpaired.length) notes.push(`On the ranking tab but not the pick counts tab (ignored): ${unpaired.join(', ')}.`);
    const noRank = roster.filter((r) => r.rating === '');
    if (noRank.length) notes.push(`No rank found for: ${noRank.map((r) => r.name).join(', ')}.`);
    if (inProgress) notes.push('A draft is in progress: only ranks and pick counts of existing players will change, and the order is kept.');
    $('#review-notes').replaceChildren(...notes.map((n) => el('li', '', n)));
  }

  function applyReview() {
    const rows = [...document.querySelectorAll('#review-rows tr')];
    const choices = rows.map((tr) => tr.querySelector('select').value);
    const ids = choices.filter((v) => v !== 'new' && v !== 'skip');
    const dup = ids.find((v, i) => ids.indexOf(v) !== i);
    if (dup) return alert(`${playerById(dup).name} is matched to more than one sheet row. Fix that before applying.`);

    const aliases = loadJson(ALIAS_KEY);
    let updated = 0, added = 0;
    state.review.forEach((r, i) => {
      const choice = choices[i];
      if (choice === 'skip') return;
      if (choice === 'new') {
        state.players.push({ id: 'p' + Date.now().toString(36) + i, name: r.name, rating: r.rating, allowed: r.allowed, prefs: [] });
        added++;
        return;
      }
      const p = playerById(choice);
      if (normalize(p.name) !== normalize(r.name)) aliases[normalize(r.name)] = p.id;
      Object.assign(p, { name: r.name, rating: r.rating, allowed: r.allowed });
      updated++;
    });
    store.set(ALIAS_KEY, JSON.stringify(aliases));
    store.set(SHEET_KEY, JSON.stringify({ ...loadJson(SHEET_KEY), cols: Object.fromEntries(
      Object.entries(columnChoice()).map(([k, i]) => [k, state.sheet[COLS[k][0]].header[i]])) }));

    if (!state.log.length) sortByRating();
    save();
    $('#sheet-review').close();
    renderSetup();
    setStatus(`Updated ${updated} player${updated === 1 ? '' : 's'}${added ? `, added ${added}` : ''} from the sheet.`, 'ok', '#sheet-status');
  }

  function setupSheet() {
    const saved = loadJson(SHEET_KEY);
    $('#sheet-picks').value = saved.picksLink || '';
    $('#sheet-rank').value = saved.rankLink || '';
    $('#sheet-import').addEventListener('click', importSheet);
    $('#sheet-review .colmap').addEventListener('change', renderReview);
    $('#review-rows').addEventListener('change', (e) => {
      const tr = e.target.closest('tr');
      const st = tr.querySelector('.status');
      st.textContent = 'set';
      st.dataset.kind = 'ok';
      tr.classList.remove('guess');
    });
    $('#review-apply').addEventListener('click', applyReview);
    $('#review-cancel').addEventListener('click', () => $('#sheet-review').close());
  }

  // ------------------------------------------------------------------ draft view

  function renderDraft() {
    const { seq, rem, turn, done } = current();
    if (done) return render();
    const k = state.log.length;
    const p = turn.player;

    $('#progress').textContent = `Round ${turn.round + 1} ${turn.round % 2 ? '←' : '→'} · Pick ${k + 1} of ${seq.length}`;

    // up next
    $('#upnext').replaceChildren(...seq.slice(k + 1, k + 1 + UPNEXT_N).map((t, i, arr) => {
      const prev = i ? arr[i - 1] : turn;
      const li = el('li', t.round !== prev.round ? 'turn new-round' : 'turn', t.player.name);
      if (t.round !== prev.round) li.title = `Round ${t.round + 1}`;
      return li;
    }));
    if (!$('#upnext').children.length) $('#upnext').append(el('li', 'turn muted', 'Last pick!'));

    // on the clock
    const taken = draftedBy(p.id).length;
    $('#clock-name').textContent = p.name;
    const twice = seq[k - 1] && seq[k - 1].player === p ? ' · picks again' : '';
    $('#clock-meta').textContent = `Pick ${taken + 1} of ${allowedOf(p)}${twice}`;

    const prefs = availablePrefs(p, rem);
    const rankOf = new Map();
    for (const a of prefs) if (!rankOf.has(a.name)) rankOf.set(a.name, a.rank);
    const shown = state.showAll ? prefs : prefs.slice(0, TOP_N);
    $('#prefs').replaceChildren(...shown.map((a) => tile(a.name, { rank: a.rank, left: rem.get(a.name) })));
    $('#prefs-empty').hidden = prefs.length > 0;
    $('#prefs-empty').textContent = p.prefs.length ? 'Nothing from their list is left.' : `${p.name} didn't submit a list.`;
    $('#more').hidden = prefs.length <= TOP_N;
    $('#more').textContent = state.showAll ? 'Show fewer' : `Show all ${prefs.length} still available`;

    // pool search (cards on their list get their rank badge)
    const q = $('#pool-search').value.trim().toLowerCase();
    const matches = state.cards.filter((c) => rem.get(c.name) > 0
      && (!q || c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)));
    $('#pool').replaceChildren(...matches.slice(0, POOL_LIMIT).map((c) =>
      tile(c.name, { rank: rankOf.get(c.name), left: rem.get(c.name), small: true })));
    $('#pool-shown').textContent = matches.length > POOL_LIMIT
      ? `Showing ${POOL_LIMIT} of ${matches.length} matching cards. Search to narrow it down.`
      : `${matches.length} matching card${matches.length === 1 ? '' : 's'} left in the pool.`;

    // selection
    const sel = state.selected && rem.get(state.selected) > 0 ? state.selected : null;
    state.selected = sel;
    const selBox = $('#selected');
    if (sel) {
      const r = rankOf.get(sel);
      selBox.replaceChildren(nameNode(sel, 'sel-name'), el('span', 'muted', r ? ` · #${r} on their list` : ' · not on their list'));
    } else {
      selBox.textContent = 'Select a card';
    }
    selBox.classList.toggle('muted', !sel);
    $('#confirm').disabled = !sel;
    $('#confirm').textContent = sel ? `Confirm pick for ${p.name}` : 'Confirm pick';

    renderLog(p);
  }

  function renderLog(active) {
    $('#log').replaceChildren(...state.players.map((p) => {
      const box = el('section', p === active ? 'log-player active' : 'log-player');
      const head = el('div', 'log-head');
      head.append(el('strong', '', p.name), el('span', 'muted', ` ${draftedBy(p.id).length}/${allowedOf(p)}`));
      box.append(head);
      const ol = el('ol', 'log-cards');
      for (const { card, rank } of draftedWithRanks(p)) {
        const li = el('li');
        li.append(nameNode(card, ''), el('span', 'muted', rank ? ` #${rank}` : ' unranked'));
        ol.append(li);
      }
      box.append(ol);
      return box;
    }));
  }

  function setupDraft() {
    $('#prefs').addEventListener('click', onTileClick);
    $('#pool').addEventListener('click', onTileClick);
    $('#pool-search').addEventListener('input', renderDraft);
    $('#more').addEventListener('click', () => { state.showAll = !state.showAll; renderDraft(); });
    $('#confirm').addEventListener('click', makePick);
    $('#undo').addEventListener('click', undo);
    $('#back-to-draft').addEventListener('click', undo);
    $('#to-setup').addEventListener('click', () => { state.phase = 'setup'; save(); render(); });
    $('#export').addEventListener('click', exportCsv);
    $('#reset').addEventListener('click', () => {
      if (!confirm('Clear all picks and go back to setup? Players, ratings and pick counts are kept.')) return;
      state.log = [];
      state.phase = 'setup';
      state.selected = null;
      save();
      render();
    });
    document.addEventListener('keydown', (e) => {
      if (state.phase !== 'draft' || e.target.closest('input')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    });
  }

  // ------------------------------------------------------------------ results

  function renderDone() {
    $('#progress').textContent = `Complete · ${state.log.length} picks`;
    $('#results').replaceChildren(...state.players.map((p) => {
      const box = el('section', 'result');
      box.append(el('h3', '', `${p.name} (${draftedBy(p.id).length})`));
      const grid = el('div', 'grid result-grid');
      for (const { card, rank } of draftedWithRanks(p)) {
        const t = tile(card, { rank, small: true });
        if (!rank) t.append(el('span', 'qty', 'unranked'));
        grid.append(t);
      }
      box.append(grid);
      return box;
    }));
  }

  function exportCsv() {
    const seq = turnSequence();
    const ranks = new Map(state.players.map((p) => [p.id, draftedWithRanks(p)]));
    const used = new Map();
    const lines = [['pick_no', 'round', 'player', 'card', 'list_rank']];
    state.log.forEach((l, i) => {
      const p = playerById(l.playerId);
      const n = used.get(l.playerId) || 0;
      used.set(l.playerId, n + 1);
      const r = ranks.get(l.playerId)[n].rank;
      lines.push([i + 1, seq[i] ? seq[i].round + 1 : '', p ? p.name : l.playerId, l.card, r || '']);
    });
    const blob = new Blob([lines.map((r) => r.map(csvField).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `draft-results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ view switching

  function render() {
    const drafting = state.phase === 'draft';
    const done = drafting && current().done;
    $('#setup').hidden = drafting;
    $('#draft').hidden = !drafting || done;
    $('#done').hidden = !done;
    $('#progress').hidden = !drafting;
    $('#undo').hidden = !drafting || done || !state.log.length;
    $('#to-setup').hidden = !drafting;
    $('#reset').hidden = !state.log.length && !drafting;
    if (!drafting) renderSetup();
    else if (done) renderDone();
    else renderDraft();
  }

  // ------------------------------------------------------------------ init

  async function init() {
    const title = (cfg.title ? cfg.title + ' · ' : '') + 'Live Draft';
    document.title = title;
    $('#title').textContent = title;

    try {
      const res = await fetch('cards.json', { cache: 'no-cache' });
      state.cards = await res.json();
    } catch {
      $('#setup').hidden = false;
      setStatus('Could not load cards.json. Open this page through scripts\\serve.ps1 or GitHub Pages.', 'error');
      return;
    }
    for (const c of state.cards) state.byName.set(c.name, c);

    restore();
    setupSetup();
    setupSheet();
    setupDraft();
    render();
  }

  init();
})();
