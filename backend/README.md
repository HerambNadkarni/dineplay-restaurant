# DinePlay backend

Express + MariaDB API for the DinePlay React application. It persists menu,
table sessions, guest carts, orders, staff accounts, and waiter calls in MySQL
and broadcasts changes with Socket.IO.

## Requirements

- Node.js 20 or newer
- XAMPP MariaDB/MySQL running on `127.0.0.1:3306`
- The `dineplay` database (the schema also creates it if it does not exist)

## First-time setup

From this `backend` folder:

1. Install backend packages:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. The defaults match a local XAMPP install:

   ```env
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=dineplay
   PORT=5000
   JWT_SECRET=replace_with_a_long_random_secret
   FRONTEND_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
   STAFF_SIGNUP_PASSCODE=
   ```

   Replace `JWT_SECRET` with a long random secret outside local development.
   `STAFF_SIGNUP_PASSCODE` is optional; when configured, signup requires the
   matching passcode.

3. In phpMyAdmin, select **Import** and import `sql/schema.sql`. The additive
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` updates are safe to re-run and
   preserve existing tables and records. They add prepared/confirmation and
   payment-approval fields, and migrate legacy `Served` orders to
   `Confirmed Served`. The script also creates the supporting `session_guests`,
   `cart_items`, `order_details`, `waiter_calls`, and `session_payment_meta`
   tables needed for the current multi-customer UI.

4. Seed 200 menu dishes across the 10 menu categories and Tables 1–20:

   ```sh
   npm run seed
   ```

   The seed combines the 110 frontend dishes with 90 additional dishes in
   `seed/additionalDishes.js`. It upserts menu rows by their unique name and
   tables by `table_number`, so it is safe to rerun and refreshes the seeded
   menu fields without resetting table status or existing service sessions.

5. Start the API and Socket.IO server:

   ```sh
   npm run dev
   ```

   Check `http://localhost:5000/api/health`.

## Start the frontend

From the project root (a separate terminal):

```sh
npm install
```

Copy the root `.env.example` to `.env` if needed. The frontend accepts a backend
origin or an `/api` URL; it adds `/api` when needed. `VITE_SOCKET_URL` should be
the Socket.IO server origin. Start Vite:

```sh
npm run dev
```

Open the Vite URL with a table query, for example
`http://localhost:5173/?table=04`.

For phone testing on the same Wi-Fi, set `VITE_API_URL` and `VITE_SOCKET_URL`
to the computer's LAN address (for example `http://192.168.1.20:5000`), allow
the frontend origin through the backend firewall, and run Vite with
`npm run dev -- --host 0.0.0.0`. Restart Vite after changing its environment.

## Public URL and table QR codes

1. Start a public HTTPS tunnel or deploy both apps. The URL entered in the
   Staff Console’s **Table QR codes** window must be the public frontend URL
   guests can open on their phones.
2. Point the frontend at the reachable backend before starting/building it:

   ```env
   VITE_API_URL=https://your-api-host.example
   VITE_SOCKET_URL=https://your-api-host.example
   ```

   `VITE_API_URL` may also end in `/api`; the client normalizes either form.
   Restart Vite after changing these values. For a single public host, configure
   its reverse proxy to route `/api` to Express and `/socket.io` (including
   WebSocket upgrades) to the same backend. If the frontend uses HTTPS, the
   backend URL must also be HTTPS to avoid browser mixed-content blocking.
3. In `backend/.env`, set `FRONTEND_ORIGIN` to the exact public frontend origin
   (scheme and host, no path). Multiple origins may be comma-separated. Restart
   the backend after changing it. Keep the allow-list specific; do not use `*`
   for credentialed public deployments.
4. Open Staff Console → **Table QR codes**, enter the public frontend URL, then
   use **Copy link**, **Download PNG**, or **Print all tent cards**. Codes open
   the selected table as `/?table=01` through `/?table=10`.

For example, with separate tunnels, use the public frontend tunnel for the QR
base URL and `VITE_API_URL` / `VITE_SOCKET_URL` for the backend tunnel, then set
`FRONTEND_ORIGIN` to the frontend tunnel’s exact origin. A public frontend URL
cannot reach a backend that remains bound only to the same computer's
`localhost`; expose the backend securely or use a reverse proxy.

## Staff accounts

Signup hashes passwords with bcrypt and creates the account immediately. If
`STAFF_SIGNUP_PASSCODE` is set, signup requires that passcode. Use a private
passcode for a local restaurant deployment; do not expose a production value
in frontend code. Signup validates the staff name, role, identity, password,
and password confirmation; duplicate identities return a clear server error.
JWTs expire after eight hours. Logout clears the frontend staff session;
JWT revocation/blacklisting is not implemented.

## API overview

All routes use the `/api` prefix. Errors return `{ "message": "..." }`.

