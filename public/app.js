// Renders snapshots streamed from /events. All log text is inserted as text, never HTML.
//
// Calm by design: the order is steady unless the viewer picks a moving sort, nothing
// animates, the page redraws only when something meaningful changes, and a Pause control
// freezes it (WCAG 2.2.2). Every status has a colour, a symbol and words (WCAG 1.4.1).

const $ = (id) => document.getElementById(id);
const els = {
  live: $('live'),
  totals: $('totals'),
  pause: $('pause'),
  stop: $('stop'),
  views: [...document.querySelectorAll('[data-view]')],
  detail: $('detail'),
  sort: $('sort'),
  project: $('project'),
  hours: $('hours'),
  finished: $('finished'),
  guardian: $('guardian'),
  updated: $('updated'),
  now: $('now'),
  fleet: $('fleet'),
  legend: $('legend'),
  audit: $('audit'),
};

const TOOLS = {
  claude: { glyph: '✻', label: 'Claude' },
  codex: { glyph: '>_', label: 'Codex' },
};
const STATUSES = {
  running: { glyph: '▶', label: 'Working', rank: 0 },
  failed: { glyph: '✕', label: 'Failed', rank: 1 },
  stale: { glyph: '◌', label: 'Went quiet', rank: 2 },
  unlogged: { glyph: '?', label: 'No record', rank: 3 },
  idle: { glyph: '⏸', label: 'Waiting for you', rank: 4 },
  done: { glyph: '✓', label: 'Finished', rank: 5 },
};
const STATUS_HELP = {
  running: 'a turn is in progress',
  failed: 'it stopped with an error',
  stale: 'it started but stopped writing without finishing — probably closed or killed',
  unlogged: 'the launch was seen but no log was found — usually run with --ephemeral',
  idle: 'the session finished its turn and is waiting for you',
  done: 'it completed its task',
};
const ROLES = { review: 'Review', build: 'Build', guard: 'Guardian', explore: 'Explore', plan: 'Plan', 'general-purpose': 'Task' };
const KINDS = { session: 'session', subagent: 'subagent', worker: 'worker' };
const CHANGE_MARK_MS = 60_000;
const TICK_MS = 15_000;
const STORE_KEY = 'gattini-watch:prefs';
const OLD_STORE_KEY = 'agent-fleet:prefs';

const prefs = load();
const state = {
  view: prefs.view === 'blocks' ? 'blocks' : 'tree',
  collapsed: new Set(prefs.collapsed ?? []),
  pinned: Array.isArray(prefs.pinned) ? prefs.pinned : [],
  snapshot: null,
  pending: null,
  pendingCount: 0,
  paused: false,
  lastStatus: new Map(),
  changedAt: new Map(),
  signature: '',
};
let source = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      view: state.view,
      detail: els.detail.value,
      sort: els.sort.value,
      project: els.project.value,
      hours: els.hours.value,
      finished: els.finished.checked,
      guardian: els.guardian.checked,
      collapsed: [...state.collapsed],
      pinned: state.pinned,
    }));
  } catch {}
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// ---------- wording ----------

