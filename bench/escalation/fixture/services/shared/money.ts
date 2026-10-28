export const round2 = (n: number) => Math.round(n * 100) / 100

export const formatMoney = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`
