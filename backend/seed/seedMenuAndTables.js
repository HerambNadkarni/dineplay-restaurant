import 'dotenv/config'
import pool from '../config/db.js'
import { menuItems } from '../../src/data/menuData.js'
import { additionalDishSets } from './additionalDishes.js'

async function seedMenuAndTables() {
  const additionalItems = additionalDishSets.flatMap(({ category, color, dishes }) =>
    dishes.map(([name, price, type, spice, prepMinutes, description, emoji, popular = false]) => ({
      name,
      category,
      color,
      price,
      type,
      spice,
      prepMinutes,
      description,
      emoji,
      popular,
    })),
  )
  const seedItems = [...menuItems, ...additionalItems]
  const normalizedNames = seedItems.map((item) => item.name.trim().toLowerCase())
  if (seedItems.length !== 200 || new Set(normalizedNames).size !== seedItems.length) {
    throw new Error(`Seed data must contain 200 uniquely named dishes; found ${seedItems.length}.`)
  }
  const invalidItem = seedItems.find((item) =>
    !item.name.trim()
    || !item.category.trim()
    || !Number.isFinite(Number(item.price))
    || Number(item.price) <= 0
    || !['Veg', 'Non-Veg'].includes(item.type)
    || !['Mild', 'Medium', 'Spicy'].includes(item.spice)
    || !Number.isInteger(Number(item.prepMinutes))
    || Number(item.prepMinutes) <= 0
    || !item.description.trim()
    || !item.emoji.trim()
    || !item.color.trim(),
  )
  if (invalidItem) throw new Error(`Seed data is incomplete for "${invalidItem.name || 'unnamed dish'}".`)

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      `INSERT INTO menu_items
        (name, category, price, is_veg, spice_level, is_bestseller, description,
         is_available, prep_minutes, emoji, color)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         category = VALUES(category),
         price = VALUES(price),
         is_veg = VALUES(is_veg),
         spice_level = VALUES(spice_level),
         is_bestseller = VALUES(is_bestseller),
         description = VALUES(description),
         is_available = VALUES(is_available),
         prep_minutes = VALUES(prep_minutes),
         emoji = VALUES(emoji),
         color = VALUES(color)`,
      [seedItems.map((item) => [
        item.name.trim(),
        item.category.trim(),
        Number(item.price),
        item.type === 'Veg' ? 1 : 0,
        item.spice,
        item.popular ? 1 : 0,
        item.description.trim(),
        1,
        Number(item.prepMinutes),
        item.emoji.trim(),
        item.color.trim(),
      ])],
    )

    await connection.query(
      `INSERT INTO tables (table_number)
       VALUES ?
       ON DUPLICATE KEY UPDATE table_number = VALUES(table_number)`,
      [Array.from({ length: 20 }, (_, index) => [index + 1])],
    )
    await connection.commit()
    console.log(`Seed complete: 200 menu items upserted; tables 1–20 ensured.`)
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