function minutes(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  if (total < 1) return 'under a minute';
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

function shortDuration(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  if (total < 1) return '<1m';
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

function ago(at) {
  if (!at) return '';
  const elapsed = Date.now() - at;
  return elapsed < 60000 ? 'just now' : `${shortDuration(elapsed)} ago`;
}

function clock(at) {
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function duration(node) {
  if (!node.startedAt || node.status === 'unlogged') return '';
  return shortDuration((node.status === 'running' ? Date.now() : node.lastAt ?? node.startedAt) - node.startedAt);
}

function modelText(node) {
  if (!node.model) return '';
  const model = node.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return node.effort ? `${model} · ${node.effort}` : model;
}

function roleText(node) {
  if (!node.role) return '';
  return ROLES[node.role] ?? node.role.charAt(0).toUpperCase() + node.role.slice(1);
}

function tokenText(value) {
  if (!value) return '';
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
}

// The full sentence used for hover text and screen readers.
function describe(node) {
  const tool = TOOLS[node.tool].label;
  const status = STATUSES[node.status];
  const parts = [
    `${tool} ${roleText(node) ? `${roleText(node).toLowerCase()} ` : ''}${KINDS[node.kind] ?? node.kind}`,
    `${status.label}: ${STATUS_HELP[node.status]}`,
    modelText(node) && `Model ${modelText(node)}`,
    node.startedAt && `Started ${clock(node.startedAt)}`,
    duration(node) && `Ran ${minutes((node.status === 'running' ? Date.now() : node.lastAt) - node.startedAt)}`,
    node.activity && `Last action: ${node.activity}`,
    node.title,
  ];
  return parts.filter(Boolean).join('. ');
}

// ---------- marks ----------

function toolMark(node) {
  const tool = TOOLS[node.tool];
  return h('span', { class: `toolmark tool-${node.tool}`, role: 'img', 'aria-label': tool.label, title: tool.label }, tool.glyph);
}

function statusMark(node, withLabel) {
  const status = STATUSES[node.status];
  return h('span', { class: `status s-${node.status}`, title: `${status.label}: ${STATUS_HELP[node.status]}` },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, status.glyph),
    withLabel ? h('span', { class: 'label' }, status.label) : h('span', { class: 'sr-only' }, status.label),
  );
}

function changedMark(node) {
  const at = state.changedAt.get(node.key);
  if (!at || Date.now() - at > CHANGE_MARK_MS) return null;
  return h('span', { class: 'changed', title: `Changed at ${clock(at)}` }, h('span', { 'aria-hidden': 'true' }, '●'), h('span', { class: 'sr-only' }, 'recently changed'));
}

function warningMark(node, compact) {
  if (!node.warnings.length) return null;
  const text = node.warnings.join(' ');
  return compact
    ? h('span', { class: 'warn-icon', role: 'img', 'aria-label': `Warning: ${text}`, title: text }, '⚠')
    : h('div', { class: 'warning' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), text);
}

// ---------- filtering and order ----------

const SORTS = {
  steady: null,
  activity: (a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0),
  attention: (a, b) => (STATUSES[a.status].rank - STATUSES[b.status].rank) || (a.startedAt ?? 0) - (b.startedAt ?? 0),
};

function ordered(nodes, depth = 0) {
  const pick = SORTS[els.sort.value];
  // Steady: newest sessions first, but workers keep launch order so new ones append below.
  const compare = pick ?? (depth === 0 ? (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) : (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return nodes.filter(visible).map((node) => ({ ...node, children: ordered(node.children, depth + 1) })).sort(compare);
}

function visible(node) {
  return !(node.guardian && !els.guardian.checked);
}

function active(node) {
  return !['done', 'idle'].includes(node.status) || node.children.some(active);
}

function projects() {
  if (!state.snapshot) return [];
  const pinnedIndex = (name) => {
    const index = state.pinned.indexOf(name);
    return index === -1 ? Infinity : index;
  };
  return state.snapshot.projects
    .filter((project) => !els.project.value || project.name === els.project.value)
    .map((project) => ({ ...project, nodes: ordered(project.nodes.filter((node) => visible(node) && (els.finished.checked || active(node)))) }))
    .filter((project) => project.nodes.length)
    .sort((a, b) => (pinnedIndex(a.name) - pinnedIndex(b.name)) || a.name.localeCompare(b.name));
}

function flatten(nodes, project, out = []) {
  for (const node of nodes) {
    out.push({ node, project });
    flatten(node.children, project, out);
  }
  return out;
}

// ---------- tree view ----------

function treeRow(node, depth) {
  const detail = els.detail.value;
  const kids = node.children;
  const isCollapsed = state.collapsed.has(node.key);
  const toggle = kids.length
    ? h('button', {
        class: 'toggle',
        'aria-expanded': String(!isCollapsed),
        'aria-label': `${isCollapsed ? 'Show' : 'Hide'} ${kids.length} launched by this ${node.kind}`,
        onclick: () => toggleCollapse(node.key),
      }, isCollapsed ? '▸' : '▾')
    : h('span', { class: 'toggle', 'aria-hidden': 'true' });

  const line = h('div', { class: `row s-${node.status}`, tabindex: '0', 'data-key': node.key, 'aria-label': describe(node), title: describe(node) },
    toggle,
    toolMark(node),
    statusMark(node, detail !== 'glance'),
    h('div', { class: 'main' },
      h('div', { class: 'title-line' },
        roleText(node) && detail !== 'glance' ? h('span', { class: 'role' }, roleText(node)) : null,
        h('span', { class: 'title' }, node.title),
        changedMark(node),
        detail === 'glance' ? warningMark(node, true) : null,
        isCollapsed ? h('span', { class: 'hidden-count' }, `+${kids.length}`) : null,
      ),
      detail === 'full' && node.activity ? h('div', { class: 'activity' }, h('span', { class: 'sr-only' }, 'Last action: '), node.activity) : null,
      detail === 'full' ? h('div', { class: 'tags' }, node.tags.map((tag) => h('span', { class: 'tag' }, tag))) : null,
      detail !== 'glance' ? warningMark(node, false) : null,
    ),
    detail === 'glance'
      ? null
      : h('div', { class: 'facts' },
          modelText(node) ? h('span', { class: 'model' }, modelText(node)) : null,
          detail === 'full' && duration(node) ? h('span', { class: 'duration', 'data-duration': node.key }, duration(node)) : null,
          detail === 'full' && node.tokens ? h('span', { class: 'tokens', title: `${node.tokens.toLocaleString()} ${node.tokensLabel} tokens` }, `${tokenText(node.tokens)} tok`) : null,
          h('span', { class: 'when', 'data-at': node.lastAt ?? '' }, ago(node.lastAt)),
        ),
  );
  return h('li', {}, line, kids.length && !isCollapsed ? h('ul', { class: 'children' }, kids.map((kid) => treeRow(kid, depth + 1))) : null);
}

// ---------- blocks view ----------

function chip(node) {
  const detail = els.detail.value;
  return h('span', { class: `chip s-${node.status}`, tabindex: '0', 'data-key': node.key, 'aria-label': describe(node), title: describe(node) },
    toolMark(node),
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, STATUSES[node.status].glyph),
    detail !== 'glance' && roleText(node) ? h('span', { class: 'chip-text' }, roleText(node)) : null,
    detail === 'full' && modelText(node) ? h('span', { class: 'chip-text muted' }, modelText(node)) : null,
    changedMark(node),
  );
}

function block(node) {
  const detail = els.detail.value;
  const workers = flatten(node.children, null).map(({ node: child }) => child);
  const tally = {};
  for (const worker of workers) tally[worker.status] = (tally[worker.status] ?? 0) + 1;
  return h('article', { class: `block s-${node.status}`, tabindex: '0', 'data-key': node.key, 'aria-label': describe(node), title: describe(node) },
    h('div', { class: 'block-head' },
      toolMark(node),
      h('span', { class: 'block-title' }, node.title),
      statusMark(node, detail !== 'glance'),
    ),
    detail !== 'glance'
      ? h('div', { class: 'block-meta' },
          roleText(node) ? h('span', { class: 'role' }, roleText(node)) : null,
          modelText(node) ? h('span', { class: 'model' }, modelText(node)) : null,
          changedMark(node),
        )
      : null,
    detail === 'full' && node.activity ? h('div', { class: 'activity' }, node.activity) : null,
    warningMark(node, detail === 'glance'),
    workers.length ? h('div', { class: 'chips', role: 'list', 'aria-label': `${workers.length} launched` }, workers.map((worker) => h('span', { role: 'listitem' }, chip(worker)))) : null,
    h('div', { class: 'block-foot' },
      h('span', { class: 'tally' }, Object.entries(tally)
        .sort(([a], [b]) => STATUSES[a].rank - STATUSES[b].rank)
        .map(([status, count]) => h('span', { title: STATUSES[status].label }, `${STATUSES[status].glyph} ${count}`)),
        workers.length ? null : 'no workers'),
      h('span', { class: 'when', 'data-at': node.lastAt ?? '' }, ago(node.lastAt)),
    ),
  );
}

// ---------- page sections ----------

function nowStrip(list) {
  const detail = els.detail.value;
  const running = list.filter(({ node }) => node.status === 'running').sort((a, b) => (a.node.startedAt ?? 0) - (b.node.startedAt ?? 0));
  if (!running.length) return h('p', { class: 'now-empty' }, 'Nothing is working right now.');
  return h('ul', { class: 'now-list' }, running.map(({ node, project }) =>
    h('li', { class: 'now-item', tabindex: '0', 'data-key': `now:${node.key}`, 'aria-label': describe(node), title: describe(node) },
      toolMark(node),
      h('span', { class: 'now-text' },
        h('span', { class: 'now-title' }, roleText(node) ? `${roleText(node)}: ` : '', node.title),
        detail !== 'glance' ? h('span', { class: 'now-sub' }, [project, modelText(node), node.activity && detail === 'full' ? `now: ${node.activity}` : null].filter(Boolean).join(' · ')) : null,
      ),
      h('span', { class: 'duration', 'data-duration': node.key }, duration(node)),
    )));
}

function projectSection(project) {
  const pinned = state.pinned.includes(project.name);
  const all = flatten(project.nodes, project.name).map(({ node }) => node);
  const runningCount = all.filter((node) => node.status === 'running').length;
  return h('section', { class: `project view-${state.view}`, 'aria-label': project.name },
    h('div', { class: 'project-head' },
      h('h2', {}, project.name),
      h('span', { class: 'project-count' }, runningCount ? `▶ ${runningCount} working · ` : '', `${all.length} total`),
      h('button', {
        class: `pin${pinned ? ' on' : ''}`,
        'aria-pressed': String(pinned),
        title: pinned ? 'Unpin this project' : 'Pin this project to the top',
        onclick: () => togglePin(project.name),
      }, pinned ? '★ Pinned' : '☆ Pin'),
    ),
    state.view === 'blocks'
      ? h('div', { class: 'blocks' }, project.nodes.map(block))
      : h('ul', { class: 'tree' }, project.nodes.map((node) => treeRow(node, 0))),
  );
}

function renderTotals() {
  const { claude, codex } = state.snapshot.counts;
  els.totals.replaceChildren(
    h('span', { class: 'total', title: 'Claude agents working now / seen in this window' }, h('span', { class: 'toolmark tool-claude', 'aria-hidden': 'true' }, '✻'), h('b', {}, claude.running), ' working', h('small', {}, ` of ${claude.total}`)),
    h('span', { class: 'total', title: 'Codex agents working now / seen in this window' }, h('span', { class: 'toolmark tool-codex', 'aria-hidden': 'true' }, '>_'), h('b', {}, codex.running), ' working', h('small', {}, ` of ${codex.total}`)),
  );
}

function renderProjectOptions() {
  const current = prefs.project ?? els.project.value;
  delete prefs.project;
  const names = state.snapshot.projects.map((project) => project.name).sort((a, b) => a.localeCompare(b));
  const existing = [...els.project.options].map((option) => option.value).slice(1).join('\n');
  if (existing !== names.join('\n')) {
    els.project.replaceChildren(h('option', { value: '' }, 'All projects'), ...names.map((name) => h('option', { value: name }, name)));
  }
  els.project.value = names.includes(current) ? current : '';
}

function renderLegend() {
  els.legend.replaceChildren(
    h('span', {}, h('span', { class: 'toolmark tool-claude', 'aria-hidden': 'true' }, '✻'), ' Claude'),
    h('span', {}, h('span', { class: 'toolmark tool-codex', 'aria-hidden': 'true' }, '>_'), ' Codex'),
    ...Object.entries(STATUSES).map(([key, status]) => h('span', { class: `status s-${key}`, title: STATUS_HELP[key] }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, status.glyph), h('span', { class: 'label' }, status.label))),
    h('span', {}, h('span', { class: 'changed', 'aria-hidden': 'true' }, '●'), ' changed in the last minute'),
  );
}

// Proof that nothing read from disk was left out of the view.
function renderAudit() {
  const audit = state.snapshot.audit;
  if (!audit) return;
  const parts = Object.entries(audit).map(([tool, { read, shown }]) => `${TOOLS[tool]?.label ?? tool}: ${read} logs read · ${shown} shown`);
  const missing = Object.values(audit).flatMap((entry) => entry.missing);
  const gap = Object.values(audit).some((entry) => entry.read !== entry.shown);
  els.audit.classList.toggle('audit-gap', gap);
  els.audit.replaceChildren(
    h('span', {}, `${gap ? '⚠ ' : ''}${parts.join('   ')}`),
    ...(missing.length ? [h('ul', {}, missing.map((entry) => h('li', {}, entry.path ?? entry.key)))] : []),
  );
}

// Only the parts that change what a viewer sees count; timestamps and token counts do not.
function signatureOf(list) {
  const marks = [...state.changedAt.entries()].filter(([, at]) => Date.now() - at <= CHANGE_MARK_MS).map(([key]) => key).sort();
  const shape = (node) => [node.key, node.status, node.title, node.role, node.model, node.effort, els.detail.value === 'full' ? node.activity : null, node.warnings.length, node.children.map(shape)];
  return JSON.stringify([state.view, els.detail.value, state.collapsed.size, [...state.collapsed], state.pinned, marks, list.map((project) => [project.name, project.nodes.map(shape)])]);
}

function render(force = false) {
  if (!state.snapshot) return;
  const list = projects();
  const signature = signatureOf(list);
  if (!force && signature === state.signature) return;
  state.signature = signature;

  const focusedKey = document.activeElement?.dataset?.key;
  renderTotals();
  els.now.replaceChildren(h('h2', { class: 'now-heading' }, 'Working now'), nowStrip(list.flatMap((project) => flatten(project.nodes, project.name))));
  els.fleet.replaceChildren(...(list.length ? list.map(projectSection) : [h('p', { class: 'empty' }, 'No agents in this window.')]));
  for (const button of els.views) button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  if (focusedKey) document.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
}

function accept(snapshot) {
  const first = state.lastStatus.size === 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      const previous = state.lastStatus.get(node.key);
      if (!first && previous !== node.status) state.changedAt.set(node.key, snapshot.generatedAt);
      state.lastStatus.set(node.key, node.status);
      walk(node.children);
    }
  };
  for (const project of snapshot.projects) walk(project.nodes);
  state.snapshot = snapshot;
  renderProjectOptions();
  els.updated.textContent = `Updated ${clock(snapshot.generatedAt)}`;
  renderAudit();
  render();
}

