import { round2 } from '../shared/money'
import type { Quote } from '../price/price'

const PER_KG = 1.37

export const gatewayQuote = (q: Quote) => {
  const freight = q.items.reduce((n, i) => n + round2(i.base + i.weightKg * PER_KG), 0)
  const insurance = (q.declaredValue * q.insurancePct) / 100
  return round2((freight + insurance) * (1 - q.discountPct / 100))
}
