import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, Bell, Check, ChefHat, ChevronDown, CircleHelp,
  Clock3, Coffee, Eye, EyeOff, Gamepad2, Heart, LockKeyhole, LogOut, MapPin, Minus, Plus, QrCode, Search, ShoppingBag,
  Sparkles, Utensils, X, Zap,
} from 'lucide-react'
import QRCode from 'qrcode'
import { menuCategories } from './data/menuData'
import { gameSettings } from './data/games'
import { createTableQrLinks } from './data/tableQr'
import { GameBoard, PassPlayGame } from './components/TurnBasedGames'
import { useRestaurant } from './context/RestaurantContext'
import * as api from './services/api'

const money = (amount) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount || 0)

const activeCalls = (table) => table.calls.filter((call) => !call.resolved)
const activeOrders = (table) => table.orders.filter((order) => order.status !== 'Confirmed Served')
const formatCooldown = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
const readStoredGuest = () => {
  try {
    const stored = JSON.parse(sessionStorage.getItem('dineplay-guest-session') || 'null')
    return stored && /^\d{2}$/.test(stored.tableId) && stored.customerId
      ? { tableId: stored.tableId, customerId: String(stored.customerId) }
      : null
  } catch {
    return null
  }
}
const orderStatusLabel = (status) => status === 'Received'
  ? 'Order Received'
  : status === 'Awaiting Confirmation'
    ? 'Served — Awaiting Your Confirmation'
    : status
const orderStatusClass = (status) => status.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const getTodaysSpecial = (items, date = new Date()) => {
  if (!items.length) return null
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
  return items[((day % items.length) + items.length) % items.length]
}
const formatSpecialDate = (date) => new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
}).format(date)
const validateStaffIdentity = (identity) => identity.includes('@')
  ? (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(identity.trim()) ? '' : 'Enter a valid email address.')
  : (/^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$/.test(identity.trim())
      ? ''
      : 'Enter a valid Staff ID (3–50 letters, numbers, dots, underscores, or hyphens).')
const validateGuestName = (name) => name.trim().length >= 2 ? '' : 'Display name must be at least 2 characters.'
const validateGuestPhone = (phone) => {
  if (!phone.trim()) return ''
  const normalized = phone.replace(/[\s().-]/g, '')
  return /^(?:\+91)?[6-9]\d{9}$/.test(normalized)
    ? ''
    : 'Enter a valid 10-digit phone number, optionally with +91.'
}
const getTableTotal = (table) => {
  if (table.bill) {
    return {
      subtotal: Number(table.bill.subtotal) || 0,
      discount: Number(table.bill.discount) || 0,
      gst: Number(table.bill.gst) || 0,
      total: Number(table.bill.grandTotal) || 0,
    }
  }
  const items = [...table.cart, ...table.orders.flatMap((order) => order.items.map((item) => ({ item, quantity: item.quantity })))]
  const subtotal = items.reduce((sum, line) => sum + line.item.price * line.quantity, 0)
  const dessertValue = items.reduce((sum, line) => sum + (/dessert/i.test(line.item.category) ? line.item.price * line.quantity : 0), 0)
  const discount = table.coupon ? Math.round(dessertValue * table.coupon.percent / 100) : 0
  const gst = Math.round((subtotal - discount) * 0.05)
  return { subtotal, discount, gst, total: subtotal - discount + gst }
}

function App() {
  const { tables, tablesLoaded, menu, joinTable, leaveTable, waiterCooldowns, lastError, clearError } = useRestaurant()
  const storedGuest = readStoredGuest()
  const requestedTable = new URLSearchParams(window.location.search).get('table')
  const normalizedRequestedTable = requestedTable && /^\d{1,2}$/.test(requestedTable) && Number(requestedTable) >= 1 && Number(requestedTable) <= 10
    ? requestedTable.padStart(2, '0')
    : null
  const initialTable = normalizedRequestedTable || storedGuest?.tableId || '04'
  const [mode, setMode] = useState('customer')
  const [tableId, setTableId] = useState(initialTable)
  const [customerId, setCustomerId] = useState(() => (
    storedGuest && (!normalizedRequestedTable || storedGuest.tableId === normalizedRequestedTable)
      ? storedGuest.customerId
      : ''
  ))
  const [staffSession, setStaffSession] = useState(null)
  const [staffMessage, setStaffMessage] = useState('')
  const [screen, setScreen] = useState('hub')
  const [waiterOpen, setWaiterOpen] = useState(false)
  const [waiterConfirmation, setWaiterConfirmation] = useState('')
  const [now, setNow] = useState(Date.now())
  const [adminTableId, setAdminTableId] = useState('')

  const table = tables.find((entry) => entry.id === tableId) || tables[3]
  const customer = table.customers.find((entry) => entry.id === customerId)

  useEffect(() => {
    if (storedGuest && storedGuest.tableId !== tableId) {
      sessionStorage.removeItem('dineplay-guest-session')
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!customer && mode === 'customer') setScreen('hub')
  }, [customer, mode])

  useEffect(() => {
    if (!tablesLoaded) return
    if (customer) {
      sessionStorage.setItem('dineplay-guest-session', JSON.stringify({ tableId, customerId: customer.id }))
    } else if (customerId) {
      sessionStorage.removeItem('dineplay-guest-session')
      setCustomerId('')
    }
  }, [tablesLoaded, customer, customerId, tableId])

  const latestCallEnd = Math.max(
    Number(table.callCooldownEndsAt) || 0,
    waiterCooldowns[tableId]?.sessionId === table.sessionId
      ? Number(waiterCooldowns[tableId]?.endsAt) || 0
      : 0,
    ...table.calls.map((call) => Number(call.createdAt) + 15 * 60 * 1000),
  )
  const cooldown = Math.max(0, Math.ceil((latestCallEnd - now) / 1000))
  const showGuestWarning = (message) => {
    clearError()
    setStaffMessage(message)
  }

  const changeTable = async (nextTableId) => {
    if (nextTableId === tableId) return
    if (customer) {
      const hasUnconfirmedOrders = table.orders.some(
        (order) => order.customerId === customer.id && order.status !== 'Confirmed Served',
      )
      if (hasUnconfirmedOrders) {
        showGuestWarning('Wait for your orders to be served and confirmed before leaving this table.')
        return
      }
      if (table.payment?.status === 'Pending Manager Approval') {
        showGuestWarning('Please wait for Manager approval before leaving this table.')
        return
      }
      const hasCartItems = table.cart.some((line) => line.customerId === customer.id)
      const message = hasCartItems
        ? 'Leaving will remove your unsent plate items. Placed orders and the table bill will remain. Leave this table?'
        : 'Placed orders and the table bill will remain open for staff. Leave this table?'
      if (!window.confirm(message)) return
      if (!await leaveTable(tableId, customer.id)) return
    }
    sessionStorage.removeItem('dineplay-guest-session')
    setStaffMessage('')
    setTableId(nextTableId)
    setCustomerId('')
    setScreen('hub')
    setWaiterOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.set('table', nextTableId)
    window.history.replaceState({}, '', url)
  }

  const leaveCurrentTable = async () => {
    if (!customer) return
    if (table.orders.some((order) => order.customerId === customer.id && order.status !== 'Confirmed Served')) {
      showGuestWarning('Wait for your orders to be served and confirmed before leaving this table.')
      return
    }
    if (table.payment?.status === 'Pending Manager Approval') {
      showGuestWarning('Please wait for Manager approval before leaving this table.')
      return
    }
    const hasCartItems = table.cart.some((line) => line.customerId === customer.id)
    const message = hasCartItems
      ? 'Leaving will remove your unsent plate items. Placed orders and the table bill will remain. Leave this table?'
      : 'Placed orders and the table bill will remain open for staff. Leave this table?'
    if (!window.confirm(message)) return
    if (!await leaveTable(tableId, customer.id)) return
    sessionStorage.removeItem('dineplay-guest-session')
    setStaffMessage('')
    setCustomerId('')
    setScreen('hub')
    setWaiterOpen(false)
    setWaiterConfirmation('')
  }

  const join = (name, phone) => {
    if (!name.trim()) return
    joinTable(tableId, name, phone).then((joined) => {
      if (!joined?.id) return
      setCustomerId(joined.id)
      setScreen('hub')
    })
  }

  const setView = (nextMode) => {
    if (nextMode === 'admin') {
      setMode(staffSession ? 'admin' : 'staffAuth')
      setWaiterOpen(false)
    } else {
      setMode('customer')
      setAdminTableId('')
    }
  }

  const lockStaffView = async () => {
    try {
      await api.logoutStaff(staffSession?.token)
    } catch (error) {
      setStaffMessage(error instanceof Error ? error.message : 'Staff logout could not be confirmed by the server.')
    }
    setStaffSession(null)
    setAdminTableId('')
    setMode('customer')
  }

  return (
    <div className="app-shell">
      {mode === 'customer' ? (
        <CustomerView
          table={table}
          customer={customer}
          customerId={customerId}
          tableId={tableId}
          screen={screen}
          setScreen={setScreen}
          onTableChange={changeTable}
          onJoin={join}
          onLeaveTable={leaveCurrentTable}
          onOpenWaiter={() => setWaiterOpen(true)}
          cooldown={cooldown}
          now={now}
          menu={menu}
        />
      ) : mode === 'staffAuth' ? (
        <StaffAuthScreen onAuthenticated={(session) => { setStaffSession(session); setMode('admin'); setStaffMessage('') }} onBack={() => setMode('customer')} />
      ) : (
        <AdminView onInspect={setAdminTableId} now={now} staffSession={staffSession} onLock={lockStaffView} menu={menu} />
      )}

      {mode === 'customer' && waiterOpen && customer && (
        <WaiterModal
          table={table}
          customer={customer}
          cooldown={cooldown}
          confirmation={waiterConfirmation}
          setConfirmation={setWaiterConfirmation}
          onClose={() => {
            setWaiterOpen(false)
            setWaiterConfirmation('')
          }}
        />
      )}
      {adminTableId && <TableDetails table={tables.find((entry) => entry.id === adminTableId)} token={staffSession?.token} staffRole={staffSession?.staff?.role} menu={menu} onClose={() => setAdminTableId('')} />}
      {(lastError || staffMessage) && <div className="app-alert" role="alert"><span>{lastError || staffMessage}</span><button aria-label="Dismiss message" onClick={() => { clearError(); setStaffMessage('') }}><X size={15} /></button></div>}
      <ViewSwitcher mode={mode} setMode={setView} />
    </div>
  )
}

