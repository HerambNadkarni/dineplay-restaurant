import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import cors from 'cors'
import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Server as SocketServer } from 'socket.io'
import pool from './config/db.js'
import { menuItems as bundledMenu } from '../src/data/menuData.js'
import { applyTurnMove, createTurnGameState, scoreDuelGames, supportedGames } from '../src/data/gameRules.js'

const app = express()
const httpServer = http.createServer(app)
const configuredOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const allowedOrigins = [...new Set([
  ...configuredOrigins,
  'https://dineplay-restaurant.vercel.app',
])]
const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}
const io = new SocketServer(httpServer, {
  cors: corsOptions,
})
const gameRooms = new Map()

app.options('*', cors(corsOptions))
app.use(cors(corsOptions))
app.use(express.json({ limit: '1mb' }))

const menuDetailsByName = new Map(bundledMenu.map((item) => [item.name.toLowerCase(), item]))
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
const sendChange = (event, payload = {}) => io.emit(event, { ...payload, emittedAt: Date.now() })
const asString = (value) => value === null || value === undefined ? null : String(value)
const timestamp = (value) => value ? new Date(value).getTime() : null
const httpError = (message, status = 400, details = {}) => Object.assign(new Error(message), { status, details })

function parseTableNumber(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 10) {
    throw httpError('tableNumber must be an integer from 1 to 10.')
  }
  return number
}

function parseId(value, label = 'id') {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(`${label} is invalid.`)
  return id
}

