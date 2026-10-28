import { round2 } from '../shared/money'

export type Item = { weightKg: number; base: number }
export type Quote = { items: Item[]; discountPct: number; insurancePct: number; declaredValue: number }

const PER_KG = 1.37

// Freight for all items, the discount on the freight, insurance on the declared value, rounded once.
export const priceQuote = (q: Quote) => {
  const freight = q.items.reduce((n, i) => n + i.base + i.weightKg * PER_KG, 0)
  const discounted = freight * (1 - q.discountPct / 100)
  const insurance = (q.declaredValue * q.insurancePct) / 100
  return round2(discounted + insurance)
}
