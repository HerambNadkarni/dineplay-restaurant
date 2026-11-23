import { io } from 'socket.io-client'

const configuredApiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:5000').trim().replace(/\/+$/, '')
export const API_URL = /\/api$/i.test(configuredApiUrl) ? configuredApiUrl : `${configuredApiUrl}/api`
export const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL || new URL(API_URL).origin).trim().replace(/\/+$/, '')

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json') ? await response.json() : null
  if (!response.ok) {
    const error = new Error(result?.message || result?.error || `Request failed (${response.status}).`)
    error.status = response.status
    error.remainingSeconds = Number(result?.remainingSeconds) || 0
    error.cooldownEndsAt = Number(result?.cooldownEndsAt) || 0
    throw error
  }
  return result
}

export function connectLiveUpdates() {
  return io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
  })
}

export async function fetchMenu(filters = {}) {
  const query = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  })
  return request(`/menu${query.size ? `?${query}` : ''}`)
}

export async function fetchTables({ token } = {}) {
  return request('/tables', { token })
}

export async function fetchTodayRevenue(token) {
  return request('/revenue/today', { token })
}

export async function createSession(tableId, { name, phone = '' }) {
  return request('/sessions/join', {
    method: 'POST',
    body: {
      tableNumber: Number(tableId),
      customerName: name.trim(),
      customerPhone: phone.trim(),
    },
  })
}

export async function leaveSession(_tableId, guestId, sessionId) {
  return request(`/sessions/${sessionId}/guests/${guestId}`, { method: 'DELETE' })
}

export async function addToCart(tableId, item, customerId, note = '') {
  return request(`/tables/${Number(tableId)}/cart`, {
    method: 'POST',
    body: { itemId: item.id, customerId, note },
  })
}

export async function updateCartLine(tableId, lineId, quantity, note) {
  return request(`/tables/${Number(tableId)}/cart/${lineId}`, {
    method: 'PATCH',
    body: { quantity, ...(note === undefined ? {} : { note }) },
  })
}

export async function placeOrder(tableId, customer, instructions = '') {
  return request('/orders', {
    method: 'POST',
    body: {
      tableNumber: Number(tableId),
      sessionId: customer.sessionId,
      customerId: customer.id,
      instructions: instructions.trim(),
    },
  })
}

export async function updateOrderStatus(_tableId, orderId, status, { token } = {}) {
  return request(`/orders/${orderId}/status`, { method: 'PATCH', body: { status }, token })
}

export async function confirmOrderServed(orderId, customerId) {
  return request(`/orders/${orderId}/confirm-served`, {
    method: 'POST',
    body: { customerId },
  })
}

export async function callWaiter(tableId, customer, reason) {
  return request(`/tables/${Number(tableId)}/call-waiter`, {
    method: 'POST',
    body: { customerId: customer.id, reason },
  })
}

export async function resolveCall(tableId, callId, { token } = {}) {
  return request(`/tables/${Number(tableId)}/resolve-waiter`, {
    method: 'POST',
    body: { callId },
    token,
  })
}

export async function payBill(_tableId, method, sessionId, { token } = {}) {
  if (!sessionId) throw new Error('There is no active table session to pay.')
  const paymentMethod = method === 'Cash at counter' ? 'Cash' : method
  return request(`/sessions/${sessionId}/pay`, {
    method: 'POST',
    body: { paymentMethod },
    token,
  })
}

export async function approvePayment(sessionId, { token } = {}) {
  if (!sessionId) throw new Error('There is no active table session to approve.')
  return request(`/sessions/${sessionId}/approve-payment`, { method: 'POST', token })
}

export async function awardCoupon(_tableId, sessionId) {
  if (!sessionId) throw new Error('Join a table before claiming a game reward.')
  return request(`/sessions/${sessionId}/reward`, {
    method: 'POST',
    body: { discountPercent: 5 },
  })
}

export async function addAdminItem(tableId, item, { token } = {}) {
  return request(`/tables/${Number(tableId)}/orders/items`, {
    method: 'POST',
    body: { itemId: item.id },
    token,
  })
}

export async function closeTable(tableId, { token } = {}) {
  return request(`/tables/${Number(tableId)}/close`, { method: 'POST', token })
}

export async function loginStaff(credentials) {
  return request('/auth/login', { method: 'POST', body: credentials })
}

export async function signupStaff(details) {
  return request('/auth/signup', { method: 'POST', body: details })
}

export async function logoutStaff(token) {
  return request('/auth/logout', { method: 'POST', token })
}
