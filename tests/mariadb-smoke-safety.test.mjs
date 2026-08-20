import assert from 'node:assert/strict';
import test from 'node:test';

import { smokeDatabaseName } from '../lib/smoke-database-name.mjs';

test('MariaDB smoke refuses non-disposable database names', () => {
  assert.equal(smokeDatabaseName(undefined, 42), 'gbc_porting_smoke_42');
  assert.equal(smokeDatabaseName('gbc_porting_smoke_review'), 'gbc_porting_smoke_review');
  for (const unsafe of ['gbc_porting', 'gbc_porting_legacy', 'production', 'smoke_test',
    'gbc_porting_smoke_', 'gbc_porting_smoke_bad-name']) {
    assert.throws(() => smokeDatabaseName(unsafe), /must start with gbc_porting_smoke_/i);
  }
});
