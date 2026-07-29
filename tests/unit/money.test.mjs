import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMinorUnits, sumMinorUnits } from '../../scripts/lib/money.mjs';

test('money helpers accept only safe integer minor units', () => {
  assert.equal(assertMinorUnits(125050), 125050);
  assert.equal(sumMinorUnits([800000, 64000]), 864000);
  assert.throws(() => assertMinorUnits(12.5), /safe integer/);
  assert.throws(() => sumMinorUnits([Number.MAX_SAFE_INTEGER, 1]), /safe integer range/);
});
