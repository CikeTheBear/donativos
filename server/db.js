// db.js — Inicialización de la base de datos SQLite.
//
// Usamos better-sqlite3 porque su API es síncrona: para una app de este
// tamaño es más simple de razonar que callbacks/promesas, y SQLite es
// tan rápido que no bloquea nada en la práctica.
//
// El stock NO se guarda como número editable: se calcula sumando
// entradas y restando salidas. Así siempre hay trazabilidad de por qué
// el stock es el que es (quién metió qué y quién sacó qué).

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// La BD vive en /data para poder respaldarla copiando un solo archivo,
// y para montarla como volumen persistente al desplegar en Docker.
const dataDir = path.join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'donativos.db'));

// WAL = Write-Ahead Logging: modo de journaling de SQLite que permite
// lecturas y escrituras concurrentes sin bloquearse entre sí.
// Imprescindible cuando varios voluntarios usan la app a la vez.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Usuarios de la app. role: 'admin' gestiona usuarios y puede borrar
  -- registros; 'voluntario' solo registra movimientos.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'voluntario' CHECK (role IN ('admin', 'voluntario')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Sesiones activas (una fila por login). El token viaja en una cookie
  -- httpOnly. Guardarlas en BD (y no en memoria) permite que sobrevivan
  -- a reinicios del servidor.
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  -- Tokens de acceso personales para el endpoint MCP (/mcp).
  -- Guardamos el HASH del token, no el token: si alguien roba la BD no
  -- obtiene tokens usables. El token real solo se muestra al crearlo.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id         INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT
  );

  -- Catálogo de artículos donables (arroz, paracetamol, mantas...).
  -- unit es la unidad de medida: kg, unidades, cajas, litros...
  CREATE TABLE IF NOT EXISTS items (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    unit     TEXT NOT NULL DEFAULT 'unidades'
  );

  -- Movimientos de bienes. type 'entrada' = donación recibida,
  -- 'salida' = despacho/distribución. party es el donante o el destino
  -- según el tipo. El stock de un artículo = SUM(entradas) - SUM(salidas).
  CREATE TABLE IF NOT EXISTS movements (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL CHECK (type IN ('entrada', 'salida')),
    item_id    INTEGER NOT NULL REFERENCES items(id),
    quantity   REAL NOT NULL CHECK (quantity > 0),
    party      TEXT,
    notes      TEXT,
    date       TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Movimientos de dinero. Va en tabla aparte porque el dinero no es
  -- inventario: no tiene artículo ni unidad, tiene monto y moneda.
  CREATE TABLE IF NOT EXISTS money_movements (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL CHECK (type IN ('entrada', 'salida')),
    amount     REAL NOT NULL CHECK (amount > 0),
    currency   TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'VES')),
    party      TEXT,
    notes      TEXT,
    date       TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Primer arranque: si no hay ningún usuario, creamos el admin inicial.
// La contraseña sale de la variable de entorno ADMIN_PASSWORD o, en su
// defecto, de un valor por defecto que hay que cambiar al desplegar.
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const initialPassword = process.env.ADMIN_PASSWORD || 'cambiame123';
  db.prepare(
    'INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run('admin', 'Administrador', hashPassword(initialPassword), 'admin');

  console.log('══════════════════════════════════════════════════════');
  console.log('  Usuario inicial creado → usuario: admin');
  console.log(`  Contraseña: ${process.env.ADMIN_PASSWORD ? '(la de ADMIN_PASSWORD)' : 'cambiame123  ⚠ CÁMBIALA al entrar'}`);
  console.log('══════════════════════════════════════════════════════');
}
