// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, its filters, a per-protocol detail drawer and the calibration behind the
// prices. No network: every byte it shows arrived in data.js.
//
// The page recomputes every row's implied value from the components data.js carries (TVL, the
// category's peer multiple, the chain factor, and the growth and maturity multipliers it derives
// from the row's own change_7d and age), with the same rounding lib/model.ts uses, so the number
// on screen is the number board.json carries, checked in the open.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var CAL = DATA.calibration;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', band: 'all', tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // The model, recomputed: the same arithmetic as impliedValue in lib/model.ts.
  function growthOf(row) {
    var g = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, CAL.growth_floor_pct, CAL.growth_cap_pct);
    return round4(1 + (g / 100) * CAL.growth_weight);
  }
  function maturityOf(row) {
    var age = row.age_days === null || row.age_days === undefined ? CAL.unknown_age_days : row.age_days;
    return round4(CAL.maturity_floor + (Math.min(Math.max(age, 0), CAL.maturity_days) / CAL.maturity_days) * CAL.maturity_range);
  }
  function impliedOf(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.model.peer_multiple * row.model.chain_factor * growthOf(row) * maturityOf(row)));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('band')) state.band = params.get('band');
    if (params.get('tab') === 'live') state.tab = 'live';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.band !== 'all') params.set('band', state.band);
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  var BANDS = [
    ['all', 'Any value'],
    ['b1', 'Implied $1B and up'],
    ['m100', 'Implied $100M to $1B'],
    ['m10', 'Implied $10M to $100M'],
    ['u10', 'Implied under $10M']
  ];
  function inBand(v) {
    if (state.band === 'b1') return v >= 1e9;
    if (state.band === 'm100') return v >= 1e8 && v < 1e9;
    if (state.band === 'm10') return v >= 1e7 && v < 1e8;
    if (state.band === 'u10') return v < 1e7;
    return true;
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!inBand(r.implied_value_usd)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'mult') { av = a.model.peer_multiple; bv = b.model.peer_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'Token Radar' }),
          el('div', { class: 'brand-sub', text: 'pre-token protocols, priced by their peers' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: 'model ' + DATA.model_version })
      )
    );
  }

  function lede() {
    var top = DATA.rows[0];
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Which tokenless protocols would be worth the most, priced the way their peers trade?' }),
        el('p', null,
          'Every protocol below records no token. The radar prices each one off the snapshot\u2019s own tokenised protocols: a category of tokens trades at a median market cap per dollar of TVL, and each pre-token protocol inherits its category\u2019s multiple, a chain factor, its seven-day growth and its tokenless age. Top of the board: ',
          el('b', { text: top.name + ' at ' + fmtUsd(top.implied_value_usd) }),
          '. Implied value is the entry\u2019s model, not a promise and not a prediction that a token is issued.'
        )
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', null, el('em', { text: String(DATA.watchlist_size) }), ' / ' + DATA.watchlist_size)),
        el('div', { class: 'fact' }, el('span', { text: 'Board rows ranked' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Pricing peers (tokenised)' }), el('b', { text: String(CAL.peer_count) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function select(id, label, values, current, onChange) {
      var s = el('select', { id: id, 'aria-label': label },
        values.map(function (v) {
          var value = Array.isArray(v) ? v[0] : v;
          var text = Array.isArray(v) ? v[1] : v;
          return el('option', { value: value, text: text, selected: value === current ? 'selected' : null });
        })
      );
      s.addEventListener('change', function () { onChange(s.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), s);
    }
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live tokens', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      select('category', 'Category', ['all'].concat(categories).map(function (c) { return [c, c === 'all' ? 'All categories' : c]; }), state.category, function (v) { state.category = v; }),
      select('chain', 'Chain', ['all'].concat(chains).map(function (c) { return [c, c === 'all' ? 'All chains' : c]; }), state.chain, function (v) { state.chain = v; }),
      select('band', 'Value band', BANDS, state.band, function (v) { state.band = v; }),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre' ? rows().length + ' of ' + DATA.board_size + ' rows' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; } render(); } },
        label,
        state.sort === key ? el('span', { class: 'arrow', 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or widen the category, chain or value band to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.band = 'all'; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unlisted') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.model.peer_multiple.toFixed(2) + '\u00d7' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, r.watchlist ? el('span', { class: 'tag watch', text: 'watchlist' }) : el('span', { class: 'tag', text: 'early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols ranked by implied value. Select a row for its pricing breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Tokenless'),
            sortHeader('mult', 'Peer \u00d7'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Radar' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unlisted') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_tvl === null ? 'n/a' : r.mcap_tvl.toFixed(2) + '\u00d7' }),
        el('td', null, el('span', { class: 'tag', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Set aside, not ranked: these protocols already have a token, so their market cap is a market fact. Their mcap/TVL ratios are the peers the board\u2019s multiples are calibrated from (the largest by market cap are shown).' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var onBoard = {};
    DATA.rows.forEach(function (r) { onBoard[r.category || 'Uncategorised'] = true; });
    var cats = CAL.categories.filter(function (c) { return onBoard[c.category]; });
    var tbody = el('tbody');
    cats.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: c.multiple.toFixed(3) + '\u00d7' }),
        el('td', { class: 'num', text: String(c.peers) })
      ));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How the radar prices a launch' }),
      el('div', { class: 'formula', text: 'implied = tvl \u00d7 peer multiple (category, shrunk) \u00d7 chain factor \u00d7 growth multiplier \u00d7 maturity multiplier' }),
      el('div', { class: 'model-grid' },
        el('div', null,
          el('ul', null,
            el('li', null, el('b', { text: 'Peers. ' }), 'The ' + CAL.peer_count + ' tokenised protocols in the snapshot price at a median market cap of ' + CAL.market_median.toFixed(3) + '\u00d7 TVL (ratios winsorised to ' + CAL.ratio_floor + '\u2013' + CAL.ratio_cap + '\u00d7 so one outlier cannot bend the market).'),
            el('li', null, el('b', { text: 'Category multiple. ' }), 'Each category\u2019s median peer ratio, shrunk toward the market median by its peer count (k = ' + CAL.category_shrinkage + '), so a category priced off two tokens borrows the market\u2019s evidence.'),
            el('li', null, el('b', { text: 'Chain factor. ' }), 'Peers on the protocol\u2019s first chain, shrunk harder (k = ' + CAL.chain_shrinkage + ') and clamped to ' + '0.75\u20131.33\u00d7' + ' against the market median.'),
            el('li', null, el('b', { text: 'Growth. ' }), 'Seven-day TVL change, clamped to ' + CAL.growth_floor_pct + '%\u2026+' + CAL.growth_cap_pct + '%, weighted ' + CAL.growth_weight + ': a hot week lifts a price, it does not set it.'),
            el('li', null, el('b', { text: 'Tokenless age. ' }), 'Listed ' + 'days run from first tracking to the snapshot; the maturity multiplier runs ' + CAL.maturity_floor + '\u2013' + (CAL.maturity_floor + CAL.maturity_range).toFixed(2) + ' over ' + CAL.maturity_days + ' days. An unreported age counts ' + CAL.unknown_age_days + ' days.')
          )
        ),
        el('div', null,
          el('table', { class: 'mult-table' },
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Multiple' }), el('th', { scope: 'col', text: 'Peers' }))),
            tbody
          )
        )
      ),
      el('p', { text: 'Coverage: the watchlist whole (' + DATA.watchlist_size + ' protocols at or above ' + fmtUsd(DATA.floor_usd) + ' TVL recording no token), plus every other pre-token protocol at or above $10M TVL that passes the watchlist\u2019s own product tests \u2014 not a wrapped, staked or bridged product of a token that already trades, not an exchange product, not a versioned pool. Wrapped and staked products (a bitcoin wrapper is Bitcoin, not a launch) are left off the board on purpose.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var m = row.model;
    var recomputed = impliedOf(row);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' \u00b7 watchlist' : ' \u00b7 early radar') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain unlisted') + ' \u00b7 records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value, step by step' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL (snapshot)' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Peer multiple \u00b7 ' + (row.category || 'Uncategorised') + ', ' + m.category_peers + ' peers' }), el('b', { class: 'num', text: m.peer_multiple.toFixed(4) + '\u00d7' })),
        el('div', null, el('span', { text: 'Chain factor \u00b7 ' + (row.chains && row.chains.length ? row.chains[0] : 'no chain') + ', ' + m.chain_peers + ' peers' }), el('b', { class: 'num', text: m.chain_factor.toFixed(4) + '\u00d7' })),
        el('div', null, el('span', { text: 'Growth \u00b7 7d ' + fmtPct(row.change_7d) }), el('b', { class: 'num', text: m.growth_multiplier.toFixed(4) + '\u00d7' })),
        el('div', null, el('span', { text: 'Maturity \u00b7 tokenless ' + fmtAge(row.age_days) }), el('b', { class: 'num', text: m.maturity_multiplier.toFixed(4) + '\u00d7' })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'check', text: 'This page recomputes the row from those components as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ' \u2014 the same number board.json carries.' : ' \u2014 which differs from board.json: the data would be stale.') + ' The multiple is what the snapshot\u2019s tokenised ' + (row.category || 'uncategorised') + ' protocols actually trade at; the rest is this protocol\u2019s own record.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Snapshot record' }),
      el('dl', { class: 'kv' },
        el('dt', { text: 'First tracked' }), el('dd', { text: row.listed_at || 'not reported' }),
        el('dt', { text: 'Tokenless age' }), el('dd', { text: row.age_days === null ? 'unknown (model counts ' + CAL.unknown_age_days + 'd)' : row.age_days + ' days' }),
        el('dt', { text: 'TVL change, 7d' }), el('dd', { text: fmtPct(row.change_7d) }),
        el('dt', { text: 'Chains' }), el('dd', { text: (row.chains || []).join(', ') || 'none listed' })
      )
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    var keepDialog = dialog.open;
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(modelPanel());
    shell.appendChild(el('p', { class: 'foot', text: 'Implied values are this entry\u2019s model of what a token would be worth if each protocol\u2019s record stayed as it is; they are not prices, not predictions that a token is issued, and not advice. A protocol is described as recording no token because the snapshot\u2019s record is what the radar reads; a token its record does not carry would not appear here.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected && !keepDialog) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
