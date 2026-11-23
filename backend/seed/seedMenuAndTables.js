import 'dotenv/config'
import pool from '../config/db.js'
import { menuItems } from '../../src/data/menuData.js'

async function seedMenuAndTables() {
  const connection = await pool.getConnection()
  try {
    const [existingRows] = await connection.query('SELECT name FROM menu_items')
    const existingNames = new Set(existingRows.map((row) => row.name.toLowerCase()))
    const missingItems = menuItems.filter((item) => !existingNames.has(item.name.toLowerCase()))

    await connection.beginTransaction()
    if (missingItems.length) {
      await connection.query(
        `INSERT INTO menu_items
          (name, category, price, is_veg, spice_level, is_bestseller, description,
           is_available, prep_minutes, emoji, color)
         VALUES ?`,
        [missingItems.map((item) => [
          item.name,
          item.category,
          item.price,
          item.type === 'Veg' ? 1 : 0,
          item.spice,
          item.popular ? 1 : 0,
          item.description,
          1,
          item.prepMinutes,
          item.emoji,
          item.color,
        ])],
      )
    }

    for (const item of menuItems) {
      await connection.query(
        'UPDATE menu_items SET prep_minutes = ?, emoji = ?, color = ? WHERE name = ?',
        [item.prepMinutes, item.emoji, item.color, item.name],
      )
    }

    await connection.query(
      `INSERT INTO tables (table_number)
       SELECT numbers.table_number
       FROM (
         SELECT 1 AS table_number UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
         UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10
       ) AS numbers
       LEFT JOIN tables existing ON existing.table_number = numbers.table_number
       WHERE existing.id IS NULL`,
    )
    await connection.commit()
    console.log(`Seed complete: ${missingItems.length} menu items added; tables 1–10 ensured.`)
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
    await pool.end()
  }
}

seedMenuAndTables().catch((error) => {
  console.error('Seed failed:', error.message)
  process.exitCode = 1
})
