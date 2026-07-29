import { assertMinorUnits, sumMinorUnits } from './money.mjs';

function safeIntegerFromBigInt(value, name) {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new RangeError(`${name} exceeds the safe integer range.`);
  return converted;
}

function greatestCommonDivisor(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function parseDecimalQuantity(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) {
    throw new TypeError('quantity must be a positive decimal string with at most 6 decimal places.');
  }
  const [whole, fraction = ''] = text.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator <= 0n) throw new RangeError('quantity must be greater than zero.');
  const divisor = greatestCommonDivisor(numerator, scale);
  return {
    numerator: safeIntegerFromBigInt(numerator / divisor, 'quantity numerator'),
    scale: safeIntegerFromBigInt(scale / divisor, 'quantity scale'),
    display: text
  };
}

export function roundRatioHalfUp(numerator, denominator, name = 'calculation') {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || numerator < 0n || denominator <= 0n) {
    throw new TypeError(`${name} requires non-negative integer terms and a positive denominator.`);
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return safeIntegerFromBigInt(quotient + (remainder * 2n >= denominator ? 1n : 0n), name);
}

export function calculateLineItem({ quantity, unitPriceMinor }) {
  assertMinorUnits(unitPriceMinor, 'unitPriceMinor');
  if (unitPriceMinor < 0) throw new RangeError('unitPriceMinor must be non-negative.');
  const parsed = parseDecimalQuantity(quantity);
  const subtotalMinor = roundRatioHalfUp(
    BigInt(unitPriceMinor) * BigInt(parsed.numerator),
    BigInt(parsed.scale),
    'line subtotal'
  );
  return { ...parsed, unitPriceMinor, subtotalMinor };
}

export function calculateDiscount(subtotalMinor, discount) {
  assertMinorUnits(subtotalMinor, 'subtotalMinor');
  if (subtotalMinor < 0) throw new RangeError('subtotalMinor must be non-negative.');
  if (!discount || discount.type === 'NONE') return { type: 'NONE', value: 0, amountMinor: 0 };
  if (discount.type === 'FIXED') {
    assertMinorUnits(discount.amount_minor, 'discount.amount_minor');
    if (discount.amount_minor < 0 || discount.amount_minor > subtotalMinor) {
      throw new RangeError('Fixed discount must be between zero and the subtotal.');
    }
    return { type: 'FIXED', value: discount.amount_minor, amountMinor: discount.amount_minor };
  }
  if (discount.type === 'PERCENTAGE') {
    if (!Number.isInteger(discount.basis_points) || discount.basis_points < 0 || discount.basis_points > 10000) {
      throw new RangeError('Percentage discount basis_points must be an integer from 0 to 10000.');
    }
    return {
      type: 'PERCENTAGE',
      value: discount.basis_points,
      amountMinor: roundRatioHalfUp(BigInt(subtotalMinor) * BigInt(discount.basis_points), 10000n, 'discount')
    };
  }
  throw new TypeError(`Unsupported discount type: ${discount.type}.`);
}

export function calculateTax(netMinor, taxRule) {
  assertMinorUnits(netMinor, 'netMinor');
  if (netMinor < 0) throw new RangeError('netMinor must be non-negative.');
  if (!taxRule) return { mode: 'NONE', amountMinor: 0 };
  if (taxRule.calculation_method !== 'EXCLUSIVE') {
    throw new Error(`F5 supports EXCLUSIVE tax rules only; received ${taxRule.calculation_method}.`);
  }
  if (!Number.isInteger(taxRule.rate_basis_points) || taxRule.rate_basis_points < 0) {
    throw new TypeError('Tax rate_basis_points must be a non-negative integer.');
  }
  return {
    mode: 'RULE',
    amountMinor: roundRatioHalfUp(BigInt(netMinor) * BigInt(taxRule.rate_basis_points), 10000n, 'tax')
  };
}

export function calculateQuotationTotals({ lineItems, discount, taxRule }) {
  const calculatedLines = lineItems.map(calculateLineItem);
  const subtotalMinor = sumMinorUnits(calculatedLines.map((line) => line.subtotalMinor));
  const calculatedDiscount = calculateDiscount(subtotalMinor, discount);
  const netMinor = subtotalMinor - calculatedDiscount.amountMinor;
  const calculatedTax = calculateTax(netMinor, taxRule);
  const totalMinor = sumMinorUnits([netMinor, calculatedTax.amountMinor]);
  return {
    lines: calculatedLines,
    subtotalMinor,
    discountMinor: calculatedDiscount.amountMinor,
    discount: calculatedDiscount,
    taxMinor: calculatedTax.amountMinor,
    tax: calculatedTax,
    totalMinor
  };
}

export function calculateValidUntil(issueDate, validityDays) {
  if (typeof issueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new TypeError('issue_date must use YYYY-MM-DD.');
  if (!Number.isInteger(validityDays) || validityDays <= 0 || validityDays > 3650) {
    throw new RangeError('validity_days must be an integer from 1 to 3650.');
  }
  const date = new Date(`${issueDate}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== issueDate) throw new RangeError('issue_date must be a real calendar date.');
  date.setUTCDate(date.getUTCDate() + validityDays);
  return date.toISOString().slice(0, 10);
}
