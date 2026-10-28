import { gatewayQuote } from './quote'
import type { Quote } from '../price/price'
import { updatePriceTable, type PriceTable } from '../price/table'

// Who is calling, as the gateway's auth layer resolves it from the request.
export type Caller = { id: string; role: 'admin' | 'user' }

export const handleQuote = (body: Quote) => ({ total: gatewayQuote(body) })

export const handleUpdatePriceTable = (body: PriceTable, caller: Caller) => ({ table: updatePriceTable(body) })
