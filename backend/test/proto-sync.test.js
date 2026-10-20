// El contrato gRPC vive en ai/proto y tiene una copia en backend/proto: deben ser idénticos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('backend/proto y ai/proto tienen el mismo compatibility.proto', () => {
  assert.equal(read('../proto/compatibility.proto'), read('../../ai/proto/compatibility.proto'));
});
