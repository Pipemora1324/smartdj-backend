// Pruebas del mapeo de resultados de iTunes (sin red: datos de ejemplo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeMediaUrl, toTrack } from '../src/music-search.js';

const ITEM = {
  kind: 'song', trackId: 1440818839, trackName: 'Vivir Mi Vida', artistName: 'Marc Anthony', primaryGenreName: 'Salsa y Tropical',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/x.m4a', trackTimeMillis: 251000,
  trackViewUrl: 'https://music.apple.com/co/album/vivir-mi-vida/1440818834?i=1440818839',
};

test('convierte un resultado de iTunes en canción', () => {
  assert.deepEqual(toTrack(ITEM), {
    trackId: '1440818839', title: 'Vivir Mi Vida', artist: 'Marc Anthony', genre: 'Salsa y Tropical',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music/x/300x300bb.jpg',
    previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/x.m4a', durationMs: 251000,
    source: 'itunes', kind: 'preview', kindLabel: 'Preview 30 s', storeUrl: 'https://music.apple.com/co/album/vivir-mi-vida/1440818834?i=1440818839',
  });
  assert.equal(toTrack({ ...ITEM, trackViewUrl: 'https://evil.example/x' }).storeUrl, null);
});

test('descarta resultados que no son canciones o no tienen id', () => {
  assert.equal(toTrack({ ...ITEM, kind: 'music-video' }), null);
  assert.equal(toTrack({ ...ITEM, trackId: undefined }), null);
  assert.equal(toTrack(null), null);
});

test('rellena artista y género faltantes', () => {
  const track = toTrack({ ...ITEM, artistName: undefined, primaryGenreName: undefined });
  assert.equal(track.artist, 'Artista desconocido');
  assert.equal(track.genre, 'Sin género');
});

test('solo acepta URLs https de dominios de Apple', () => {
  assert.equal(safeMediaUrl('https://is1-ssl.mzstatic.com/a.jpg'), 'https://is1-ssl.mzstatic.com/a.jpg');
  assert.equal(safeMediaUrl('http://is1-ssl.mzstatic.com/a.jpg'), null);
  assert.equal(safeMediaUrl('javascript:alert(1)'), null);
  assert.equal(safeMediaUrl('https://evil.example.com/mzstatic.com.jpg'), null);
  assert.equal(safeMediaUrl('https://mzstatic.com.evil.example/a.jpg'), null);
  assert.equal(safeMediaUrl(42), null);
});
