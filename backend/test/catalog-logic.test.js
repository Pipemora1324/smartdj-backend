// Pruebas de la lógica del catálogo (caché, crédito, licencias y coincidencia de peticiones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackUpsert, filterLicense, isFresh, matchesRequest, monthKey, normalizeText, searchKey, tagsForVenue, toPublicTrack, uniqueTracks } from '../src/catalog-logic.js';

const TRACK = { provider: 'jamendo', externalId: '1', title: 'A', artist: 'B', genre: 'lounge', durationSeconds: 200, artworkUrl: null, audioUrl: 'https://mp3l.jamendo.com/?trackid=1&format=mp31', shareUrl: 'https://www.jamendo.com/track/1', licenseUrl: null, licenseLabel: 'CC BY 4.0', nonCommercial: false, bpm: 0, musicalKey: '', energy: 3, waveform: [0.5] };
const ROW = { id: 'u1', provider: 'jamendo', external_id: '1', title: 'Summer', artist: 'Ana', genre: 'lounge', duration_seconds: 200, artwork_url: null, audio_url: 'https://mp3l.jamendo.com/?trackid=1&format=mp31', waveform: [0.2], energy: 3, bpm: null, musical_key: null, share_url: 'https://www.jamendo.com/track/1', license_label: 'CC BY-NC 3.0', license_url: 'https://creativecommons.org/licenses/by-nc/3.0/', non_commercial: true };

test('la clave de caché no depende de mayúsculas, acentos ni el orden de los géneros', () => {
  assert.equal(searchKey('jamendo', '  Canción  Ñ ', ['Jazz', 'lounge']), searchKey('jamendo', 'cancion n', ['lounge', 'jazz']));
  assert.notEqual(searchKey('jamendo', 'x', []), searchKey('audius', 'x', []));
  assert.ok(searchKey('jamendo', 'x'.repeat(500), []).length <= 200);
  assert.equal(normalizeText('¡Hola, Señor!'), 'hola senor');
});

test('el caché vence a las 24 horas', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(isFresh('2026-10-21T00:00:00Z', now), true);
  assert.equal(isFresh('2026-10-20T11:59:00Z', now), false);
});

test('el contador de cuota es por mes', () => {
  assert.equal(monthKey(new Date('2026-10-21T12:00:00Z')), 'jamendo:calls:2026-10');
});

test('arma el upsert sin duplicados y con parámetros, no con texto concatenado', () => {
  const tracks = uniqueTracks([TRACK, { ...TRACK }, { ...TRACK, externalId: '2' }]);
  assert.equal(tracks.length, 2);
  const { text, values } = buildTrackUpsert(tracks);
  assert.equal(values.length, 32);
  assert.ok(text.includes('ON CONFLICT (provider, external_id)'));
  assert.ok(!text.includes('mp3l'));
});

test('la pista pública lleva crédito y licencia; sin audio cuando se pide', () => {
  const track = toPublicTrack(ROW);
  assert.deepEqual(track.credit, { artist: 'Ana', title: 'Summer', url: 'https://www.jamendo.com/track/1', source: 'Jamendo', license: 'CC BY-NC 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc/3.0/', nonCommercial: true });
  assert.equal(track.audioUrl, ROW.audio_url);
  assert.equal(track.audioFallbackUrl, 'https://prod-1.storage.jamendo.com/?trackid=1&format=mp31');
  assert.equal(toPublicTrack({ ...ROW, provider: 'audius' }).audioFallbackUrl, null);
  const publicTrack = toPublicTrack(ROW, { withAudio: false });
  assert.equal(publicTrack.audioUrl, undefined);
  assert.equal(publicTrack.audioFallbackUrl, undefined);
  assert.equal(publicTrack.waveform, undefined);
  assert.equal(toPublicTrack(null), null);
});

test('filtra las pistas no comerciales solo si el local lo pide', () => {
  const rows = [ROW, { ...ROW, id: 'u2', non_commercial: false }];
  assert.equal(filterLicense(rows, false).length, 2);
  assert.deepEqual(filterLicense(rows, true).map((r) => r.id), ['u2']);
});

test('reconoce la misma canción del catálogo libre', () => {
  assert.equal(matchesRequest({ title: 'Vivir Mi Vida (Radio Edit)', artist: 'Marc Anthony' }, 'Vivir mi vida', 'Marc Anthony'), true);
  assert.equal(matchesRequest({ title: 'Vivir', artist: 'Marc Anthony feat. X' }, 'Vivir', 'marc anthony'), true);
  assert.equal(matchesRequest({ title: 'Vivir Mi Vida', artist: 'Otro' }, 'Vivir Mi Vida', 'Marc Anthony'), false);
  assert.equal(matchesRequest({ title: 'Vivir', artist: '' }, 'Vivir', ''), false);
});

