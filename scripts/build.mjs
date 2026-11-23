import { access, cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  channelKey, has, httpsUrl, ID, manualStreamUrl, membershipChanges, parsePlaylist, renderPlaylist, UNASSIGNED,
} from '../web/playlist.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const path = (...parts) => join(root, ...parts);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const unique = values => new Set(values).size === values.length;

async function optionalJson(filename) {
  try { return await readJson(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

function sourceList(sources) {
  return Array.isArray(sources) && sources.every(source =>
    object(source) && ID.test(source.id ?? '') && text(source.name) && httpsUrl(source.url))
    && unique(sources.map(source => source.id));
}

export function validateProject(project, sources) {
  const require = (condition, label) => {
    if (!condition) throw new Error(`Érvénytelen projektbeállítás: ${label}`);
  };
  const idsFrom = (list, allowed) => Array.isArray(list)
    && unique(list) && list.every(id => allowed.some(source => source.id === id));
  require(object(project) && project.version === 1 && text(project.name), 'version / name');
  require(idsFrom(project.sources, sources.m3u) && project.sources.length, 'sources');
  const custom = project.customEpg ?? [];
  require(sourceList(custom), 'customEpg');
  const epg = [...sources.epg, ...custom];
  require(unique(epg.map(source => source.id)) && idsFrom(project.epgSources, epg), 'epgSources');
  require(['manual', 'number'].includes(project.sort), 'sort');
  require(['primary', 'all'].includes(project.streamMode), 'streamMode');
  require(Array.isArray(project.groups) && unique(project.groups)
    && project.groups.every(group => text(group) && group.toLowerCase() !== UNASSIGNED.toLowerCase()), 'groups');
  require(Array.isArray(project.order) && unique(project.order) && project.order.every(text), 'order');
  const manual = project.manualChannels === undefined ? [] : project.manualChannels;
  require(Array.isArray(manual) && manual.every(channel => object(channel) &&
    typeof channel.id === 'string' && ID.test(channel.id) && text(channel.name) && manualStreamUrl(channel.url))
    && unique(manual.map(channel => channel.id)), 'manualChannels');
  require(object(project.channels), 'channels');
  for (const [key, override] of Object.entries(project.channels)) {
    require(text(key) && object(override), 'channel');
    if (has(override, 'name')) require(text(override.name), `${key}.name`);
    if (has(override, 'enabled')) require(typeof override.enabled === 'boolean', `${key}.enabled`);
    if (has(override, 'number')) require(override.number === null ||
      (Number.isSafeInteger(override.number) && override.number > 0), `${key}.number`);
    if (has(override, 'logo')) require(override.logo === '' || httpsUrl(override.logo), `${key}.logo`);
    if (has(override, 'group')) require(project.groups.includes(override.group), `${key}.group`);
    if (has(override, 'primary')) require(text(override.primary), `${key}.primary`);
    if (has(override, 'epg')) require(object(override.epg) && text(override.epg.id)
      && project.epgSources.includes(override.epg.source), `${key}.epg`);
  }
  if (project.aliases !== undefined) require(object(project.aliases) &&
    Object.entries(project.aliases).every(([key, value]) => text(key) && text(value)), 'aliases');
  return epg;
}

async function download(url, limit) {
  if (!httpsUrl(url)) throw new Error('Csak nyilvános HTTPS-forrás adható meg.');
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok || !httpsUrl(response.url)) throw new Error(`Letöltési hiba (HTTP ${response.status}).`);
  const pieces = [];
  let bytes = 0;
  for await (const piece of response.body) {
    bytes += piece.length;
    if (bytes > limit) throw new Error('A forrásfájl túl nagy.');
    pieces.push(piece);
  }
  return Buffer.concat(pieces, bytes);
}

async function logoIndex(url, channels) {
  if (!url) return {};
  try {
    const data = JSON.parse((await download(url, 40 * 1024 * 1024)).toString('utf8'));
    const channelIds = new Set(channels.map(id => id.split('@')[0]));
    const exact = new Map();
    const fallback = new Map();
    for (const item of data) {
      if (!channelIds.has(item.channel) || !httpsUrl(item.url)) continue;
      const key = item.feed ? `${item.channel}@${item.feed}` : item.channel;
      if (!exact.has(key) || (item.in_use && !exact.get(key).in_use)) exact.set(key, item);
      if (!item.feed && (!fallback.has(item.channel) || (item.in_use && !fallback.get(item.channel).in_use))) {
        fallback.set(item.channel, item);
      }
    }
    return Object.fromEntries(channels.flatMap(id => {
      const item = exact.get(id) ?? fallback.get(id.split('@')[0]);
      return item ? [[id, item.url]] : [];
    }));
  } catch (error) {
    console.warn(`A logóadatbázis nem elérhető: ${error.message}`);
    return null;
  }
}

async function epgIndex(url) {
  const data = await download(url, 32 * 1024 * 1024);
  const python = process.env.IPTV_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [path('scripts', 'epg-index.py')], {
    input: data, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 25_000,
  });
  if (result.error || result.status !== 0) throw new Error('Az XMLTV-csatornalista nem olvasható.');
  return JSON.parse(result.stdout);
}

async function writeIfChanged(filename, data) {
  let previous;
  try { previous = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== data) await writeFile(filename, data, 'utf8');
}

async function updateRepoPlaylists(playlists) {
  const directory = path('playlists');
  await mkdir(directory, { recursive: true });
  for (const [filename, content] of playlists) {
    await writeIfChanged(join(directory, filename), content);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.m3u') && ID.test(entry.name.slice(0, -4))
      && !playlists.has(entry.name)) {
      await unlink(join(directory, entry.name));
    }
  }
}