function validateStaffIdentity(identity) {
  const value = String(identity || '').trim()
  if (value.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? '' : 'Enter a valid email address.'
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$/.test(value)
    ? ''
    : 'Enter a valid Staff ID (3–50 letters, numbers, dots, underscores, or hyphens).'
}

function isValidStaffName(value) {
  return value.length >= 2 && value.length <= 120 && /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(value)
}

function isValidSignupPassword(value) {
  return value.length >= 8 && value.length <= 200 && /[A-Za-z]/.test(value) && /\d/.test(value)
}

function isValidGuestPhone(value) {
  if (!value) return true
  const normalized = value.replace(/[\s().-]/g, '')
  return /^(?:\+91)?[6-9]\d{9}$/.test(normalized)
}

function mapMenuItem(row, price = row.price) {
  const localDetails = menuDetailsByName.get(String(row.name).toLowerCase())
  return {
    id: asString(row.id),
    name: row.name,
    category: row.category,
    price: Number(price),
    type: Boolean(row.is_veg) ? 'Veg' : 'Non-Veg',
    spice: ['Mild', 'Medium', 'Spicy'].includes(row.spice_level) ? row.spice_level : 'Mild',
    prepMinutes: Number(row.prep_minutes) || localDetails?.prepMinutes || 15,
    description: row.description || localDetails?.description || '',
    emoji: row.emoji || localDetails?.emoji || '',
    color: row.color || localDetails?.color || '',
    popular: Boolean(row.is_bestseller),
  }
}

function toUiOrderStatus(status) {
  if (status === 'Order Received') return 'Received'
  if (status === 'Served') return 'Confirmed Served'
  return status
}

async function findTable(tableNumber, connection = pool, lock = false) {
  const [rows] = await connection.query(
    `SELECT id, table_number, status, current_session_id, call_reason, call_timestamp
       FROM tables WHERE table_number = ? ${lock ? 'FOR UPDATE' : ''}`,
    [tableNumber],
  )
  if (!rows.length) throw httpError(`Table #${String(tableNumber).padStart(2, '0')} was not found.`, 404)
  return rows[0]
}

async function getActiveSessionForTable(tableNumber, connection = pool, lock = false) {
  const [rows] = await connection.query(
    `SELECT id, table_number, customer_name, customer_phone, discount_percent,
            is_paid, payment_method, payment_status, payment_requested_at,
            payment_approved_by, payment_approved_at, is_active, started_at
       FROM table_sessions
      WHERE table_number = ? AND is_active = TRUE
      ORDER BY id DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [tableNumber],
  )
  return rows[0] || null
}

async function loadTables() {
  const [tableRows] = await pool.query(
    `SELECT id, table_number, status, current_session_id, call_reason, call_timestamp
       FROM tables ORDER BY table_number`,
  )
  if (!tableRows.length) return []
  const tableNumbers = tableRows.map((table) => table.table_number)
  const [sessionRows] = await pool.query(
    `SELECT id, table_number, customer_name, customer_phone, discount_percent,
            is_paid, payment_method, payment_status, payment_requested_at,
            payment_approved_by, payment_approved_at, is_active, started_at
       FROM table_sessions
      WHERE table_number IN (?) AND is_active = TRUE
      ORDER BY id DESC`,
    [tableNumbers],
  )
  const sessionsByTable = new Map()
  sessionRows.forEach((session) => {
    if (!sessionsByTable.has(session.table_number)) sessionsByTable.set(session.table_number, session)
  })
  const sessions = [...sessionsByTable.values()]
  const sessionIds = sessions.map((session) => session.id)
  const tablesById = new Map(tableRows.map((table) => [table.id, table]))
  const customers = []
  const carts = []
  const orders = []
  const calls = []

  if (sessionIds.length) {
    const [guestRows] = await pool.query(
      `SELECT id, session_id, customer_name, customer_phone, joined_at
         FROM session_guests WHERE session_id IN (?) ORDER BY id`,
      [sessionIds],
    )
    guestRows.forEach((guest) => {
      const session = sessions.find((entry) => entry.id === guest.session_id)
      customers.push({
        id: asString(guest.id),
        sessionId: asString(guest.session_id),
        tableId: String(session.table_number).padStart(2, '0'),
        name: guest.customer_name,
        phone: guest.customer_phone || '',
        joinedAt: timestamp(guest.joined_at),
      })
    })

    const [cartRows] = await pool.query(
      `SELECT c.id AS cart_id, c.session_id, c.guest_id, c.quantity, c.note,
              m.id, m.name, m.category, m.price, m.is_veg, m.spice_level,
              m.is_bestseller, m.description, m.prep_minutes, m.emoji, m.color
         FROM cart_items c JOIN menu_items m ON m.id = c.menu_item_id
        WHERE c.session_id IN (?) ORDER BY c.id`,
      [sessionIds],
    )
    cartRows.forEach((row) => {
      carts.push({
        id: asString(row.cart_id),
        customerId: asString(row.guest_id),
        sessionId: asString(row.session_id),
        item: mapMenuItem(row),
        quantity: Number(row.quantity),
        note: row.note || '',
      })
    })

    const [orderRows] = await pool.query(
      `SELECT o.id, o.session_id, o.table_number, o.customer_name, o.subtotal,
              o.status, o.created_at, d.guest_id, d.instructions
         FROM orders o LEFT JOIN order_details d ON d.order_id = o.id
        WHERE o.session_id IN (?) ORDER BY o.id`,
      [sessionIds],
    )
    orderRows.forEach((order) => {
      orders.push({
        id: asString(order.id),
        sessionId: asString(order.session_id),
        tableId: String(order.table_number).padStart(2, '0'),
        customerId: asString(order.guest_id),
        customerName: order.customer_name,
        instructions: order.instructions || '',
        status: toUiOrderStatus(order.status),
        subtotal: Number(order.subtotal),
        createdAt: timestamp(order.created_at),
        items: [],
      })
    })
    const orderIds = orderRows.map((order) => order.id)
    if (orderIds.length) {
      const [itemRows] = await pool.query(
        `SELECT oi.order_id, oi.quantity, oi.unit_price, oi.item_name, oi.note,
                m.id, m.name, m.category, m.is_veg, m.spice_level, m.is_bestseller,
                m.description, m.prep_minutes, m.emoji, m.color
           FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
          WHERE oi.order_id IN (?) ORDER BY oi.id`,
        [orderIds],
      )
      const ordersById = new Map(orders.map((order) => [order.id, order]))
      itemRows.forEach((row) => {
        const item = mapMenuItem({ ...row, name: row.item_name }, row.unit_price)
        ordersById.get(asString(row.order_id))?.items.push({
          ...item,
          quantity: Number(row.quantity),
          note: row.note || '',
        })
      })
    }

    const [callRows] = await pool.query(
      `SELECT wc.id, wc.table_id, wc.guest_id, wc.reason, wc.is_resolved,
              UNIX_TIMESTAMP(wc.created_at) AS created_at_epoch,
              g.customer_name
         FROM waiter_calls wc LEFT JOIN session_guests g ON g.id = wc.guest_id
        WHERE wc.session_id IN (?) ORDER BY wc.id`,
      [sessionIds],
    )
    callRows.forEach((call) => {
      const table = tablesById.get(call.table_id)
      calls.push({
        id: asString(call.id),
        tableId: String(table.table_number).padStart(2, '0'),
        customerId: asString(call.guest_id),
        customerName: call.customer_name || 'Guest',
        reason: call.reason,
        resolved: Boolean(call.is_resolved),
        createdAt: Number(call.created_at_epoch) * 1000,
      })
    })
  }

  const [paymentRows] = sessionIds.length
    ? await pool.query('SELECT session_id, paid_at FROM session_payment_meta WHERE session_id IN (?)', [sessionIds])
    : [[]]
  const paidAtBySession = new Map(paymentRows.map((row) => [row.session_id, row.paid_at]))
  const ordersBySession = new Map()
  orders.forEach((order) => {
    if (!ordersBySession.has(order.sessionId)) ordersBySession.set(order.sessionId, [])
    ordersBySession.get(order.sessionId).push(order)
  })

  return tableRows.map((row) => {
    const tableKey = String(row.table_number).padStart(2, '0')
    const session = sessionsByTable.get(row.table_number)
    const sessionId = session ? asString(session.id) : null
    const tableCustomers = customers.filter((guest) => guest.tableId === tableKey)
    const tableCart = carts.filter((line) => line.sessionId === sessionId)
    const tableOrders = ordersBySession.get(sessionId) || []
    const tableCalls = calls.filter((call) => call.tableId === tableKey)
    const billLines = [
      ...tableCart.map((line) => ({ item: line.item, quantity: line.quantity })),
      ...tableOrders.flatMap((order) => order.items.map((item) => ({ item, quantity: item.quantity }))),
    ]
    const subtotal = billLines.reduce((sum, line) => sum + line.item.price * line.quantity, 0)
    const dessertTotal = billLines.reduce((sum, line) =>
      sum + (/dessert/i.test(line.item.category) ? line.item.price * line.quantity : 0), 0)
    const discount = session ? Math.round(dessertTotal * Number(session.discount_percent) / 100) : 0
    const gst = Math.round((subtotal - discount) * 0.05)

    return {
      id: tableKey,
      tableNumber: Number(row.table_number),
      status: row.status,
      sessionId,
      customers: tableCustomers,
      cart: tableCart.map(({ sessionId: _sessionId, ...line }) => line),
      orders: tableOrders,
      calls: tableCalls,
      callCooldownEndsAt: tableCalls.reduce(
        (latest, call) => Math.max(latest, Number(call.createdAt) + 15 * 60 * 1000),
        0,
      ) || null,
      coupon: session && Number(session.discount_percent) > 0
        ? { type: 'dessert', percent: Number(session.discount_percent), label: `${Number(session.discount_percent)}% Off Dessert` }
        : null,
      payment: session && session.payment_status !== 'Unpaid'
        ? {
          status: session.payment_status,
          method: session.payment_method,
          requestedAt: timestamp(session.payment_requested_at),
          approvedAt: timestamp(session.payment_approved_at),
          approvedBy: asString(session.payment_approved_by),
          paidAt: timestamp(paidAtBySession.get(session.id) || session.payment_approved_at),
        }
        : null,
      callReason: row.call_reason,
      callTimestamp: timestamp(row.call_timestamp),
      bill: { subtotal, gst, discount, grandTotal: subtotal - discount + gst },
    }
  })
}

async function loadOrders({ sessionId, activeOnly = false } = {}) {
  const where = []
  const values = []
  if (sessionId) {
    where.push('o.session_id = ?')
    values.push(parseId(sessionId, 'sessionId'))
  }
  if (activeOnly) where.push('s.is_active = TRUE')
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [rows] = await pool.query(
    `SELECT o.id, o.session_id, o.table_number, o.customer_name, o.subtotal,
            o.status, o.created_at, d.guest_id, d.instructions
       FROM orders o JOIN table_sessions s ON s.id = o.session_id
       LEFT JOIN order_details d ON d.order_id = o.id
      ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC`,
    values,
  )
  const orderIds = rows.map((row) => row.id)
  const itemsByOrder = new Map(orderIds.map((id) => [String(id), []]))
  if (orderIds.length) {
    const [itemRows] = await pool.query(
      `SELECT oi.order_id, oi.quantity, oi.unit_price, oi.item_name, oi.note,
              m.id, m.category, m.is_veg, m.spice_level, m.is_bestseller, m.description,
              m.prep_minutes, m.emoji, m.color
         FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
        WHERE oi.order_id IN (?) ORDER BY oi.id`,
      [orderIds],
    )
    itemRows.forEach((row) => {
      itemsByOrder.get(String(row.order_id)).push({
        ...mapMenuItem({ ...row, name: row.item_name }, row.unit_price),
        quantity: Number(row.quantity),
        note: row.note || '',
      })
    })
  }
  return rows.map((row) => ({
    id: asString(row.id),
    sessionId: asString(row.session_id),
    tableId: String(row.table_number).padStart(2, '0'),
    customerId: asString(row.guest_id),
    customerName: row.customer_name,
    instructions: row.instructions || '',
    status: toUiOrderStatus(row.status),
    subtotal: Number(row.subtotal),
    createdAt: timestamp(row.created_at),
    items: itemsByOrder.get(String(row.id)) || [],
  }))
}

async function authRequired(req, _res, next) {
  try {
    const authorization = req.get('authorization') || ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!token) throw httpError('Staff authentication is required.', 401)
    if (!process.env.JWT_SECRET) throw httpError('JWT_SECRET is not configured.', 500)
    const claims = jwt.verify(token, process.env.JWT_SECRET)
    const [rows] = await pool.query(
      'SELECT id, full_name, role, email FROM staff_users WHERE id = ?',
      [claims.sub],
    )
    if (!rows.length) throw httpError('Staff account no longer exists.', 401)
    req.staff = rows[0]
    next()
  } catch (error) {
    next(error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError'
      ? httpError('Staff session is invalid or expired.', 401)
      : error)
  }
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1')
  res.json({ status: 'ok', database: process.env.DB_NAME || 'dineplay' })
}))

app.get('/api/menu', asyncRoute(async (req, res) => {
  const filters = []
  const values = []
  if (req.query.search) {
    const search = `%${String(req.query.search).trim()}%`
    filters.push('(name LIKE ? OR description LIKE ?)')
    values.push(search, search)
  }
  if (req.query.category) {
    filters.push('category = ?')
    values.push(String(req.query.category))
  }
  if (String(req.query.vegOnly).toLowerCase() === 'true') filters.push('is_veg = 1')
  if (String(req.query.bestsellersOnly).toLowerCase() === 'true') filters.push('is_bestseller = 1')
  filters.push('is_available = 1')
  const [rows] = await pool.query(
    `SELECT id, name, category, price, is_veg, spice_level, is_bestseller,
            description, prep_minutes, emoji, color
       FROM menu_items WHERE ${filters.join(' AND ')} ORDER BY category, id`,
    values,
  )
  res.json(rows.map((row) => mapMenuItem(row)))
}))

app.get('/api/tables', asyncRoute(async (_req, res) => res.json(await loadTables())))

app.post('/api/sessions/join', asyncRoute(async (req, res) => {
  const tableNumber = parseTableNumber(req.body?.tableNumber)
  const customerName = String(req.body?.customerName || '').trim()
  const customerPhone = String(req.body?.customerPhone || '').trim()
  if (customerName.length < 2 || customerName.length > 120) throw httpError('Display name must be at least 2 characters.')
  if (!isValidGuestPhone(customerPhone)) throw httpError('Enter a valid 10-digit phone number, optionally with the +91 country code.')
  if (customerPhone.length > 25) throw httpError('Phone number must be 25 characters or fewer.')
  const connection = await pool.getConnection()
  let guest
  try {
    await connection.beginTransaction()
    const table = await findTable(tableNumber, connection, true)
    let session = await getActiveSessionForTable(tableNumber, connection, true)
    if (session && session.payment_status !== 'Unpaid') {
      throw httpError('This table is waiting for payment approval and cannot accept new guests.', 409)
    }
    if (!session) {
      const [result] = await connection.query(
        `INSERT INTO table_sessions
          (table_number, customer_name, customer_phone, is_active, started_at)
         VALUES (?, ?, ?, TRUE, NOW())`,
        [tableNumber, customerName, customerPhone || null],
      )
      session = { id: result.insertId }
    }
    const [guestResult] = await connection.query(
      `INSERT INTO session_guests (session_id, customer_name, customer_phone)
       VALUES (?, ?, ?)`,
      [session.id, customerName, customerPhone || null],
    )
    guest = {
      id: asString(guestResult.insertId),
      sessionId: asString(session.id),
      name: customerName,
      phone: customerPhone,
    }
    await connection.query(
      `UPDATE tables SET status = IF(status = 'calling_waiter', status, 'occupied'),
         current_session_id = ? WHERE id = ?`,
      [session.id, table.id],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('tables:updated', { tableNumber })
  res.status(201).json(guest)
}))

app.delete('/api/sessions/:sessionId/guests/:guestId', asyncRoute(async (req, res) => {
  const sessionId = parseId(req.params.sessionId, 'sessionId')
  const guestId = parseId(req.params.guestId, 'guestId')
  const connection = await pool.getConnection()
  let tableNumber
  let tableClosed = false
  try {
    await connection.beginTransaction()
    const [sessionRows] = await connection.query(
      'SELECT table_number FROM table_sessions WHERE id = ? AND is_active = TRUE',
      [sessionId],
    )
    if (!sessionRows.length) throw httpError('Active guest session was not found.', 404)
    tableNumber = Number(sessionRows[0].table_number)
    const table = await findTable(tableNumber, connection, true)
    const session = await getActiveSessionForTable(tableNumber, connection, true)
    if (!session || Number(session.id) !== sessionId) throw httpError('Active guest session was not found.', 404)
    if (session.payment_status === 'Pending Manager Approval') {
      throw httpError('A payment is awaiting Manager approval. Please wait before leaving this table.', 409)
    }

    const [[guest]] = await connection.query(
      'SELECT id FROM session_guests WHERE id = ? AND session_id = ? FOR UPDATE',
      [guestId, sessionId],
    )
    if (!guest) throw httpError('Active guest session was not found.', 404)
    const [[pendingOrders]] = await connection.query(
      `SELECT COUNT(*) AS count
         FROM orders o JOIN order_details d ON d.order_id = o.id
        WHERE o.session_id = ? AND d.guest_id = ? AND o.status <> 'Confirmed Served'`,
      [sessionId, guestId],
    )
    if (Number(pendingOrders.count) > 0) {
      throw httpError('Wait for your orders to be served and confirmed before leaving this table.', 409)
    }

    await connection.query('DELETE FROM session_guests WHERE id = ? AND session_id = ?', [guestId, sessionId])
    const [[remainingGuests]] = await connection.query(
      'SELECT COUNT(*) AS count FROM session_guests WHERE session_id = ?',
      [sessionId],
    )
    const [[orderCount]] = await connection.query(
      'SELECT COUNT(*) AS count FROM orders WHERE session_id = ?',
      [sessionId],
    )
    const [[activeCalls]] = await connection.query(
      'SELECT COUNT(*) AS count FROM waiter_calls WHERE session_id = ? AND is_resolved = 0',
      [sessionId],
    )
    if (!Number(remainingGuests.count) && !Number(orderCount.count) && !Number(activeCalls.count)) {
      await connection.query(
        'UPDATE table_sessions SET is_active = 0, closed_at = NOW() WHERE id = ?',
        [sessionId],
      )
      await connection.query(
        `UPDATE tables SET status = 'available', current_session_id = NULL,
           call_reason = NULL, call_timestamp = NULL WHERE id = ?`,
        [table.id],
      )
      tableClosed = true
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('tables:updated', { sessionId: asString(sessionId), tableNumber })
  res.json({ removed: true, tableClosed })
}))

app.post('/api/tables/:tableNumber/cart', asyncRoute(async (req, res) => {
  const tableNumber = parseTableNumber(req.params.tableNumber)
  const guestId = parseId(req.body?.customerId, 'customerId')
  const menuItemId = parseId(req.body?.itemId, 'itemId')
  const note = String(req.body?.note || '').trim()
  if (note.length > 255) throw httpError('Cooking note must be 255 characters or fewer.')
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const table = await findTable(tableNumber, connection, true)
    const session = await getActiveSessionForTable(tableNumber, connection)
    if (!session) throw httpError('Join this table before adding dishes.', 409)
    if (session.payment_status !== 'Unpaid') throw httpError('This table is waiting for payment approval.', 409)
    const [[guest]] = await connection.query(
      'SELECT id FROM session_guests WHERE id = ? AND session_id = ?',
      [guestId, session.id],
    )
    if (!guest) throw httpError('The guest is not in this active table session.', 404)
    const [[menuItem]] = await connection.query(
      'SELECT id FROM menu_items WHERE id = ? AND is_available = 1',
      [menuItemId],
    )
    if (!menuItem) throw httpError('Menu item is unavailable.', 404)
    await connection.query(
      `INSERT INTO cart_items (session_id, guest_id, menu_item_id, quantity, note)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
      [session.id, guestId, menuItem.id, note],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('tables:updated', { tableNumber })
  res.status(201).json({ added: true })
}))