function StaffAuthScreen({ onAuthenticated, onBack }) {
  const [formMode, setFormMode] = useState('signin')
  const [showPassword, setShowPassword] = useState(false)
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('')
  const [identity, setIdentity] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

  const toggleMode = (nextMode) => {
    setFormMode(nextMode)
    setError('')
    setSuccess('')
    setFieldErrors({})
  }

  const fieldError = (field) => {
    if (field === 'fullName') {
      return fullName.trim().length < 2 || !/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(fullName.trim())
        ? 'Use at least 2 letters; spaces, hyphens, and apostrophes are allowed.'
        : ''
    }
    if (field === 'role') return role ? '' : 'Choose your staff role.'
    if (field === 'identity') return validateStaffIdentity(identity)
    if (field === 'password') {
      if (!password) return 'Password is required.'
      if (formMode === 'signup' && (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))) {
        return 'Use at least 8 characters with at least one letter and one number.'
      }
      return ''
    }
    if (field === 'confirmPassword') {
      return confirmPassword && confirmPassword === password ? '' : 'Passwords must match.'
    }
    return ''
  }

  const validateOnBlur = (field) => setFieldErrors((current) => ({ ...current, [field]: fieldError(field) }))
  const updateField = (field, setter, value) => {
    setter(value)
    setFieldErrors((current) => current[field] ? { ...current, [field]: '' } : current)
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setSuccess('')
    const fields = formMode === 'signup'
      ? ['fullName', 'role', 'identity', 'password', 'confirmPassword']
      : ['identity', 'password']
    const nextErrors = Object.fromEntries(fields.map((field) => [field, fieldError(field)]))
    setFieldErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      setError('Please correct the highlighted fields.')
      return
    }

    setBusy(true)
    try {
      if (formMode === 'signup') {
        const result = await api.signupStaff({
          fullName: fullName.trim(),
          role,
          identity: identity.trim(),
          password,
          confirmPassword,
          restaurantPasscode: passcode.trim() || undefined,
        })
        setFormMode('signin')
        setPassword('')
        setConfirmPassword('')
        setPasscode('')
        setFieldErrors({})
        setSuccess(result?.message || 'Staff account created. You can now sign in.')
      } else {
        const result = await api.loginStaff({ identity: identity.trim(), password })
        if (!result?.token || !result?.staff) {
          throw new Error('The authentication service did not return a valid staff session.')
        }
        onAuthenticated({ token: result.token, staff: result.staff })
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Staff authentication failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="staff-auth-layout">
      <header className="auth-topbar">
        <div className="brand"><span className="brand-mark">D<span>·</span></span><span>Dine<span>Play</span></span></div>
        <span className="auth-secure-note"><LockKeyhole size={14} /> STAFF ACCESS</span>
      </header>
      <section className="staff-auth-card">
        <div className="auth-emblem"><LockKeyhole size={22} /></div>
        <span className="eyebrow">RESTAURANT TEAM CONSOLE</span>
        <h1>{formMode === 'signin' ? 'Welcome back.' : 'Join your team.'}</h1>
        <p className="auth-description">{formMode === 'signin' ? 'Sign in with your restaurant staff account to access the floor.' : 'Create a staff account to access the restaurant console.'}</p>
        <div className="auth-mode-tabs">
          <button type="button" className={formMode === 'signin' ? 'active' : ''} onClick={() => toggleMode('signin')}>Staff Sign In</button>
          <button type="button" className={formMode === 'signup' ? 'active' : ''} onClick={() => toggleMode('signup')}>Staff Sign Up</button>
        </div>
        <form className="staff-auth-form" onSubmit={submit}>
          {formMode === 'signup' && <>
            <label htmlFor="staff-full-name">Full name</label>
            <input id="staff-full-name" autoComplete="name" value={fullName} aria-invalid={Boolean(fieldErrors.fullName)} aria-describedby="staff-full-name-error" onBlur={() => validateOnBlur('fullName')} onChange={(event) => updateField('fullName', setFullName, event.target.value)} placeholder="Your full name" />
            {fieldErrors.fullName && <small className="field-error" id="staff-full-name-error">{fieldErrors.fullName}</small>}
            <label htmlFor="staff-role">Role</label>
            <select id="staff-role" value={role} aria-invalid={Boolean(fieldErrors.role)} aria-describedby="staff-role-error" onBlur={() => validateOnBlur('role')} onChange={(event) => updateField('role', setRole, event.target.value)}>
              <option value="">Select a role</option><option>Manager</option><option>Waiter / Captain</option><option>Kitchen / Chef</option>
            </select>
            {fieldErrors.role && <small className="field-error" id="staff-role-error">{fieldErrors.role}</small>}
          </>}
          <label htmlFor="staff-identity">Email / Staff ID</label>
          <input id="staff-identity" autoComplete="username" value={identity} aria-invalid={Boolean(fieldErrors.identity)} aria-describedby="staff-identity-error" onBlur={() => validateOnBlur('identity')} onChange={(event) => updateField('identity', setIdentity, event.target.value)} placeholder="name@restaurant.com or staff ID" />
          {fieldErrors.identity && <small className="field-error" id="staff-identity-error">{fieldErrors.identity}</small>}
          <label htmlFor="staff-password">Password</label>
          <div className="password-field">
            <input id="staff-password" type={showPassword ? 'text' : 'password'} autoComplete={formMode === 'signin' ? 'current-password' : 'new-password'} value={password} aria-invalid={Boolean(fieldErrors.password)} aria-describedby="staff-password-error" onBlur={() => validateOnBlur('password')} onChange={(event) => updateField('password', setPassword, event.target.value)} placeholder="At least 8 characters" />
            <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
          {fieldErrors.password && <small className="field-error" id="staff-password-error">{fieldErrors.password}</small>}
          {formMode === 'signup' && <>
            <label htmlFor="staff-confirm-password">Confirm password</label>
            <input id="staff-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} aria-invalid={Boolean(fieldErrors.confirmPassword)} aria-describedby="staff-confirm-password-error" onBlur={() => validateOnBlur('confirmPassword')} onChange={(event) => updateField('confirmPassword', setConfirmPassword, event.target.value)} placeholder="Re-enter your password" />
            {fieldErrors.confirmPassword && <small className="field-error" id="staff-confirm-password-error">{fieldErrors.confirmPassword}</small>}
            <label htmlFor="staff-passcode">Restaurant / staff passcode <span>OPTIONAL</span></label>
            <input id="staff-passcode" autoComplete="off" value={passcode} onChange={(event) => setPasscode(event.target.value)} placeholder="Provided by your manager" />
          </>}
          {error && <div className="auth-message error" role="alert">{error}</div>}
          {success && <div className="auth-message success" role="status">{success}</div>}
          <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : formMode === 'signin' ? 'Sign in to staff console' : 'Create staff account'} <ArrowRight size={15} /></button>
        </form>
        <button className="auth-back" onClick={onBack} type="button"><ArrowLeft size={14} /> Return to customer view</button>
        <p className="auth-footer"><LockKeyhole size={12} /> Staff access is verified by the restaurant authentication service.</p>
      </section>
    </main>
  )
}

function CustomerView({ table, customer, customerId, tableId, screen, setScreen, onTableChange, onJoin, onLeaveTable, onOpenWaiter, cooldown, now, menu }) {
  const [gameInvite, setGameInvite] = useState(null)
  const [acceptedGameInvite, setAcceptedGameInvite] = useState(null)
  const kitchenMinutes = Math.max(10, 15 + activeOrders(table).length * 3)
  const myCart = table.cart.filter((line) => line.customerId === customerId)
  const cartCount = myCart.reduce((sum, line) => sum + line.quantity, 0)
  const cartTotal = myCart.reduce((sum, line) => sum + line.item.price * line.quantity, 0)
  const navigation = [
    { id: 'menu', title: 'Food & drink', caption: 'Regional favourites and café plates', icon: Utensils, tone: 'amber', emoji: '🍽️' },
    { id: 'games', title: 'Table games', caption: 'Take a turn while you wait', icon: Gamepad2, tone: 'purple', emoji: '🕹️' },
    { id: 'waiter', title: 'Call your server', caption: cooldown ? `Available in ${formatCooldown(cooldown)}` : 'Ask for a hand', icon: Bell, tone: 'mint', emoji: '🔔' },
    { id: 'plate', title: 'Your order & bill', caption: `${cartCount} items · review your plate`, icon: ShoppingBag, tone: 'pink', emoji: '🧾' },
  ]

  const open = (id) => id === 'waiter' ? onOpenWaiter() : setScreen(id)

  useEffect(() => {
    if (!customerId || !table.sessionId) return undefined
    const socket = api.connectLiveUpdates()
    const joinTableRoom = () => socket.emit('game:table:join', {
      tableNumber: Number(tableId),
      sessionId: table.sessionId,
      customerId,
    })
    const onInvite = (invite) => setGameInvite(invite)
    socket.on('connect', joinTableRoom)
    socket.on('game:invite', onInvite)
    if (socket.connected) joinTableRoom()
    return () => {
      socket.off('connect', joinTableRoom)
      socket.off('game:invite', onInvite)
      socket.disconnect()
    }
  }, [customerId, table.sessionId, tableId])

  return (
    <main className="customer-layout">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setScreen('hub') }}>
          <span className="brand-mark">D<span>·</span></span>
          <span>Dine<span>Play</span></span>
        </a>
        <div className="topbar-right">
          <label className="table-select-wrap">
            <MapPin size={14} />
            <select aria-label="Select table" value={tableId} onChange={(event) => onTableChange(event.target.value)}>
              {Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(2, '0')).map((id) => (
                <option key={id} value={id}>Table #{id}</option>
              ))}
            </select>
            <ChevronDown size={13} />
          </label>
          {customer && (
            <button className="profile-chip" aria-label="Add another guest" onClick={() => { const name = window.prompt('What name should we add to the table?'); if (name?.trim()) onJoin(name, '') }} title="Add another guest">
              <span className="avatar">{customer.name.charAt(0).toUpperCase()}</span>
              <span className="profile-name">{customer.name}</span>
              <Plus size={14} className="profile-plus" />
            </button>
          )}
          {customer && <button className="leave-table-button" onClick={onLeaveTable} aria-label="Leave table" title="Leave table"><LogOut size={15} /><span>Leave table</span></button>}
          <button className={`waiter-header ${cooldown ? 'is-cooling' : ''}`} onClick={onOpenWaiter} disabled={!customer || cooldown > 0}>
            <Bell size={15} /> <span>{cooldown ? formatCooldown(cooldown) : 'Call waiter'}</span>
          </button>
        </div>
      </header>
      {gameInvite && customer && <div className="game-invite-toast" role="status">
        <div><b>Table #{String(gameInvite.fromTable).padStart(2, '0')} challenges you</b><span>{gameInvite.game.replaceAll('-', ' ')} · room {gameInvite.code}</span></div>
        <button className="primary-button" onClick={() => { setAcceptedGameInvite(gameInvite); setGameInvite(null); setScreen('games') }}>Join multiplayer</button>
        <button className="icon-button" aria-label="Dismiss game invitation" onClick={() => setGameInvite(null)}><X size={15} /></button>
      </div>}

      {!customer ? (
        <WelcomeModal tableId={tableId} onJoin={onJoin} onTableChange={onTableChange} embedded />
      ) : (
        <div className="content-wrap">
          <div className="crumb-row">
            {screen !== 'hub' && <button className="back-link" onClick={() => setScreen('hub')}><ArrowLeft size={15} /> Back to table</button>}
            <span className="crumb-label">YOUR DINING ROOM <span>·</span> TABLE #{tableId}</span>
          </div>
          {screen === 'hub' && <CustomerHub table={table} customer={customer} kitchenMinutes={kitchenMinutes} navigation={navigation} onNavigate={open} now={now} menu={menu} />}
          {screen === 'menu' && <MenuScreen table={table} customer={customer} customerId={customerId} menu={menu} now={now} onOpenPlate={() => setScreen('plate')} />}
          {screen === 'plate' && <PlateScreen table={table} customer={customer} now={now} />}
          {screen === 'games' && <GameZone table={table} tableId={tableId} customerId={customerId} initialInvite={acceptedGameInvite} onInviteAccepted={() => setAcceptedGameInvite(null)} />}
        </div>
      )}
      {customer && cartCount > 0 && (
        <button className="floating-cart-bar" onClick={() => setScreen('plate')}>
          <span className="floating-cart-count">{cartCount}</span>
          <span><b>{cartCount} {cartCount === 1 ? 'Item' : 'Items'}</b><i> · </i>{money(cartTotal)}</span>
          <strong>View plate <ArrowRight size={15} /></strong>
        </button>
      )}
      <footer className="customer-footer"><span>Good food, good company.</span><span>Made for your moment <Heart size={12} fill="currentColor" /></span></footer>
    </main>
  )
}

