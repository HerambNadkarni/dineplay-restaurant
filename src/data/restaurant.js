export const initialTables = () =>
  Array.from({ length: 10 }, (_, index) => ({
    id: String(index + 1).padStart(2, '0'),
    customers: [],
    cart: [],
    orders: [],
    calls: [],
    callCooldownEndsAt: null,
    coupon: null,
    payment: null,
  }))