app.patch('/api/tables/:tableNumber/cart/:lineId', asyncRoute(async (req, res) => {
  const tableNumber = parseTableNumber(req.params.tableNumber)
  const lineId = parseId(req.params.lineId, 'lineId')
  const quantity = Number(req.body?.quantity)
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) throw httpError('quantity must be an integer from 0 to 99.')
  const note = req.body?.note === undefined ? undefined : String(req.body.note).trim()
  if (note !== undefined && note.length > 255) throw httpError('Cooking note must be 255 characters or fewer.')
  const session = await getActiveSessionForTable(tableNumber)
  if (!session) throw httpError('Active table session was not found.', 404)
  if (session.payment_status !== 'Unpaid') throw httpError('This table is waiting for payment approval.', 409)
  if (quantity === 0) {
    await pool.query('DELETE FROM cart_items WHERE id = ? AND session_id = ?', [lineId, session.id])
  } else {
    const [result] = note === undefined
      ? await pool.query('UPDATE cart_items SET quantity = ? WHERE id = ? AND session_id = ?', [quantity, lineId, session.id])
      : await pool.query('UPDATE cart_items SET quantity = ?, note = ? WHERE id = ? AND session_id = ?', [quantity, note, lineId, session.id])
    if (!result.affectedRows) throw httpError('Cart item was not found.', 404)
  }
  sendChange('tables:updated', { tableNumber })
  res.json({ updated: true })
}))