test('cada tipo de local tiene géneros y los desconocidos usan los de "other"', () => {
  assert.ok(tagsForVenue('nightclub').includes('electronic'));
  assert.deepEqual(tagsForVenue('nope'), tagsForVenue('other'));
});

test('el género de una petición de iTunes se traduce a tags de Jamendo', async () => {
  const { tagsForGenre } = await import('../src/catalog-logic.js');
  assert.deepEqual(tagsForGenre('Salsa y Tropical'), ['latin', 'reggaeton']);
  assert.deepEqual(tagsForGenre('Electrónica'), ['electronic', 'house']);
  assert.deepEqual(tagsForGenre('Hip-Hop/Rap'), ['hiphop']);
  assert.deepEqual(tagsForGenre('Pop Latino'), ['latin', 'reggaeton']);
  assert.deepEqual(tagsForGenre('Clásica'), []);
});

test('distingue pistas completas de previews y lo muestra en la pista pública', async () => {
  const { toPublicTrack: publicTrack, trackKind } = await import('../src/catalog-logic.js');
  assert.equal(trackKind('jamendo'), 'full');
  assert.equal(trackKind('itunes'), 'preview');
  const preview = publicTrack({ ...ROW, provider: 'itunes', license_label: 'Preview cortesía de iTunes' });
  assert.deepEqual([preview.kind, preview.kindLabel, preview.credit.source, preview.audioFallbackUrl], ['preview', 'Preview 30 s', 'iTunes', null]);
  assert.equal(publicTrack(ROW).kindLabel, 'Completa');
});

test('saca géneros del ambiente del local y los pone antes que los del tipo', async () => {
  const { tagsInText, tagsForVenueProfile } = await import('../src/catalog-logic.js');
  assert.deepEqual(tagsInText('Jazz suave y algo de salsa'), ['latin', 'reggaeton', 'jazz']);
  assert.deepEqual(tagsInText(''), []);
  const tags = tagsForVenueProfile({ kind: 'nightclub', ambience: 'Rock en vivo' });
  assert.equal(tags[0], 'rock');
  assert.ok(tags.includes('electronic'));
  assert.equal(new Set(tags).size, tags.length);
});

test('convierte una petición de iTunes en un corte de 30 s', async () => {
  const { itunesRequestTrack } = await import('../src/catalog-logic.js');
  const request = { external_id: '1440818839', title: 'Vivir Mi Vida', artist: 'Marc Anthony', genre: 'Salsa', preview_url: 'https://audio-ssl.itunes.apple.com/x.m4a', store_url: 'https://music.apple.com/co/album/x', artwork_url: null, bpm: null, musical_key: null };
  const track = itunesRequestTrack(request);
  assert.deepEqual([track.provider, track.durationSeconds, track.audioUrl, track.shareUrl, track.nonCommercial], ['itunes', 30, request.preview_url, request.store_url, true]);
  assert.equal(itunesRequestTrack({ ...request, preview_url: null }), null);
  assert.equal(itunesRequestTrack(null), null);
});

test('el buscador público prefiere pistas completas y completa con previews sin repetir', async () => {
  const { mergeSearchResults } = await import('../src/catalog-logic.js');
  const full = (n) => Array.from({ length: n }, (_, i) => ({ provider: 'jamendo', externalId: String(i), title: `Tema ${i}`, artist: 'Ana', genre: 'pop', artworkUrl: null, durationSeconds: 200, credit: {}, audioUrl: 'https://x' }));
  const previews = [
    { trackId: '1', title: 'Tema 0', artist: 'Ana', genre: 'Pop', previewUrl: 'https://audio-ssl.itunes.apple.com/a.m4a', storeUrl: 'https://music.apple.com/x' },
    { trackId: '2', title: 'Otra', artist: 'Beto', genre: 'Pop', previewUrl: 'https://audio-ssl.itunes.apple.com/b.m4a', storeUrl: null },
  ];
  const few = mergeSearchResults(full(2), previews);
  assert.deepEqual(few.map((r) => `${r.kindLabel}:${r.title}`), ['Completa:Tema 0', 'Completa:Tema 1', 'Preview 30 s:Otra']);
  assert.ok(few.every((r) => !('previewUrl' in r) && !('audioUrl' in r)));
  assert.equal(mergeSearchResults(full(6), previews).every((r) => r.kind === 'full'), true);
  assert.equal(mergeSearchResults(full(12), []).length, 10);
  assert.deepEqual(mergeSearchResults([], previews).map((r) => r.trackId), ['1', '2']);
});
