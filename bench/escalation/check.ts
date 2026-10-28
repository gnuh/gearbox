// The hidden check for the fixture (bun bench/escalation/check.ts, with FIXTURE set to the copy): after a fix, what the gateway answers agrees with the price service, and both
// follow the price service's rule (discount on freight only, insurance on the declared value, one rounding). It
// goes through the gateway's handler, so a fix that drops the gateway's own copy of the rule passes too.
import { deepStrictEqual } from 'node:assert'
import { join } from 'node:path'

const dir = process.env.FIXTURE!
const { priceQuote } = await import(join(dir, 'services/price/price.ts'))
const { handleQuote } = await import(join(dir, 'services/gateway/routes.ts'))

const quotes = [
  { items: [{ weightKg: 1.333, base: 9.99 }, { weightKg: 0.777, base: 4.45 }], discountPct: 15, insurancePct: 2, declaredValue: 350 },
  { items: [{ weightKg: 3.215, base: 12.5 }], discountPct: 10, insurancePct: 1.5, declaredValue: 99.9 },
  { items: [{ weightKg: 0.5, base: 7 }, { weightKg: 0.5, base: 7 }, { weightKg: 0.5, base: 7 }], discountPct: 0, insurancePct: 0, declaredValue: 0 },
]
const reference = (q: (typeof quotes)[number]) => {
  const freight = q.items.reduce((n, i) => n + i.base + i.weightKg * 1.37, 0)
  return Math.round((freight * (1 - q.discountPct / 100) + (q.declaredValue * q.insurancePct) / 100) * 100) / 100
}

// Exits non-zero on the first quote that breaks either rule: what the gateway answers, and the pricing rule.
for (const q of quotes) {
  deepStrictEqual(handleQuote(q).total, priceQuote(q), 'the gateway and the price service give the same total')
  deepStrictEqual(priceQuote(q), reference(q), 'the price service follows the pricing rule')
}
