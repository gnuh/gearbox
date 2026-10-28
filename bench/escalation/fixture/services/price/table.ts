// The price table the price service quotes from. Anyone who reaches updatePriceTable can change it today.
export type PriceTable = { perKg: number; minimum: number }

let table: PriceTable = { perKg: 1.37, minimum: 5 }

export const getPriceTable = (): PriceTable => table

export const updatePriceTable = (next: PriceTable) => {
  table = next
  return table
}