app.post('/api/tables/:tableNumber/call-waiter', asyncRoute(async (req, res) => {
  const tableNumber = parseTableNumber(req.params.tableNumber)
  const reason = String(req.body?.reason || '').trim()
  if (!['Water / Cutlery', 'Need Assistance', 'Clean Table', 'Request Bill'].includes(reason)) {
    throw httpError('Choose a valid waiter-call reason.')
  }
  const guestId = req.body?.customerId ? parseId(req.body.customerId, 'customerId') : null
  const connection = await pool.getConnection()
  let call
  try {
    await connection.beginTransaction()
    const table = await findTable(tableNumber, connection, true)
    const session = await getActiveSessionForTable(tableNumber, connection, true)
    if (!session) throw httpError('Join this table before calling a waiter.', 409)
    let customerName = session.customer_name
    if (guestId) {
      const [guests] = await connection.query(
        'SELECT customer_name FROM session_guests WHERE id = ? AND session_id = ?',
        [guestId, session.id],
      )
      if (!guests.length) throw httpError('Guest is not part of this table session.', 404)
      customerName = guests[0].customer_name
    }

    const [lastCalls] = await connection.query(
      `SELECT UNIX_TIMESTAMP(created_at) AS created_at_epoch FROM waiter_calls
        WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [session.id],
    )
    if (lastCalls.length) {
      const cooldownEndsAt = Number(lastCalls[0].created_at_epoch) * 1000 + 15 * 60 * 1000
      const remainingSeconds = Math.ceil((cooldownEndsAt - Date.now()) / 1000)
      if (remainingSeconds > 0) {
        throw httpError(
          `Please wait ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')} before calling again.`,
          429,
          { remainingSeconds, cooldownEndsAt },
        )
      }
    }

    const [activeCalls] = await connection.query(
      'SELECT id FROM waiter_calls WHERE session_id = ? AND is_resolved = 0 LIMIT 1',
      [session.id],
    )
    if (activeCalls.length) throw httpError('A waiter call is already open for this table.', 409)
    const [result] = await connection.query(
      'INSERT INTO waiter_calls (table_id, session_id, guest_id, reason) VALUES (?, ?, ?, ?)',
      [table.id, session.id, guestId, reason],
    )
    const [[createdCall]] = await connection.query(
      'SELECT UNIX_TIMESTAMP(created_at) AS created_at_epoch FROM waiter_calls WHERE id = ?',
      [result.insertId],
    )
    const createdAt = Number(createdCall.created_at_epoch) * 1000
    await connection.query(
      `UPDATE tables SET status = 'calling_waiter', call_reason = ?, call_timestamp = NOW(),
         current_session_id = ? WHERE id = ?`,
      [reason, session.id, table.id],
    )
    call = {
      id: asString(result.insertId),
      tableId: String(tableNumber).padStart(2, '0'),
      customerId: asString(guestId),
      customerName,
      reason,
      resolved: false,
      createdAt,
      cooldownEndsAt: createdAt + 15 * 60 * 1000,
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('waiter:called', call)
  sendChange('tables:updated', { tableNumber })
  res.status(201).json(call)
}))

