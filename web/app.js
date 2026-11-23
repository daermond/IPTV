import {
  has, httpsUrl, ID, manualChannelKey, manualStreamUrl, orderByGroups, projectChannels, streamKey, UNASSIGNED,
} from './playlist.js';

const byId = id => document.getElementById(id);
const dialog = byId('dialog');
const rows = byId('rows');
const picker = byId('project');
const projects = new Map();
let site, project, projectId, baseProject, baseSha, token, dirty = false, busy = false;
let selectedGroup = null;
let dragKey = null;
let draggedGroup = null;
let expandedEpg = null;

function node(tag, props = {}, ...children) {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

const button = (title, action, className = '') =>
  node('button', { type: 'button', textContent: title, onclick: action, className });
const option = (title, value) => new Option(title, value);
const label = (title, control, hint) =>
  node('label', { className: 'field' }, title, control,
    ...(hint ? [node('small', { className: 'muted', textContent: hint })] : []));
const input = (type, value = '', props = {}) => node('input', { type, value, ...props });
const epgSources = () => [...site.sources.epg, ...(project.customEpg ?? [])];
const allChannels = () => projectChannels(project, site.catalog, site.logos);
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('hu');
const validText = value => value && !/[\u0000-\u001f\u007f]/u.test(value);
const slug = name => normalize(name).replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 64);
const assignments = () => Object.values(project.channels).filter(channel => channel.epg);
const comparable = name => normalize(name.replace(/\s*\(\d+[pi]\)|\s*\[[^\]]+\]/giu, '').trim());

function epgMatch(channel, entries) {
  const ids = new Set(channel.streams.map(stream =>
    normalize((stream.attributes['tvg-id'] ?? '').split('@')[0])));
  const exact = entries.filter(entry => ids.has(normalize(entry.id)));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const names = new Set([channel.name, ...channel.streams.map(stream => stream.name)].map(comparable).filter(Boolean));
  const byName = entries.filter(entry => names.has(comparable(entry.name)));
  return byName.length === 1 ? byName[0] : undefined;
}

function notice(message, tone = '') {
  byId('status').textContent = message;
  byId('status').dataset.tone = tone;
}

function updateControls() {
  byId('save').disabled = !project || !dirty || busy;
  picker.disabled = !site || busy;
  byId('new-project').disabled = !site || busy;
  byId('connection').disabled = !site || busy;
  byId('connection').textContent = token ? 'GitHub ✓' : 'GitHub';
  byId('editor').inert = busy;
}

function edited() {
  dirty = true;
  notice('Nem mentett módosítások.');
  updateControls();
}

async function run(action) {
  if (busy) return;
  busy = true;
  updateControls();
  try { await action(); }
  catch (error) { notice(error.message, 'error'); }
  finally { busy = false; updateControls(); }
}

function openDialog(title, ...contents) {
  const heading = node('h2', { id: 'dialog-heading', textContent: title });
  const close = button('×', () => dialog.close(), 'dialog-close');
  close.setAttribute('aria-label', 'Bezárás');
  dialog.setAttribute('aria-labelledby', heading.id);
  byId('dialog-content').replaceChildren(node('div', { className: 'dialog-title' }, heading, close), ...contents);
  if (!dialog.open) dialog.showModal();
}

function form(title, fields, submit, action = 'Alkalmazás') {
  const feedback = node('p', { className: 'warning', hidden: true });
  feedback.setAttribute('role', 'alert');
  const wrapper = node('form', {}, node('div', { className: 'fields' }, ...fields), feedback,
    node('div', { className: 'dialog-actions' },
      node('button', { type: 'submit', className: 'primary', textContent: action }),
      button('Mégse', () => dialog.close())));
  wrapper.onsubmit = async event => {
    event.preventDefault();
    try {
      await submit();
      dialog.close();
    } catch (error) {
      feedback.textContent = error.message;
      feedback.hidden = false;
    }
  };
  openDialog(title, wrapper);
}

function select(items, value) {
  const element = node('select', {}, ...items.map(([text, key]) => option(text, key)));
  element.value = value;
  return element;
}

function githubLink(suffix = '') {
  return `https://github.com/${site.repo}${suffix}`;
}

function apiPath(projectName = '') {
  return `/contents/projects${projectName ? `/${projectName}.json` : ''}`;
}

