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