app.post('/api/tables/:tableNumber/resolve-waiter', authRequired, asyncRoute(async (req, res) => {
  const tableNumber = parseTableNumber(req.params.tableNumber)
  const callId = req.body?.callId ? parseId(req.body.callId, 'callId') : null
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const table = await findTable(tableNumber, connection, true)
    const session = await getActiveSessionForTable(tableNumber, connection, true)
    if (!session) throw httpError('Active table session was not found.', 404)
    let query = 'UPDATE waiter_calls SET is_resolved = 1, resolved_at = NOW() WHERE session_id = ? AND is_resolved = 0'
    const values = [session.id]
    if (callId) {
      query += ' AND id = ?'
      values.push(callId)
    }
    const [result] = await connection.query(query, values)
    if (!result.affectedRows) throw httpError('Active waiter call was not found.', 404)
    const [[counts]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM session_guests WHERE session_id = ?) AS guest_count,
         (SELECT COUNT(*) FROM cart_items WHERE session_id = ?) AS cart_count,
         (SELECT COUNT(*) FROM orders WHERE session_id = ?) AS order_count,
         (SELECT COUNT(*) FROM waiter_calls WHERE session_id = ? AND is_resolved = 0) AS call_count`,
      [session.id, session.id, session.id, session.id],
    )
    if (!Number(counts.guest_count) && !Number(counts.cart_count) && !Number(counts.order_count) && !Number(counts.call_count)) {
      await connection.query(
        'UPDATE table_sessions SET is_active = 0, closed_at = NOW() WHERE id = ?',
        [session.id],
      )
      await connection.query(
        `UPDATE tables SET status = 'available', current_session_id = NULL,
           call_reason = NULL, call_timestamp = NULL WHERE id = ?`,
        [table.id],
      )
    } else if (Number(counts.call_count)) {
      const [[nextCall]] = await connection.query(
        `SELECT reason, created_at FROM waiter_calls
          WHERE session_id = ? AND is_resolved = 0 ORDER BY id LIMIT 1`,
        [session.id],
      )
      await connection.query(
        `UPDATE tables SET status = 'calling_waiter', call_reason = ?,
           call_timestamp = ?, current_session_id = ? WHERE id = ?`,
        [nextCall.reason, nextCall.created_at, session.id, table.id],
      )
    } else {
      const [activeOrders] = await connection.query(
        "SELECT id FROM orders WHERE session_id = ? AND status <> 'Confirmed Served' LIMIT 1",
        [session.id],
      )
      await connection.query(
        'UPDATE tables SET status = ?, call_reason = NULL, call_timestamp = NULL WHERE id = ?',
        [activeOrders.length ? 'waiting' : 'occupied', table.id],
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('tables:updated', { tableNumber })
  res.json({ resolved: true })
}))

app.post('/api/sessions/:sessionId/reward', asyncRoute(async (req, res) => {
  const sessionId = parseId(req.params.sessionId, 'sessionId')
  const percent = Number(req.body?.discountPercent ?? req.body?.percent ?? 5)
  if (percent !== 5) throw httpError('The game reward is a fixed 5% dessert discount.')
  const [sessions] = await pool.query(
    'SELECT id FROM table_sessions WHERE id = ? AND is_active = 1',
    [sessionId],
  )
  if (!sessions.length) throw httpError('Active table session was not found.', 404)
  await pool.query('UPDATE table_sessions SET discount_percent = 5 WHERE id = ?', [sessionId])
  sendChange('tables:updated', { sessionId: asString(sessionId) })
  res.json({ type: 'dessert', percent: 5, label: '5% Off Dessert' })
}))

app.post('/api/sessions/:sessionId/pay', asyncRoute(async (req, res) => {
  const sessionId = parseId(req.params.sessionId, 'sessionId')
  const method = String(req.body?.paymentMethod || req.body?.method || '')
  if (!['UPI', 'Card', 'Cash'].includes(method)) throw httpError('paymentMethod must be UPI, Card, or Cash.')
  const connection = await pool.getConnection()
  let tableNumber
  try {
    await connection.beginTransaction()
    const [initialSessions] = await connection.query(
      'SELECT table_number FROM table_sessions WHERE id = ?',
      [sessionId],
    )
    if (!initialSessions.length) throw httpError('Active table session was not found.', 404)
    await findTable(initialSessions[0].table_number, connection, true)
    const [sessions] = await connection.query(
      `SELECT id, table_number, is_active, is_paid, payment_status
         FROM table_sessions WHERE id = ? FOR UPDATE`,
      [sessionId],
    )
    const session = sessions[0]
    if (!session?.is_active) throw httpError('Active table session was not found.', 404)
    if (session.payment_status === 'Paid' || session.is_paid) {
      throw httpError('This bill has already been paid.', 409)
    }
    if (session.payment_status === 'Pending Manager Approval') {
      throw httpError('This payment is already waiting for manager approval.', 409)
    }
    const [[cartSummary]] = await connection.query(
      'SELECT COUNT(*) AS line_count FROM cart_items WHERE session_id = ?',
      [sessionId],
    )
    if (Number(cartSummary.line_count) > 0) {
      throw httpError('Place your active plate orders before paying.', 409)
    }
    const [[orderSummary]] = await connection.query(
      `SELECT COUNT(*) AS order_count,
              SUM(status <> 'Confirmed Served') AS unconfirmed_count
         FROM orders WHERE session_id = ?`,
      [sessionId],
    )
    if (!Number(orderSummary.order_count)) throw httpError('Place an order before paying the bill.', 409)
    if (Number(orderSummary.unconfirmed_count) > 0) {
      throw httpError('Please confirm your served dishes first before paying the bill.', 409)
    }
    tableNumber = session.table_number
    await connection.query(
      `UPDATE table_sessions
          SET is_paid = 0, payment_status = 'Pending Manager Approval',
              payment_method = ?, payment_requested_at = NOW(),
              payment_approved_by = NULL, payment_approved_at = NULL
        WHERE id = ?`,
      [method, sessionId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('payment:pending', { sessionId: asString(sessionId), tableNumber, method })
  sendChange('tables:updated', { sessionId: asString(sessionId), tableNumber })
  res.json({ pendingApproval: true, status: 'Pending Manager Approval', paymentMethod: method })
}))

app.post('/api/sessions/:sessionId/approve-payment', authRequired, asyncRoute(async (req, res) => {
  if (req.staff.role !== 'Manager') throw httpError('Only a Manager can approve a payment.', 403)
  const sessionId = parseId(req.params.sessionId, 'sessionId')
  const connection = await pool.getConnection()
  let tableNumber
  try {
    await connection.beginTransaction()
    const [sessions] = await connection.query(
      `SELECT id, table_number, is_active, payment_status
         FROM table_sessions WHERE id = ? FOR UPDATE`,
      [sessionId],
    )
    const session = sessions[0]
    if (!session?.is_active) throw httpError('Active table session was not found.', 404)
    if (session.payment_status !== 'Pending Manager Approval') {
      throw httpError('This session has no payment pending approval.', 409)
    }
    tableNumber = session.table_number
    await connection.query(
      `UPDATE table_sessions
          SET is_paid = 1, payment_status = 'Paid',
              payment_approved_by = ?, payment_approved_at = NOW()
        WHERE id = ?`,
      [req.staff.id, sessionId],
    )
    await connection.query(
      `INSERT INTO session_payment_meta (session_id, paid_at) VALUES (?, NOW())
       ON DUPLICATE KEY UPDATE paid_at = VALUES(paid_at)`,
      [sessionId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('payment:approved', { sessionId: asString(sessionId), tableNumber, approvedBy: asString(req.staff.id) })
  sendChange('tables:updated', { sessionId: asString(sessionId), tableNumber })
  res.json({ approved: true, status: 'Paid' })
}))

app.post('/api/tables/:tableNumber/close', authRequired, asyncRoute(async (req, res) => {
  const tableNumber = parseTableNumber(req.params.tableNumber)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const table = await findTable(tableNumber, connection, true)
    const session = await getActiveSessionForTable(tableNumber, connection)
    if (session) {
      if (session.payment_status === 'Pending Manager Approval') {
        throw httpError('A Manager must approve or resolve the pending payment before this table can be closed.', 409)
      }
      await connection.query('DELETE FROM cart_items WHERE session_id = ?', [session.id])
      await connection.query(
        'UPDATE waiter_calls SET is_resolved = 1, resolved_at = NOW() WHERE session_id = ? AND is_resolved = 0',
        [session.id],
      )
      await connection.query(
        'UPDATE table_sessions SET is_active = 0, closed_at = NOW() WHERE id = ?',
        [session.id],
      )
    }
    await connection.query(
      `UPDATE tables SET status = 'available', current_session_id = NULL,
         call_reason = NULL, call_timestamp = NULL WHERE id = ?`,
      [table.id],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('tables:updated', { tableNumber })
  res.json({ closed: true })
}))

app.get('/api/orders', asyncRoute(async (_req, res) => {
  res.json(await loadOrders({ activeOnly: true }))
}))

app.get('/api/orders/session/:sessionId', asyncRoute(async (req, res) => {
  res.json(await loadOrders({ sessionId: req.params.sessionId }))
}))

async function createOrderRecord(body) {
  const tableNumber = parseTableNumber(body?.tableNumber)
  const guestId = body?.customerId || body?.guestId ? parseId(body.customerId || body.guestId, 'customerId') : null
  const sessionId = body?.sessionId ? parseId(body.sessionId, 'sessionId') : null
  const instructions = String(body?.instructions || '').trim()
  if (instructions.length > 2000) throw httpError('Kitchen instructions must be 2,000 characters or fewer.')
  const connection = await pool.getConnection()
  let createdOrderId
  let activeSessionId
  try {
    await connection.beginTransaction()
    const table = await findTable(tableNumber, connection, true)
    const session = await getActiveSessionForTable(tableNumber, connection, true)
    if (!session || (sessionId && Number(session.id) !== sessionId)) throw httpError('Active table session was not found.', 409)
    if (session.is_paid || session.payment_status !== 'Unpaid') {
      throw httpError('This table is already paid or waiting for payment approval.', 409)
    }
    activeSessionId = session.id
    let customerName = String(body?.customerName || 'Staff addition').trim()
    if (guestId) {
      const [guests] = await connection.query(
        'SELECT customer_name FROM session_guests WHERE id = ? AND session_id = ?',
        [guestId, session.id],
      )
      if (!guests.length) throw httpError('Guest is not part of this active table session.', 404)
      customerName = guests[0].customer_name
    }

    let orderItems
    if (Array.isArray(body?.items) && body.items.length) {
      if (body.items.length > 100) throw httpError('An order cannot contain more than 100 lines.')
      const requestedItems = body.items.map((item) => ({
        menuItemId: parseId(item.menuItemId || item.itemId, 'menuItemId'),
        quantity: Number(item.quantity),
        note: String(item.note || '').trim(),
      }))
      if (requestedItems.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) {
        throw httpError('Each item quantity must be from 1 to 99.')
      }
      if (requestedItems.some((item) => item.note.length > 255)) throw httpError('Item note must be 255 characters or fewer.')
      const ids = requestedItems.map((item) => item.menuItemId)
      const [menuRows] = await connection.query(
        `SELECT id, name, price FROM menu_items WHERE id IN (?) AND is_available = 1`,
        [ids],
      )
      const menuById = new Map(menuRows.map((item) => [item.id, item]))
      orderItems = requestedItems.map((requested) => {
        const menuItem = menuById.get(requested.menuItemId)
        if (!menuItem) throw httpError(`Menu item ${requested.menuItemId} is unavailable.`, 404)
        return { ...menuItem, ...requested }
      })
      if (!guestId) customerName = String(body?.customerName || 'Staff addition').trim()
    } else {
      if (!guestId) throw httpError('Provide order items or a guestId.')
      const [cartRows] = await connection.query(
        `SELECT c.menu_item_id, c.quantity, c.note, m.name, m.price
           FROM cart_items c JOIN menu_items m ON m.id = c.menu_item_id
          WHERE c.session_id = ? AND c.guest_id = ? FOR UPDATE`,
        [session.id, guestId],
      )
      if (!cartRows.length) throw httpError('Your plate is empty.', 409)
      orderItems = cartRows.map((item) => ({
        menuItemId: item.menu_item_id,
        name: item.name,
        price: Number(item.price),
        quantity: Number(item.quantity),
        note: item.note || '',
      }))
    }

    const subtotal = orderItems.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0)
    const [orderResult] = await connection.query(
      `INSERT INTO orders (session_id, table_number, customer_name, subtotal, status, created_at)
       VALUES (?, ?, ?, ?, 'Order Received', NOW())`,
      [session.id, tableNumber, customerName, subtotal],
    )
    createdOrderId = orderResult.insertId
    await connection.query(
      'INSERT INTO order_details (order_id, guest_id, instructions) VALUES (?, ?, ?)',
      [createdOrderId, guestId, instructions || null],
    )
    await connection.query(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price, quantity, note)
       VALUES ?`,
      [orderItems.map((item) => [
        createdOrderId,
        item.menuItemId,
        item.name,
        Number(item.price),
        item.quantity,
        item.note || null,
      ])],
    )
    if (!Array.isArray(body?.items) || !body.items.length) {
      await connection.query('DELETE FROM cart_items WHERE session_id = ? AND guest_id = ?', [session.id, guestId])
    }
    await connection.query(
      `UPDATE tables SET status = IF(status = 'calling_waiter', status, 'waiting'),
         current_session_id = ? WHERE id = ?`,
      [session.id, table.id],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  const order = (await loadOrders({ sessionId: activeSessionId }))
    .find((entry) => entry.id === asString(createdOrderId))
  return { order, tableNumber }
}

app.post('/api/orders', asyncRoute(async (req, res) => {
  const { order, tableNumber } = await createOrderRecord(req.body)
  sendChange('orders:updated', { tableNumber, orderId: order?.id })
  sendChange('tables:updated', { tableNumber })
  res.status(201).json(order)
}))

app.post('/api/tables/:tableNumber/orders/items', authRequired, asyncRoute(async (req, res) => {
  const menuItemId = parseId(req.body?.itemId, 'itemId')
  const { order, tableNumber } = await createOrderRecord({
    tableNumber: req.params.tableNumber,
    customerName: 'Staff addition',
    items: [{ menuItemId, quantity: 1 }],
  })
  sendChange('orders:updated', { tableNumber, orderId: order?.id })
  sendChange('tables:updated', { tableNumber })
  res.status(201).json(order)
}))

app.patch('/api/orders/:orderId/status', authRequired, asyncRoute(async (req, res) => {
  const orderId = parseId(req.params.orderId, 'orderId')
  const requestedStatus = String(req.body?.status || '')
  const statusInput = requestedStatus.trim().toLowerCase()
  const status = ['prepared', 'served', 'ready', 'ready for handoff', 'awaiting confirmation'].includes(statusInput)
    ? 'Awaiting Confirmation'
    : ['received', 'order received'].includes(statusInput)
      ? 'Order Received'
      : statusInput === 'preparing' ? 'Preparing' : null
  if (!status) throw httpError('status must be Received, Preparing, Prepared, or Served.')
  const [rows] = await pool.query(
    `SELECT o.session_id, o.table_number, o.status AS current_status, t.id AS table_id
       FROM orders o JOIN tables t ON t.table_number = o.table_number
      WHERE o.id = ?`,
    [orderId],
  )
  if (!rows.length) throw httpError('Order was not found.', 404)
  if (rows[0].current_status === 'Confirmed Served' || rows[0].current_status === 'Served') {
    throw httpError('A customer-confirmed order cannot be moved back in the kitchen queue.', 409)
  }
  if (rows[0].current_status === 'Awaiting Confirmation' && status !== 'Awaiting Confirmation') {
    throw httpError('This order is waiting for customer confirmation.', 409)
  }
  await pool.query(
    `UPDATE orders SET status = ?,
       prepared_at = IF(? = 'Awaiting Confirmation', COALESCE(prepared_at, NOW()), prepared_at)
     WHERE id = ?`,
    [status, status, orderId],
  )
  sendChange('orders:updated', { orderId: asString(orderId), tableNumber: rows[0].table_number, status: toUiOrderStatus(status) })
  sendChange('tables:updated', { tableNumber: rows[0].table_number })
  res.json({ updated: true, status: toUiOrderStatus(status) })
}))

app.post('/api/orders/:orderId/confirm-served', asyncRoute(async (req, res) => {
  const orderId = parseId(req.params.orderId, 'orderId')
  const guestId = parseId(req.body?.customerId, 'customerId')
  const connection = await pool.getConnection()
  let order
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query(
      `SELECT o.id, o.session_id, o.table_number, o.status, d.guest_id, s.is_active
         FROM orders o
         JOIN table_sessions s ON s.id = o.session_id
         LEFT JOIN order_details d ON d.order_id = o.id
        WHERE o.id = ? FOR UPDATE`,
      [orderId],
    )
    order = rows[0]
    if (!order || !order.is_active) throw httpError('Active order was not found.', 404)
    const [guests] = await connection.query(
      'SELECT id FROM session_guests WHERE id = ? AND session_id = ?',
      [guestId, order.session_id],
    )
    if (!guests.length) throw httpError('Guest is not part of this active table session.', 403)
    if (order.guest_id && Number(order.guest_id) !== guestId) {
      throw httpError('Only the guest who placed this order can confirm it.', 403)
    }
    if (order.status === 'Confirmed Served' || order.status === 'Served') {
      await connection.commit()
      return res.json({ confirmed: true, status: 'Confirmed Served' })
    }
    if (order.status !== 'Awaiting Confirmation') {
      throw httpError('This order is not yet ready for customer confirmation.', 409)
    }
    await connection.query(
      `UPDATE orders SET status = 'Confirmed Served', customer_confirmed_at = NOW()
        WHERE id = ?`,
      [orderId],
    )
    const [pendingOrders] = await connection.query(
      `SELECT id FROM orders
        WHERE session_id = ? AND status <> 'Confirmed Served' LIMIT 1`,
      [order.session_id],
    )
    if (!pendingOrders.length) {
      await connection.query(
        `UPDATE tables SET status = IF(status = 'calling_waiter', status, 'occupied')
          WHERE table_number = ?`,
        [order.table_number],
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  sendChange('orders:updated', {
    orderId: asString(orderId),
    tableNumber: order.table_number,
    status: 'Confirmed Served',
  })
  sendChange('tables:updated', { tableNumber: order.table_number })
  res.json({ confirmed: true, status: 'Confirmed Served' })
}))

app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const fullName = String(req.body?.fullName || '').trim()
  const role = String(req.body?.role || '')
  const identity = String(req.body?.identity || req.body?.email || req.body?.staffId || '').trim()
  const password = String(req.body?.password || '')
  const confirmPassword = String(req.body?.confirmPassword || '')
  const passcode = String(req.body?.restaurantPasscode || '')
  if (!isValidStaffName(fullName)) {
    throw httpError('Full name must be at least 2 characters and contain only letters and spaces (hyphens or apostrophes are allowed).')
  }
  if (!['Manager', 'Waiter / Captain', 'Kitchen / Chef'].includes(role)) throw httpError('Choose a valid staff role.')
  const identityError = validateStaffIdentity(identity)
  if (identityError || identity.length > 150) throw httpError(identityError || 'Email / Staff ID is too long.')
  const normalizedIdentity = identity.includes('@') ? identity.toLowerCase() : identity
  if (!isValidSignupPassword(password)) throw httpError('Password must be at least 8 characters and include at least one letter and one number.')
  if (confirmPassword !== password) throw httpError('Passwords do not match.')
  if (process.env.STAFF_SIGNUP_PASSCODE && passcode !== process.env.STAFF_SIGNUP_PASSCODE) {
    throw httpError('The restaurant staff passcode is incorrect.', 403)
  }
  const passwordHash = await bcrypt.hash(password, 12)
  try {
    const [result] = await pool.query(
      'INSERT INTO staff_users (full_name, email, role, password_hash) VALUES (?, ?, ?, ?)',
      [fullName, normalizedIdentity, role, passwordHash],
    )
    res.status(201).json({
      message: 'Staff account created. You can now sign in.',
      staff: { id: asString(result.insertId), fullName, role, identity: normalizedIdentity },
    })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw httpError('An account already uses that Email / Staff ID.', 409)
    throw error
  }
}))

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const identity = String(req.body?.identity || req.body?.email || req.body?.staffId || '').trim()
  const password = String(req.body?.password || '')
  const identityError = validateStaffIdentity(identity)
  if (identityError) throw httpError(identityError)
  if (!password) throw httpError('Enter your password.')
  const normalizedIdentity = identity.includes('@') ? identity.toLowerCase() : identity
  const [rows] = await pool.query(
    'SELECT id, full_name, role, email, password_hash FROM staff_users WHERE email = ? LIMIT 1',
    [normalizedIdentity],
  )
  const staff = rows[0]
  if (!staff || !await bcrypt.compare(password, staff.password_hash)) {
    throw httpError('Email / Staff ID or password is incorrect.', 401)
  }
  if (!process.env.JWT_SECRET) throw httpError('JWT_SECRET is not configured.', 500)
  const token = jwt.sign(
    { sub: String(staff.id), role: staff.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )
  res.json({
    token,
    staff: {
      id: asString(staff.id),
      fullName: staff.full_name,
      role: staff.role,
      identity: staff.email,
    },
  })
}))