async function api(path, { method = 'GET', data, key = token, allowMissing = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${site.repo}${path}`, {
    method, cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (response.status === 404 && allowMissing) return null;
  if (response.status === 409 || response.status === 422) throw new Error('Mentési ütközés. A GitHubon közben megváltozott a projekt, vagy a repó nem engedi ezt a mentést.');
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new Error(`A GitHub elutasította a kérést (${response.status}). Ellenőrizd a tokent és a repóhozzáférést.`);
  }
  if (!response.ok) throw new Error(`GitHub-hiba (${response.status}). Próbáld újra.`);
  return response.json();
}

function decode(content) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content), c => c.charCodeAt(0))));
}

function encode(value) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  let chars = '';
  for (const byte of bytes) chars += String.fromCharCode(byte);
  return btoa(chars);
}

async function remoteProject(id, allowMissing = false) {
  return api(`${apiPath(id)}?ref=${encodeURIComponent(site.branch)}`, { allowMissing });
}

function updatePicker() {
  picker.replaceChildren(...[...projects.entries()].map(([id, item]) => option(item.name, id)));
  picker.value = projectId;
}

async function openProject(id) {
  const entry = projects.get(id);
  let latest;
  try { latest = await remoteProject(id); }
  catch (error) { if (!entry.project) throw error; }
  project = latest ? decode(latest.content) : structuredClone(entry.project);
  projectId = id;
  baseProject = structuredClone(project);
  baseSha = latest?.sha;
  dirty = false;
  selectedGroup = null;
  expandedEpg = null;
  byId('search').value = '';
  byId('visibility').value = 'all';
  byId('editor').hidden = false;
  updatePicker();
  notice(latest ? '' : 'A legutóbb közzétett projektet látod. Mentéskor ellenőrizzük a GitHubon tárolt változatot.');
  render();
}

function connect(after) {
  const key = input('password', '', { autocomplete: 'off', required: true, spellcheck: false });
  const github = node('a', {
    href: 'https://github.com/settings/personal-access-tokens/new',
    target: '_blank', rel: 'noopener', textContent: 'GitHub-token létrehozása ↗',
  });
  form('GitHub-hozzáférés', [
    label('GitHub-token', key, `Válassz csak a(z) ${site.repo} repóra érvényes fine-grained tokent, Contents: Read and write joggal. A token az oldal bezárásáig marad meg.`),
    github,
    ...(token ? [button('Kapcsolat bontása', () => { token = undefined; updateControls(); dialog.close(); })] : []),
  ], async () => {
    const candidate = key.value.trim();
    if (!candidate.startsWith('github_pat_')) throw new Error('Adj meg egy fine-grained GitHub-tokent.');
    await api(`${apiPath()}?ref=${encodeURIComponent(site.branch)}`, { key: candidate });
    token = candidate;
    key.value = '';
    updateControls();
    if (after) setTimeout(after);
  }, 'Kapcsolódás');
}

async function save() {
  if (!dirty) return;
  if (!token) { connect(() => run(save)); return; }
  const current = await remoteProject(projectId, true);
  const expected = baseSha === undefined && current && baseProject
    && JSON.stringify(decode(current.content)) === JSON.stringify(baseProject) ? current.sha : baseSha;
  if (current ? (expected !== current.sha) : (baseProject !== null)) {
    throw new Error('A projekt időközben megváltozott a GitHubon. A változtatásaid még a szerkesztőben vannak.');
  }
  const result = await api(apiPath(projectId), { method: 'PUT', data: {
    message: `Update IPTV project ${projectId}`, content: encode(project), branch: site.branch,
    ...(current ? { sha: current.sha } : {}),
  } });
  baseSha = result.content.sha;
  baseProject = structuredClone(project);
  projects.set(projectId, { name: project.name, project: baseProject });
  dirty = false;
  notice('A projekt elmentve. Az M3U a következő sikeres GitHub Actions futás után frissül.', 'success');
  updatePicker();
  render();
}

function newProject() {
  if (dirty && !confirm('Eldobod a nem mentett módosításokat?')) return;
  const name = input('text', '', { required: true, maxLength: 80 });
  form('Új projekt', [label('Projektnév', name)], () => {
    const cleanName = name.value.trim();
    const id = slug(cleanName);
    if (!validText(cleanName) || !ID.test(id)) throw new Error('Adj meg egy betűt vagy számot tartalmazó nevet.');
    if (projects.has(id)) throw new Error('Már van ilyen nevű projekt.');
    if (baseProject === null) projects.delete(projectId);
    projectId = id;
    project = {
      version: 1, name: cleanName, sources: [site.sources.m3u[0].id],
      epgSources: site.sources.epg.slice(0, 1).map(source => source.id),
      sort: 'manual', streamMode: 'primary', groups: [], order: [], channels: {},
    };
    projects.set(id, { name: cleanName });
    baseProject = null;
    baseSha = null;
    selectedGroup = null;
    expandedEpg = null;
    byId('search').value = '';
    byId('visibility').value = 'all';
    edited();
    updatePicker();
    render();
  }, 'Létrehozás');
}

function editGroup(group) {
  const name = input('text', group ?? '', { required: true, maxLength: 80 });
  const fields = [label('Csoport neve', name)];
  if (group) fields.push(button('Csoport törlése', () => {
    if (!confirm(`Törlöd a(z) „${group}” csoportot? A csatornák az Unassigned csoportba kerülnek.`)) return;
    project.groups = project.groups.filter(item => item !== group);
    for (const ch of Object.values(project.channels)) if (ch.group === group) delete ch.group;
    if (selectedGroup === group) selectedGroup = null;
    dialog.close();
    edited();
    render();
  }));
  form(group ? 'Csoport szerkesztése' : 'Új csoport', fields, () => {
    const next = name.value.trim();
    if (!validText(next) || [UNASSIGNED, ...project.groups.filter(item => item !== group)]
      .some(item => normalize(item) === normalize(next))) throw new Error('Adj meg egy egyedi csoportnevet.');
    if (group) {
      project.groups = project.groups.map(item => item === group ? next : item);
      for (const ch of Object.values(project.channels)) if (ch.group === group) ch.group = next;
      if (selectedGroup === group) selectedGroup = next;
    } else project.groups.push(next);
    edited();
    render();
  });
}

function applyGroupOrder() {
  const order = orderByGroups(project, site.catalog, site.logos);
  if (project.sort !== 'manual' || order.length !== project.order.length ||
    order.some((key, index) => key !== project.order[index])) {
    project.order = order;
    project.sort = 'manual';
    edited();
    notice('A lista csoportsorrendbe rendezve. A Mentés után az M3U is frissül.');
  }
  selectedGroup = null;
  render();
}

function moveGroup(source, target, after) {
  if (!project.groups.includes(source) || source === target) return;
  const groups = project.groups.filter(group => group !== source);
  const index = groups.indexOf(target);
  if (index === -1) return;
  groups.splice(index + Number(after), 0, source);
  if (groups.every((group, position) => group === project.groups[position])) return;
  const refocus = document.activeElement?.dataset.groupGrip === source;
  project.groups = groups;
  edited();
  render();
  if (refocus) byId('groups').querySelector(`[data-group-grip="${CSS.escape(source)}"]`)?.focus();
}

function addGroupDrag(row, group) {
  const grip = button('⠿', () => {}, 'drag group-grip');
  grip.draggable = true;
  grip.dataset.groupGrip = group;
  grip.setAttribute('aria-label', `Csoport áthelyezése – ${group}`);
  grip.title = 'Húzd másik csoport elé vagy mögé, vagy használd a fel és le nyilat.';
  grip.ondragstart = event => {
    draggedGroup = group;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', group);
  };
  grip.ondragend = () => {
    draggedGroup = null;
    for (const other of byId('groups').children) delete other.dataset.drop;
  };
  grip.onkeydown = event => {
    const offset = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!offset) return;
    const target = project.groups[project.groups.indexOf(group) + offset];
    if (target === undefined) return;
    event.preventDefault();
    moveGroup(group, target, offset > 0);
  };
  const dropAfter = event => {
    const box = row.getBoundingClientRect();
    if (matchMedia('(max-width: 780px)').matches) return event.clientX > box.left + box.width / 2;
    return event.clientY > box.top + box.height / 2;
  };
  row.ondragover = event => {
    if (!draggedGroup || draggedGroup === group) return;
    event.preventDefault();
    row.dataset.drop = dropAfter(event) ? 'after' : 'before';
  };
  row.ondragleave = event => { if (!row.contains(event.relatedTarget)) delete row.dataset.drop; };
  row.ondrop = event => {
    if (!draggedGroup) return;
    event.preventDefault();
    const source = draggedGroup;
    draggedGroup = null;
    delete row.dataset.drop;
    moveGroup(source, group, dropAfter(event));
  };
  row.prepend(grip);
}

function updateChannel(key, changes, redraw = true) {
  const override = { ...project.channels[key], ...changes };
  for (const field of Object.keys(override)) if (override[field] === undefined) delete override[field];
  if (Object.keys(override).length) project.channels[key] = override;
  else delete project.channels[key];
  edited();
  if (redraw) render();
}

function groupSelect(group) {
  return select([UNASSIGNED, ...project.groups].map(name => [name, name]), group);
}

function numberField(value) {
  return input('number', value ?? '', { min: '1', max: String(Number.MAX_SAFE_INTEGER), step: '1', inputMode: 'numeric' });
}

function readNumber(field) {
  if (!field.validity.valid) throw new Error('A csatornaszám pozitív egész szám legyen.');
  return field.value === '' ? null : field.valueAsNumber;
}

function streamField(url = '') {
  return input('text', url, { required: true, inputMode: 'url', autocomplete: 'off', spellcheck: false,
    placeholder: 'https://…/stream.m3u8' });
}

function readStreamUrl(field) {
  const url = field.value.trim();
  if (!manualStreamUrl(url)) throw new Error('Adj meg egy érvényes, közvetlen streamcímet.');
  return url;
}

function addManualChannel() {
  const name = input('text', '', { required: true, maxLength: 180 });
  const url = streamField();
  const number = numberField(null);
  const group = groupSelect(selectedGroup ?? UNASSIGNED);
  form('Saját csatorna hozzáadása', [
    label('Csatorna neve', name),
    label('Stream URL', url, 'Ez a cím megjelenik a nyilvános M3U-fájlban.'),
    node('div', { className: 'two-fields' }, label('Csatornaszám', number), label('Csoport', group)),
  ], () => {
    const channelName = name.value.trim();
    if (!validText(channelName)) throw new Error('Adj meg egy érvényes csatornanevet.');
    const address = readStreamUrl(url);
    const chno = readNumber(number);
    const id = crypto.randomUUID();
    const key = manualChannelKey(id);
    (project.manualChannels ??= []).push({ id, name: channelName, url: address });
    if (selectedGroup !== null) selectedGroup = group.value;
    byId('search').value = '';
    byId('visibility').value = 'all';
    updateChannel(key, { number: chno ?? undefined, group: group.value === UNASSIGNED ? undefined : group.value });
    requestAnimationFrame(() => rowControl(key, 'details')?.scrollIntoView({ block: 'nearest' }));
  }, 'Hozzáadás');
}

function removeManualChannel(channel) {
  if (!confirm(`Eltávolítod a(z) „${channel.name}” saját csatornát a projektből?`)) return;
  project.manualChannels = project.manualChannels.filter(entry => entry.id !== channel.manual.id);
  if (!project.manualChannels.length) delete project.manualChannels;
  delete project.channels[channel.key];
  project.order = project.order.filter(key => key !== channel.key);
  dialog.close();
  edited();
  render();
}

function epgEditor(channel, inline = false) {
  const available = epgSources().filter(source => project.epgSources.includes(source.id));
  const initialSource = inline && available.length === 1 ? available[0].id : '';
  const epgSource = select([['Nincs kézi hozzárendelés', ''], ...available.map(source => [source.name, source.id])],
    channel.epg?.source ?? initialSource);
  const epgId = input('text', channel.epg?.id ?? '', { autocomplete: 'off' });
  const epgList = node('datalist', { id: inline ? 'row-epg-candidates' : 'epg-candidates' });
  epgId.setAttribute('list', epgList.id);
  const epgHint = node('small', { className: 'muted' });
  const epgSuggestion = button('', () => { epgId.value = epgSuggestion.dataset.id; epgId.focus(); });
  const refreshOptions = () => {
    const source = available.find(source => source.id === epgSource.value);
    const entries = source ? site.epg[source.url]?.channels ?? [] : [];
    epgList.replaceChildren(...entries.map(entry => option(entry.name, entry.id)));
    epgId.disabled = !source;
    const match = epgMatch(channel, entries);
    epgSuggestion.hidden = !match;
    if (match) {
      epgSuggestion.textContent = `EPG-javaslat: ${match.name}`;
      epgSuggestion.dataset.id = match.id;
    }
    if (!available.length) epgHint.textContent = 'Adj hozzá egy EPG-forrást a Projektbeállításokban.';
    else if (source && entries.length === 0) epgHint.textContent = 'A forrás csatornaindexe még üres. Megadhatod a pontos XMLTV-azonosítót kézzel.';
    else epgHint.textContent = 'Keress a műsorújság csatornanevére vagy add meg az XMLTV-azonosítót.';
  };
  epgSource.onchange = () => { epgId.value = ''; refreshOptions(); };
  refreshOptions();
  return {
    source: epgSource,
    fields: [
      label('EPG-forrás', epgSource),
      node('label', { className: 'field' }, 'EPG-csatorna', epgId, epgList, epgHint),
      epgSuggestion,
    ],
    read() {
      if (!epgSource.value) return undefined;
      const id = epgId.value.trim();
      if (!validText(id)) throw new Error('Add meg az EPG-csatorna azonosítóját.');
      return { source: epgSource.value, id };
    },
  };
}

function editChannel(channel) {
  const original = project.channels[channel.key] ?? {};
  const manual = channel.manual;
  const name = input('text', manual ? channel.name : original.name ?? '',
    { required: Boolean(manual), placeholder: channel.name, maxLength: 180 });
  const number = numberField(channel.number);
  const logo = input('url', original.logo ?? '', { placeholder: 'https://…' });
  const group = groupSelect(channel.group);
  const url = manual ? streamField(manual.url) : null;
  const streamOptions = channel.streams.map((s, index) => {
    let host = s.url;
    try { host = new URL(s.url.replace(/^@/u, '')).hostname || s.url; }
    catch { /* Some player-specific URL formats are not valid browser URLs. */ }
    return [`${index + 1}. ${s.name || channel.name} · ${host}`, streamKey(s)];
  });
  if (original.primary && !streamOptions.some(([, key]) => key === original.primary)) {
    streamOptions.push(['A korábban választott stream jelenleg hiányzik', original.primary]);
  }
  const primary = select([['A forrás első streamje', ''], ...streamOptions], original.primary ?? '');
  const epg = epgEditor(channel);
  form(channel.name, [
    label('Megjelenített név', name, manual ? undefined : 'Üresen a forrás nevét használja.'),
    node('div', { className: 'two-fields' }, label('Csatornaszám', number), label('Csoport', group)),
    label('Saját logó URL-je', logo, 'HTTPS kép-URL. Üresen visszaáll az alapértelmezett logó.'),
    url ? label('Stream URL', url, 'Ez a cím megjelenik a nyilvános M3U-fájlban.') : label('Elsődleges stream', primary),
    ...epg.fields,
    ...(manual ? [button('Saját csatorna törlése', () => removeManualChannel(channel), 'remove-channel')] : []),
  ], () => {
    const customLogo = logo.value.trim();
    if (customLogo && !httpsUrl(customLogo)) throw new Error('A logóhoz érvényes HTTPS kép-URL kell.');
    const chno = readNumber(number);
    const nameValue = name.value.trim();
    if ((manual || nameValue) && !validText(nameValue)) throw new Error('Adj meg egy érvényes csatornanevet.');
    const assignment = epg.read();
    if (manual) {
      manual.url = readStreamUrl(url);
      manual.name = nameValue;
    }
    if (expandedEpg?.key === channel.key) expandedEpg = null;
    updateChannel(channel.key, {
      name: manual ? undefined : nameValue || undefined,
      number: chno === channel.number ? original.number : chno, logo: customLogo || undefined,
      group: group.value === UNASSIGNED ? undefined : group.value,
      primary: manual ? undefined : primary.value || undefined,
      epg: assignment,
    });
  });
}

function rowControl(key, control) {
  return rows.querySelector(`[data-channel-key="${CSS.escape(key)}"] [data-control="${control}"]`);
}

function rowNumber(channel) {
  let saved = channel.number;
  const number = numberField(saved);
  number.className = 'row-number';
  number.placeholder = '—';
  number.dataset.control = 'number';
  number.setAttribute('aria-label', `Csatornaszám – ${channel.name}`);
  const commit = () => {
    let next;
    try { next = readNumber(number); }
    catch (error) {
      number.value = saved ?? '';
      notice(error.message, 'error');
      return;
    }
    if (next === saved) return;
    saved = next;
    updateChannel(channel.key, { number: next }, false);
    // Let Tab or a click finish moving focus before reordering the rows.
    if (project.sort === 'number') requestAnimationFrame(render);
    else renderWarnings(allChannels());
  };
  number.onchange = commit;
  number.onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  };
  return number;
}

function toggleRowEpg(channel) {
  const close = () => {
    expandedEpg = null;
    render();
    rowControl(channel.key, 'epg')?.focus();
  };
  if (expandedEpg?.key === channel.key) { close(); return; }
  const editor = epgEditor(channel, true);
  const error = node('p', { className: 'warning', hidden: true, role: 'alert' });
  const body = node('form', { className: 'row-epg-form', ariaLabel: `EPG – ${channel.name}` },
    node('div', { className: 'row-epg-fields' }, ...editor.fields),
    error,
    node('div', { className: 'row-epg-actions' },
      node('button', { type: 'submit', className: 'primary', textContent: 'Alkalmazás' }),
      button('Mégse', close)));
  body.onsubmit = event => {
    event.preventDefault();
    try {
      const epg = editor.read();
      if (epg?.source !== channel.epg?.source || epg?.id !== channel.epg?.id) {
        updateChannel(channel.key, { epg }, false);
      }
      close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
  };
  body.onkeydown = event => { if (event.key === 'Escape') close(); };
  const row = node('tr', { className: 'row-epg', id: 'row-epg-panel' }, node('td', { colSpan: 7 }, body));
  expandedEpg = { key: channel.key, row };
  render();
  editor.source.focus();
}

function suggestEpg() {
  const available = epgSources().filter(source => project.epgSources.includes(source.id));
  const selected = select(available.map(source => [source.name, source.id]), available[0]?.id ?? '');
  const list = node('div', { className: 'suggestions' });
  const summary = node('p', { className: 'muted' });
  let suggestions = [];
  const refresh = () => {
    const source = available.find(item => item.id === selected.value);
    const entries = source ? site.epg[source.url]?.channels ?? [] : [];
    suggestions = allChannels().filter(channel => channel.enabled && !channel.epg).flatMap(channel => {
      const match = epgMatch(channel, entries);
      if (!match) return [];
      const check = input('checkbox', '', { checked: true });
      return [{ channel, match, check }];
    });
    summary.textContent = suggestions.length
      ? `${suggestions.length} egyértelmű egyezés. Jelöld meg, melyiket szeretnéd alkalmazni.`
      : 'Nincs egyértelmű találat. A csatornák EPG-je kézzel is megadható.';
    list.replaceChildren(...suggestions.map(({ channel, match, check }) =>
      node('label', { className: 'check' }, check, `${channel.name} → ${match.name}`)));
  };
  selected.onchange = refresh;
  refresh();
  form('EPG-javaslatok', [label('EPG-forrás', selected), summary, list], () => {
    const chosen = suggestions.filter(item => item.check.checked);
    if (!chosen.length) throw new Error('Jelölj ki legalább egy javaslatot.');
    for (const { channel, match } of chosen) {
      project.channels[channel.key] = { ...project.channels[channel.key], epg: { source: selected.value, id: match.id } };
    }
    expandedEpg = null;
    edited();
    render();
  });
}

function settings() {
  const mode = select([['Egy stream csatornánként', 'primary'], ['Minden stream külön sorban', 'all']], project.streamMode);
  const sources = node('fieldset', {}, node('legend', { textContent: 'M3U-források' }));
  const guides = node('fieldset', {}, node('legend', { textContent: 'Külső EPG-források' }));
  const sourceChecks = new Map(), epgChecks = new Map();
  const customs = [...(project.customEpg ?? [])];
  for (const source of site.sources.m3u) {
    const check = input('checkbox', '', { checked: project.sources.includes(source.id) });
    sourceChecks.set(source.id, check);
    sources.append(node('label', { className: 'check' }, check, source.name));
  }
  const addEpg = (source, checked) => {
    const check = input('checkbox', '', { checked, title: source.url });
    epgChecks.set(source.id, check);
    guides.append(node('div', { className: 'check' }, node('label', { className: 'check' }, check, source.name),
      node('a', { href: source.url, target: '_blank', rel: 'noopener', textContent: '↗', title: source.url,
        ariaLabel: `${source.name} letöltése` })));
  };
  for (const source of epgSources()) addEpg(source, project.epgSources.includes(source.id));
  const epgName = input('text', '', { maxLength: 80 });
  const epgUrl = input('url');
  const epgInputError = node('small', { className: 'warning', hidden: true });
  const createEpg = button('EPG-forrás hozzáadása', () => {
    const name = epgName.value.trim(), url = epgUrl.value.trim();
    if (!validText(name) || !httpsUrl(url)) {
      epgInputError.textContent = 'Adj meg egy nevet és egy HTTPS XMLTV-címet.';
      epgInputError.hidden = false;
      return;
    }
    if ([...site.sources.epg, ...customs].some(source => source.url === url)) {
      epgInputError.textContent = 'Ez az EPG-cím már szerepel a források között.';
      epgInputError.hidden = false;
      return;
    }
    const id = `epg-${crypto.randomUUID()}`;
    const source = { id, name, url };
    customs.push(source);
    addEpg(source, true);
    epgName.value = epgUrl.value = '';
    epgInputError.hidden = true;
  });
  const checked = map => [...map].filter(([, check]) => check.checked).map(([id]) => id);
  const actions = node('a', {
    href: githubLink('/actions/workflows/publish.yml'), target: '_blank', rel: 'noopener',
    textContent: 'EPG-csatornaindex kézi frissítése az Actionsben ↗',
  });
  form('Projektbeállítások', [
    label('Stream exportálása', mode), sources, guides,
    node('div', { className: 'two-fields' }, label('Új EPG neve', epgName), label('XMLTV vagy XML.GZ URL', epgUrl)),
    createEpg, epgInputError,
    node('small', { className: 'muted', textContent: 'A lejátszó a műsorújságot közvetlenül ezekről a címekről tölti le. Egyes lejátszókban a címeket külön kell megadni.' }),
    actions,
  ], () => {
    if (!checked(sourceChecks).length) throw new Error('Válassz legalább egy M3U-forrást.');
    if (epgName.value || epgUrl.value) throw new Error('A megadott EPG-címhez használd a hozzáadás gombot.');
    const chosen = checked(epgChecks);
    if (assignments().some(channel => !chosen.includes(channel.epg.source))) {
      throw new Error('Egy csatorna még ehhez az EPG-hez van rendelve. Előbb módosítsd a hozzárendelését.');
    }
    project.sources = checked(sourceChecks);
    project.epgSources = chosen;
    if (customs.length) project.customEpg = customs;
    project.streamMode = mode.value;
    expandedEpg = null;
    edited();
    render();
  });
}

function move(source, target, after) {
  if (!source || source === target || project.sort !== 'manual') return;
  const ordered = [...new Set([...project.order, ...allChannels().map(channel => channel.key)])]
    .filter(id => id !== source);
  const position = ordered.indexOf(target);
  if (position < 0) return;
  ordered.splice(position + (after ? 1 : 0), 0, source);
  project.order = ordered;
  edited();
  render();
}

function dropPosition(event, row) {
  const box = row.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
}

function logoFor(channel) {
  const fallback = () => channel.name.split(/\s+/u).slice(0, 3).map(part => part[0]).join('').toUpperCase();
  const logo = node('span', { className: 'logo', textContent: fallback() });
  logo.setAttribute('aria-hidden', 'true');
  if (httpsUrl(channel.logo)) {
    const image = node('img', { src: channel.logo, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    image.onerror = () => { logo.textContent = fallback(); };
    logo.replaceChildren(image);
  }
  return logo;
}

function render() {
  const focused = document.activeElement;
  const focusedRow = focused.closest('tr[data-channel-key]');
  const channels = allChannels();
  const enabled = channels.filter(channel => channel.enabled).length;
  const currentKeys = new Set(channels.map(channel => channel.key));
  const missing = [...new Set([...Object.keys(project.channels), ...project.order])]
    .filter(key => !currentKeys.has(key));
  byId('title').textContent = project.name;
  byId('stats').textContent = `${enabled} aktív · ${channels.length} csatorna${missing.length ? ` · ${missing.length} hiányzik` : ''}`;
  byId('sort').value = project.sort;
  byId('apply-group-order').disabled = project.groups.length === 0;
  byId('log-link').href = githubLink(`/blob/${site.branch}/channel-changes.log`);
  const published = site.projects.some(item => item.id === projectId);
  byId('output').hidden = !published;
  byId('output').href = `playlists/${projectId}.m3u`;
  byId('published').textContent = published
    ? `Közzétéve: ${new Date(site.generatedAt).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}`
    : 'Az M3U a projekt első sikeres közzététele után jelenik meg.';

  byId('groups').replaceChildren(...[null, ...project.groups, UNASSIGNED].map(group => {
    const choose = button('', () => { selectedGroup = group; render(); }, 'group');
    const name = node('span', { textContent: group ?? 'Összes csatorna' });
    name.dataset.label = '';
    choose.append(name, node('span', {
      className: 'group-count', textContent: String(group === null ? channels.length : channels.filter(c => c.group === group).length),
    }));
    choose.setAttribute('aria-current', String(group === selectedGroup));
    const wrapper = node('div', { className: 'group-row' }, choose);
    if (group && group !== UNASSIGNED) {
      addGroupDrag(wrapper, group);
      const menu = button('⋯', () => editGroup(group), 'group-menu');
      menu.setAttribute('aria-label', `${group} szerkesztése`);
      wrapper.append(menu);
    }
    return wrapper;
  }));

  const query = normalize(byId('search').value.trim());
  const visibility = byId('visibility').value;
  const visible = channels.filter(channel => (selectedGroup === null || selectedGroup === channel.group)
    && (!query || normalize(`${channel.name} ${channel.key}`).includes(query))
    && (visibility === 'all' || (visibility === 'on' && channel.enabled) || (visibility === 'off' && !channel.enabled)));
  if (expandedEpg && !visible.some(channel => channel.key === expandedEpg.key)) expandedEpg = null;
  const tableRows = visible.flatMap((channel, index) => {
    const row = node('tr');
    row.dataset.channelKey = channel.key;
    row.dataset.disabled = String(!channel.enabled);
    const handle = button('⠿', () => {}, 'drag');
    handle.dataset.control = 'drag';
    handle.disabled = project.sort !== 'manual';
    handle.draggable = !handle.disabled;
    handle.setAttribute('aria-label', `${channel.name} áthelyezése`);
    handle.title = 'Húzd a sorok között, vagy használd a fel és le nyilat.';
    handle.ondragstart = event => {
      dragKey = channel.key;
      event.dataTransfer.setData('text/plain', channel.key);
      event.dataTransfer.effectAllowed = 'move';
    };
    handle.ondragend = () => { dragKey = null; for (const item of rows.children) delete item.dataset.drop; };
    handle.onkeydown = event => {
      const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : -1;
      if (!visible[to]) return;
      event.preventDefault();
      move(channel.key, visible[to].key, to > index);
    };
    row.ondragover = event => {
      if (!dragKey || dragKey === channel.key) return;
      event.preventDefault();
      row.dataset.drop = dropPosition(event, row) ? 'after' : 'before';
    };
    row.ondragleave = event => { if (!row.contains(event.relatedTarget)) delete row.dataset.drop; };
    row.ondrop = event => {
      event.preventDefault();
      const source = dragKey;
      dragKey = null;
      delete row.dataset.drop;
      move(source, channel.key, dropPosition(event, row));
    };
    const edit = button('', () => editChannel(channel), 'channel');
    edit.dataset.control = 'details';
    edit.append(logoFor(channel), node('span', { className: 'channel-title', textContent: channel.name }));
    if (channel.manual) edit.append(node('span', { className: 'manual-label', textContent: 'Saját' }));
    const toggle = input('checkbox', '', { checked: channel.enabled });
    toggle.dataset.control = 'active';
    toggle.setAttribute('aria-label', `${channel.name} bekapcsolva`);
    toggle.onchange = () => updateChannel(channel.key, { enabled: toggle.checked ? undefined : false });
    const group = groupSelect(channel.group);
    group.className = 'row-group';
    group.dataset.control = 'group';
    group.setAttribute('aria-label', `Csoport – ${channel.name}`);
    group.onchange = () => updateChannel(channel.key, { group: group.value === UNASSIGNED ? undefined : group.value });

    const isExpanded = expandedEpg?.key === channel.key;
    const epg = button(channel.epg ? 'Párosítva' : 'Párosítás', () => toggleRowEpg(channel),
      `row-epg-button${channel.epg ? ' good' : ''}`);
    epg.dataset.control = 'epg';
    epg.title = channel.epg?.id ?? 'EPG hozzárendelése';
    epg.setAttribute('aria-label', `EPG – ${channel.name}${channel.epg ? ` (${channel.epg.id})` : ''}`);
    epg.setAttribute('aria-expanded', String(isExpanded));
    if (isExpanded) epg.setAttribute('aria-controls', expandedEpg.row.id);
    row.append(node('td', {}, handle), node('td', {}, edit), node('td', {}, rowNumber(channel)),
      node('td', {}, group), node('td', {}, epg), node('td', {}, String(channel.streams.length)), node('td', {}, toggle));
    return isExpanded ? [row, expandedEpg.row] : [row];
  });
  if (visibility === 'missing') for (const key of missing) {
    const override = project.channels[key] ?? {};
    const name = override.name ?? key.replace(/^id:/u, '');
    const group = override.group ?? UNASSIGNED;
    if (selectedGroup !== null && selectedGroup !== group) continue;
    if (!normalize(name).includes(query)) continue;
    tableRows.push(node('tr', {}, node('td'), node('td', { textContent: name }),
      node('td', {}, String(override.number ?? '—')), node('td', {}, group),
      node('td', { colSpan: 3, className: 'muted', textContent: 'Hiányzik a forrásból' })));
  }
  rows.replaceChildren(...tableRows);
  byId('empty').hidden = tableRows.length > 0;
  if (focusedRow && focused.dataset.control) {
    const replacement = rowControl(focusedRow.dataset.channelKey, focused.dataset.control) ?? byId('search');
    replacement.focus({ preventScroll: true });
  } else if (expandedEpg?.row.contains(focused)) {
    focused.focus({ preventScroll: true });
  }
  renderWarnings(channels);
}

function renderWarnings(channels) {
  const numbers = channels.filter(item => item.enabled && item.number !== null).map(item => item.number);
  const knownEpgIds = new Map();
  for (const source of epgSources().filter(item => project.epgSources.includes(item.id))) {
    for (const item of site.epg[source.url]?.channels ?? []) {
      if (!knownEpgIds.has(item.id)) knownEpgIds.set(item.id, new Set());
      knownEpgIds.get(item.id).add(source.id);
    }
  }
  for (const { epg } of assignments()) {
    if (!knownEpgIds.has(epg.id)) knownEpgIds.set(epg.id, new Set());
    knownEpgIds.get(epg.id).add(epg.source);
  }
  const warnings = [];
  if (new Set(numbers).size < numbers.length) warnings.push('Több aktív csatorna ugyanazt a csatornaszámot használja.');
  if (assignments().some(({ epg }) => knownEpgIds.get(epg.id).size > 1)) {
    warnings.push('Egy hozzárendelt EPG-azonosító több forrásban is szerepel. A választott műsorújság lejátszónként eltérhet.');
  }
  byId('warning').textContent = warnings.join(' ');
  byId('warning').hidden = !warnings.length;
}

async function initialize() {
  const response = await fetch('data/catalog.json', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('A csatornakatalógus még nem érhető el. Ellenőrizd az Actions futását.');
  site = await response.json();
  for (const entry of site.projects) projects.set(entry.id, entry);
  try {
    const files = await api(`${apiPath()}?ref=${encodeURIComponent(site.branch)}`);
    for (const { name } of files) {
      const id = name.slice(0, -5);
      if (name.endsWith('.json') && ID.test(id) && !projects.has(id)) projects.set(id, { name: id });
    }
  } catch { /* Use the last published project list during a GitHub API outage. */ }
  await openProject(projects.keys().next().value);
}

picker.onchange = () => {
  const next = picker.value;
  picker.value = projectId;
  if (dirty && !confirm('Eldobod a nem mentett módosításokat?')) return;
  run(async () => {
    const previousDraft = baseProject === null ? projectId : null;
    await openProject(next);
    if (previousDraft) projects.delete(previousDraft);
    updatePicker();
  });
};
byId('connection').onclick = () => connect();
byId('new-project').onclick = newProject;
byId('save').onclick = () => run(save);
byId('settings').onclick = settings;
byId('epg-suggestions').onclick = suggestEpg;
byId('add-group').onclick = () => editGroup();
byId('apply-group-order').onclick = applyGroupOrder;
byId('add-channel').onclick = addManualChannel;
byId('search').oninput = render;
byId('visibility').onchange = render;
byId('sort').onchange = () => { project.sort = byId('sort').value; edited(); render(); };
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
run(initialize);