// ---------- controls ----------

function toggleCollapse(key) {
  state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
  save();
  render(true);
}

function togglePin(name) {
  state.pinned = state.pinned.includes(name) ? state.pinned.filter((item) => item !== name) : [...state.pinned, name];
  save();
  render(true);
}

function setPaused(paused) {
  state.paused = paused;
  if (!paused && state.pending) {
    const pending = state.pending;
    state.pending = null;
    accept(pending);
  }
  state.pendingCount = 0;
  updatePauseButton();
}

function updatePauseButton() {
  els.pause.setAttribute('aria-pressed', String(state.paused));
  els.pause.textContent = state.paused ? (state.pendingCount ? `▶ Resume (${state.pendingCount} update${state.pendingCount === 1 ? '' : 's'})` : '▶ Resume') : '⏸ Pause';
}

function connect() {
  source?.close();
  els.live.className = 'live connecting';
  els.live.title = 'Connecting';
  source = new EventSource(`/events?hours=${encodeURIComponent(els.hours.value)}`);
  source.onopen = () => {
    els.live.className = 'live on';
    els.live.title = 'Connected';
  };
  source.onerror = () => {
    els.live.className = 'live off';
    els.live.title = 'Disconnected — retrying';
  };
  source.onmessage = (event) => {
    const snapshot = JSON.parse(event.data);
    if (state.paused) {
      state.pending = snapshot;
      state.pendingCount += 1;
      updatePauseButton();
      return;
    }
    accept(snapshot);
  };
  source.addEventListener('failure', (event) => {
    els.updated.textContent = `Read error: ${JSON.parse(event.data)}`;
  });
}

