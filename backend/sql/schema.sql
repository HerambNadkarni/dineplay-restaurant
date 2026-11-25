CREATE DATABASE IF NOT EXISTS dineplay
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE dineplay;

-- These six base tables follow the current phpMyAdmin schema. CREATE IF NOT
-- EXISTS preserves tables/data already created in the dineplay database.
CREATE TABLE IF NOT EXISTS menu_items (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(100) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  is_veg TINYINT(1) NOT NULL DEFAULT 1,
  spice_level VARCHAR(30) NOT NULL DEFAULT 'Mild',
  is_bestseller TINYINT(1) NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_menu_items_name (name),
  KEY idx_menu_items_category (category),
  KEY idx_menu_items_available (is_available)
) ENGINE=InnoDB;

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS prep_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS emoji VARCHAR(16) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS color VARCHAR(24) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS tables (
  id INT NOT NULL AUTO_INCREMENT,
  table_number INT NOT NULL,
  status ENUM('available', 'occupied', 'waiting', 'calling_waiter') NOT NULL DEFAULT 'available',
  call_reason VARCHAR(120) NULL,
  call_timestamp DATETIME NULL,
  current_session_id INT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tables_table_number (table_number),
  KEY idx_tables_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS table_sessions (
  id INT NOT NULL AUTO_INCREMENT,
  table_number INT NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(25) NULL,
  discount_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  is_paid TINYINT(1) NOT NULL DEFAULT 0,
  payment_method ENUM('UPI', 'Card', 'Cash') NULL,
  payment_status ENUM('Unpaid', 'Pending Manager Approval', 'Paid') NOT NULL DEFAULT 'Unpaid',
  payment_requested_at DATETIME NULL,
  payment_approved_by INT NULL,
  payment_approved_at DATETIME NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_table_sessions_active (table_number, is_active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id INT NOT NULL AUTO_INCREMENT,
  session_id INT NOT NULL,
  table_number INT NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
  status ENUM('Order Received', 'Preparing', 'Served', 'Awaiting Confirmation', 'Confirmed Served') NOT NULL DEFAULT 'Order Received',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  prepared_at DATETIME NULL,
  customer_confirmed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_orders_session (session_id),
  KEY idx_orders_status (status)
) ENGINE=InnoDB;

ALTER TABLE orders
  MODIFY COLUMN status ENUM(
    'Order Received',
    'Preparing',
    'Served',
    'Awaiting Confirmation',
    'Confirmed Served'
  ) NOT NULL DEFAULT 'Order Received',
  ADD COLUMN IF NOT EXISTS prepared_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS customer_confirmed_at DATETIME NULL;

UPDATE orders SET status = 'Confirmed Served' WHERE status = 'Served';

ALTER TABLE table_sessions
  ADD COLUMN IF NOT EXISTS payment_status
    ENUM('Unpaid', 'Pending Manager Approval', 'Paid') NOT NULL DEFAULT 'Unpaid',
  ADD COLUMN IF NOT EXISTS payment_requested_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS payment_approved_by INT NULL,
  ADD COLUMN IF NOT EXISTS payment_approved_at DATETIME NULL;

UPDATE table_sessions
   SET payment_status = 'Paid'
 WHERE is_paid = 1 AND payment_status <> 'Paid';

UPDATE table_sessions
   SET payment_status = 'Pending Manager Approval'
 WHERE is_paid = 0 AND payment_method IS NOT NULL AND payment_status = 'Unpaid';

CREATE TABLE IF NOT EXISTS order_items (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  menu_item_id INT NOT NULL,
  item_name VARCHAR(150) NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  quantity INT NOT NULL,
  note VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_order_items_order (order_id),
  KEY idx_order_items_menu (menu_item_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS staff_users (
  id INT NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL,
  role ENUM('Manager', 'Waiter / Captain', 'Kitchen / Chef') NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_staff_email (email)
) ENGINE=InnoDB;

-- Supporting records preserve multi-guest table sessions, active carts,
-- waiter-call history, order notes, and payment timestamps.
CREATE TABLE IF NOT EXISTS session_guests (
  id INT NOT NULL AUTO_INCREMENT,
  session_id INT NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(32) NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_session_guests_session (session_id),
  CONSTRAINT fk_guests_session FOREIGN KEY (session_id) REFERENCES table_sessions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cart_items (
  id INT NOT NULL AUTO_INCREMENT,
  session_id INT NOT NULL,
  guest_id INT NOT NULL,
  menu_item_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  note VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cart_guest_item_note (guest_id, menu_item_id, note),
  KEY idx_cart_session (session_id),
  CONSTRAINT fk_cart_session FOREIGN KEY (session_id) REFERENCES table_sessions (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_cart_guest FOREIGN KEY (guest_id) REFERENCES session_guests (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_cart_menu FOREIGN KEY (menu_item_id) REFERENCES menu_items (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_details (
  order_id INT NOT NULL,
  guest_id INT NULL,
  instructions TEXT NULL,
  PRIMARY KEY (order_id),
  CONSTRAINT fk_order_details_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_order_details_guest FOREIGN KEY (guest_id) REFERENCES session_guests (id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS waiter_calls (
  id INT NOT NULL AUTO_INCREMENT,
  table_id INT NOT NULL,
  session_id INT NOT NULL,
  guest_id INT NULL,
  reason VARCHAR(120) NOT NULL,
  is_resolved TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_waiter_calls_table_active (table_id, is_resolved),
  KEY idx_waiter_calls_session_created (session_id, created_at),
  CONSTRAINT fk_waiter_calls_table FOREIGN KEY (table_id) REFERENCES tables (id),
  CONSTRAINT fk_waiter_calls_session FOREIGN KEY (session_id) REFERENCES table_sessions (id),
  CONSTRAINT fk_waiter_calls_guest FOREIGN KEY (guest_id) REFERENCES session_guests (id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE waiter_calls
  ADD INDEX IF NOT EXISTS idx_waiter_calls_session_created (session_id, created_at);

CREATE TABLE IF NOT EXISTS session_payment_meta (
  session_id INT NOT NULL,
  paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id),
  CONSTRAINT fk_payment_meta_session FOREIGN KEY (session_id) REFERENCES table_sessions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bills (
  id INT NOT NULL AUTO_INCREMENT,
  bill_number VARCHAR(40) NOT NULL,
  session_id INT NOT NULL,
  table_number INT NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  service_charge DECIMAL(10, 2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  grand_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  payment_status ENUM('Unpaid', 'Pending Manager Approval', 'Paid') NOT NULL DEFAULT 'Unpaid',
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bills_bill_number (bill_number),
  UNIQUE KEY uq_bills_session (session_id),
  KEY idx_bills_table_generated (table_number, generated_at),
  KEY idx_bills_payment_paid_at (payment_status, paid_at),
  CONSTRAINT fk_bills_session FOREIGN KEY (session_id) REFERENCES table_sessions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feedback (
  id INT NOT NULL AUTO_INCREMENT,
  session_id INT NOT NULL,
  table_number INT NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  `comment` TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_feedback_created (created_at),
  KEY idx_feedback_session (session_id),
  CONSTRAINT fk_feedback_session FOREIGN KEY (session_id) REFERENCES table_sessions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB;