function CustomerHub({ table, customer, kitchenMinutes, navigation, onNavigate, now, menu }) {
  const { addToCart } = useRestaurant()
  const currentOrders = table.orders.filter((order) => order.customerId === customer.id)
  const featured = menu.find((item) => item.popular)
  const special = getTodaysSpecial(menu, new Date(now))
  const specialDate = formatSpecialDate(new Date(now))
  const fullName = customer.name || 'Guest'
  const addSpecial = async () => {
    if (await addToCart(table.id, special, customer.id)) onNavigate('plate')
  }
  return (
    <div className="hub-view">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow"><Coffee size={13} /> DINEPLAY · TABLE SERVICE</span>
          <h1>Welcome, {fullName}.<br />Your table is ready.</h1>
          <p>Take a look at the menu. We’ll bring everything to your table.</p>
          <div className="hero-meta">
            <span className="wait-badge"><Clock3 size={14} /> Kitchen wait <b>~{kitchenMinutes} mins</b></span>
            <span className="online-dot"><i /> Table #{table.id} is live</span>
          </div>
        </div>
        <div className="hero-art">
          <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
          <span className="hero-food">🍔</span><span className="hero-fries">🍟</span><span className="hero-drink">🍹</span>
          <span className="hero-sticker">MADE<br />WITH<br /><b>CARE</b></span>
        </div>
        <span className="hero-corner">FRESH FROM THE KITCHEN</span>
      </section>

      {special && <section className="today-special-card">
        <div className="today-special-art"><span>{special.emoji}</span><i>✦</i></div>
        <div className="today-special-copy"><span className="today-special-kicker">TODAY’S SPECIAL <i /> {specialDate}</span><h2>{special.name}</h2><p>{special.description}</p><div><b>{money(special.price)}</b><span>{special.spice} · {special.prepMinutes} min</span></div></div>
        <button className="today-special-add" onClick={addSpecial}><Plus size={14} /> Add to plate</button>
      </section>}

      {currentOrders.length > 0 && (
        <section className="order-ribbon">
          <span className="ribbon-icon"><ChefHat size={17} /></span>
          <div><b>{orderStatusLabel(currentOrders[currentOrders.length - 1].status)}</b><span>We’ll keep you posted from the kitchen.</span></div>
          <button onClick={() => onNavigate('plate')}>Track order <ArrowRight size={14} /></button>
        </section>
      )}

      <div className="section-heading">
        <div><span className="eyebrow">FROM OUR KITCHEN</span><h2>What sounds good?</h2></div>
        <span className="heading-note">Pick your next move <ArrowDown size={14} /></span>
      </div>
      <div className="navigation-grid">
        {navigation.map(({ id, title, caption, icon: Icon, tone, emoji }) => (
          <button className={`nav-card ${tone}`} key={id} onClick={() => onNavigate(id)}>
            <span className="nav-emoji">{emoji}</span>
            <span className="nav-icon"><Icon size={18} /></span>
            <span className="nav-card-title">{title}</span>
            <span className="nav-caption">{caption}</span>
            <span className="nav-arrow"><ArrowRight size={16} /></span>
          </button>
        ))}
      </div>

      <section className="feature-strip">
        <div className="feature-copy">
          <span className="eyebrow"><Zap size={12} /> A SWEET PAUSE</span>
          <h3>One quick round.<br /><span>Something sweet, too.</span></h3>
          <p>Win a game and we’ll take 5% off dessert on your table bill.</p>
          <button className="text-button" onClick={() => onNavigate('games')}>Play a round <ArrowRight size={15} /></button>
        </div>
        <div className="feature-dessert"><span>🍰</span><i>5%<small>OFF</small></i></div>
        <span className="feature-spark spark-a">✳</span><span className="feature-spark spark-b">✦</span>
      </section>
      <div className="hub-recommendation">
        <span className="recommendation-label">HOUSE FAVOURITE</span><span>{featured.emoji}</span><b>{featured.name}</b><span>{money(featured.price)}</span>
      </div>
      <div className="service-note"><span className="online-dot"><i /></span> Need a hand? Your server is just a tap away.</div>
    </div>
  )
}