// Quietly refreshes times; redraws only if a change marker has expired.
setInterval(() => {
  for (const node of document.querySelectorAll('.when[data-at]')) {
    const at = Number(node.dataset.at);
    if (at) node.textContent = ago(at);
  }
  if (state.snapshot && !state.paused) {
    const durations = new Map(flatten(state.snapshot.projects.flatMap((project) => project.nodes), null).map(({ node }) => [node.key, node]));
    for (const node of document.querySelectorAll('[data-duration]')) {
      const data = durations.get(node.dataset.duration);
      if (data) node.textContent = duration(data);
    }
    render();
  }
}, TICK_MS);

if (prefs.hours) els.hours.value = prefs.hours;
if (prefs.sort in SORTS) els.sort.value = prefs.sort;
if (['glance', 'standard', 'full'].includes(prefs.detail)) els.detail.value = prefs.detail;
if (typeof prefs.finished === 'boolean') els.finished.checked = prefs.finished;
if (typeof prefs.guardian === 'boolean') els.guardian.checked = prefs.guardian;

for (const button of els.views) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    save();
    render(true);
  });
}
els.pause.addEventListener('click', () => setPaused(!state.paused));
els.stop.addEventListener('click', async () => {
  if (!confirm('Stop Gattini Watch? This page stops updating until you start it again.')) return;
  try {
    const response = await fetch('/api/stop', { method: 'POST', headers: { 'x-gattini-watch': 'stop' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    els.updated.textContent = `Could not stop: ${error.message}`;
    return;
  }
  source?.close();
  els.live.className = 'live off';
  els.live.title = 'Stopped';
  els.stop.disabled = true;
  els.now.replaceChildren(
    h('h2', { class: 'now-heading' }, 'Stopped'),
    h('p', {}, 'Gattini Watch has stopped. Start it again with ', h('code', {}, 'brew services run gattini-watch'), ' or ', h('code', {}, 'gattini-watch --open'), '.'),
  );
});
els.hours.addEventListener('change', () => {
  save();
  connect();
});
for (const control of [els.project, els.sort, els.detail, els.finished, els.guardian]) {
  control.addEventListener('change', () => {
    save();
    render(true);
  });
}

renderLegend();
updatePauseButton();
connect();
