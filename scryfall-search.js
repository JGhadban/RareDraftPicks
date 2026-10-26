// A subset of Scryfall's search syntax, run against cards.json entries.
// ScryfallSearch.compile(query) -> { test(card) -> bool, error: string | null }.
// Half-typed input (open quote or parenthesis, "pow>") is tolerated. On a real syntax error or
// unknown key, test() falls back to a plain name/type substring match.
(() => {
  'use strict';

  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ------------------------------------------------------------------ colors

  const WUBRG = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_NAMES = {
    white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
    azorius: 'WU', dimir: 'UB', rakdos: 'BR', gruul: 'RG', selesnya: 'GW',
    orzhov: 'WB', izzet: 'UR', golgari: 'BG', boros: 'RW', simic: 'GU',
    bant: 'GWU', esper: 'WUB', grixis: 'UBR', jund: 'BRG', naya: 'RGW',
    abzan: 'WBG', jeskai: 'URW', sultai: 'BGU', mardu: 'RWB', temur: 'GUR',
    chaos: 'UBRG', aggression: 'BRGW', altruism: 'RGWU', growth: 'GWUB', artifice: 'WUBR',
    wubrg: 'WUBRG', rainbow: 'WUBRG', fivecolor: 'WUBRG',
  };

  // -> { set: Set } | { colorless: true } | { multi: true } | null
  function parseColors(v) {
    v = fold(v);
    if (v === 'c' || v === 'colorless') return { colorless: true };
    if (v === 'm' || v === 'multi' || v === 'multicolor') return { multi: true };
    const letters = COLOR_NAMES[v] || v.toUpperCase();
    if (!/^[WUBRG]+$/.test(letters)) return null;
    return { set: new Set(letters) };
  }

  function compareColors(cardColors, op, value) {
    const have = new Set(cardColors || []);
    if (/^\d+$/.test(value)) return cmpNum(have.size, op, Number(value));
    const want = parseColors(value);
    if (!want) throw new Error(`Unknown color "${value}"`);
    if (want.colorless) return op === '!=' ? have.size > 0 : have.size === 0;
    if (want.multi) return op === '!=' ? have.size <= 1 : have.size > 1;
    const sup = [...want.set].every((c) => have.has(c));
    const sub = [...have].every((c) => want.set.has(c));
    switch (op) {
      case ':': case '>=': return sup;
      case '=': return sup && sub;
      case '!=': return !(sup && sub);
      case '<=': return sub;
      case '<': return sub && !sup;
      case '>': return sup && !sub;
    }
    return false;
  }

  // Color identity defaults to "subset" for ':' like Scryfall (commander-style).
  const compareIdentity = (ids, op, value) => compareColors(ids, op === ':' ? '<=' : op, value);

  // ------------------------------------------------------------------ numbers

  function cmpNum(a, op, b) {
    if (a == null || Number.isNaN(a) || b == null || Number.isNaN(b)) return false;
    switch (op) {
      case ':': case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
    return false;
  }

  // "*" counts as 0 and "1+*" as 1, as on Scryfall.
  const statNum = (s) => {
    if (s == null || s === '') return null;
    const n = parseFloat(String(s).replace(/\*/g, '0'));
    return Number.isNaN(n) ? 0 : n;
  };

  const STATS = { pow: 'power', power: 'power', tou: 'toughness', toughness: 'toughness',
    loy: 'loyalty', loyalty: 'loyalty', def: 'defense', defense: 'defense',
    mv: 'cmc', cmc: 'cmc', manavalue: 'cmc' };

  // Stats for each face (or the card itself), so a DFC matches if either side does.
  const faceStats = (card, field) => {
    if (field === 'cmc') return [card.cmc];
    const faces = card.faces && card.faces.length ? card.faces : [card];
    return faces.map((f) => statNum(f[field]));
  };

  // ------------------------------------------------------------------ text helpers

  const texts = (card, field) => {
    const faces = card.faces && card.faces.length ? card.faces : [];
    return [card[field], ...faces.map((f) => f[field])].filter((t) => t != null);
  };

  // Mana costs: "{2}{U}{U}" or shorthand "2uu" -> ["{2}", "{U}", "{U}"].
  function manaSymbols(s) {
    s = String(s || '').toUpperCase();
    const out = [];
    const re = /\{([^}]+)\}|(\d+)|([WUBRGCXSYZ])/g;
    let m;
    while ((m = re.exec(s))) out.push(`{${m[1] || m[2] || m[3]}}`);
    return out;
  }

  function hasMana(cost, want) {
    const pool = manaSymbols(cost);
    for (const sym of want) {
      const i = pool.indexOf(sym);
      if (i < 0) return false;
      pool.splice(i, 1);
    }
    return true;
  }

  const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, special: 3, mythic: 4, bonus: 5 };
  const RARITY_ABBR = { c: 'common', u: 'uncommon', r: 'rare', s: 'special', m: 'mythic', b: 'bonus' };

  const PERMANENTS = ['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'battle'];
  const IS = {
    dfc: (c) => !!c.back || ['transform', 'modal_dfc', 'meld', 'reversible_card'].includes(c.layout),
    mdfc: (c) => c.layout === 'modal_dfc',
    transform: (c) => c.layout === 'transform',
    split: (c) => c.layout === 'split',
    adventure: (c) => c.layout === 'adventure',
    flip: (c) => c.layout === 'flip',
    prepare: (c) => c.layout === 'prepare',
    multiface: (c) => !!(c.faces && c.faces.length),
    permanent: (c) => PERMANENTS.some((t) => fold(c.type.split(' // ')[0]).includes(t)),
    spell: (c) => !fold(c.type.split(' // ')[0]).includes('land'),
    multicolor: (c) => (c.colors || []).length > 1,
    colorless: (c) => (c.colors || []).length === 0,
    monocolor: (c) => (c.colors || []).length === 1,
    hybrid: (c) => /\{[WUBRG2]\/[WUBRG]\}/.test(c.mana || ''),
    phyrexian: (c) => /\{[WUBRG]\/P\}/.test(c.mana || ''),
    vanilla: (c) => !c.oracle,
    legendary: (c) => fold(c.type).includes('legendary'),
  };

  // ------------------------------------------------------------------ tokenizer

  // Tokens: '(' ')' 'or' '-' (negates the next group) and terms { neg, key, op, value, regex, exact }.
  function tokenize(q) {
    const toks = [];
    let i = 0;
    const readValue = () => {
      if (q[i] === '"') {
        // An unclosed quote (still typing) runs to the end of the query.
        let end = q.indexOf('"', i + 1);
        if (end < 0) end = q.length;
        const v = q.slice(i + 1, end);
        i = end + 1;
        return { value: v };
      }
      if (q[i] === '/') {
        let j = i + 1;
        while (j < q.length && q[j] !== '/') j += q[j] === '\\' ? 2 : 1;
        if (j >= q.length) throw new Error('Missing closing / in regex');
        const src = q.slice(i + 1, j);
        i = j + 1;
        try { return { value: src, regex: new RegExp(src, 'i') }; } catch { throw new Error(`Bad regex /${src}/`); }
      }
      const m = /^[^\s()]*/.exec(q.slice(i));
      i += m[0].length;
      return { value: m[0] };
    };

    while (i < q.length) {
      const ch = q[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '(' || ch === ')') { toks.push(ch); i++; continue; }

      let neg = false;
      if (ch === '-' && i + 1 < q.length && !/\s/.test(q[i + 1])) { neg = true; i++; }
      if (neg && q[i] === '(') { toks.push('-'); continue; }

      if (q[i] === '!') {
        i++;
        toks.push({ neg, key: 'exact', op: '=', ...readValue() });
        continue;
      }

      const km = /^([a-z]+)(>=|<=|!=|:|=|<|>)/i.exec(q.slice(i));
      if (km) {
        i += km[0].length;
        toks.push({ neg, key: km[1].toLowerCase(), op: km[2], ...readValue() });
        continue;
      }

      const v = readValue();
      if (!v.regex && q[i - 1] !== '"' && /^or$/i.test(v.value) && !neg) { toks.push('or'); continue; }
      if (!v.value && !v.regex) { i++; continue; }
      toks.push({ neg, key: 'name', op: ':', ...v });
    }
    return toks;
  }

  // ------------------------------------------------------------------ term -> predicate

  function textPred(value, regex, field) {
    if (regex) return (card) => texts(card, field).some((t) => regex.test(t));
    const v = fold(value);
    return (card) => texts(card, field).some((t) => fold(t).includes(v));
  }

  function termPred(t) {
    const { key, op, value, regex } = t;
    if (value === '' && !regex) return () => true; // "pow>" while still typing
    switch (key) {
      case 'name': case 'n':
        return textPred(value, regex, 'name');
      case 'exact': {
        const v = fold(value);
        return (card) => fold(card.name) === v || fold(card.name).split(' // ').includes(v);
      }
      case 'o': case 'oracle': case 'text': {
        if (regex) return textPred(value, regex, 'oracle');
        const v = fold(value);
        if (!v.includes('~')) return (card) => texts(card, 'oracle').some((txt) => fold(txt).includes(v));
        // "~" stands for the card itself: its full name, its short name ("Codie"), or "this creature" etc.
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return (card) => {
          const names = [card.name, ...(card.faces || []).map((f) => f.name)].map(fold)
            .flatMap((n) => [n, n.split(',')[0]]);
          const self = `(?:${names.map(esc).join('|')}|this [a-z]+)`;
          const re = new RegExp(v.split('~').map(esc).join(self));
          return texts(card, 'oracle').some((txt) => re.test(fold(txt)));
        };
      }
      case 't': case 'type':
        return textPred(value, regex, 'type');
      case 'kw': case 'keyword': {
        const v = fold(value);
        return (card) => (card.keywords || []).some((k) => fold(k) === v || fold(k).includes(v));
      }
      case 'c': case 'color': case 'colors':
        parseOrCount(value);
        return (card) => compareColors(card.colors, op, value);
      case 'id': case 'identity': case 'ci':
        parseOrCount(value);
        return (card) => compareIdentity(card.identity || card.colors, op, value);
      case 'm': case 'mana': {
        const want = manaSymbols(value);
        if (!want.length) throw new Error(`Bad mana cost "${value}"`);
        if (op === '=') {
          const key = want.slice().sort().join('');
          return (card) => texts(card, 'mana').some((m) => manaSymbols(m).sort().join('') === key);
        }
        return (card) => texts(card, 'mana').some((m) => hasMana(m, want));
      }
      case 'r': case 'rarity': {
        const r = RARITY_ABBR[fold(value)] || fold(value);
        if (!(r in RARITY_ORDER)) throw new Error(`Unknown rarity "${value}"`);
        return (card) => (op === ':' ? card.rarity === r : cmpNum(RARITY_ORDER[card.rarity], op, RARITY_ORDER[r]));
      }
      case 's': case 'set': case 'e': case 'edition': {
        const v = fold(value);
        return (card) => (op === '!=' ? fold(card.set) !== v : fold(card.set) === v);
      }
      case 'is': case 'not': {
        const f = IS[fold(value)];
        if (!f) throw new Error(`Unknown is:${value}`);
        return key === 'not' ? (card) => !f(card) : f;
      }
      case 'qty': case 'copies':
        if (!/^\d+$/.test(value)) throw new Error(`Bad number "${value}"`);
        return (card) => cmpNum(card.qty || 1, op, Number(value));
    }

    if (key in STATS) {
      const field = STATS[key];
      const v = fold(value);
      if (field === 'cmc' && (v === 'even' || v === 'odd')) {
        return (card) => card.cmc % 2 === (v === 'even' ? 0 : 1);
      }
      if (v in STATS) { // pow>tou: compare two stats on the same face
        const other = STATS[v];
        return (card) => {
          const faces = card.faces && card.faces.length ? card.faces : [card];
          return faces.some((f) => cmpNum(field === 'cmc' ? card.cmc : statNum(f[field]),
            op, other === 'cmc' ? card.cmc : statNum(f[other])));
        };
      }
      if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Bad number "${value}"`);
      const n = Number(value);
      return (card) => faceStats(card, field).some((s) => cmpNum(s, op, n));
    }

    throw new Error(`Unknown key "${key}"`);
  }

  function parseOrCount(value) {
    if (!/^\d+$/.test(value) && !parseColors(value)) throw new Error(`Unknown color "${value}"`);
  }

  // ------------------------------------------------------------------ parser
  // query := and ('or' and)* ; and := unit+ ; unit := '-'? '(' query ')' | term

  function parse(toks) {
    let pos = 0;
    const peek = () => toks[pos];

    function parseOr() {
      const parts = [parseAnd()];
      while (peek() === 'or') { pos++; parts.push(parseAnd()); }
      return parts.length === 1 ? parts[0] : (card) => parts.some((p) => p(card));
    }

    function parseAnd() {
      const parts = [];
      while (pos < toks.length && peek() !== ')' && peek() !== 'or') parts.push(parseUnit());
      if (!parts.length) throw new Error('Empty group');
      return parts.length === 1 ? parts[0] : (card) => parts.every((p) => p(card));
    }

    function parseUnit() {
      const t = toks[pos++];
      if (t === '-') {
        const p = parseUnit();
        return (card) => !p(card);
      }
      if (t === '(') {
        if (pos >= toks.length) return () => true; // just typed "("
        const inner = parseOr();
        if (pos < toks.length && toks[pos++] !== ')') throw new Error('Missing )');
        return inner; // a group left open at the end (still typing) is closed implicitly
      }
      if (typeof t === 'string') throw new Error(`Unexpected ${t}`);
      const p = termPred(t);
      return t.neg ? (card) => !p(card) : p;
    }

    const pred = parseOr();
    if (pos < toks.length) throw new Error('Unexpected )');
    return pred;
  }

  // ------------------------------------------------------------------ public

  function fallback(q) {
    const v = fold(q);
    return (card) => fold(card.name).includes(v) || fold(card.type).includes(v);
  }

  function compile(query) {
    const q = String(query || '').trim();
    if (!q) return { test: () => true, error: null };
    try {
      const pred = parse(tokenize(q));
      // A bad value can only surface per card (e.g. a weird color); treat that card as a non-match.
      const test = (card) => {
        try { return pred(card); } catch { return false; }
      };
      return { test, error: null };
    } catch (err) {
      return { test: fallback(q), error: err.message };
    }
  }

  window.ScryfallSearch = { compile };
})();