app.post('/api/auth/logout', authRequired, (_req, res) => {
  res.json({ loggedOut: true })
})

app.use((req, _res, next) => next(httpError(`Route ${req.method} ${req.path} was not found.`, 404)))
app.use((error, _req, res, _next) => {
  const status = Number(error.status) || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)
  if (status >= 500) console.error(error)
  res.status(status).json({
    message: status >= 500 ? 'A server error occurred.' : error.message,
    ...(status < 500 && error.details ? error.details : {}),
  })
})

function sendGameError(socket, acknowledge, message) {
  if (typeof acknowledge === 'function') acknowledge({ error: message })
  socket.emit('game:error', { message })
}

async function validateGameGuest(payload) {
  const tableNumber = parseTableNumber(payload?.tableNumber)
  const sessionId = parseId(payload?.sessionId, 'sessionId')
  const customerId = parseId(payload?.customerId, 'customerId')
  const [rows] = await pool.query(
    `SELECT g.id, g.customer_name, s.id AS session_id, s.table_number
       FROM session_guests g
       JOIN table_sessions s ON s.id = g.session_id
      WHERE g.id = ? AND s.id = ? AND s.table_number = ? AND s.is_active = 1
      LIMIT 1`,
    [customerId, sessionId, tableNumber],
  )
  if (!rows.length) throw httpError('Join an active table session before playing.', 403)
  return {
    customerId: Number(rows[0].id),
    sessionId: Number(rows[0].session_id),
    tableNumber: Number(rows[0].table_number),
    name: rows[0].customer_name,
  }
}

