// Pruebas del proveedor Jamendo (sin red: datos de ejemplo y un cliente HTTP falso).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioUrlFor,
  createJamendoClient,
  licenseFromUrl,
  reduceWaveform,
  safeImageUrl,
  toJamendoTrack,
} from '../src/music-providers/jamendo.js';

const ITEM = {
  id: '1532771',
  name: 'Summer Lounge',
  duration: 214,
  artist_name: 'Chill Artist',
  image: 'https://usercontent.jamendo.com/?type=album&id=1&width=300',
  audio: 'https://prod-1.storage.jamendo.com/?trackid=1532771&format=mp31&from=app-secreto',
  license_ccurl: 'http://creativecommons.org/licenses/by-nc-sa/3.0/',
  waveform: '{"peaks":[0,10,20,40,80,40,20,10]}',
  musicinfo: { speed: 'high', tags: { genres: ['lounge', 'electronic'] } },
};

test('convierte una pista de Jamendo con crédito, licencia y energía', () => {
  const track = toJamendoTrack(ITEM);
  assert.equal(track.provider, 'jamendo');
  assert.equal(track.externalId, '1532771');
  assert.equal(track.title, 'Summer Lounge');
  assert.equal(track.artist, 'Chill Artist');
  assert.equal(track.genre, 'lounge');
  assert.equal(track.durationSeconds, 214);
  assert.equal(track.energy, 4);
  assert.equal(track.bpm, 0);
  assert.equal(track.shareUrl, 'https://www.jamendo.com/track/1532771');
  assert.equal(track.licenseLabel, 'CC BY-NC-SA 3.0');
  assert.equal(track.licenseUrl, 'https://creativecommons.org/licenses/by-nc-sa/3.0/');
  assert.equal(track.nonCommercial, true);
  assert.equal(track.waveform.length, 8);
});

test('el audio va por mp3l (CORS abierto) y nunca lleva el client_id', () => {
  const track = toJamendoTrack(ITEM);
  assert.equal(track.audioUrl, 'https://mp3l.jamendo.com/?trackid=1532771&format=mp31');
  assert.ok(!track.audioUrl.includes('from='));
  assert.equal(audioUrlFor('1 OR 1=1'), null);
  assert.equal(audioUrlFor(''), null);
});

test('reconoce licencias comerciales, no comerciales y desconocidas', () => {
  assert.deepEqual(licenseFromUrl('https://creativecommons.org/licenses/by/4.0/'), {
    label: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    nonCommercial: false,
  });
  assert.equal(licenseFromUrl('http://creativecommons.org/licenses/by-sa/3.0/').nonCommercial, false);
  assert.equal(licenseFromUrl('http://creativecommons.org/licenses/by-nc-nd/3.0/').nonCommercial, true);
  assert.equal(licenseFromUrl('https://evil.example/licenses/by/4.0/').nonCommercial, true);
  assert.equal(licenseFromUrl(undefined).label, 'Licencia desconocida');
});

test('la portada solo se acepta por https y de Jamendo', () => {
  assert.equal(safeImageUrl('https://usercontent.jamendo.com/a.jpg'), 'https://usercontent.jamendo.com/a.jpg');
  assert.equal(safeImageUrl('http://usercontent.jamendo.com/a.jpg'), null);
  assert.equal(safeImageUrl('https://jamendo.com.evil.example/a.jpg'), null);
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
});

test('reduce la forma de onda a 120 picos normalizados', () => {
  const peaks = reduceWaveform({ peaks: Array.from({ length: 1000 }, (_, i) => i % 50) });
  assert.equal(peaks.length, 120);
  assert.ok(peaks.every((v) => v >= 0 && v <= 1));
  assert.equal(Math.max(...peaks), 1);
  assert.deepEqual(reduceWaveform('no es json'), []);
  assert.deepEqual(reduceWaveform(null), []);
});

test('descarta pistas sin id o sin nombre y tolera musicinfo ausente', () => {
  assert.equal(toJamendoTrack({ ...ITEM, id: undefined }), null);
  assert.equal(toJamendoTrack({ ...ITEM, name: '' }), null);
  const bare = toJamendoTrack({ id: 5, name: 'X' });
  assert.equal(bare.energy, 0);
  assert.equal(bare.genre, '');
  assert.equal(bare.artist, 'Artista desconocido');
  assert.equal(bare.nonCommercial, true);
});

test('el cliente no llama a Jamendo sin client_id ni con la cuota agotada', async () => {
  let calls = 0;
  const http = {
    get: async () => {
      calls += 1;
      return { data: { headers: { status: 'success' }, results: [ITEM] } };
    },
  };
  await assert.rejects(createJamendoClient({ clientId: '', http }).search({ q: 'x' }), { status: 503 });
  await assert.rejects(createJamendoClient({ clientId: 'id', http, allowCall: async () => false }).search({ q: 'x' }), { status: 503 });
  assert.equal(calls, 0);
  const tracks = await createJamendoClient({ clientId: 'id', http }).search({ q: 'x', tags: ['lounge', 'jazz'] });
  assert.equal(calls, 1);
  assert.equal(tracks[0].externalId, '1532771');
});

test('el cliente envía los filtros y convierte los errores de Jamendo', async () => {
  let params;
  const ok = {
    get: async (_url, options) => {
      params = options.params;
      return { data: { headers: { status: 'success' }, results: [] } };
    },
  };
  await createJamendoClient({ clientId: 'id', http: ok }).search({ tags: ['lounge', 'jazz'], limit: 50 });
  assert.equal(params.fuzzytags, 'lounge jazz');
  assert.equal(params.include, 'musicinfo');
  assert.equal(params.limit, 50);
  assert.equal(params.order, 'popularity_month');
  assert.equal(params.durationbetween, '90_480');
  assert.equal(params.boost, undefined);
  await createJamendoClient({ clientId: 'id', http: ok }).search({ q: 'vivir' });
  assert.deepEqual([params.search, params.boost, params.order], ['vivir', 'popularity_total', undefined]);
  const failed = { get: async () => ({ data: { headers: { status: 'failed', code: 5, error_message: 'x' } } }) };
  await assert.rejects(createJamendoClient({ clientId: 'id', http: failed }).search({ q: 'x' }), { status: 502 });
  const timeout = {
    get: async () => {
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    },
  };
  await assert.rejects(createJamendoClient({ clientId: 'id', http: timeout }).search({ q: 'x' }), { status: 504 });
});
