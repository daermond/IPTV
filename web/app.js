import { has, httpsUrl, ID, projectChannels, streamKey, UNASSIGNED } from './playlist.js';

const byId = id => document.getElementById(id);
const dialog = byId('dialog');
const rows = byId('rows');
const picker = byId('project');
const projects = new Map();
let site, project, projectId, baseProject, baseSha, token, dirty = false, busy = false;
let selectedGroup = null;
let dragKey = null;

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

function updateChannel(key, changes) {
  const override = { ...project.channels[key], ...changes };
  for (const field of Object.keys(override)) if (override[field] === undefined) delete override[field];
  if (Object.keys(override).length) project.channels[key] = override;
  else delete project.channels[key];
  edited();
  render();
}

function editChannel(channel) {
  const original = project.channels[channel.key] ?? {};
  const name = input('text', original.name ?? '', { placeholder: channel.name, maxLength: 180 });
  const number = input('number', original.number ?? '', { min: '1', step: '1', placeholder: String(channel.number ?? '') });
  const logo = input('url', original.logo ?? '', { placeholder: 'https://…' });
  const group = select([UNASSIGNED, ...project.groups].map(group => [group, group]), channel.group);
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
  const available = epgSources().filter(source => project.epgSources.includes(source.id));
  const epgSource = select([['Nincs kézi hozzárendelés', ''], ...available.map(source => [source.name, source.id])], channel.epg?.source ?? '');
  const epgId = input('text', channel.epg?.id ?? '', { autocomplete: 'off' });
  const epgList = node('datalist', { id: 'epg-candidates' });
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
    epgHint.textContent = source && entries.length === 0
      ? 'A forrás csatornaindexe még üres. Megadhatod a pontos XMLTV-azonosítót kézzel.'
      : 'Keress a műsorújság csatornanevére vagy add meg az XMLTV-azonosítót.';
  };
  epgSource.onchange = () => { epgId.value = ''; refreshOptions(); };
  refreshOptions();
  form(channel.name, [
    label('Megjelenített név', name, 'Üresen a forrás nevét használja.'),
    node('div', { className: 'two-fields' }, label('Csatornaszám', number), label('Csoport', group)),
    label('Saját logó URL-je', logo, 'HTTPS kép-URL. Üresen visszaáll az alapértelmezett logó.'),
    label('Elsődleges stream', primary),
    label('EPG-forrás', epgSource),
    node('label', { className: 'field' }, 'EPG-csatorna', epgId, epgList, epgHint), epgSuggestion,
  ], () => {
    const customLogo = logo.value.trim();
    if (customLogo && !httpsUrl(customLogo)) throw new Error('A logóhoz érvényes HTTPS kép-URL kell.');
    const chno = number.value === '' ? undefined : Number(number.value);
    if (chno !== undefined && (!Number.isSafeInteger(chno) || chno < 1)) throw new Error('A csatornaszám pozitív egész szám legyen.');
    const epgChannel = epgId.value.trim();
    if (epgSource.value && !validText(epgChannel)) throw new Error('Add meg az EPG-csatorna azonosítóját.');
    const nameValue = name.value.trim();
    if (nameValue && !validText(nameValue)) throw new Error('Adj meg egy érvényes csatornanevet.');
    updateChannel(channel.key, {
      name: nameValue || undefined, number: chno, logo: customLogo || undefined,
      group: group.value === UNASSIGNED ? undefined : group.value,
      primary: primary.value || undefined,
      epg: epgSource.value ? { source: epgSource.value, id: epgChannel } : undefined,
    });
  });
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
  const channels = allChannels();
  const enabled = channels.filter(channel => channel.enabled).length;
  const currentKeys = new Set(channels.map(channel => channel.key));
  const missing = [...new Set([...Object.keys(project.channels), ...project.order])]
    .filter(key => !currentKeys.has(key));
  byId('title').textContent = project.name;
  byId('stats').textContent = `${enabled} aktív · ${channels.length} csatorna${missing.length ? ` · ${missing.length} hiányzik` : ''}`;
  byId('sort').value = project.sort;
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
  const tableRows = visible.map((channel, index) => {
    const row = node('tr');
    row.dataset.disabled = String(!channel.enabled);
    const handle = button('⠿', () => {}, 'drag');
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
      [...rows.querySelectorAll('.drag')].find(item => item.getAttribute('aria-label') === handle.getAttribute('aria-label'))?.focus();
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
    edit.append(logoFor(channel), node('span', { className: 'channel-title', textContent: channel.name }));
    const toggle = input('checkbox', '', { checked: channel.enabled });
    toggle.setAttribute('aria-label', `${channel.name} bekapcsolva`);
    toggle.onchange = () => updateChannel(channel.key, { enabled: toggle.checked ? undefined : false });
    const badge = node('span', { className: `tag${channel.epg ? ' good' : ''}`,
      textContent: channel.epg ? 'Párosítva' : '—', title: channel.epg?.id ?? '' });
    row.append(node('td', {}, handle), node('td', {}, edit), node('td', {}, String(channel.number ?? '—')),
      node('td', {}, channel.group), node('td', {}, badge), node('td', {}, String(channel.streams.length)), node('td', {}, toggle));
    return row;
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
byId('search').oninput = render;
byId('visibility').onchange = render;
byId('sort').onchange = () => { project.sort = byId('sort').value; edited(); render(); };
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
run(initialize);