function MenuScreen({ table, customer, customerId, menu, now, onOpenPlate }) {
  const { addToCart, updateCartLine } = useRestaurant()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [notes, setNotes] = useState({})
  const [selectedCategory, setSelectedCategory] = useState(menuCategories[0])
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const special = getTodaysSpecial(menu, new Date(now))
  const groupedItems = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = menu.filter((item) =>
      (filter === 'all' || (filter === 'veg' && item.type === 'Veg') || (filter === 'nonveg' && item.type === 'Non-Veg') || (filter === 'popular' && item.popular)) &&
      (!query || `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query)),
    )
    return menuCategories.map((category) => ({
      category,
      items: filtered.filter((item) => item.category === category),
    })).filter((group) => group.items.length)
  }, [filter, search, menu])

  const jumpToCategory = (category) => {
    setSelectedCategory(category)
    setCategoryMenuOpen(false)
    document.getElementById(`menu-category-${menuCategories.indexOf(category)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const updateQuantity = (item, quantity) => {
    const lines = table.cart.filter((line) => line.item.id === item.id && line.customerId === customerId)
    const existing = lines[0]
    if (existing) updateCartLine(table.id, existing.id, existing.quantity + quantity)
    else if (quantity > 0) addToCart(table.id, item, customerId, notes[item.id] || '')
  }

  return (
    <section className="page-section menu-page">
      <div className="menu-editorial-heading">
        <div><span className="eyebrow">THE DINEPLAY KITCHEN · MADE WITH HEART</span><h1>A menu worth lingering over.</h1><p>Regional favourites, café comforts, and something sweet to finish.</p></div>
        <span className="menu-total-count">{menu.length} thoughtfully made dishes</span>
      </div>
      <div className="menu-search menu-search-wide"><Search size={17} /><input aria-label="Search dishes and ingredients" placeholder="Search a dish or ingredient — paneer, garlic, biryani..." value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={15} /></button>}<kbd>⌘ K</kbd></div>
      {special && <div className="menu-special-banner"><span>{special.emoji}</span><div><small>TODAY’S SPECIAL · {formatSpecialDate(new Date(now))}</small><b>{special.name}</b></div><strong>{money(special.price)}</strong><button onClick={() => addToCart(table.id, special, customer.id)}><Plus size={13} /> Add</button></div>}
      <div className="menu-filters" role="group" aria-label="Filter menu">
        {[['all', 'All'], ['veg', 'Pure Veg'], ['nonveg', 'Non-Veg'], ['popular', 'Bestsellers']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'veg' ? <span className="veg-symbol" /> : value === 'nonveg' ? <span className="nonveg-symbol" /> : value === 'popular' ? <span>★</span> : null}{label}</button>)}
      </div>
      <nav className="menu-category-sticky" aria-label="Menu categories">{menuCategories.map((category, index) => <button key={category} className={selectedCategory === category ? 'active' : ''} onClick={() => jumpToCategory(category)}>{category}<span>{String(index + 1).padStart(2, '0')}</span></button>)}</nav>
      {groupedItems.length ? (
        <div className="menu-sections">{groupedItems.map((group) => (
          <section className="menu-category-section" id={`menu-category-${menuCategories.indexOf(group.category)}`} key={group.category}>
            <header className="menu-category-heading"><div><span className="eyebrow">FROM OUR REGIONAL KITCHEN</span><h2>{group.category}</h2></div><span>{group.items.length} dishes</span></header>
            <div className="menu-list">{group.items.map((item) => {
              const lines = table.cart.filter((line) => line.item.id === item.id && line.customerId === customerId)
              const quantity = lines.reduce((sum, line) => sum + line.quantity, 0)
              const noteOpen = Boolean(notes[`${item.id}-open`])
              return (
                <article className={`menu-row ${special?.id === item.id ? 'today-special-item' : ''}`} key={item.id}>
                  <span className={`diet-mark ${item.type === 'Veg' ? 'is-veg' : 'is-nonveg'}`} aria-label={item.type} title={item.type} />
                  <div className="menu-row-emoji">{item.emoji}</div>
                  <div className="menu-row-copy">
                    <div className="menu-row-name"><h3>{item.name}</h3>{special?.id === item.id && <span className="today-special-tag">TODAY’S SPECIAL</span>}{item.popular && <span className="bestseller-tag">★ BESTSELLER</span>}</div>
                    <p>{item.description}</p>
                    <div className="menu-row-meta"><span className={`spice-${item.spice.toLowerCase()}`} aria-label={`${item.spice} spice`}>{item.spice === 'Spicy' ? '🌶️🌶️🌶️' : item.spice === 'Medium' ? '🌶️🌶️' : '🌶️'} <i>{item.spice}</i></span><span><Clock3 size={12} /> {item.prepMinutes} min</span><button onClick={() => setNotes({ ...notes, [`${item.id}-open`]: !noteOpen })}>{noteOpen ? 'Hide note' : 'Add a note'}</button></div>
                    {noteOpen && <input className="menu-row-note" aria-label={`Kitchen note for ${item.name}`} placeholder="e.g. mild spice, no onion..." value={notes[item.id] || ''} onChange={(event) => setNotes({ ...notes, [item.id]: event.target.value })} />}
                  </div>
                  <div className="menu-row-buy"><b>{money(item.price)}</b>{quantity ? <span className="menu-stepper"><button aria-label={`Remove one ${item.name}`} onClick={() => updateCartLine(table.id, lines[0].id, lines[0].quantity - 1)}><Minus size={13} /></button><strong>{quantity}</strong><button aria-label={`Add one ${item.name}`} onClick={() => updateQuantity(item, 1)}><Plus size={13} /></button></span> : <button className="menu-add-pill" onClick={() => updateQuantity(item, 1)}>+ ADD</button>}</div>
                </article>
              )
            })}</div>
          </section>
        ))}</div>
      ) : <div className="empty-state"><span>🥄</span><b>No dishes found</b><p>Try another ingredient or clear the selected filters.</p></div>}
      <div className="category-jump-wrap">
        {categoryMenuOpen && <div className="category-jump-menu">{menuCategories.map((category, index) => <button key={category} onClick={() => jumpToCategory(category)}><span>{String(index + 1).padStart(2, '0')}</span>{category}<ArrowRight size={13} /></button>)}</div>}
        <button className="category-jump-button" onClick={() => setCategoryMenuOpen(!categoryMenuOpen)}><ChevronDown size={15} /> Menu categories</button>
      </div>
    </section>
  )
}

function PlateScreen({ table, customer, now }) {
  const { updateCartLine, placeOrder, confirmOrderServed, payBill } = useRestaurant()
  const [instructions, setInstructions] = useState('')
  const [message, setMessage] = useState('')
  const cart = table.cart.filter((line) => line.customerId === customer.id)
  const orders = table.orders.filter((order) => order.customerId === customer.id)
  const totals = getTableTotal(table)
  const payment = table.payment
  const paymentPending = payment?.status === 'Pending Manager Approval'
  const paymentPaid = payment?.status === 'Paid'
  const allOrdersConfirmed = table.orders.length > 0 && table.orders.every((order) => order.status === 'Confirmed Served')
  const canPay = !payment && !table.cart.length && allOrdersConfirmed
  const paymentBlockMessage = !table.orders.length
    ? 'Place an order before paying the bill.'
    : table.cart.length
      ? 'Place all items on the active plate before paying the bill.'
      : !allOrdersConfirmed
        ? 'Please confirm your served dishes first before paying the bill.'
        : ''
  const submitOrder = async () => {
    const created = await placeOrder(table.id, customer, instructions)
    if (created) {
      setInstructions('')
      setMessage('Order sent to the kitchen!')
      window.setTimeout(() => setMessage(''), 2600)
    }
  }
  const progressStatus = (status) => status === 'Awaiting Confirmation'
    ? 'served'
    : status === 'Confirmed Served' ? 'confirmed-served' : orderStatusClass(status)

  return (
    <section className="page-section">
      <div className="page-title-row">
        <div><span className="eyebrow">YOUR TABLE, YOUR ORDER</span><h1>My plate & bill.</h1><p>Everything you need, all in one place.</p></div>
        {table.coupon && <span className="coupon-pill"><Sparkles size={14} /> {table.coupon.label} applied</span>}
      </div>
      <div className="plate-layout">
        <div className="plate-main">
          <div className="surface-card">
            <div className="surface-title"><div><span className="eyebrow">NOT SENT YET</span><h2>Active plate <span className="count-bubble">{cart.reduce((sum, line) => sum + line.quantity, 0)}</span></h2></div><ShoppingBag size={19} /></div>
            {cart.length ? <>
              <div className="cart-list">{cart.map((line) => (
                <div className="cart-row" key={line.id}>
                  <span className="cart-emoji">{line.item.emoji}</span>
                  <div className="cart-item-copy"><b>{line.item.name}</b><span>{money(line.item.price)} each</span><input aria-label={`Cooking note for ${line.item.name}`} placeholder="Cooking note..." value={line.note} onChange={(event) => updateCartLine(table.id, line.id, line.quantity, event.target.value)} /></div>
                  <div className="qty-control"><button aria-label="Decrease quantity" onClick={() => updateCartLine(table.id, line.id, line.quantity - 1)}><Minus size={13} /></button><b>{line.quantity}</b><button aria-label="Increase quantity" onClick={() => updateCartLine(table.id, line.id, line.quantity + 1)}><Plus size={13} /></button></div>
                  <strong>{money(line.item.price * line.quantity)}</strong>
                </div>
              ))}</div>
              <label className="instruction-field">Note for the kitchen<textarea placeholder="Anything else we should know?" value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
              <button className="primary-button wide" onClick={submitOrder}><ChefHat size={16} /> Place order <ArrowRight size={15} /></button>
            </> : <div className="empty-inline"><span>🍽️</span><div><b>Your plate is taking a breather</b><p>Pick something delicious from the menu to get started.</p></div></div>}
            {message && <div className="success-message"><Check size={15} /> {message}</div>}
          </div>

          <div className="surface-card">
            <div className="surface-title"><div><span className="eyebrow">FROM OUR KITCHEN</span><h2>Order tracker</h2></div><Clock3 size={19} /></div>
            {orders.length ? <div className="order-track-list">{orders.map((order) => (
              <div className="order-track-card" key={order.id}>
                <div className="order-track-head"><div><b>Order #{order.id.slice(-4).toUpperCase()}</b><span>{timeAgo(order.createdAt, now)}</span></div><span className={`status-badge ${orderStatusClass(order.status)}`}>{orderStatusLabel(order.status)}</span></div>
                <div className="order-food-names">{order.items.map((item) => `${item.quantity}× ${item.name}`).join(' · ')}</div>
                <div className="progress-track"><span className={progressStatus(order.status)} /></div>
                <div className="progress-labels"><span>Received</span><span>Preparing</span><span>Served</span></div>
                {order.status === 'Awaiting Confirmation' && <div className="served-confirm-panel"><p>Please confirm this order reached your table.</p><button className="primary-button" onClick={() => confirmOrderServed(order.id, customer.id)}><Check size={15} /> Confirm food served</button></div>}
              </div>
            ))}</div> : <div className="empty-inline"><span>👨‍🍳</span><div><b>No orders in the kitchen yet</b><p>Once you place an order, we’ll show its progress here.</p></div></div>}
          </div>
        </div>
        <aside className="bill-card">
          <span className="eyebrow">YOUR TABLE’S TOTAL</span><h2>Table bill</h2><span className="bill-table">TABLE #{table.id} <i /> LIVE BILL</span>
          <div className="bill-line"><span>Food & drinks</span><b>{money(totals.subtotal)}</b></div>
          {table.coupon && <div className="bill-line discount"><span><Sparkles size={13} /> {table.coupon.label}</span><b>−{money(totals.discount)}</b></div>}
          <div className="bill-line"><span>GST <small>5%</small></span><b>{money(totals.gst)}</b></div>
          <div className="bill-total"><span>Grand total</span><b>{money(totals.total)}</b></div>
          {paymentPending ? <div className="payment-pending-state"><Clock3 size={17} /><div><b>Pending Manager Approval</b><span>Payment submitted via {payment.method}. A manager will confirm it shortly.</span></div></div> : paymentPaid ? <div className="paid-state"><Check size={16} /><div><b>Bill paid</b><span>Approved · Paid via {payment.method}</span></div></div> : (
            <>
              <span className="pay-hint">Choose how you’d like to wrap up.</span>
              {paymentBlockMessage && <p className="payment-block-message" role="status">{paymentBlockMessage}</p>}
              <button className="pay-option" disabled={!canPay} onClick={() => payBill(table.id, 'UPI')}><span>◈</span><div><b>Pay with UPI</b><small>GPay, PhonePe, Paytm</small></div><ArrowRight size={15} /></button>
              <button className="pay-option" disabled={!canPay} onClick={() => payBill(table.id, 'Card')}><span>▤</span><div><b>Credit / debit card</b><small>Secure card payment</small></div><ArrowRight size={15} /></button>
              <button className="pay-option" disabled={!canPay} onClick={() => payBill(table.id, 'Cash at counter')}><span>₹</span><div><b>Cash at the counter</b><small>We’ll see you there</small></div><ArrowRight size={15} /></button>
            </>
          )}
          <div className="bill-footnote"><Sparkles size={13} /> Keep playing for tasty rewards.</div>
        </aside>
      </div>
    </section>
  )
}

function GameZone({ table, tableId, customerId, initialInvite, onInviteAccepted }) {
  const [game, setGame] = useState(initialInvite?.game || '')
  const [mode, setMode] = useState(initialInvite ? 'multiplayer' : '')
  const players = table.customers.filter((player) => player.id !== customerId)
  const games = [
    { id: 'air-hockey', title: 'Air hockey', icon: '🏒', eyebrow: `FIRST TO ${gameSettings.hockey.goal}`, description: 'A quick table-top rally with a lively arcade puck.', className: 'hockey-card' },
    { id: 'burger-stacker', title: 'Burger stacker', icon: '🍔', eyebrow: `${gameSettings.stacker.durationSeconds} SEC`, description: 'Catch the falling fillings and build a taller burger.', className: 'stack-card' },
    { id: 'tic-tac-toe', title: 'Tic-Tac-Toe', icon: '⭕', eyebrow: 'THREE IN A ROW', description: 'A little strategy, a little luck. Best played between bites.', className: '' },
    { id: 'connect-four', title: 'Connect Four', icon: '🔴', eyebrow: 'DROP & CONNECT', description: 'Line up four counters before the other player does.', className: '' },
    { id: 'dots-and-boxes', title: 'Dots & Boxes', icon: '🟩', eyebrow: 'CLAIM THE MOST', description: 'Draw the last side of a box and keep the turn.', className: '' },
  ]

  useEffect(() => {
    if (initialInvite) {
      setGame(initialInvite.game)
      setMode('multiplayer')
    }
  }, [initialInvite?.code])

  return (
    <section className="page-section game-section">
      {!game ? <>
        <div className="page-title-row"><div><span className="eyebrow"><Zap size={13} /> A TURN AT THE TABLE</span><h1>Fancy a game?</h1><p>Choose a quick game and keep the score here on this device.</p></div><span className="game-online"><i /> TABLE #{tableId}</span></div>
        <div className="challenge-panel">
          <span className="challenge-icon">🕹️</span>
          <div><span className="eyebrow">ARCADE MODE</span><h3>Take a turn while you wait</h3><p>Play together on one phone or challenge another table with a live room code.</p></div>
          {players.length > 0 && <div className="opponent-list">{players.map((player) => <span className="opponent-pill" key={player.id}><i /> {player.name} at this table</span>)}</div>}
        </div>
        <div className="game-cards">
          {games.map((entry) => <article className={`game-card ${entry.className}`} key={entry.id}>
            <div className="game-card-art"><span>{entry.icon}</span><i>{entry.eyebrow}</i><b>{entry.title.toUpperCase()}</b></div>
            <div className="game-card-content"><span className="eyebrow">PASS & PLAY · LIVE ROOMS</span><h2>{entry.title}</h2><p>{entry.description}</p><div className="game-meta"><span><Zap size={13} /> Thumb-friendly</span><span><Sparkles size={13} /> Table match</span></div><button className="primary-button" onClick={() => setGame(entry.id)}>Choose this game <ArrowRight size={15} /></button></div>
          </article>)}
        </div>
      </> : !mode ? <div className="game-mode-panel">
        <button className="back-link" onClick={() => setGame('')}><ArrowLeft size={15} /> All games</button>
        <span className="eyebrow">BEFORE YOU PLAY</span><h2>Choose how to play</h2><p>Pick up the same device for a quick local match, or open a room for friends at this or another table.</p>
        <div className="game-mode-options">
          <button className="game-mode-option" onClick={() => setMode('pass')}><span>ONE DEVICE · NO SIGN-IN</span><b>Pass & Play</b><span>Take turns with the phone in hand. Rematch whenever you like.</span></button>
          <button className="game-mode-option" onClick={() => setMode('multiplayer')}><span>LIVE · SOCKET.IO ROOM</span><b>Multiplayer</b><span>Create a room or join a friend’s room code from another device.</span></button>
        </div>
      </div> : mode === 'pass' && ['tic-tac-toe', 'connect-four', 'dots-and-boxes'].includes(game)
        ? <PassPlayGame game={game} tableId={tableId} sessionId={table.sessionId} onBack={() => setMode('')} />
        : mode === 'pass'
          ? <GameCanvas game={game === 'air-hockey' ? 'hockey' : 'stacker'} tableId={tableId} sessionId={table.sessionId} passPlay onBack={() => setMode('')} />
          : <MultiplayerGame game={game} table={table} tableId={tableId} customerId={customerId} onBack={() => setMode('')} initialInvite={initialInvite} onInviteAccepted={onInviteAccepted} />}
    </section>
  )
}

function GameCanvas({ game, tableId, sessionId, onBack, passPlay = false, onlineSolo = false, onScoreComplete }) {
  const { awardCoupon } = useRestaurant()
  const [started, setStarted] = useState(false)
  const [score, setScore] = useState(0)
  const [opponentScore, setOpponentScore] = useState(0)
  const [timeLeft, setTimeLeft] = useState(gameSettings.stacker.durationSeconds)
  const [result, setResult] = useState('')
  const [playerTurn, setPlayerTurn] = useState(0)
  const [passScores, setPassScores] = useState([null, null])
  const [passReady, setPassReady] = useState(false)
  const canvasRef = useRef(null)
  const controls = useRef({ x: 180, opponentX: 180 })
  const keys = useRef({ left: false, right: false })
  const gameRef = useRef({ ballX: 180, ballY: 165, vx: 3.3, vy: 3.1, playerX: 180, opponentX: 180, score: 0, opponent: 0, ended: false, ingredients: [] })
  const isHockey = game === 'hockey'
  const soloRound = onlineSolo || (passPlay && isHockey)
  const rewardScore = gameSettings.stacker.rewardScore
  const targetScore = gameSettings.hockey.goal

  const finish = (playerWon, finalScore) => {
    if (gameRef.current.ended) return
    gameRef.current.ended = true
    if (onlineSolo && onScoreComplete) {
      setResult(`Round submitted: ${finalScore}. Waiting for the other table.`)
      setStarted(false)
      Promise.resolve(onScoreComplete(finalScore)).then((response) => {
        if (response?.error) setResult('')
      })
      return
    }
    if (passPlay) {
      if (playerTurn === 0) {
        setPassScores([finalScore, null])
        setPassReady(true)
        setStarted(false)
        setScore(finalScore)
        return
      }
      const finalScores = [passScores[0], finalScore]
      setPassScores(finalScores)
      const winner = finalScores[0] === finalScores[1] ? null : finalScores[0] > finalScores[1] ? 0 : 1
      const earnedReward = winner !== null && (isHockey || finalScores[winner] >= rewardScore)
      setResult(winner === null
        ? 'A close tie — play another round.'
        : earnedReward
          ? `Player ${winner + 1} wins ${isHockey ? 'the match' : 'the stack-off'}!`
          : `Player ${winner + 1} wins — reach ${rewardScore} ingredients for dessert off.`)
      if (earnedReward) awardCoupon(tableId, sessionId)
      return
    }
    setResult(playerWon ? 'You win! A little something sweet is on us.' : 'Nice rally! Give it another go.')
    if (playerWon) awardCoupon(tableId, sessionId)
    if (!isHockey && playerWon) setScore(finalScore)
  }

  useEffect(() => {
    if (!started || result) return undefined
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    const width = canvas.width
    const height = canvas.height
    let frame = 0
    let lastTime = performance.now()
    let animation
    const drawHockey = () => {
      const state = gameRef.current
      const dt = Math.min(2, (performance.now() - lastTime) / 16.67)
      lastTime = performance.now()
      context.clearRect(0, 0, width, height)
      context.fillStyle = '#eadcc6'
      context.fillRect(0, 0, width, height)
      context.strokeStyle = '#9b7a5240'
      context.setLineDash([6, 8])
      context.beginPath()
      context.moveTo(0, height / 2)
      context.lineTo(width, height / 2)
      context.stroke()
      context.setLineDash([])
      context.strokeStyle = '#b58e5a80'
      context.beginPath(); context.arc(width / 2, height / 2, 45, 0, Math.PI * 2); context.stroke()
      state.playerX = controls.current.x
      state.opponentX = controls.current.opponentX
      if (soloRound) {
        state.opponentX = Math.max(40, Math.min(width - 40, state.opponentX + Math.max(-4, Math.min(4, (state.ballX - state.opponentX) * 0.035)) * dt))
      } else {
        if (keys.current.left) state.opponentX = Math.max(40, state.opponentX - 5 * dt)
        if (keys.current.right) state.opponentX = Math.min(width - 40, state.opponentX + 5 * dt)
      }
      controls.current.opponentX = state.opponentX
      state.ballX += state.vx * dt
      state.ballY += state.vy * dt
      if (state.ballX < 12 || state.ballX > width - 12) state.vx *= -1
      const paddleY = height - 31
      if (state.ballY >= paddleY - 13 && state.ballY <= paddleY + 10 && Math.abs(state.ballX - state.playerX) < 42 && state.vy > 0) {
        state.vy = -Math.abs(state.vy) * 1.04
        state.vx += (state.ballX - state.playerX) * 0.075
      }
      if (state.ballY <= 30 && Math.abs(state.ballX - state.opponentX) < 43 && state.vy < 0) {
        state.vy = Math.abs(state.vy) * 1.02
        state.vx += (state.ballX - state.opponentX) * 0.04
      }
      if (state.ballY < -8) {
        state.score += 1; setScore(state.score)
        if (state.score >= targetScore) { finish(true, state.score); return }
        state.ballX = width / 2; state.ballY = height / 2; state.vy = 3.2
      }
      if (state.ballY > height + 8) {
        state.opponent += 1; setOpponentScore(state.opponent)
        if (state.opponent >= targetScore) { finish(false, state.score); return }
        state.ballX = width / 2; state.ballY = height / 2; state.vy = -3.2
      }
      context.fillStyle = '#557b4c'
      context.shadowColor = '#557b4c66'
      context.shadowBlur = 8
      context.beginPath(); context.roundRect(state.opponentX - 36, 15, 72, 12, 7); context.fill()
      context.fillStyle = '#bd5035'
      context.shadowColor = '#bd503566'
      context.beginPath(); context.roundRect(state.playerX - 36, height - 29, 72, 12, 7); context.fill()
      context.fillStyle = '#6f4a27'
      context.shadowColor = '#6f4a2755'
      context.beginPath(); context.arc(state.ballX, state.ballY, 8, 0, Math.PI * 2); context.fill()
      context.shadowBlur = 0
      frame += 1
      animation = requestAnimationFrame(drawHockey)
    }
    const drawStacker = () => {
      const state = gameRef.current
      context.clearRect(0, 0, width, height)
      context.fillStyle = '#f0e3d0'; context.fillRect(0, 0, width, height)
      context.fillStyle = '#d9c09f'; context.fillRect(0, height - 25, width, 25)
      if (frame % 42 === 0) state.ingredients.push({ x: 20 + Math.random() * (width - 40), y: -10, speed: 2 + Math.random() * 2, emoji: ['🧀', '🥬', '🍅', '🥓'][Math.floor(Math.random() * 4)] })
      state.ingredients = state.ingredients.filter((ingredient) => {
        ingredient.y += ingredient.speed
        context.font = '23px sans-serif'; context.fillText(ingredient.emoji, ingredient.x, ingredient.y)
        if (ingredient.y >= height - 65 && Math.abs(ingredient.x - controls.current.x) < 48) {
          state.score += 1; setScore(state.score); return false
        }
        return ingredient.y < height + 10
      })
      context.font = '40px sans-serif'; context.fillText('🍔', controls.current.x - 20, height - 20)
      context.font = '12px sans-serif'; context.fillStyle = '#806849'; context.textAlign = 'center'; context.fillText('CATCH THE INGREDIENTS', width / 2, 22); context.textAlign = 'left'
      frame += 1
      animation = requestAnimationFrame(drawStacker)
    }
    animation = requestAnimationFrame(isHockey ? drawHockey : drawStacker)
    return () => cancelAnimationFrame(animation)
  }, [started, result, isHockey, onlineSolo, soloRound, onScoreComplete, passPlay, playerTurn, passScores])

  useEffect(() => {
    if (!started || !isHockey) return undefined
    const handleKey = (event, pressed) => {
      const key = event.key.toLowerCase()
      if (key === 'a' || key === 'arrowleft') {
        keys.current.left = pressed
        event.preventDefault()
      }
      if (key === 'd' || key === 'arrowright') {
        keys.current.right = pressed
        event.preventDefault()
      }
    }
    const onKeyDown = (event) => handleKey(event, true)
    const onKeyUp = (event) => handleKey(event, false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      keys.current = { left: false, right: false }
    }
  }, [started, isHockey, onlineSolo])

  useEffect(() => {
    if (!started || isHockey || result) return undefined
    const timer = window.setInterval(() => setTimeLeft((remaining) => {
      if (remaining <= 1) {
        window.clearInterval(timer)
        const finalScore = gameRef.current.score
        finish(finalScore >= rewardScore, finalScore)
        return 0
      }
      return remaining - 1
    }), 1000)
    return () => window.clearInterval(timer)
  }, [started, isHockey, result, onlineSolo])

  const movePaddle = (event) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = Math.min(canvasRef.current.width - 40, Math.max(40, (event.clientX - rect.left) * canvasRef.current.width / rect.width))
    const y = (event.clientY - rect.top) * canvasRef.current.height / rect.height
    if (isHockey && !soloRound && y < canvasRef.current.height / 2) controls.current.opponentX = x
    else controls.current.x = x
  }

  const start = () => {
    gameRef.current = { ballX: 180, ballY: 165, vx: 3.3, vy: 3.1, playerX: 180, opponentX: 180, score: 0, opponent: 0, ended: false, ingredients: [] }
    controls.current.x = 180
    controls.current.opponentX = 180
    setScore(0); setOpponentScore(0); setTimeLeft(gameSettings.stacker.durationSeconds); setResult(''); setPassScores([null, null]); setPlayerTurn(0); setPassReady(false); setStarted(true)
  }

  const startSecondTurn = () => {
    gameRef.current = { ballX: 180, ballY: 165, vx: 3.3, vy: 3.1, playerX: 180, opponentX: 180, score: 0, opponent: 0, ended: false, ingredients: [] }
    controls.current.x = 180
    setScore(0)
    setTimeLeft(gameSettings.stacker.durationSeconds)
    setPlayerTurn(1)
    setPassReady(false)
    setStarted(true)
  }

  const earnedLocalReward = result.startsWith('You win') || result.includes('wins the stack-off')

  return (
    <div className="arcade-view">
      <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to games</button>
      <div className="arcade-heading"><div><span className="eyebrow">{onlineSolo ? 'LIVE TABLE DUEL · YOUR ROUND' : passPlay ? `PASS & PLAY · PLAYER ${playerTurn + 1} ROUND` : isHockey ? `LOCAL MATCH · FIRST TO ${targetScore}` : `STACK ATTACK · ${gameSettings.stacker.durationSeconds} SECOND ROUND`}</span><h1>{isHockey ? 'Air hockey, anyone?' : 'Build that burger!'}</h1></div><span className="arcade-opponent">{onlineSolo ? 'PLAY AGAINST THE OTHER TABLE' : passPlay && isHockey ? 'TAKE TURNS · ONE DEVICE' : isHockey ? 'TWO PLAYERS · ONE DEVICE' : `REWARD AT ${rewardScore} INGREDIENTS`}</span></div>
      {passPlay && <div className="multiplayer-scores"><span>Player 1 · {passScores[0] ?? (playerTurn === 0 ? score : '—')}</span><span>Player 2 · {passScores[1] ?? (playerTurn === 1 ? score : '—')}</span>{!isHockey && <span>{timeLeft}s left</span>}</div>}
      {!passPlay && !onlineSolo && <div className="arcade-scoreboard"><span>PLAYER 1 <b>{score}</b></span>{isHockey ? <span>PLAYER 2 <b>{opponentScore}</b></span> : <span>TIME <b>{timeLeft}s</b></span>}</div>}
      {onlineSolo && <div className="arcade-scoreboard"><span>YOU <b>{score}</b></span>{isHockey ? <span>BOT <b>{opponentScore}</b></span> : <span>TIME <b>{timeLeft}s</b></span>}</div>}
      {onlineSolo && <div className="multiplayer-turn">Your turn — play a round, then the other table takes theirs.</div>}
      <div className="canvas-wrap">
        <canvas ref={canvasRef} width="360" height="420" onPointerMove={movePaddle} aria-label={isHockey ? 'Air hockey. Move the lower paddle by touch; in same-device play move in the upper half to control the other paddle.' : 'Burger stacker game. Move your pointer to catch ingredients.'} />
        {!started && !passReady && !result && <div className="game-overlay"><span>{isHockey ? '🏒' : '🍔'}</span><b>{isHockey ? 'Ready for a match?' : passPlay ? `Ready, Player ${playerTurn + 1}?` : 'Ready to stack?'}</b><p>{isHockey ? onlineSolo || passPlay ? 'Move your paddle to beat the table-side bot. The other guest gets the same turn next.' : 'Move the lower paddle by touch. Player 2 can use the upper half or A / D keys.' : `Catch ingredients and reach ${rewardScore} points before the timer ends.`}</p><button className="primary-button" onClick={start}>{isHockey ? 'Start match' : 'Start 60-second round'} <ArrowRight size={15} /></button></div>}
        {passReady && <div className="game-overlay"><span>📱</span><b>Pass the phone to Player 2</b><p>Player 1 scored {passScores[0]} {isHockey ? 'goals' : 'ingredients'}. Ready for your turn?</p><button className="primary-button" onClick={startSecondTurn}>Player 2, take your turn <ArrowRight size={15} /></button></div>}
        {result && <div className="game-overlay result-overlay"><span>{result.includes('wins') || result.startsWith('You win') ? '🏆' : '🍔'}</span><b>{result}</b>{earnedLocalReward && <div className="reward-tag"><Sparkles size={14} /> 5% off dessert added to your bill!</div>}<button className="primary-button" onClick={onlineSolo ? onBack : start}>{onlineSolo ? 'Back to games' : 'Play again'} <ArrowRight size={15} /></button></div>}
      </div>
      <p className="game-tip"><CircleHelp size={14} /> {isHockey ? soloRound ? 'Move the lower paddle with touch or mouse. Each guest gets one turn against the bot.' : 'Touch the lower half for Player 1 and upper half for Player 2; keyboard controls work too.' : 'Move your bun left and right to catch the falling ingredients.'}</p>
    </div>
  )
}

