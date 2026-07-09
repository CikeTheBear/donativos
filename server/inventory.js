// inventory.js — Lógica de inventario compartida.
//
// Estas funciones las usan tanto la API REST (/api/*) como las
// herramientas MCP (/mcp). Vivir en un solo sitio garantiza que ambas
// puertas de entrada apliquen exactamente las mismas reglas de negocio
// (stock no negativo, monedas válidas, artículos sin duplicar).

import { db } from './db.js';

// Stock por artículo: entradas - salidas, calculado siempre desde los
// movimientos (nunca almacenado).
const stockQuery = db.prepare(`
  SELECT
    i.id, i.name, i.category, i.unit,
    COALESCE(SUM(CASE WHEN m.type = 'entrada' THEN m.quantity END), 0) AS entradas,
    COALESCE(SUM(CASE WHEN m.type = 'salida'  THEN m.quantity END), 0) AS salidas
  FROM items i
  LEFT JOIN movements m ON m.item_id = i.id
  GROUP BY i.id
  ORDER BY i.category, i.name
`);

export function getStock() {
  return stockQuery.all().map((r) => ({ ...r, stock: r.entradas - r.salidas }));
}

export function getMoneyBalances() {
  return db.prepare(`
    SELECT currency,
      COALESCE(SUM(CASE WHEN type = 'entrada' THEN amount END), 0) AS recibido,
      COALESCE(SUM(CASE WHEN type = 'salida'  THEN amount END), 0) AS entregado
    FROM money_movements
    GROUP BY currency
  `).all().map((r) => ({ ...r, disponible: r.recibido - r.entregado }));
}

// Importa un lote de movimientos (bienes y/o dinero) en UNA transacción:
// o entra el lote completo o no entra nada. Crea artículos nuevos si
// hace falta y valida que ninguna salida deje el stock en negativo.
export const importBatch = db.transaction((rows, userId) => {
  const results = [];
  for (const row of rows) {
    if (row.kind === 'dinero') {
      const amt = Number(row.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error(`Monto no válido: "${row.amount}"`);
      if (!['USD', 'EUR', 'VES'].includes(row.currency)) throw new Error(`Moneda no válida: "${row.currency}"`);
      if (!['entrada', 'salida'].includes(row.type)) throw new Error('Tipo de movimiento no válido');
      db.prepare(`
        INSERT INTO money_movements (type, amount, currency, party, notes, date, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.type, amt, row.currency, row.party?.trim() || null,
             row.notes?.trim() || null, row.date, userId);
      results.push(`${row.type} de dinero: ${amt} ${row.currency}`);
      continue;
    }

    // Bienes: reutilizar el artículo si existe, crearlo si no.
    const qty = Number(row.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Cantidad no válida en "${row.item_name}": debe ser mayor que cero`);
    }
    if (!['entrada', 'salida'].includes(row.type)) throw new Error('Tipo de movimiento no válido');

    let item = db.prepare('SELECT * FROM items WHERE lower(trim(name)) = lower(trim(?))')
      .get(row.item_name);
    if (!item) {
      const info = db.prepare('INSERT INTO items (name, category, unit) VALUES (?, ?, ?)')
        .run(row.item_name.trim(), row.category?.trim() || 'Sin categoría',
             row.unit?.trim() || 'unidades');
      item = db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
    }

    // No despachar más de lo que hay. La consulta ve los inserts previos
    // de esta misma transacción, así que un lote con entrada + salida
    // del mismo artículo se valida en orden.
    if (row.type === 'salida') {
      const s = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN type = 'entrada' THEN quantity ELSE -quantity END), 0) AS stock
        FROM movements WHERE item_id = ?
      `).get(item.id);
      if (qty > s.stock) {
        throw new Error(`Stock insuficiente de "${item.name}": hay ${s.stock} ${item.unit}`);
      }
    }

    db.prepare(`
      INSERT INTO movements (type, item_id, quantity, party, notes, date, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.type, item.id, qty, row.party?.trim() || null,
           row.notes?.trim() || null, row.date, userId);
    results.push(`${row.type}: ${qty} ${item.unit} de ${item.name}`);
  }
  return results;
});