export async function build({ updateState = false, refreshEpg = false } = {}) {
  const sources = await readJson(path('sources.json'));
  if (!sourceList(sources.m3u) || !sourceList(sources.epg)) throw new Error('Érvénytelen forráslista.');

  const projects = [];
  for (const filename of (await readdir(path('projects'))).filter(name => name.endsWith('.json')).sort()) {
    const id = filename.slice(0, -5);
    if (!ID.test(id)) throw new Error(`Érvénytelen projektfájlnév: ${filename}`);
    const project = await readJson(path('projects', filename));
    const epgSources = validateProject(project, sources);
    projects.push({ id, project, epgSources });
  }
  if (projects.length === 0) throw new Error('Legalább egy projekt szükséges.');

  const streamed = await Promise.all(sources.m3u.map(async source => {
    try {
      const input = await download(source.url, 16 * 1024 * 1024);
      return [source.id, parsePlaylist(input.toString('utf8'))];
    } catch (error) {
      throw new Error(`${source.name}: ${error.message}`, { cause: error });
    }
  }));
  const catalog = Object.fromEntries(streamed);
  const stateFile = path('state', 'channels.json');
  const state = await optionalJson(stateFile);
  const events = [];
  const timestamp = new Date().toISOString().slice(0, 10);
  for (const source of sources.m3u) {
    const current = Object.fromEntries(catalog[source.id].map(stream => [
      channelKey(stream, source.id), stream.name || stream.attributes['tvg-id'] || stream.url,
    ]));
    const previous = state[source.id]?.url === source.url ? state[source.id].channels : undefined;
    const changes = membershipChanges(previous, current);
    if (!previous || changes.length) state[source.id] = { url: source.url, channels: current };
    for (const [action, channel] of changes) {
      const name = channel.replace(/[\u0000-\u001f\u007f]/gu, ' ');
      events.push(`${timestamp}\t${action}\t${source.id}\t${name}\n`);
    }
  }

  const epgFile = path('state', 'epg-index.json');
  const oldEpg = await optionalJson(epgFile);
  const epgUrls = new Set([
    ...sources.epg.map(source => source.url),
    ...projects.flatMap(({ project, epgSources }) =>
      epgSources.filter(source => project.epgSources.includes(source.id)).map(source => source.url)),
  ]);
  const epg = Object.fromEntries(await Promise.all([...epgUrls].map(async url => {
    if (has(oldEpg, url) && !refreshEpg) return [url, oldEpg[url]];
    try {
      const channels = await epgIndex(url);
      return [url, { checked: new Date().toISOString().slice(0, 10), channels }];
    } catch (error) {
      console.warn(`Az EPG-csatornaindex nem frissült (${new URL(url).host}): ${error.message}`);
      return [url, oldEpg[url] ?? { channels: [] }];
    }
  })));
  const logoFile = path('state', 'logos.json');
  const ids = [...new Set(Object.values(catalog).flatMap(streams => streams.map(stream => stream.attributes['tvg-id']).filter(Boolean)))];
  const logos = (await logoIndex(sources.logos, ids)) ?? await optionalJson(logoFile);

  await Promise.all(['data', 'playlists'].map(dir => mkdir(path('dist', dir), { recursive: true })));
  for (const file of await readdir(path('web'))) await cp(path('web', file), path('dist', file));
  const playlists = new Map();
  for (const { id, project, epgSources } of projects) {
    const filename = `${id}.m3u`;
    const content = renderPlaylist(project, catalog, logos, epgSources);
    playlists.set(filename, content);
    await writeFile(path('dist', 'playlists', filename), content);
  }
  const manifest = {
    repo: process.env.GITHUB_REPOSITORY ?? 'daermond/IPTV',
    branch: process.env.IPTV_BRANCH ?? 'main',
    generatedAt: new Date().toISOString(), sources, catalog, logos, epg,
    projects: projects.map(({ id, project }) => ({ id, name: project.name, project })),
  };
  await writeFile(path('dist', 'data', 'catalog.json'), JSON.stringify(manifest));
  if (updateState) {
    await updateRepoPlaylists(playlists);
    await mkdir(path('state'), { recursive: true });
    await writeIfChanged(stateFile, json(state));
    await writeIfChanged(epgFile, json(epg));
    await writeIfChanged(logoFile, json(logos));
    if (events.length) {
      const log = path('channel-changes.log');
      await access(log);
      const previous = await readFile(log, 'utf8');
      await writeFile(log, previous + events.join(''), 'utf8');
    }
  }
  console.log(`${projects.length} M3U elkészült · ${events.length} csatornaváltozás.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build({ updateState: process.argv.includes('--update-state'), refreshEpg: process.argv.includes('--refresh-epg') })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