function MultiplayerGame({ game, table, tableId, customerId, onBack, initialInvite, onInviteAccepted }) {
  const { tables, awardCoupon } = useRestaurant()
  const [socket, setSocket] = useState(null)
  const [connected, setConnected] = useState(false)
  const [connectionCount, setConnectionCount] = useState(0)
  const [roomState, setRoomState] = useState(null)
  const [joinCode, setJoinCode] = useState('')
  const [targetTable, setTargetTable] = useState('')
  const [invite, setInvite] = useState(null)
  const [error, setError] = useState('')
  const rewardSent = useRef(false)
  const customer = table.customers.find((entry) => entry.id === customerId)
  const otherTables = tables.filter((entry) => entry.id !== tableId && entry.customers.length > 0)
  const myIndex = roomState?.players?.findIndex((player) => String(player.customerId) === String(customerId)) ?? -1
  const myTurn = roomState?.status === 'active' && roomState.currentTurn === myIndex
  const displayName = game === 'air-hockey' ? 'hockey' : game === 'burger-stacker' ? 'stacker' : game
  const winnerEarnedReward = roomState?.winner === myIndex
    && (game !== 'burger-stacker' || Number(roomState.scores?.[myIndex]) >= gameSettings.stacker.rewardScore)

  useEffect(() => {
    const liveSocket = api.connectLiveUpdates()
    setSocket(liveSocket)
    const onConnect = () => {
      setConnected(true)
      setConnectionCount((count) => count + 1)
      liveSocket.emit('game:table:join', {
        tableNumber: Number(tableId),
        sessionId: table.sessionId,
        customerId,
      }, (response) => {
        if (response?.error) setError(response.error)
      })
    }
    const onDisconnect = () => setConnected(false)
    const onState = (nextState) => {
      setRoomState(nextState)
      setError('')
    }
    const onError = (payload) => setError(payload?.message || 'The game room could not be updated.')
    const onInvite = (payload) => setInvite(payload)
    liveSocket.on('connect', onConnect)
    liveSocket.on('disconnect', onDisconnect)
    liveSocket.on('game:state', onState)
    liveSocket.on('game:error', onError)
    liveSocket.on('game:invite', onInvite)
    if (liveSocket.connected) onConnect()
    return () => {
      liveSocket.off('connect', onConnect)
      liveSocket.off('disconnect', onDisconnect)
      liveSocket.off('game:state', onState)
      liveSocket.off('game:error', onError)
      liveSocket.off('game:invite', onInvite)
      liveSocket.disconnect()
    }
  }, [tableId, table.sessionId, customerId])

  useEffect(() => {
    if (roomState?.status === 'active') rewardSent.current = false
    if (roomState?.status === 'finished' && winnerEarnedReward && !rewardSent.current) {
      rewardSent.current = true
      awardCoupon(tableId, table.sessionId)
    }
  }, [roomState, myIndex, winnerEarnedReward, awardCoupon, tableId, table.sessionId])

  const handleResponse = (response) => {
    if (!response || response.error) {
      setError(response?.error || 'The game room could not be reached. Please try again.')
      return
    }
    if (response.state) setRoomState(response.state)
    setError('')
  }

  const createRoom = () => {
    if (!socket?.connected || !customer) return
    socket.emit('game:create', {
      game,
      tableNumber: Number(tableId),
      sessionId: table.sessionId,
      customerId,
      customerName: customer.name,
      targetTableNumber: targetTable ? Number(targetTable) : null,
    }, handleResponse)
  }

  const joinRoom = (code = joinCode, afterJoin) => {
    if (!socket?.connected || !customer || !code.trim()) return
    socket.emit('game:join', {
      game,
      code: code.trim().toUpperCase(),
      tableNumber: Number(tableId),
      sessionId: table.sessionId,
      customerId,
      customerName: customer.name,
    }, (response) => {
      handleResponse(response)
      if (!response?.error) afterJoin?.()
    })
    setInvite(null)
  }

  useEffect(() => {
    if (connected && initialInvite?.code && socket && !roomState) {
      joinRoom(initialInvite.code, onInviteAccepted)
    }
  }, [connected, initialInvite?.code, socket])

  useEffect(() => {
    if (connectionCount > 1 && roomState?.code && connected && socket) {
      joinRoom(roomState.code)
    }
  }, [connectionCount, connected, roomState?.code, socket])

  const sendMove = (move) => {
    if (!socket || !roomState || !myTurn) return Promise.resolve({ error: 'It is not your turn.' })
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve({ error: 'The game server did not respond. Please reconnect and try again.' }), 5000)
      socket.emit('game:move', { code: roomState.code, customerId, move }, (response) => {
        window.clearTimeout(timeout)
        handleResponse(response)
        resolve(response)
      })
    })
  }

  const requestRematch = () => {
    if (socket && roomState) socket.emit('game:rematch', { code: roomState.code, customerId }, handleResponse)
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomState.code)
      setError('Room code copied. Send it to the other guest.')
    } catch {
      setError('Room code: ' + roomState.code)
    }
  }

  const isScoreDuel = game === 'air-hockey' || game === 'burger-stacker'
  const canPlayRound = isScoreDuel && myTurn && roomState?.scores?.[myIndex] === null

  return <div className="arcade-view">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to game modes</button>
    {!roomState ? <div className="multiplayer-panel">
      <span className="eyebrow">MULTIPLAYER · {game.replaceAll('-', ' ').toUpperCase()}</span>
      <h2>Play across tables</h2>
      <p className="multiplayer-status">{connected ? 'Connected to the live game service.' : 'Connecting to the live game service…'} Use a room code to invite a guest, or challenge an occupied table.</p>
      {invite && <div className="multiplayer-invite"><span>Table #{invite.fromTable} has invited you to a match.</span><button className="primary-button" onClick={() => joinRoom(invite.code)}>Accept invite</button></div>}
      <div className="multiplayer-controls">
        <select aria-label="Challenge a table" value={targetTable} onChange={(event) => setTargetTable(event.target.value)}>
          <option value="">Choose a table to invite (optional)</option>
          {otherTables.map((entry) => <option key={entry.id} value={entry.id}>Table #{entry.id} · {entry.customers.map((guest) => guest.name).join(', ')}</option>)}
        </select>
        <button className="primary-button" onClick={createRoom} disabled={!connected}>Create a room</button>
      </div>
      <div className="multiplayer-controls" style={{ marginTop: 10 }}>
        <input aria-label="Room code" maxLength={8} placeholder="Enter room code" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} />
        <button className="secondary-button" onClick={() => joinRoom()} disabled={!connected || !joinCode.trim()}>Join room</button>
      </div>
      {error && <p className="qr-message qr-error" role="status">{error}</p>}
    </div> : <div className="multiplayer-panel">
      <div className="multiplayer-invite"><b>Room {roomState.code}</b><button className="secondary-button" onClick={copyCode}>Copy code</button></div>
      <div className="multiplayer-scores">{roomState.players.map((player, index) => <span key={player.customerId}>Player {index + 1}: {player.name} · Table #{String(player.tableNumber).padStart(2, '0')} {player.connected ? '· online' : '· reconnecting'}</span>)}</div>
      {roomState.status === 'waiting' && <div className="multiplayer-turn">Waiting for another guest to join. Share the room code or invite an active table.</div>}
      {roomState.status === 'active' && !isScoreDuel && <div className="multiplayer-turn">{myTurn ? 'Your turn — make a move.' : `Waiting for ${roomState.players[roomState.currentTurn]?.name || 'the other player'}…`}</div>}
      {roomState.status === 'active' && isScoreDuel && <div className="multiplayer-turn">{myTurn ? 'Your turn — complete a round and send your score.' : `Waiting for ${roomState.players[roomState.currentTurn]?.name || 'the other player'} to finish their round.`}</div>}
      {roomState.status === 'active' && !isScoreDuel && <GameBoard game={game} state={roomState} onMove={sendMove} disabled={!myTurn} />}
      {canPlayRound && <GameCanvas game={displayName} tableId={tableId} sessionId={table.sessionId} onBack={onBack} onlineSolo onScoreComplete={(score) => sendMove({ score })} />}
      {roomState.status === 'active' && isScoreDuel && <div className="multiplayer-scores">{roomState.players.map((player, index) => <span key={player.customerId}>{player.name}’s score: {roomState.scores[index] === null ? '—' : roomState.scores[index]}</span>)}</div>}
      {roomState.status === 'finished' && <div className="multiplayer-result" role="status">{roomState.winner === null ? 'A close tie — rematch?' : roomState.winner === myIndex ? winnerEarnedReward ? 'You win! 5% off dessert is on us.' : 'You win this round!' : `${roomState.players[roomState.winner]?.name || 'Your opponent'} wins this round.`}</div>}
      {roomState.status === 'finished' && <button className="primary-button" onClick={requestRematch}><Sparkles size={15} /> Request a rematch</button>}
      {roomState.rematchRequested && <p className="multiplayer-status">A rematch is waiting for the other player to agree.</p>}
      {error && <p className="qr-message qr-error" role="status">{error}</p>}
    </div>}
  </div>
}

function TableQrModal({ onClose }) {
  const [baseUrl, setBaseUrl] = useState(window.location.origin)
  const [cards, setCards] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    const makeCards = async () => {
      try {
        const links = createTableQrLinks(baseUrl)
        const nextCards = await Promise.all(links.map(async ({ table, link }) => {
          return {
            table,
            link,
            image: await QRCode.toDataURL(link, {
              width: 420,
              margin: 2,
              errorCorrectionLevel: 'H',
              color: { dark: '#1C1917', light: '#FFFFFF' },
            }),
          }
        }))
        if (active) {
          setCards(nextCards)
          setError('')
          setNotice('')
        }
      } catch (generationError) {
        if (active) {
          setCards([])
          setError(generationError.message || 'Could not generate these table QR codes.')
        }
      }
    }
    makeCards()
    return () => { active = false }
  }, [baseUrl])

  useEffect(() => {
    const afterPrint = () => document.body.classList.remove('printing-table-qrs')
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('afterprint', afterPrint)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.classList.remove('printing-table-qrs')
      window.removeEventListener('afterprint', afterPrint)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const copyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link)
      setNotice('Table link copied.')
      setError('')
    } catch {
      setNotice('')
      setError('Clipboard access is unavailable. Select and copy the link instead.')
    }
  }

  const downloadPng = (card) => {
    const anchor = document.createElement('a')
    anchor.href = card.image
    anchor.download = `dineplay-table-${card.table}.png`
    anchor.click()
  }

  const printAll = () => {
    document.body.classList.add('printing-table-qrs')
    window.requestAnimationFrame(() => window.print())
  }

  return (
    <div className="modal-backdrop qr-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-modal-title">
        <div className="modal-top">
          <div><span className="eyebrow">READY FOR THE DINING ROOM</span><h2 id="qr-modal-title">Table QR codes</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close QR code window"><X size={19} /></button>
        </div>
        <label className="qr-base-label" htmlFor="qr-base-url">Public app base URL</label>
        <div className="qr-base-row"><input id="qr-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://your-public-app.example" /><button className="secondary-button" onClick={printAll} disabled={!cards.length}><QrCode size={15} /> Print all tent cards</button></div>
        <p className="qr-help">Use your hosted app URL or a public tunnel address. Each code opens its table’s guest entry screen.</p>
        {error && <p className="qr-message qr-error" role="alert">{error}</p>}
        {notice && <p className="qr-message" role="status">{notice}</p>}
        <div className="qr-card-grid qr-printable">
          {cards.map((card) => <article className="qr-table-card" key={card.table}>
            <span className="qr-table-label">DINEPLAY · TABLE</span>
            <h3>#{card.table}</h3>
            <img src={card.image} alt={`QR code for DinePlay Table ${card.table}`} />
            <p>Scan to see the menu & order</p>
            <code>{card.link}</code>
            <div className="qr-card-actions">
              <button onClick={() => copyLink(card.link)}>Copy link</button>
              <button onClick={() => downloadPng(card)}>Download PNG</button>
            </div>
          </article>)}
        </div>
      </div>
    </div>
  )
}

