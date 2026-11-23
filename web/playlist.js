export const UNASSIGNED = 'Unassigned';
export const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const has = (object, key) => Object.hasOwn(object, key);
const streamAddress = /^@?(?:https?|rtmps?|rtsps?|udp|rtp|mms|srt):\/\/\S/iu;

export function httpsUrl(value) {
  if (typeof value !== 'string' || !value || /[\s"<>]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function manualStreamUrl(value) {
  if (typeof value !== 'string' || !streamAddress.test(value) || /[\s\u0000-\u001f\u007f"<>\\]/u.test(value)) return false;
  try {
    const parsed = new URL(value.replace(/^@/u, ''));
    return Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function metadata(line) {
  let quoted = false;
  let comma = -1;
  for (let i = 8; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ',' && !quoted) {
      comma = i;
      break;
    }
  }
  if (comma === -1) throw new Error('Érvénytelen EXTINF sor.');
  const header = line.slice(8, comma).trim();
  const attributes = Object.fromEntries(
    [...header.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );
  return { name: line.slice(comma + 1).trim(), duration: header.split(/\s+/, 1)[0], attributes };
}

export function parsePlaylist(input) {
  const lines = input.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).map(line => line.trim());
  if (!/^#EXTM3U(?:\s|$)/u.test(lines[0])) throw new Error('Az M3U fejléc hiányzik.');
  const streams = [];
  let current;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXTINF:')) {
      if (current) throw new Error('Az egyik csatornához nem tartozik streamcím.');
      current = { ...metadata(line), directives: [] };
    } else if (current && /^#(?:EXTVLCOPT|KODIPROP|EXTHTTP|WEBPROP):/u.test(line)) {
      current.directives.push(line);
    } else if (current && line && !line.startsWith('#')) {
      if (!streamAddress.test(line)) {
        throw new Error('Érvénytelen vagy nem támogatott streamcím.');
      }
      streams.push({ ...current, url: line });
      current = undefined;
    }
  }
  if (current || streams.length === 0) throw new Error('Üres vagy hiányos M3U-forrás.');
  return streams;
}

export function channelKey(stream, sourceId) {
  const id = stream.attributes['tvg-id']?.trim();
  if (id) return `id:${id}`;
  const name = stream.name.replace(/\s*\(\d+[pi]\)(?=\s|$)/giu, '').trim().normalize('NFC');
  return `name:${sourceId}:${name.toLowerCase() || stream.url}`;
}

export function streamKey(stream) {
  return JSON.stringify([stream.url, ...stream.directives]);
}

export const manualChannelKey = id => `manual:${id}`;

export function collectChannels(sourceIds, catalog, logos = {}, aliases = {}) {
  const found = new Map();
  for (const sourceId of sourceIds) {
    for (const stream of catalog[sourceId] ?? []) {
      const key = channelKey(stream, sourceId);
      const mergedKey = has(aliases, key) ? aliases[key] : key;
      if (!found.has(mergedKey)) {
        found.set(mergedKey, {
          key: mergedKey,
          name: stream.name || stream.attributes['tvg-name'] || stream.attributes['tvg-id'] || 'Ismeretlen csatorna',
          logo: stream.attributes['tvg-logo'] || (has(logos, stream.attributes['tvg-id']) ? logos[stream.attributes['tvg-id']] : ''),
          number: Number(stream.attributes['tvg-chno']) || null,
          streams: [],
          streamKeys: new Set(),
        });
      }
      const channel = found.get(mergedKey);
      const signature = streamKey(stream);
      if (!channel.streamKeys.has(signature)) {
        channel.streamKeys.add(signature);
        channel.streams.push({ ...stream, sourceId });
      }
    }
  }
  return [...found.values()].map(({ streamKeys, ...channel }) => channel);
}

function projectGroup(project, group) {
  return project.groups.includes(group) ? group : UNASSIGNED;
}

export function projectChannels(project, catalog, logos) {
  const order = new Map(project.order.map((key, index) => [key, index]));
  const rank = key => order.get(key) ?? Infinity;
  const imported = collectChannels(project.sources, catalog, logos, project.aliases);
  const manual = (project.manualChannels ?? []).map(entry => ({
    key: manualChannelKey(entry.id), name: entry.name, number: null, logo: '', manual: entry,
    streams: [{ name: entry.name, url: entry.url, duration: '-1', attributes: {}, directives: [] }],
  }));
  return [...imported, ...manual]
    .map(channel => {
      const override = has(project.channels, channel.key) ? project.channels[channel.key] : {};
      const preferred = channel.streams.find(stream => streamKey(stream) === override.primary);
      return {
        ...channel,
        name: override.name ?? channel.name,
        logo: override.logo ?? channel.logo,
        number: has(override, 'number') ? override.number : channel.number,
        group: projectGroup(project, override.group),
        enabled: override.enabled !== false,
        epg: override.epg ?? null,
        primary: preferred ?? channel.streams[0],
      };
    })
    .sort((a, b) => {
      if (project.sort === 'number') {
        const byNumber = (a.number ?? Infinity) - (b.number ?? Infinity);
        if (byNumber) return byNumber;
      }
      return rank(a.key) - rank(b.key) || 0;
    });
}

export function orderByGroups(project, catalog, logos) {
  const channels = projectChannels({ ...project, sort: 'manual' }, catalog, logos);
  const channelGroups = new Map(channels.map(channel => [channel.key, channel.group]));
  const groups = new Map([...project.groups, UNASSIGNED].map(group => [group, []]));
  const order = new Set([...project.order, ...channelGroups.keys()]);
  for (const key of order) {
    // A channel that temporarily left the source keeps its saved position within its group.
    const group = channelGroups.get(key) ?? projectGroup(project, project.channels[key]?.group);
    groups.get(group).push(key);
  }
  return [...groups.values()].flat();
}

const clean = value => String(value ?? '').replace(/[\r\n\u0000]/gu, ' ');
const attr = value => clean(value).replace(/"/gu, '＂');

export function renderPlaylist(project, catalog, logos, epgSources) {
  const urls = project.epgSources.map(id => epgSources.find(source => source.id === id)?.url).filter(Boolean);
  const lines = [`#EXTM3U${urls.length ? ` x-tvg-url="${attr(urls.join(','))}"` : ''}`];
  for (const channel of projectChannels(project, catalog, logos)) {
    if (!channel.enabled) continue;
    const streams = project.streamMode === 'all'
      ? [channel.primary, ...channel.streams.filter(stream => stream !== channel.primary)]
      : [channel.primary];
    streams.forEach((stream, index) => {
      const attrs = { ...stream.attributes, 'tvg-name': channel.name, 'group-title': channel.group };
      if (channel.epg) attrs['tvg-id'] = channel.epg.id;
      if (channel.logo) attrs['tvg-logo'] = channel.logo;
      else delete attrs['tvg-logo'];
      if (channel.number !== null) attrs['tvg-chno'] = channel.number;
      else delete attrs['tvg-chno'];
      const settings = Object.entries(attrs).map(([key, value]) => ` ${key}="${attr(value)}"`).join('');
      const title = index ? `${channel.name} (${index + 1})` : channel.name;
      lines.push(`#EXTINF:${/^-?\d+$/u.test(stream.duration) ? stream.duration : -1}${settings},${clean(title)}`,
        ...stream.directives, stream.url);
    });
  }
  return `${lines.join('\n')}\n`;
}

export function membershipChanges(previous, current) {
  if (!previous) return [];
  return [
    ...Object.entries(current).filter(([id]) => !has(previous, id)).map(([, name]) => ['ADDED', name]),
    ...Object.entries(previous).filter(([id]) => !has(current, id)).map(([, name]) => ['REMOVED', name]),
  ];
}
