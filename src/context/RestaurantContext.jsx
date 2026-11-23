import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { menuItems as bundledMenu } from '../data/menuData'
import { initialTables } from '../data/restaurant'
import * as api from '../services/api'

const RestaurantContext = createContext(null)

function normalizeMenuItems(items) {
  return items.filter((item) => item && typeof item === 'object').map((item) => ({
    ...item,
    id: String(item.id ?? ''),
    name: String(item.name || 'Menu item'),
    emoji: String(item.emoji || '🍽️'),
    category: String(item.category || ''),
    description: String(item.description || ''),
    price: Number(item.price) || 0,
    type: item.type === 'Non-Veg' ? 'Non-Veg' : 'Veg',
    spice: ['Mild', 'Medium', 'Spicy'].includes(item.spice) ? item.spice : 'Mild',
    prepMinutes: Number(item.prepMinutes) || 15,
    popular: Boolean(item.popular),
  }))
}

function normalizeTableRows(rows) {
  const rowsById = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter(Boolean)
      .map((row) => [String(row.id ?? row.tableNumber ?? '').padStart(2, '0'), row]),
  )

  return initialTables().map((emptyTable) => {
    const row = rowsById.get(emptyTable.id)
    if (!row) return emptyTable

    return {
      ...emptyTable,
      ...row,
      id: emptyTable.id,
      customers: Array.isArray(row.customers)
        ? row.customers.filter(Boolean).map((guest) => ({
          ...guest,
          id: String(guest.id ?? ''),
          name: String(guest.name || 'Guest'),
          phone: guest.phone || '',
        }))
        : [],
      cart: Array.isArray(row.cart)
        ? row.cart.filter((line) => line && line.item).map((line) => ({
          ...line,
          quantity: Number(line.quantity) || 0,
          item: {
            ...line.item,
            name: String(line.item.name || 'Menu item'),
            emoji: String(line.item.emoji || '🍽️'),
            price: Number(line.item.price) || 0,
            category: String(line.item.category || ''),
          },
        }))
        : [],
      orders: Array.isArray(row.orders)
        ? row.orders.filter(Boolean).map((order) => ({
          ...order,
          status: String(order.status || 'Received'),
          customerName: String(order.customerName || 'Guest'),
          createdAt: Number(order.createdAt) || 0,
          items: Array.isArray(order.items)
            ? order.items.filter(Boolean).map((item) => ({
              ...item,
              name: String(item.name || 'Menu item'),
              price: Number(item.price) || 0,
              quantity: Number(item.quantity) || 0,
            }))
            : [],
        }))
        : [],
      calls: Array.isArray(row.calls) ? row.calls.filter(Boolean) : [],
    }
  })
}

