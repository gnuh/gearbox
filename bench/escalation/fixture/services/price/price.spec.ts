import { expect, test } from 'bun:test'
import { priceQuote } from './price'

test('one item, no discount, no insurance', () => {
  expect(priceQuote({ items: [{ weightKg: 2, base: 10 }], discountPct: 0, insurancePct: 0, declaredValue: 0 })).toBe(12.74)
})
