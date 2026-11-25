import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { validateProject } from '../scripts/build.mjs';
import {
  collectChannels, manualChannelKey, membershipChanges, orderByGroups, parsePlaylist, projectChannels, renderPlaylist, streamKey,
} from '../web/playlist.js';

const first = parsePlaylist(`#EXTM3U
#EXTINF:-1 tvg-id="ATV.hu@SD" tvg-logo="https://example.org/atv.png",ATV
#EXTVLCOPT:http-user-agent=Example Player
https://example.org/atv.m3u8
#EXTINF:-1 tvg-id="ATV.hu@SD",ATV (360p)
https://example.org/atv-alt.m3u8
#EXTINF:-1 tvg-id="M4Sport.hu@SD" tvg-chno="4",M4 Sport
https://example.org/m4.m3u8
`);
const sources = {
  m3u: [{ id: 'hu', url: 'https://example.org/hu.m3u', name: 'Magyar lista' }],
  epg: [{ id: 'guide', url: 'https://example.org/guide.xml.gz', name: 'Műsorújság' }],
};
const config = { version: 1, name: 'Otthon', sources: ['hu'], epgSources: ['guide'],
  groups: ['Hírek'], order: [], sort: 'manual', streamMode: 'primary', channels: {} };

test('exports enabled channels, applies overrides and preserves original stream options', () => {
  const project = { ...config, channels: {
    'id:ATV.hu@SD': { name: 'ATV hírek', group: 'Hírek', number: 7, logo: 'https://example.org/custom.png',
      epg: { source: 'guide', id: 'atv.xmltv' } },
    'id:M4Sport.hu@SD': { enabled: false },
  } };
  const result = renderPlaylist(project, { hu: first }, {}, validateProject(project, sources));
  assert.match(result, /^#EXTM3U x-tvg-url="https:\/\/example.org\/guide.xml.gz"/u);
  assert.match(result, /tvg-id="atv.xmltv".*tvg-logo="https:\/\/example.org\/custom.png".*group-title="Hírek".*tvg-chno="7",ATV hírek/u);
  assert.match(result, /#EXTVLCOPT:http-user-agent=Example Player\nhttps:\/\/example.org\/atv.m3u8/u);
  assert.doesNotMatch(result, /M4Sport|atv-alt/u);
});

test('new channels are enabled and unassigned, and removed channels can return with their previous settings', () => {
  const project = { ...config, channels: { 'id:ATV.hu@SD': { name: 'Kedvenc', enabled: false } } };
  const m4 = projectChannels(project, { hu: [first[2]] }, {});
  assert.deepEqual(m4.map(({ name, number, group, enabled }) => ({ name, number, group, enabled })),
    [{ name: 'M4 Sport', number: 4, group: 'Unassigned', enabled: true }]);
  const atv = projectChannels(project, { hu: first }, {}).find(item => item.key === 'id:ATV.hu@SD');
  assert.equal(atv.name, 'Kedvenc');
  assert.equal(atv.enabled, false);
});

test('saves stream selection independently of numbering and supports both ordering modes', () => {
  const project = { ...config, channels: { 'id:ATV.hu@SD': { primary: streamKey(first[1]) } } };
  const byNumber = projectChannels({ ...project, sort: 'number' }, { hu: first }, {});
  assert.equal(byNumber[0].name, 'M4 Sport');
  const manual = projectChannels({ ...project, order: ['id:ATV.hu@SD', 'id:M4Sport.hu@SD'] }, { hu: first }, {});
  assert.equal(manual[0].primary.url, first[1].url);
  const all = renderPlaylist({ ...project, streamMode: 'all' }, { hu: first }, {}, sources.epg);
  assert.ok(all.indexOf(first[1].url) < all.indexOf(first[0].url));
  assert.equal([...all.matchAll(/#EXTINF:/gu)].length, 3);
});

test('merges exact matches across sources, preserves feed variants and deduplicates stream URLs with the same options', () => {
  const overseas = parsePlaylist('#EXTM3U\n#EXTINF:-1 tvg-id="ATV.hu@International",ATV Intl\nhttps://example.org/intl.m3u8\n');
  const merged = collectChannels(['hu', 'other'], { hu: first, other: [first[0], ...overseas] });
  assert.equal(merged.length, 3);
  assert.equal(merged.find(channel => channel.key === 'id:ATV.hu@SD').streams.length, 2);
});

test('applies custom group order once while keeping existing intra-group positions and Unassigned at the end', () => {
  const extras = parsePlaylist(`#EXTM3U
#EXTINF:-1 tvg-id="M1.hu@HD",M1
https://example.org/m1.m3u8
#EXTINF:-1 tvg-id="M5.hu@SD",M5
https://example.org/m5.m3u8
`);
  const project = {
    ...config,
    groups: ['Sport', 'Hírek'],
    sort: 'number',
    order: ['id:ATV.hu@SD', 'id:M4Sport.hu@SD', 'id:Missing.hu@SD', 'id:M1.hu@HD'],
    channels: {
      'id:ATV.hu@SD': { group: 'Hírek', number: 90 },
      'id:Missing.hu@SD': { group: 'Hírek' },
      'id:M1.hu@HD': { group: 'Hírek', number: 2 },
      'id:M4Sport.hu@SD': { group: 'Sport' },
    },
  };
  const catalog = { hu: [...first, ...extras] };
  const order = orderByGroups(project, catalog, {});
  assert.deepEqual(order, ['id:M4Sport.hu@SD', 'id:ATV.hu@SD', 'id:Missing.hu@SD', 'id:M1.hu@HD', 'id:M5.hu@SD']);
  assert.deepEqual(orderByGroups({ ...project, order, sort: 'manual' }, catalog, {}), order);
  const grouped = renderPlaylist({ ...project, order, sort: 'manual' }, catalog, {}, sources.epg);
  assert.deepEqual(parsePlaylist(grouped).map(stream => stream.attributes['group-title']), ['Sport', 'Hírek', 'Hírek', 'Unassigned']);
});

test('exports project-only channels with the same metadata and controls as imported channels', () => {
  const channel = { id: 'special', name: 'Saját TV', url: 'https://example.org/live.m3u8' };
  const key = manualChannelKey(channel.id);
  const project = {
    ...config,
    manualChannels: [channel],
    channels: { [key]: { group: 'Hírek', number: 7, epg: { source: 'guide', id: 'local.xmltv' } } },
  };
  const catalog = { hu: first };
  const guides = validateProject(project, sources);
  assert.equal(orderByGroups(project, catalog, {})[0], key);
  const manual = parsePlaylist(renderPlaylist(project, catalog, {}, guides)).find(stream => stream.url === channel.url);
  assert.equal(manual.name, channel.name);
  assert.equal(manual.attributes['group-title'], 'Hírek');
  assert.equal(manual.attributes['tvg-chno'], '7');
  assert.equal(manual.attributes['tvg-id'], 'local.xmltv');
  assert.ok(!renderPlaylist({ ...project, channels: { [key]: { enabled: false } } }, catalog, {}, guides).includes(channel.url));
  assert.throws(() => validateProject({ ...project, manualChannels: [channel, channel] }, sources), /manualChannels/u);
  assert.throws(() => validateProject({ ...project, manualChannels: [{ ...channel, url: channel.url + '\n#EXTINF:0' }] }, sources), /manualChannels/u);
});

test('uses the custom M3U only for the project that selects it', () => {
  const customM3u = { id: 'independent-source', name: 'Saját lista', url: 'https://example.org/custom.m3u' };
  const custom = { ...config, name: 'Egyéni', sources: [customM3u.id], customM3u };
  const stream = 'https://example.org/custom-channel.m3u8';
  const catalog = { hu: first, [customM3u.id]: parsePlaylist(`#EXTM3U\n#EXTINF:-1,Saját csatorna\n${stream}\n`) };
  const output = renderPlaylist(custom, catalog, {}, validateProject(custom, sources));
  assert.deepEqual(parsePlaylist(output).map(item => item.url), [stream]);
  const defaultOutput = renderPlaylist(config, catalog, {}, validateProject(config, sources));
  assert.ok(!defaultOutput.includes(stream));
  assert.throws(() => validateProject({ ...custom, customM3u: { ...customM3u, url: 'file:///playlist.m3u' } }, sources), /customM3u/u);
  assert.throws(() => validateProject({ ...custom, sources: ['hu'], customM3u: { ...customM3u, id: 'hu' } }, sources), /customM3u/u);
});

test('membership changes log only additions and removals after the first successful snapshot', () => {
  const before = { 'id:ATV.hu@SD': 'ATV', 'id:M4Sport.hu@SD': 'M4 Sport' };
  assert.deepEqual(membershipChanges(undefined, before), []);
  assert.deepEqual(membershipChanges(before, { ...before, 'id:ATV.hu@SD': 'ATV HD' }), []);
  assert.deepEqual(membershipChanges(before, { 'id:ATV.hu@SD': 'ATV', 'id:M1.hu@HD': 'M1 HD' }),
    [['ADDED', 'M1 HD'], ['REMOVED', 'M4 Sport']]);
  assert.throws(() => parsePlaylist('#EXTM3U\n'), /Üres/u);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:-1,Csatorna'), /hiányos/u);
});

test('extracts channel names and IDs from gzipped XMLTV while skipping programmes', () => {
  const xml = '<tv><channel id="example.hu"><display-name>Hírek</display-name></channel>' +
    '<programme channel="example.hu" start="20260101100000"><title>Programme</title></programme></tv>';
  const python = process.env.IPTV_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['scripts/epg-index.py'], { input: gzipSync(xml), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ id: 'example.hu', name: 'Hírek' }]);
});