| Method | Route | Access |
| --- | --- | --- |
| GET | `/health` | Public; checks MySQL |
| GET | `/menu?search=&category=&vegOnly=true&bestsellersOnly=true` | Public |
| GET | `/tables` | Public; normalized tables, guests, carts, orders, calls, and totals |
| GET | `/revenue/today` | Staff JWT; approved bills settled today, including closed tables |
| GET, POST | `/sessions/:sessionId/bill` | Public; preview or generate the session's itemized bill |
| POST | `/feedback` | Public; submit a 1–5 star session rating and comment |
| GET | `/feedback` | Staff JWT; latest 100 guest feedback entries |
| POST | `/sessions/join` | Public; `{ tableNumber, customerName, customerPhone? }` |
| DELETE | `/sessions/:sessionId/guests/:guestId` | Public; removes the guest, preserving open orders/bills |
| POST | `/tables/:tableNumber/cart` | Public; add an item by menu key |
| PATCH | `/tables/:tableNumber/cart/:lineId` | Public; update quantity/note |
| POST | `/tables/:tableNumber/call-waiter` | Public; enforces a 15-minute per-session cooldown |
| POST | `/tables/:tableNumber/resolve-waiter` | Staff JWT |
| POST | `/sessions/:sessionId/reward` | Public; applies the fixed 5% dessert reward |
| POST | `/sessions/:sessionId/pay` | Public; requires confirmed orders, requests payment approval |
| POST | `/sessions/:sessionId/approve-payment` | Manager JWT; marks a pending payment Paid |
| POST | `/tables/:tableNumber/close` | Staff JWT |
| GET | `/orders` | Public; active-session kitchen orders |
| GET | `/orders/session/:sessionId` | Public |
| POST | `/orders` | Public; creates an order from that guest's active cart |
| PATCH | `/orders/:orderId/status` | Staff JWT; Prepared/Served awaits guest confirmation |
| POST | `/orders/:orderId/confirm-served` | Guest in the order's active session |
| POST | `/tables/:tableNumber/orders/items` | Staff JWT; manually adds a menu item |
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | Signup/login public; logout requires Staff JWT |

Use `Authorization: Bearer <token>` for staff-only routes. Only a staff member
with the `Manager` role can approve a pending payment. Food is not considered
served until the guest who placed the order confirms it. The server emits
`tables:updated`, `orders:updated`, `waiter:called`, `payment:pending`, and
`payment:approved`, and `feedback:created` Socket.IO events after the
corresponding changes; the frontend listens and reloads the shared table state.

The game service uses Socket.IO rooms for `game:create`, `game:join`,
`game:move`, `game:state`, and `game:rematch`. Turn-based boards and score-duel
submissions are validated on the server. Guest/session membership is checked
against the active table session; room state is held in memory and will be lost
when the backend restarts. Reconnecting guests can rejoin with their room code.

Waiter-call cooldowns are calculated from the latest call in the active table
session, whether or not staff have resolved it. A throttled request returns
HTTP 429 with `remainingSeconds` and `cooldownEndsAt`. Guests cannot leave while
their orders await confirmation or a payment awaits Manager approval. Leaving
clears their unsent cart, but keeps placed orders and the open table bill.

## Important integration notes

- Order prices and subtotals are read/calculated server-side from `menu_items`;
  cart/order items retain a price snapshot for historical totals. Menu rows
  store preparation time, emoji, and category color as well as filtering,
  pricing, and dietary details.
- The table bill includes cart and ordered items, a 5% GST calculation, and
  the game reward discount on dessert items.
- Payment submission records a method and awaits manager approval; only the
  manager approval route sets `is_paid` and the official `Paid` state. Connect
  and verify a real payment gateway before treating a bill as financially
  settled.
- The staff revenue summary includes only sessions with `is_paid = 1` and
  `payment_status = 'Paid'`, filtered by `bills.paid_at` (falling back to
  `session_payment_meta.paid_at` and then `payment_approved_at`) against
  MariaDB's `CURDATE()`. Generated bill
  snapshots are marked pending at payment submission and Paid with a `paid_at`
  timestamp only after Manager approval; the revenue summary uses the saved
  grand total and still includes legacy paid sessions without a bill snapshot.
  The database server's timezone therefore defines the business day. Bill
  totals use persisted order items, the dessert reward discount, 5% GST, and a
  currently zero service charge.
- `bills` and `feedback` are created idempotently by server startup as well as
  by `sql/schema.sql`. Importing the schema remains the recommended first setup.
- Today's Special is derived deterministically from the current date and
  seeded menu, so it rotates daily without a database write or manual reset.
- This initial server is for a single restaurant/database. Add tenant scoping,
  production secrets, rate limiting, TLS, token revocation, and stricter
  authorization before public deployment.