function makeGameMatch(game) {
  if (scoreDuelGames.includes(game)) {
    return { game, status: 'active', currentTurn: 0, winner: null, scores: [null, null] }
  }
  return createTurnGameState(game)
}

function serializeGameRoom(room) {
  return {
    ...room.match,
    code: room.code,
    game: room.game,
    status: room.players.length < 2 ? 'waiting' : room.match.status,
    players: room.players.map((player) => ({
      customerId: String(player.customerId),
      name: player.name,
      tableNumber: player.tableNumber,
      connected: player.connected,
    })),
    rematchRequested: room.rematchBy.size > 0,
  }
}

function broadcastGameRoom(room) {
  io.to(room.code).emit('game:state', serializeGameRoom(room))
}

async function joinGameRoom(socket, payload, acknowledge) {
  try {
    const code = String(payload?.code || '').trim().toUpperCase()
    const room = gameRooms.get(code)
    if (!room) throw httpError('That game room has expired or does not exist.', 404)
    if (payload?.game && payload.game !== room.game) throw httpError('That room is for a different game.')
    const guest = await validateGameGuest(payload)
    let playerIndex = room.players.findIndex((player) => player.customerId === guest.customerId)
    if (playerIndex < 0) {
      if (room.players.length >= 2) throw httpError('This room already has two players.')
      if (room.targetTableNumber && room.targetTableNumber !== guest.tableNumber) {
        throw httpError(`This invitation is for Table #${String(room.targetTableNumber).padStart(2, '0')}.`, 403)
      }
      if (room.players.some((player) => player.tableNumber === guest.tableNumber && player.customerId === guest.customerId)) {
        throw httpError('Choose a different guest to join the match.')
      }
      playerIndex = room.players.length
      room.players.push(guest)
    } else {
      const previousSocketId = room.players[playerIndex].socketId
      if (previousSocketId && previousSocketId !== socket.id) {
        io.sockets.sockets.get(previousSocketId)?.leave(room.code)
      }
      Object.assign(room.players[playerIndex], guest)
    }
    room.players[playerIndex].socketId = socket.id
    room.players[playerIndex].connected = true
    socket.join(room.code)
    socket.join(`table:${guest.tableNumber}`)
    if (room.players.length === 2 && room.match.status === 'waiting') room.match.status = 'active'
    broadcastGameRoom(room)
    if (typeof acknowledge === 'function') acknowledge({ state: serializeGameRoom(room), playerIndex })
  } catch (error) {
    sendGameError(socket, acknowledge, error.status ? error.message : 'Could not join the game room. Please try again.')
  }
}

