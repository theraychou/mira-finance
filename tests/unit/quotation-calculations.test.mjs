import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDiscount,
  calculateLineItem,
  calculateQuotationTotals,
  calculateTax,
  calculateValidUntil,
  parseDecimalQuantity
} from '../../scripts/lib/quotation-calculations.mjs';

test('line calculations support integer and decimal quantities using half-up minor-unit rounding', () => {
  assert.deepEqual(parseDecimalQuantity('1.25'), { numerator: 5, scale: 4, display: '1.25' });
  assert.equal(calculateLineItem({ quantity: '1.5', unitPriceMinor: 10001 }).subtotalMinor, 15002);
  assert.throws(() => calculateLineItem({ quantity: 1.5, unitPriceMinor: 100 }), /decimal string/);
});

test('percentage and fixed discounts use deterministic integer arithmetic', () => {
  assert.deepEqual(calculateDiscount(10005, { type: 'PERCENTAGE', basis_points: 1250 }), {
    type: 'PERCENTAGE', value: 1250, amountMinor: 1251
  });
  assert.deepEqual(calculateDiscount(10005, { type: 'FIXED', amount_minor: 500 }), {
    type: 'FIXED', value: 500, amountMinor: 500
  });
  assert.throws(() => calculateDiscount(100, { type: 'FIXED', amount_minor: 101 }), /subtotal/);
});

test('taxable and non-taxable totals reconcile exactly', () => {
  const lines = [
    { quantity: '2', unitPriceMinor: 10000 },
    { quantity: '0.5', unitPriceMinor: 10000 }
  ];
  const withoutTax = calculateQuotationTotals({ lineItems: lines, discount: { type: 'NONE' }, taxRule: null });
  assert.equal(withoutTax.totalMinor, 25000);
  assert.equal(withoutTax.subtotalMinor - withoutTax.discountMinor + withoutTax.taxMinor, withoutTax.totalMinor);

  const taxRule = { calculation_method: 'EXCLUSIVE', rate_basis_points: 600 };
  const withTax = calculateQuotationTotals({ lineItems: lines, discount: { type: 'PERCENTAGE', basis_points: 1000 }, taxRule });
  assert.deepEqual(
    { subtotal: withTax.subtotalMinor, discount: withTax.discountMinor, tax: withTax.taxMinor, total: withTax.totalMinor },
    { subtotal: 25000, discount: 2500, tax: 1350, total: 23850 }
  );
  assert.equal(withTax.subtotalMinor - withTax.discountMinor + withTax.taxMinor, withTax.totalMinor);
  assert.throws(() => calculateTax(100, { calculation_method: 'INCLUSIVE', rate_basis_points: 600 }), /EXCLUSIVE/);
});

test('validity dates use UTC calendar arithmetic', () => {
  assert.equal(calculateValidUntil('2028-02-28', 2), '2028-03-01');
  assert.throws(() => calculateValidUntil('2026-02-30', 30), /real calendar date/);
});
