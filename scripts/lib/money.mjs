export function assertMinorUnits(value, name = 'amount') {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer in minor units.`);
  return value;
}

export function sumMinorUnits(values) {
  return values.reduce((total, value, index) => {
    assertMinorUnits(value, `amount[${index}]`);
    const next = total + value;
    if (!Number.isSafeInteger(next)) throw new RangeError('Minor-unit total exceeds the safe integer range.');
    return next;
  }, 0);
}
