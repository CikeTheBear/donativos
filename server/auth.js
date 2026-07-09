// auth.js — Contraseñas y sesiones, sin dependencias externas.
//
// Para las contraseñas usamos scrypt, que viene en el módulo crypto de
// Node. scrypt es un KDF (key derivation function): a diferencia de un
// hash normal (SHA-256), está diseñado para ser LENTO y consumir
// memoria, lo que hace inviable probar millones de contraseñas por
// segundo si alguien roba la base de datos.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Genera el hash de una contraseña.
 * El "salt" es un valor aleatorio único por usuario que se mezcla con la
 * contraseña antes de hashear: así dos usuarios con la misma contraseña
 * tienen hashes distintos y no sirven las tablas precalculadas (rainbow
 * tables). Guardamos salt y hash juntos separados por ':'.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Comprueba una contraseña contra su hash guardado.
 * timingSafeEqual compara en tiempo constante: una comparación normal
 * (===) termina antes cuando el primer byte difiere, y ese microtiempo
 * se puede medir para adivinar el hash byte a byte (timing attack).
 */
export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

const SESSION_DAYS = 30;

/**
 * Crea una sesión para un usuario y devuelve el token.
 * El token es aleatorio puro (no contiene datos): la información de la
 * sesión vive en la BD y el token solo es la "llave" para encontrarla.
 */
export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expires.toISOString());
  return token;
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Lee la cookie "session" del header Cookie de la petición. */
function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Middleware de Express: si hay sesión válida, cuelga el usuario en
 * req.user y deja pasar; si no, responde 401 y la petición muere aquí.
 * Se aplica a todas las rutas /api excepto login.
 */
export function requireAuth(db) {
  return (req, res, next) => {
    const token = getSessionToken(req);
    if (!token) return res.status(401).json({ error: 'No has iniciado sesión' });

    const row = db.prepare(`
      SELECT u.id, u.username, u.name, u.role, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);

    if (!row || new Date(row.expires_at) < new Date()) {
      if (row) deleteSession(db, token); // sesión caducada: limpiarla
      return res.status(401).json({ error: 'Sesión expirada' });
    }

    req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
    req.sessionToken = token;
    next();
  };
}

/** Middleware adicional para rutas que solo puede tocar un admin. */
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el administrador puede hacer esto' });
  }
  next();
}