io.on('connection', (socket) => {
  socket.emit('connection:ready', { connected: true })

  socket.on('game:table:join', async (payload, acknowledge) => {
    try {
      const guest = await validateGameGuest(payload)
      socket.join(`table:${guest.tableNumber}`)
      if (typeof acknowledge === 'function') acknowledge({ joined: true })
    } catch (error) {
      sendGameError(socket, acknowledge, error.status ? error.message : 'Could not verify the active table session.')
    }
  })

  socket.on('game:create', async (payload, acknowledge) => {
    try {
      const game = String(payload?.game || '')
      if (!supportedGames.includes(game)) throw httpError('Choose a supported game.')
      const guest = await validateGameGuest(payload)
      const targetTableNumber = payload?.targetTableNumber ? parseTableNumber(payload.targetTableNumber) : null
      for (const [roomCode, existingRoom] of gameRooms) {
        if (Date.now() - existingRoom.createdAt > 6 * 60 * 60 * 1000) gameRooms.delete(roomCode)
      }
      let code
      do {
        code = randomBytes(3).toString('hex').toUpperCase()
      } while (gameRooms.has(code))
      const room = {
        code,
        game,
        targetTableNumber,
        createdAt: Date.now(),
        players: [{ ...guest, socketId: socket.id, connected: true }],
        match: makeGameMatch(game),
        rematchBy: new Set(),
      }
      gameRooms.set(code, room)
      socket.join(code)
      socket.join(`table:${guest.tableNumber}`)
      const state = serializeGameRoom(room)
      if (targetTableNumber) {
        io.to(`table:${targetTableNumber}`).emit('game:invite', {
          code,
          game,
          fromTable: guest.tableNumber,
          fromName: guest.name,
        })
      }
      if (typeof acknowledge === 'function') acknowledge({ state, playerIndex: 0 })
      broadcastGameRoom(room)
    } catch (error) {
      sendGameError(socket, acknowledge, error.status ? error.message : 'Could not create a game room. Please try again.')
    }
  })

  socket.on('game:join', (payload, acknowledge) => joinGameRoom(socket, payload, acknowledge))

  socket.on('game:state', (payload, acknowledge) => {
    const room = gameRooms.get(String(payload?.code || '').trim().toUpperCase())
    const player = room?.players.find((entry) => entry.customerId === Number(payload?.customerId) && entry.socketId === socket.id)
    if (!room || !player) {
      sendGameError(socket, acknowledge, 'You are not a player in that game room.')
      return
    }
    socket.emit('game:state', serializeGameRoom(room))
    if (typeof acknowledge === 'function') acknowledge({ state: serializeGameRoom(room) })
  })

  socket.on('game:move', (payload, acknowledge) => {
    const room = gameRooms.get(String(payload?.code || '').trim().toUpperCase())
    const customerId = Number(payload?.customerId)
    const playerIndex = room?.players.findIndex((player) => player.customerId === customerId && player.socketId === socket.id) ?? -1
    if (!room || playerIndex < 0) {
      sendGameError(socket, acknowledge, 'Reconnect to the game room before making a move.')
      return
    }
    if (room.players.length !== 2 || room.match.status !== 'active') {
      sendGameError(socket, acknowledge, 'This game is not ready for a move.')
      return
    }
    if (room.match.currentTurn !== playerIndex) {
      sendGameError(socket, acknowledge, 'It is the other player’s turn.')
      return
    }
    if (scoreDuelGames.includes(room.game)) {
      const score = Number(payload?.move?.score)
      const maxScore = room.game === 'air-hockey' ? 5 : 100
      if (!Number.isInteger(score) || score < 0 || score > maxScore || room.match.scores[playerIndex] !== null) {
        sendGameError(socket, acknowledge, 'That round score is not valid.')
        return
      }
      room.match.scores[playerIndex] = score
      if (room.match.scores.every((value) => value !== null)) {
        room.match.status = 'finished'
        room.match.winner = room.match.scores[0] === room.match.scores[1]
          ? null
          : room.match.scores[0] > room.match.scores[1] ? 0 : 1
      } else {
        room.match.currentTurn = 1 - playerIndex
      }
    } else {
      const nextState = applyTurnMove(room.match, playerIndex, payload?.move)
      if (!nextState) {
        sendGameError(socket, acknowledge, 'That move is not available.')
        return
      }
      room.match = nextState
    }
    room.rematchBy.clear()
    const state = serializeGameRoom(room)
    broadcastGameRoom(room)
    if (typeof acknowledge === 'function') acknowledge({ state })
  })

  socket.on('game:rematch', (payload, acknowledge) => {
    const room = gameRooms.get(String(payload?.code || '').trim().toUpperCase())
    const customerId = Number(payload?.customerId)
    const playerIndex = room?.players.findIndex((player) => player.customerId === customerId && player.socketId === socket.id) ?? -1
    if (!room || playerIndex < 0 || room.match.status !== 'finished') {
      sendGameError(socket, acknowledge, 'A rematch is not available for this game.')
      return
    }
    room.rematchBy.add(playerIndex)
    if (room.rematchBy.size === 2) {
      room.match = makeGameMatch(room.game)
      room.rematchBy.clear()
    }
    const state = serializeGameRoom(room)
    broadcastGameRoom(room)
    if (typeof acknowledge === 'function') acknowledge({ state })
  })

  socket.on('disconnect', () => {
    gameRooms.forEach((room) => {
      const player = room.players.find((entry) => entry.socketId === socket.id)
      if (player) {
        player.connected = false
        player.socketId = null
        broadcastGameRoom(room)
      }
    })
  })
})

const port = Number(process.env.PORT || 5000)
httpServer.listen(port, () => console.log(`DinePlay API listening on http://localhost:${port}`))
