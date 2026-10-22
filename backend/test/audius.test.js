// Pruebas del proveedor Audius (sin red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudiusClient, toAudiusTrack } from '../src/music-providers/audius.js';

const ITEM = {
  id: 'a5aXGmz',
  title: 'Return',
  genre: 'Afro Beat',
  duration: 170,
  bpm: 115,
  musical_key: 'A flat minor',
  is_streamable: true,
  permalink: '/nazah/return',
  user: { name: 'nazah' },
  artwork: { '480x480': 'https://creatornode.audius.co/content/x/480x480.jpg' },
  license: null,
};

test('convierte una pista de Audius con BPM, tonalidad y crédito', () => {
  const track = toAudiusTrack(ITEM);
  assert.equal(track.provider, 'audius');
  assert.equal(track.bpm, 115);
  assert.equal(track.musicalKey, 'A flat minor');
  assert.equal(track.artist, 'nazah');
  assert.equal(track.shareUrl, 'https://audius.co/nazah/return');
  assert.equal(track.audioUrl, 'https://api.audius.co/v1/tracks/a5aXGmz/stream?app_name=SmartDJ');
  assert.equal(track.nonCommercial, true);
  assert.equal(track.licenseLabel, 'Términos de Audius');
});

test('descarta pistas no reproducibles o con id raro', () => {
  assert.equal(toAudiusTrack({ ...ITEM, is_streamable: false }), null);
  assert.equal(toAudiusTrack({ ...ITEM, id: '../x' }), null);
  assert.equal(toAudiusTrack({ ...ITEM, bpm: 900 }).bpm, 0);
  assert.equal(toAudiusTrack({ ...ITEM, permalink: 'https://evil.example' }).shareUrl, null);
});

test('la clave va solo en la cabecera, nunca en la URL del audio', async () => {
  let options;
  const http = {
    get: async (_url, o) => {
      options = o;
      return { data: { data: [ITEM] } };
    },
  };
  const [track] = await createAudiusClient({ apiKey: 'clave-secreta', http }).search({ q: 'return' });
  assert.equal(options.headers.Authorization, 'Bearer clave-secreta');
  assert.ok(!track.audioUrl.includes('clave-secreta'));
  await assert.rejects(createAudiusClient({ apiKey: '' }).search({ q: 'x' }), { status: 503 });
});
