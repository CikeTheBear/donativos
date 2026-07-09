// index.js — Servidor principal: sirve la web estática y expone la API.
//
// Arquitectura: un único proceso Express hace de backend (rutas /api/*)
// y de servidor de archivos estáticos (la carpeta /public). Sin build
// step: lo que hay en public/ es exactamente lo que recibe el navegador.

import express from 'express';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  hashPassword, verifyPassword,
  createSession, deleteSession,
  requireAuth, requireAdmin,
} from './auth.js';
import { parseDonations } from './llm.js';
import { getStock, getMoneyBalances, importBatch, deleteItemById } from './inventory.js';
import { mountMcp, hashToken } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cookie de sesión: httpOnly evita que JavaScript del navegador pueda
// leerla (protege contra XSS); sameSite=lax evita que otras webs la
// envíen en peticiones cross-site (protege contra CSRF).
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`);
}

// ─── Autenticación ──────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // Mismo mensaje si el usuario no existe o la contraseña falla: no
  // regalamos a un atacante la pista de qué usuarios existen.
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  setSessionCookie(res, createSession(db, user.id));
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
});

// Todo lo que viene después de esta línea exige sesión iniciada.
app.use('/api', requireAuth(db));

app.post('/api/logout', (req, res) => {
  deleteSession(db, req.sessionToken);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json(req.user));

app.post('/api/me/password', (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current || '', user.password_hash)) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  }
  if (!next || next.length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

// ─── Catálogo de artículos ──────────────────────────────────────────

app.get('/api/items', (req, res) => {
  res.json(db.prepare('SELECT * FROM items ORDER BY category, name').all());
});

app.post('/api/items', (req, res) => {
  const { name, category, unit } = req.body || {};
  if (!name?.trim() || !category?.trim()) {
    return res.status(400).json({ error: 'Nombre y categoría son obligatorios' });
  }
  try {
    const info = db.prepare('INSERT INTO items (name, category, unit) VALUES (?, ?, ?)')
      .run(name.trim(), category.trim(), unit?.trim() || 'unidades');
    res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    // UNIQUE en items.name: dos artículos con el mismo nombre serían
    // dos stocks separados para lo mismo — mejor rechazarlo.
    if (String(e).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ya existe un artículo con ese nombre' });
    }
    throw e;
  }
});

// Borrar artículo del catálogo (solo admin, solo sin movimientos).
// Misma lógica y misma regla que la herramienta MCP donativos_borrar_articulo.
app.delete('/api/items/:id', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, name: deleteItemById(Number(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Stock (calculado, nunca almacenado) ────────────────────────────

// La lógica vive en inventory.js: la comparten esta API y el MCP.
app.get('/api/stock', (req, res) => {
  res.json(getStock());
});

// ─── Movimientos de bienes ──────────────────────────────────────────

app.get('/api/movements', (req, res) => {
  // Últimos 500 para no mandar historiales enormes al navegador.
  res.json(db.prepare(`
    SELECT m.*, i.name AS item_name, i.unit, u.name AS user_name
    FROM movements m
    JOIN items i ON i.id = m.item_id
    JOIN users u ON u.id = m.user_id
    ORDER BY m.date DESC, m.id DESC
    LIMIT 500
  `).all());
});

app.post('/api/movements', (req, res) => {
  const { type, item_id, quantity, party, notes, date } = req.body || {};

  if (!['entrada', 'salida'].includes(type)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido' });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser un número mayor que cero' });
  }
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(item_id);
  if (!item) return res.status(400).json({ error: 'Artículo no encontrado' });

  // Regla de negocio: no se puede despachar más de lo que hay.
  // Evita stocks negativos por errores de tipeo (200 en vez de 20).
  if (type === 'salida') {
    const s = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type = 'entrada' THEN quantity ELSE -quantity END), 0) AS stock
      FROM movements WHERE item_id = ?
    `).get(item_id);
    if (qty > s.stock) {
      return res.status(400).json({
        error: `Stock insuficiente: hay ${s.stock} ${item.unit} de "${item.name}"`,
      });
    }
  }

  const info = db.prepare(`
    INSERT INTO movements (type, item_id, quantity, party, notes, date, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(type, item_id, qty, party?.trim() || null, notes?.trim() || null,
         date || new Date().toISOString().slice(0, 10), req.user.id);

  res.json({ id: info.lastInsertRowid });
});

// Borrar un movimiento corrige errores de registro. Solo admin, porque
// borrar movimientos altera el stock y debe ser una acción controlada.
app.delete('/api/movements/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM movements WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Movimiento no encontrado' });
  res.json({ ok: true });
});

// ─── Movimientos de dinero ──────────────────────────────────────────

app.get('/api/money', (req, res) => {
  res.json(db.prepare(`
    SELECT mm.*, u.name AS user_name
    FROM money_movements mm
    JOIN users u ON u.id = mm.user_id
    ORDER BY mm.date DESC, mm.id DESC
    LIMIT 500
  `).all());
});

app.post('/api/money', (req, res) => {
  const { type, amount, currency, party, notes, date } = req.body || {};

  if (!['entrada', 'salida'].includes(type)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'El monto debe ser un número mayor que cero' });
  }
  if (!['USD', 'EUR', 'VES'].includes(currency)) {
    return res.status(400).json({ error: 'Moneda no válida' });
  }

  const info = db.prepare(`
    INSERT INTO money_movements (type, amount, currency, party, notes, date, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(type, amt, currency, party?.trim() || null, notes?.trim() || null,
         date || new Date().toISOString().slice(0, 10), req.user.id);

  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/money/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM money_movements WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Movimiento no encontrado' });
  res.json({ ok: true });
});