export function RestaurantProvider({ children }) {
  const [tables, setTables] = useState(initialTables())
  const [tablesLoaded, setTablesLoaded] = useState(false)
  const [menu, setMenu] = useState(bundledMenu)
  const [lastError, setLastError] = useState('')
  const [waiterCooldowns, setWaiterCooldowns] = useState({})
  const tableRequestSequence = useRef(0)
  const latestAppliedTableRequest = useRef(0)

  const refreshTables = useCallback(async (token) => {
    const requestId = ++tableRequestSequence.current
    const responseTables = await api.fetchTables({ token })
    if (!Array.isArray(responseTables)) throw new Error('The restaurant API returned an invalid tables response.')
    const updatedTables = normalizeTableRows(responseTables)
    if (requestId > latestAppliedTableRequest.current) {
      latestAppliedTableRequest.current = requestId
      setTables(updatedTables)
      setTablesLoaded(true)
    }
    return updatedTables
  }, [])

  useEffect(() => {
    // Remove data from the earlier seeded browser-only prototype.
    localStorage.removeItem('dineplay-restaurant-v1')
    localStorage.removeItem('dineplay-active-session-v1')
    refreshTables().catch((error) => setLastError(error.message))
    api.fetchMenu()
      .then((items) => {
        if (!Array.isArray(items)) throw new Error('The restaurant API returned an invalid menu response.')
        setMenu(normalizeMenuItems(items))
      })
      .catch((error) => setLastError(error.message))
  }, [refreshTables])

  useEffect(() => {
    const socket = api.connectLiveUpdates()
    let refreshTimer
    const refresh = () => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTables().catch((error) => setLastError(error.message))
      }, 100)
    }
    socket.on('tables:updated', refresh)
    socket.on('orders:updated', refresh)
    socket.on('waiter:called', refresh)
    socket.on('payment:pending', refresh)
    socket.on('payment:approved', refresh)
    socket.on('connect', () => {
      Promise.all([refreshTables(), api.fetchMenu()])
        .then(([updatedTables, items]) => {
          if (!Array.isArray(updatedTables) || !Array.isArray(items)) {
            throw new Error('The restaurant API returned an invalid response.')
          }
          setMenu(normalizeMenuItems(items))
          setLastError('')
        })
        .catch((error) => setLastError(error instanceof Error ? error.message : 'Could not load restaurant data.'))
    })
    socket.on('connect_error', () => {
      setLastError('Could not connect to the DinePlay real-time server. Check that the backend is running.')
    })
    return () => {
      window.clearTimeout(refreshTimer)
      socket.disconnect()
    }
  }, [refreshTables])

  const run = useCallback(async (operation, { token, tableId, sessionId, returnsValue = false } = {}) => {
    try {
      setLastError('')
      const result = await operation()
      await refreshTables(token)
      return returnsValue ? result : true
    } catch (error) {
      if (Number(error?.cooldownEndsAt) > 0) {
        setWaiterCooldowns((current) => ({
          ...current,
          [String(tableId)]: {
            endsAt: Number(error.cooldownEndsAt),
            sessionId: String(sessionId || ''),
          },
        }))
      }
      setLastError(error instanceof Error ? error.message : 'The requested action failed.')
      return undefined
    }
  }, [refreshTables])

  const joinTable = useCallback(
    (tableId, name, phone = '') => run(
      () => api.createSession(tableId, { name, phone }),
      { returnsValue: true },
    ),
    [run],
  )

  const leaveTable = useCallback(
    (tableId, customerId) => {
      const sessionId = tables.find((table) => table.id === tableId)?.sessionId
      return run(() => api.leaveSession(tableId, customerId, sessionId))
    },
    [run, tables],
  )

  const addToCart = useCallback(
    (tableId, item, customerId, note = '') => run(() => api.addToCart(tableId, item, customerId, note)),
    [run],
  )

  const updateCartLine = useCallback(
    (tableId, lineId, quantity, note) => run(() => api.updateCartLine(tableId, lineId, quantity, note)),
    [run],
  )

  const placeOrder = useCallback(
    (tableId, customer, instructions = '') => run(
      () => api.placeOrder(tableId, customer, instructions),
      { returnsValue: true },
    ),
    [run],
  )

  const updateOrderStatus = useCallback(
    (tableId, orderId, status, token) => run(
      () => api.updateOrderStatus(tableId, orderId, status, { token }),
      { token },
    ),
    [run],
  )

  const confirmOrderServed = useCallback(
    (orderId, customerId) => run(() => api.confirmOrderServed(orderId, customerId)),
    [run],
  )

  const callWaiter = useCallback(
    (tableId, customer, reason) => run(
      () => api.callWaiter(tableId, customer, reason),
      { tableId, sessionId: customer.sessionId, returnsValue: true },
    ),
    [run],
  )

  const resolveCall = useCallback(
    (tableId, callId, token) => run(
      () => api.resolveCall(tableId, callId, { token }),
      { token },
    ),
    [run],
  )

  const payBill = useCallback(
    (tableId, method, token) => run(
      () => api.payBill(tableId, method, tables.find((table) => table.id === tableId)?.sessionId, { token }),
      { token },
    ),
    [run, tables],
  )

  const approvePayment = useCallback(
    (tableId, token) => run(
      () => api.approvePayment(tables.find((table) => table.id === tableId)?.sessionId, { token }),
      { token },
    ),
    [run, tables],
  )

  const awardCoupon = useCallback(
    (tableId, sessionId) => run(
      () => api.awardCoupon(tableId, sessionId || tables.find((table) => table.id === tableId)?.sessionId),
    ),
    [run, tables],
  )

  const addAdminItem = useCallback(
    (tableId, item, token) => run(
      () => api.addAdminItem(tableId, item, { token }),
      { token },
    ),
    [run],
  )

  const resetTable = useCallback(
    (tableId, token) => run(
      () => api.closeTable(tableId, { token }),
      { token },
    ),
    [run],
  )

  const clearError = useCallback(() => setLastError(''), [])
  const value = useMemo(
    () => ({
      tables,
      tablesLoaded,
      menu,
      lastError,
      waiterCooldowns,
      clearError,
      refreshTables,
      joinTable,
      leaveTable,
      addToCart,
      updateCartLine,
      placeOrder,
      updateOrderStatus,
      confirmOrderServed,
      callWaiter,
      resolveCall,
      payBill,
      approvePayment,
      awardCoupon,
      addAdminItem,
      resetTable,
    }),
    [tables, tablesLoaded, menu, lastError, waiterCooldowns, clearError, refreshTables, joinTable, leaveTable, addToCart, updateCartLine, placeOrder, updateOrderStatus, confirmOrderServed, callWaiter, resolveCall, payBill, approvePayment, awardCoupon, addAdminItem, resetTable],
  )

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>
}

export function useRestaurant() {
  const context = useContext(RestaurantContext)
  if (!context) throw new Error('useRestaurant must be used within RestaurantProvider')
  return context
}
