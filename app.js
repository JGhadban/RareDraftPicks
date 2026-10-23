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

  // "Diviner of Victory // Unwind History": filter on the front face, show the rest muted.
  const frontType = (card) => card.type.split(' // ')[0];
  const frontName = (name) => name.split(' // ')[0];
  function nameNode(name, cls) {
    const [front, ...rest] = name.split(' // ');
    const span = el('span', cls, front);
    if (rest.length) span.append(el('span', 'alt', ` // ${rest.join(' // ')}`));
    return span;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'];
  const RARITIES = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'];
  const TOKEN_KEY = 'rdp_token';

  const state = {
    cards: [],
    byName: new Map(),
    badges: new Map(),   // card name -> badge element in the grid
    picks: [],           // ordered card names; duplicates = extra copies
    token: null,
    deadline: null,
    locked: false,
    dirty: false,
    colors: new Set(),
  };

  // Copies available. Cards missing from cards.json (list changed) are uncapped.
  const qtyOf = (name) => {
    const card = state.byName.get(name);
    return card ? card.qty || 1 : Infinity;
  };
  const countOf = (name) => state.picks.filter((n) => n === name).length;

  // ------------------------------------------------------------------ storage (best effort)

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const draftKey = () => 'rdp_draft_' + (state.token || 'new');

  function saveDraft() {
    store.set(draftKey(), JSON.stringify({ name: $('#name').value, picks: state.picks }));
  }

  // ------------------------------------------------------------------ Supabase RPC

  async function rpc(fn, args) {
    const key = cfg.supabaseAnonKey;
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // legacy JWT anon key
    const res = await fetch(`${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(args || {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && data.message) || `Request failed (${res.status})`);
    return data;
  }

  // ------------------------------------------------------------------ status / dirty

  function setStatus(msg, kind) {
    const s = $('#status');
    s.textContent = msg || '';
    s.dataset.kind = kind || '';
  }

  function markDirty() {
    state.dirty = true;
    saveDraft();
    setStatus('Unsaved changes', 'warn');
  }

  // ------------------------------------------------------------------ card grid

  function buildFilters() {
    const types = TYPES.filter((t) => state.cards.some((c) => frontType(c).includes(t)));
    for (const t of types) $('#type').append(new Option(t, t));
    const rarities = RARITIES.filter((r) => state.cards.some((c) => c.rarity === r));
    for (const r of rarities) $('#rarity').append(new Option(r[0].toUpperCase() + r.slice(1), r));

    $('#search').addEventListener('input', applyFilters);
    $('#type').addEventListener('change', applyFilters);
    $('#rarity').addEventListener('change', applyFilters);
    $('#colors').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-c]');
      if (!b) return;
      const c = b.dataset.c;
      state.colors.has(c) ? state.colors.delete(c) : state.colors.add(c);
      b.classList.toggle('on', state.colors.has(c));
      applyFilters();
    });
  }

  function matchesColor(card) {
    if (!state.colors.size) return true;
    const cs = card.colors || [];
    for (const c of state.colors) {
      if (c === 'C' && cs.length === 0) return true;
      if (c === 'M' && cs.length > 1) return true;
      if (cs.includes(c)) return true;
    }
    return false;
  }

  function applyFilters() {
    const q = $('#search').value.trim().toLowerCase();
    const type = $('#type').value;
    const rarity = $('#rarity').value;
    let shown = 0;
    for (const tile of $('#grid').children) {
      const card = state.byName.get(tile.dataset.name);
      const ok = (!q || card.name.toLowerCase().includes(q) || card.type.toLowerCase().includes(q))
        && (!type || frontType(card).includes(type))
        && (!rarity || card.rarity === rarity)
        && matchesColor(card);
      tile.hidden = !ok;
      if (ok) shown++;
    }
    $('#shown').textContent = `${shown} of ${state.cards.length} cards`;
  }

  function buildGrid() {
    const grid = $('#grid');
    for (const card of state.cards) {
      const tile = el('button', 'tile');
      tile.type = 'button';
      tile.dataset.name = card.name;
      tile.title = `Add ${frontName(card.name)}`;

      const img = el('img');
      img.src = card.img || '';
      img.alt = card.name;
      img.loading = 'lazy';
      img.width = 244; img.height = 340;

      const badge = el('span', 'badge');
      badge.hidden = true;
      state.badges.set(card.name, badge);

      const zoom = el('span', 'zoom', '⤢');
      zoom.title = 'View larger';
      zoom.setAttribute('role', 'button');

      tile.append(img, badge, zoom);
      if ((card.qty || 1) > 1) tile.append(el('span', 'qty', `${card.qty} available`));
      grid.append(tile);
    }

    grid.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      if (e.target.closest('.zoom')) return openZoom(tile.dataset.name);
      addPick(tile.dataset.name);
    });
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

  function updateBadges() {
    const counts = new Map();
    for (const n of state.picks) counts.set(n, (counts.get(n) || 0) + 1);
    for (const [name, badge] of state.badges) {
      const n = counts.get(name) || 0;
      const qty = qtyOf(name);
      const tile = badge.parentElement;
      badge.hidden = n === 0;
      badge.textContent = qty > 1 ? `${n}/${qty}` : '✓';
      tile.classList.toggle('picked', n > 0);
      tile.classList.toggle('maxed', n >= qty);
      tile.title = n >= qty
        ? (qty > 1 ? `All ${qty} copies of ${frontName(name)} picked` : `${frontName(name)} picked`)
        : `Add ${frontName(name)}`;
    }
  }

  // ------------------------------------------------------------------ priority list

  function addPick(name) {
    if (state.locked) return;
    const qty = qtyOf(name);
    if (countOf(name) >= qty) {
      setStatus(qty > 1
        ? `You've already picked all ${qty} copies of ${frontName(name)}.`
        : `${frontName(name)} is already in your list (only 1 available).`, 'error');
      return;
    }
    state.picks.push(name);
    renderPicks();
    markDirty();
    setStatus(`Added ${frontName(name)} at #${state.picks.length}. Unsaved changes`, 'warn');
  }

  // Drop the lowest-ranked extras if someone holds more copies than exist (list changed).
  function trimToQuantities() {
    const seen = new Map();
    const before = state.picks.length;
    state.picks = state.picks.filter((name) => {
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      return n <= qtyOf(name);
    });
    const removed = before - state.picks.length;
    if (removed) {
      state.dirty = true;
      saveDraft();
      setStatus(`Removed ${removed} pick${removed > 1 ? 's' : ''} that exceeded the copies available. Save to keep this.`, 'warn');
    }
  }

  function renderPicks() {
    const ol = $('#picks');
    const seen = new Map();
    ol.replaceChildren(...state.picks.map((name, i) => {
      const copy = (seen.get(name) || 0) + 1;
      seen.set(name, copy);
      const card = state.byName.get(name);

      const li = el('li', 'pick');
      li.append(el('span', 'rank', `#${i + 1}`));
      const thumb = el('img', 'thumb');
      thumb.src = (card && card.small) || '';
      thumb.alt = '';
      li.append(thumb);
      const label = nameNode(name, 'pick-name');
      const qty = qtyOf(name);
      if (qty > 1 && qty !== Infinity) label.append(el('span', 'copy', ` copy ${copy} of ${qty}`));
      else if (copy > 1) label.append(el('span', 'copy', ` copy ${copy}`));
      li.append(label);

      const top = el('button', 'icon', '⤒');
      top.type = 'button'; top.title = 'Move to #1'; top.dataset.act = 'top'; top.dataset.i = i;
      const del = el('button', 'icon danger', '✕');
      del.type = 'button'; del.title = 'Remove'; del.dataset.act = 'del'; del.dataset.i = i;
      li.append(top, del);
      return li;
    }));

    $('#empty').hidden = state.picks.length > 0;
    document.querySelectorAll('.pick-count').forEach((n) => { n.textContent = state.picks.length; });
    updateBadges();
  }

  function setupList() {
    const ol = $('#picks');
    ol.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || state.locked) return;
      const i = Number(b.dataset.i);
      const [name] = state.picks.splice(i, 1);
      if (b.dataset.act === 'top') state.picks.unshift(name);
      renderPicks();
      markDirty();
    });

    if (window.Sortable) {
      state.sortable = new Sortable(ol, {
        animation: 150,
        delay: 150,
        delayOnTouchOnly: true,
        filter: 'button',
        preventOnFilter: false,
        onEnd(e) {
          if (e.oldIndex === e.newIndex) return;
          const [name] = state.picks.splice(e.oldIndex, 1);
          state.picks.splice(e.newIndex, 0, name);
          renderPicks();
          markDirty();
        },
      });
    }
  }

  // ------------------------------------------------------------------ save / edit link

  const editUrl = () => `${location.origin}${location.pathname}?t=${state.token}`;

  function showEditLink() {
    $('#edit-link').hidden = !state.token;
    $('#not-me').hidden = !state.token;
    if (state.token) $('#edit-url').value = editUrl();
  }

  async function save() {
    if (state.locked) return;
    const name = $('#name').value.trim();
    if (!name) {
      setStatus('Enter your name first.', 'error');
      $('#name').focus();
      return;
    }
    $('#save').disabled = true;
    setStatus('Saving…');
    try {
      if (!state.token) {
        const oldDraft = draftKey();
        state.token = await rpc('create_submission', { p_name: name, p_picks: state.picks });
        store.del(oldDraft);
        store.set(TOKEN_KEY, state.token);
        history.replaceState(null, '', editUrl());
        showEditLink();
        $('#edit-link').classList.add('flash');
      } else {
        await rpc('update_submission', { p_token: state.token, p_name: name, p_picks: state.picks });
      }
      state.dirty = false;
      store.del(draftKey());
      setStatus(`Saved ${state.picks.length} picks at ${new Date().toLocaleTimeString()}`, 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      $('#save').disabled = state.locked;
    }
  }

  async function copyLink() {
    const input = $('#edit-url');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('#copy').textContent = 'Copied!';
    setTimeout(() => { $('#copy').textContent = 'Copy'; }, 1500);
  }

  function startFresh() {
    if (state.dirty && !confirm('Discard unsaved changes?')) return;
    store.del(TOKEN_KEY);
    store.del(draftKey());
    state.dirty = false;
    location.href = location.pathname;
  }

  // ------------------------------------------------------------------ deadline

  function renderDeadline() {
    const box = $('#deadline');
    if (!state.deadline) { box.hidden = true; return; }
    box.hidden = false;
    const ms = state.deadline - Date.now();
    const when = state.deadline.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    if (ms <= 0) {
      box.textContent = `Picks closed ${when}`;
      box.classList.add('closed');
      setLocked(true);
      return;
    }
    const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
    const left = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
    box.textContent = `Picks close ${when} (${left} left)`;
    box.classList.toggle('soon', ms < 864e5);
  }

  function setLocked(locked) {
    state.locked = locked;
    document.body.classList.toggle('locked', locked);
    $('#save').disabled = locked;
    $('#name').disabled = locked;
    if (state.sortable) state.sortable.option('disabled', locked);
    if (locked) setStatus('The deadline has passed. Picks can no longer be changed.', 'error');
  }

  // ------------------------------------------------------------------ tabs (mobile)

  function setupTabs() {
    document.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      $('.panes').dataset.active = b.dataset.tab;
      document.querySelectorAll('.tabs [data-tab]').forEach((t) => t.setAttribute('aria-selected', t === b));
      window.scrollTo({ top: $('.tabs').offsetTop, behavior: 'smooth' });
    });
  }

  // ------------------------------------------------------------------ init

  async function init() {
    document.title = cfg.title || document.title;
    $('#title').textContent = cfg.title || $('#title').textContent;

    if (!cfg.supabaseUrl || /YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {
      setStatus('Setup needed: fill in config.js with your Supabase URL and key.', 'error');
    }

    try {
      const res = await fetch('cards.json', { cache: 'no-cache' });
      state.cards = await res.json();
    } catch {
      setStatus('Could not load cards.json.', 'error');
      return;
    }
    for (const c of state.cards) state.byName.set(c.name, c);

    buildFilters();
    buildGrid();
    setupList();
    setupTabs();
    applyFilters();

    $('#save').addEventListener('click', save);
    $('#copy').addEventListener('click', copyLink);
    $('#not-me').addEventListener('click', startFresh);
    $('#name').addEventListener('input', markDirty);
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Identify the person: ?t= link wins, then the token remembered on this device.
    const urlToken = new URLSearchParams(location.search).get('t');
    const token = [urlToken, store.get(TOKEN_KEY)].find((t) => t && UUID_RE.test(t));

    try {
      const [deadline, sub] = await Promise.all([
        rpc('get_deadline'),
        token ? rpc('get_submission', { p_token: token }) : null,
      ]);
      state.deadline = deadline ? new Date(deadline) : null;
      if (sub) {
        state.token = token;
        store.set(TOKEN_KEY, token);
        if (!urlToken) history.replaceState(null, '', editUrl());
        $('#name').value = sub.name;
        state.picks = Array.isArray(sub.picks) ? sub.picks : [];
        setStatus(`Loaded your saved picks (last saved ${new Date(sub.updated_at).toLocaleString()}).`, 'ok');
      } else if (token) {
        if (token === store.get(TOKEN_KEY)) store.del(TOKEN_KEY);
        setStatus('That edit link was not recognised. You can start a new list.', 'error');
      }
    } catch (err) {
      setStatus(`Could not reach the server: ${err.message}`, 'error');
    }

    // Restore unsaved local edits, if any (and still allowed).
    try {
      const draft = JSON.parse(store.get(draftKey()) || 'null');
      const closed = state.deadline && state.deadline <= Date.now();
      const same = draft && draft.name === $('#name').value
        && JSON.stringify(draft.picks) === JSON.stringify(state.picks);
      if (closed || same) {
        store.del(draftKey());
      } else if (draft && Array.isArray(draft.picks)) {
        $('#name').value = draft.name || $('#name').value;
        state.picks = draft.picks;
        state.dirty = true;
        setStatus('Restored your unsaved changes. Remember to save.', 'warn');
      }
    } catch { /* ignore bad draft */ }

    if (!state.locked && !(state.deadline && state.deadline <= Date.now())) trimToQuantities();

    showEditLink();
    renderPicks();
    renderDeadline();
    setInterval(renderDeadline, 30000);
  }

  init();
})();