// ─── Registro con IA: interpretar texto libre y confirmar ──────────

// Paso 1: el LLM convierte texto libre en movimientos PROPUESTOS.
// No escribe nada en la BD — devuelve la propuesta para revisión humana.
app.post('/api/parse', async (req, res) => {
  if (!process.env.LLM_API_KEY) {
    return res.status(503).json({
      error: 'La función de IA no está configurada (falta LLM_API_KEY en el servidor)',
    });
  }
  const { text } = req.body || {};
  if (!text?.trim()) {
    return res.status(400).json({ error: 'Pega el texto con los donativos a interpretar' });
  }

  try {
    const catalog = db.prepare('SELECT id, name, category, unit FROM items').all();
    const movements = await parseDonations(text.trim(), catalog);

    // Enriquecemos cada propuesta de bienes con el id del artículo si ya
    // existe en el catálogo (comparación sin mayúsculas/espacios), para
    // que la vista previa muestre "existente" vs "artículo nuevo".
    const byName = new Map(catalog.map((i) => [i.name.trim().toLowerCase(), i]));
    const enriched = movements.map((m) => {
      if (m.kind !== 'bien') return m;
      const match = byName.get(m.item_name.trim().toLowerCase());
      return { ...m, item_id: match ? match.id : null };
    });

    res.json({ movements: enriched });
  } catch (e) {
    console.error('Error en /api/parse:', e);
    res.status(502).json({ error: `No se pudo interpretar el texto: ${e.message}` });
  }
});

// Paso 2: el humano revisó y confirmó. importBatch (inventory.js)
// inserta todo en UNA transacción: o entra el lote completo o nada.
app.post('/api/import', (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No hay movimientos que importar' });
  }
  try {
    const results = importBatch(rows, req.user.id);
    res.json({ imported: results.length, results });
  } catch (e) {
    // La transacción ya hizo rollback: la BD queda intacta.
    res.status(400).json({ error: e.message });
  }
});

// ─── Resumen para el dashboard ──────────────────────────────────────

app.get('/api/summary', (req, res) => {
  res.json({ stock: getStock(), money: getMoneyBalances() });
});

// ─── Gestión de usuarios (solo admin) ───────────────────────────────

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY name').all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, name, password, role } = req.body || {};
  if (!username?.trim() || !name?.trim()) {
    return res.status(400).json({ error: 'Usuario y nombre son obligatorios' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(username.trim().toLowerCase(), name.trim(), hashPassword(password),
          role === 'admin' ? 'admin' : 'voluntario');
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    }
    throw e;
  }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  }
  // Si el usuario ya registró movimientos, la foreign key impide
  // borrarlo (perderíamos la trazabilidad de quién registró qué).
  try {
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    if (info.changes === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ ok: true });
  } catch {
    return res.status(400).json({
      error: 'Este usuario tiene movimientos registrados y no se puede eliminar',
    });
  }
});

// ─── Tokens de acceso MCP ───────────────────────────────────────────

// Cada usuario gestiona sus propios tokens desde la pestaña Cuenta.
// El token en claro solo existe en la respuesta de creación: en la BD
// queda su hash (ver api_tokens en db.js).
app.get('/api/tokens', (req, res) => {
  res.json(db.prepare(`
    SELECT id, name, created_at, last_used FROM api_tokens
    WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id));
});

app.post('/api/tokens', (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Ponle un nombre al token (ej: "Claude en mi laptop")' });
  }
  // Prefijo "dnt_" para reconocer los tokens de esta app a simple vista.
  const token = 'dnt_' + randomBytes(32).toString('hex');
  db.prepare('INSERT INTO api_tokens (token_hash, name, user_id) VALUES (?, ?, ?)')
    .run(hashToken(token), name.trim(), req.user.id);
  res.json({ token, name: name.trim() });
});

app.delete('/api/tokens/:id', (req, res) => {
  // Solo se pueden revocar tokens propios.
  const info = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Token no encontrado' });
  res.json({ ok: true });
});

// ─── Endpoint MCP (fuera de /api: usa tokens, no cookies) ──────────

mountMcp(app);

// ─── Arranque ───────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Donativos escuchando en http://localhost:${PORT}`);
});
