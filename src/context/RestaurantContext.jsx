import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { menuItems as bundledMenu } from '../data/menuData'
import { initialTables } from '../data/restaurant'
import * as api from '../services/api'

const RestaurantContext = createContext(null)

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
    const updatedTables = await api.fetchTables({ token })
    if (!Array.isArray(updatedTables)) throw new Error('The restaurant API returned an invalid tables response.')
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
        setMenu(items)
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
          setMenu(items)
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