function AdminView({ onInspect, now, staffSession, onLock, menu }) {
  const { tables, updateOrderStatus, resolveCall, approvePayment } = useRestaurant()
  const [tab, setTab] = useState('floor')
  const [showQrCodes, setShowQrCodes] = useState(false)
  const allOrders = tables.flatMap((table) => table.orders.map((order) => ({ ...order, tableId: table.id }))).sort((a, b) => a.createdAt - b.createdAt)
  const queue = allOrders.filter((order) => order.status !== 'Confirmed Served')
  const calls = tables.flatMap((table) => activeCalls(table).map((call) => ({ ...call, tableId: table.id })))
  const nextStatus = { Received: 'Preparing', Preparing: 'Prepared' }
  const openCalls = calls.length
  const special = getTodaysSpecial(menu, new Date(now))

  return (
    <main className="admin-layout">
      <header className="admin-topbar"><div className="brand"><span className="brand-mark">D<span>·</span></span><span>Dine<span>Play</span></span><i className="admin-label">STAFF CONSOLE</i></div><div className="admin-top-right"><span className="live-badge"><i /> RESTAURANT API</span><button className="table-qr-trigger" onClick={() => setShowQrCodes(true)}><QrCode size={15} /><span>Table QR codes</span></button><span className="staff-avatar">{staffSession?.staff?.fullName?.charAt(0)?.toUpperCase() || 'S'}</span><span>{staffSession?.staff?.fullName || staffSession?.staff?.role || 'Staff'}</span><button className="lock-staff-button" onClick={onLock}><LogOut size={14} /> Lock staff view</button></div></header>
      <div className="admin-wrap">
        <div className="admin-welcome"><div><span className="eyebrow">{staffSession?.staff?.role?.toUpperCase() || 'STAFF'} · RESTAURANT CONSOLE</span><h1>Welcome, {staffSession?.staff?.fullName?.split(' ')[0] || 'team'}.</h1><p>Restaurant service data updates in real time.</p></div><div className="admin-date"><span>LOCAL TIME</span><b>{new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</b></div></div>
        {special && <div className="admin-today-special"><span>TODAY’S SPECIAL <i /> {formatSpecialDate(new Date(now))}</span><b>{special.emoji} {special.name}</b><strong>{money(special.price)}</strong></div>}
        <div className="stat-grid">
          <StatCard label="TABLES IN SERVICE" value={`${tables.filter((table) => table.customers.length || table.orders.length).length}/10`} icon={<Utensils size={16} />} tone="stat-amber" detail="Tables with activity" />
          <StatCard label="ACTIVE ORDERS" value={queue.length} icon={<ChefHat size={16} />} tone="stat-blue" detail="In the kitchen queue" />
          <StatCard label="WAITER CALLS" value={openCalls} icon={<Bell size={16} />} tone={openCalls ? 'stat-red' : 'stat-mint'} detail={openCalls ? 'Needs your attention' : 'All caught up'} />
          <StatCard label="TODAY'S REVENUE" value={money(tables.filter((table) => table.payment?.status === 'Paid').reduce((sum, table) => sum + getTableTotal(table).total, 0))} icon={<Sparkles size={16} />} tone="stat-purple" detail="Manager-approved tables" />
        </div>
        <div className="admin-tabs">
          <button className={tab === 'floor' ? 'active' : ''} onClick={() => setTab('floor')}><MapPin size={15} /> Floor map <span>10</span></button>
          <button className={tab === 'kitchen' ? 'active' : ''} onClick={() => setTab('kitchen')}><ChefHat size={15} /> Kitchen queue <span>{queue.length}</span></button>
          <button className={tab === 'calls' ? 'active' : ''} onClick={() => setTab('calls')}><Bell size={15} /> Waiter calls <span>{openCalls}</span></button>
        </div>
        {tab === 'floor' && <section className="admin-section"><div className="admin-section-heading"><div><span className="eyebrow">THE RESTAURANT</span><h2>Live floor map</h2><p>Tap any table to see the full picture.</p></div><div className="floor-legend"><span><i className="legend-green" /> Available</span><span><i className="legend-blue" /> Occupied</span><span><i className="legend-amber" /> Order active</span><span><i className="legend-red" /> Calling</span></div></div>
          <div className="floor-grid">{tables.map((table) => {
            const calls = activeCalls(table)
            const pendingOrders = activeOrders(table)
            const isOccupied = table.customers.length > 0 || table.orders.length > 0 || table.cart.length > 0
            const tone = calls.length ? 'calling' : pendingOrders.length ? 'order-active' : isOccupied ? 'occupied' : 'available'
            const total = getTableTotal(table).total
            return <div className={`floor-card ${tone}`} key={table.id} role="button" tabIndex={0} onClick={() => onInspect(table.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onInspect(table.id) } }}>
              <div className="floor-card-top"><b>Table #{table.id}</b><span className="floor-dot" /></div>
              <span className="floor-status">{calls.length ? 'CALLING WAITER' : pendingOrders.length ? 'ORDER ACTIVE' : isOccupied ? 'OCCUPIED' : 'AVAILABLE'}</span>
              {table.payment?.status === 'Pending Manager Approval' && <span className="payment-approval-badge">PAYMENT PENDING APPROVAL</span>}
              {table.payment?.status === 'Pending Manager Approval' && (staffSession?.staff?.role === 'Manager'
                ? <button className="approve-payment-button floor-approve-payment" onClick={(event) => { event.stopPropagation(); approvePayment(table.id, staffSession?.token) }}><Check size={12} /> Approve payment</button>
                : <small className="manager-approval-note floor-approval-note">Manager approval required</small>)}
              {calls.length ? <div className="floor-call"><Bell size={13} /><b>{calls[0].reason}</b><small>{calls[0].customerName} · {timeAgo(calls[0].createdAt, now)}</small><button onClick={(event) => { event.stopPropagation(); resolveCall(table.id, calls[0].id, staffSession?.token) }}><Check size={11} /> Mark resolved</button></div> : isOccupied ? <div className="floor-guest"><span className="mini-avatars">{table.customers.slice(0, 3).map((guest) => <i key={guest.id}>{guest.name[0]}</i>)}</span><b>{table.customers.map((guest) => guest.name).join(', ') || 'Kitchen order'}</b><span className="floor-total">{money(total)}</span></div> : <div className="available-copy"><span>Available</span></div>}
              <div className="floor-card-bottom"><span>{pendingOrders.length ? `${pendingOrders.length} order${pendingOrders.length === 1 ? '' : 's'} · ${timeAgo(pendingOrders[0].createdAt, now)}` : isOccupied ? `${table.customers.length} guest${table.customers.length === 1 ? '' : 's'} at table` : 'Tap to open table'}</span><ArrowRight size={14} /></div>
            </div>
          })}</div>
        </section>}
        {tab === 'kitchen' && <section className="admin-section"><div className="admin-section-heading"><div><span className="eyebrow">TICKETS, NOT TAKEOUT</span><h2>Kitchen queue</h2><p>Current kitchen orders.</p></div><span className="queue-live"><i /> LIVE</span></div>{queue.length ? <div className="kitchen-list">{queue.map((order) => (
          <article className="kitchen-card" key={order.id}><div className="kitchen-card-heading"><div><span className="kitchen-table">TABLE #{order.tableId}</span><h3>{order.customerName}</h3><span>{timeAgo(order.createdAt, now)}</span></div><span className={`status-badge ${orderStatusClass(order.status)}`}>{orderStatusLabel(order.status)}</span></div><div className="kitchen-items">{order.items.map((item, index) => <div key={`${item.id}-${index}`}><span>{item.quantity}× {item.name}</span>{item.note && <small>“{item.note}”</small>}</div>)}</div>{order.instructions && <div className="kitchen-note">Kitchen note: {order.instructions}</div>}{nextStatus[order.status] ? <button className="primary-button" onClick={() => updateOrderStatus(order.tableId, order.id, nextStatus[order.status], staffSession?.token)}>{order.status === 'Received' ? <><ChefHat size={15} /> Start preparing</> : <><Check size={15} /> Mark prepared / ready</>} <ArrowRight size={14} /></button> : <p className="kitchen-waiting-confirmation">Waiting for the customer to confirm the dish was served.</p>}</article>
        ))}</div> : <div className="empty-state"><span>🍳</span><b>Kitchen is all caught up</b><p>New orders will show up here as soon as guests place them.</p></div>}</section>}
        {tab === 'calls' && <section className="admin-section"><div className="admin-section-heading"><div><span className="eyebrow">GUEST REQUESTS</span><h2>Waiter calls</h2><p>Current guest requests.</p></div></div>{calls.length ? <div className="calls-list">{calls.map((call) => <article className="call-card" key={call.id}><span className="call-icon"><Bell size={18} /></span><div><span className="kitchen-table">TABLE #{call.tableId}</span><h3>{call.reason}</h3><p>{call.customerName} · {timeAgo(call.createdAt, now)}</p></div><button className="resolve-button" onClick={() => resolveCall(call.tableId, call.id, staffSession?.token)}><Check size={14} /> Mark resolved</button></article>)}</div> : <div className="empty-state"><span>🔔</span><b>No active waiter calls</b><p>Guest requests will appear here.</p></div>}</section>}
      </div>
      {showQrCodes && <TableQrModal onClose={() => setShowQrCodes(false)} />}
    </main>
  )
}

function StatCard({ label, value, icon, tone, detail }) {
  return <div className={`stat-card ${tone}`}><div className="stat-top"><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></div>
}

function TableDetails({ table, token, staffRole, menu, onClose }) {
  const { resetTable, addAdminItem, updateOrderStatus, approvePayment } = useRestaurant()
  const [itemId, setItemId] = useState(menu[0]?.id || '')
  useEffect(() => {
    if (menu.length && !menu.some((item) => item.id === itemId)) setItemId(menu[0].id)
  }, [menu, itemId])
  if (!table) return null
  const totals = getTableTotal(table)
  const items = table.orders.flatMap((order) => order.items.map((item) => ({ ...item, orderStatus: order.status, orderId: order.id })))
  const nextStatus = { Received: 'Preparing', Preparing: 'Prepared' }
  const closeTable = async () => {
    if (window.confirm(`Close and reset Table #${table.id}? This clears its current guests, orders, and bill.`)) {
      const closed = await resetTable(table.id, token)
      if (closed) onClose()
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="table-detail-modal" role="dialog" aria-modal="true" aria-labelledby="table-detail-title">
        <div className="modal-top"><div><span className="eyebrow">STAFF TABLE VIEW</span><h2 id="table-detail-title">Table #{table.id}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        <div className="detail-guests"><span className="eyebrow">GUESTS</span><p>{table.customers.length ? table.customers.map((guest) => `${guest.name}${guest.phone ? ` · ${guest.phone}` : ''}`).join(', ') : 'No active guests'}</p></div>
        <div className="detail-items"><span className="eyebrow">ITEMIZED ORDERS</span>{items.length ? items.map((item, index) => <div className="detail-item" key={`${item.orderId}-${index}`}><span>{item.quantity}× {item.name}<small>{item.note || item.orderStatus}</small></span><b>{money(item.price * item.quantity)}</b></div>) : <p className="detail-empty">No items ordered yet.</p>}</div>
        <div className="admin-add-item"><label className="eyebrow" htmlFor="admin-add-select">ADD AN ITEM</label><div><select id="admin-add-select" value={itemId} onChange={(event) => setItemId(event.target.value)}>{menu.map((item) => <option key={item.id} value={item.id}>{item.name} · {money(item.price)}</option>)}</select><button disabled={!menu.length} onClick={() => { const item = menu.find((entry) => entry.id === itemId); if (item) addAdminItem(table.id, item, token) }}><Plus size={14} /> Add</button></div></div>
        <div className="detail-total"><span>Live total <small>incl. GST</small></span><b>{money(totals.total)}</b></div>
        <div className="payment-status">
          <span>PAYMENT</span>
          <b className={table.payment?.status === 'Paid' ? 'paid-label' : ''}>{table.payment?.status === 'Paid' ? `Paid via ${table.payment.method}` : table.payment?.status || 'Unpaid'}</b>
          {table.payment?.status === 'Pending Manager Approval' && (staffRole === 'Manager'
            ? <button className="approve-payment-button" onClick={() => approvePayment(table.id, token)}><Check size={13} /> Approve payment</button>
            : <small className="manager-approval-note">Manager approval required. Ask a Manager to approve this payment.</small>)}
        </div>
        {table.orders.some((order) => order.status !== 'Confirmed Served') && <div className="detail-status-actions"><span className="eyebrow">ORDER STATUS</span>{table.orders.filter((order) => order.status !== 'Confirmed Served').map((order) => nextStatus[order.status] ? <button key={order.id} onClick={() => updateOrderStatus(table.id, order.id, nextStatus[order.status], token)}>Move {order.customerName}’s order to {nextStatus[order.status]} <ArrowRight size={13} /></button> : <small className="manager-approval-note">{orderStatusLabel(order.status)}</small>)}</div>}
        {table.payment?.status === 'Pending Manager Approval' && <small className="manager-approval-note">Approve this payment before closing the table.</small>}
        <button className="reset-table-button" disabled={table.payment?.status === 'Pending Manager Approval'} onClick={closeTable}><X size={15} /> Close & reset table</button>
      </div>
    </div>
  )
}

function WelcomeModal({ tableId, onJoin, onTableChange, embedded = false }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const validate = () => {
    const errors = {
      name: validateGuestName(name),
      phone: validateGuestPhone(phone),
    }
    setFieldErrors(errors)
    return !Object.values(errors).some(Boolean)
  }
  const updateName = (value) => {
    setName(value)
    setFieldErrors((current) => current.name ? { ...current, name: '' } : current)
  }
  const updatePhone = (value) => {
    setPhone(value)
    setFieldErrors((current) => current.phone ? { ...current, phone: '' } : current)
  }
  const submit = (event) => {
    event.preventDefault()
    if (!validate()) return
    onJoin(name, phone)
  }
  const skipPhone = () => {
    if (validateGuestName(name)) {
      setFieldErrors((current) => ({ ...current, name: validateGuestName(name) }))
      return
    }
    onJoin(name, '')
  }
  return (
    <div className={embedded ? 'welcome-embedded' : 'modal-backdrop'}>
      <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <div className="welcome-mark"><span>🍽️</span><i>✦</i></div>
        <span className="eyebrow">WELCOME TO THE TABLE</span>
        <h2 id="welcome-title">Welcome to<br /><span>Table #{tableId}.</span></h2>
        <p>Add a name for your order. No account is needed; your phone number is optional.</p>
        <form onSubmit={submit}>
          <label htmlFor="guest-name">What should we call you?</label><input id="guest-name" autoFocus placeholder="Your name or nickname" maxLength={24} value={name} aria-invalid={Boolean(fieldErrors.name)} aria-describedby="guest-name-error" onBlur={() => setFieldErrors((current) => ({ ...current, name: validateGuestName(name) }))} onChange={(event) => updateName(event.target.value)} />
          {fieldErrors.name && <small className="field-error" id="guest-name-error">{fieldErrors.name}</small>}
          <label htmlFor="guest-phone">Phone number <span>OPTIONAL</span></label><input id="guest-phone" inputMode="tel" placeholder="+91 98765 43210" maxLength={16} value={phone} aria-invalid={Boolean(fieldErrors.phone)} aria-describedby="guest-phone-error" onBlur={() => setFieldErrors((current) => ({ ...current, phone: validateGuestPhone(phone) }))} onChange={(event) => updatePhone(event.target.value)} />
          {fieldErrors.phone && <small className="field-error" id="guest-phone-error">{fieldErrors.phone}</small>}
          <button className="skip-phone" type="button" aria-label="Skip phone number" onClick={skipPhone}>Skip phone number</button>
          <button className="primary-button welcome-submit" type="submit">Let’s get comfy <ArrowRight size={16} /></button>
        </form>
        <div className="welcome-table-switch">Not at this table? <select aria-label="Change table" value={tableId} onChange={(event) => onTableChange(event.target.value)}>{Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(2, '0')).map((id) => <option key={id} value={id}>Table #{id}</option>)}</select></div>
        <span className="welcome-footnote"><Heart size={12} fill="currentColor" /> Good food, good company.</span>
      </div>
    </div>
  )
}

function WaiterModal({ table, customer, cooldown, confirmation, setConfirmation, onClose }) {
  const { callWaiter } = useRestaurant()
  const [calling, setCalling] = useState(false)
  const reasons = ['Water / Cutlery', 'Need Assistance', 'Clean Table', 'Request Bill']
  const notify = async (reason) => {
    if (cooldown > 0 || calling) return
    setCalling(true)
    try {
      const call = await callWaiter(table.id, customer, reason)
      if (call) setConfirmation(reason)
    } finally {
      setCalling(false)
    }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="waiter-modal" role="dialog" aria-modal="true" aria-labelledby="waiter-title">
    <div className="modal-top"><div><span className="eyebrow">HERE FOR YOU</span><h2 id="waiter-title">Need a hand?</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
    {confirmation ? <div className="notified-state"><span><Check size={24} /></span><h3>Waiter notified!</h3><p>We’ve sent your “{confirmation}” request. Someone will be with you shortly.</p><div className="cooldown-note"><Clock3 size={14} /> You can call again in {formatCooldown(cooldown)}.</div><button className="secondary-button" onClick={onClose}>Sounds good</button></div> : <>
      <p className="waiter-intro">What can we help with at Table #{table.id}?</p>
      <div className="reason-grid">{reasons.map((reason, index) => <button key={reason} onClick={() => notify(reason)} disabled={cooldown > 0 || calling}><span>{['💧', '🙋', '🧹', '🧾'][index]}</span>{reason}<ArrowRight size={14} /></button>)}</div>
      {cooldown > 0 && <div className="cooldown-note"><Clock3 size={14} /> Another request can be sent in {formatCooldown(cooldown)}.</div>}
    </>}
  </div></div>
}

function ViewSwitcher({ mode, setMode }) {
  return <div className="view-switcher"><span>VIEW AS</span><button className={mode === 'customer' ? 'active' : ''} onClick={() => setMode('customer')}><Utensils size={13} /> Guest</button><button className={mode !== 'customer' ? 'active' : ''} onClick={() => setMode('admin')}><Coffee size={13} /> Staff</button></div>
}

function timeAgo(timestamp, now) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'Just now'
  return `${minutes} min${minutes === 1 ? '' : 's'} ago`
}

export default App
