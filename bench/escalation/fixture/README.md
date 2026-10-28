# quotes

A small shipping-quote system: the gateway answers customers, the price service is the source of truth for prices.

- `services/shared/money.ts`: rounding and formatting
- `services/price/price.ts`: the price service's quote
- `services/gateway/quote.ts`: the gateway's quote
- `services/price/table.ts`: the price table and its update
- `services/gateway/routes.ts`: the gateway's HTTP handlers (each gets the resolved `Caller`)

Run the tests with `bun test`.
