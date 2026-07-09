// mcp.js — Servidor MCP remoto montado en el mismo Express.
//
// MCP (Model Context Protocol) expone la app como herramientas que
// cualquier cliente LLM (Claude Code, claude.ai, Claude Desktop) puede
// descubrir y usar: "registra 50 kg de arroz" se convierte en una
// llamada a donativos_registrar_movimientos contra esta URL.
//
// Transporte: Streamable HTTP en modo "stateless" — cada petición POST
// crea su propio transporte y servidor, sin sesiones persistentes.
// Es el modo más simple de operar y escala sin estado compartido.
//
// Auth: token personal (Bearer). Cada usuario genera el suyo en la
// pestaña Cuenta; los movimientos registrados por MCP quedan a su
// nombre, igual que si los hubiera registrado desde la web.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { getStock, getMoneyBalances, importBatch } from './inventory.js';

// Los tokens se guardan hasheados (ver db.js). SHA-256 basta aquí: los
// tokens son aleatorios de 256 bits, no contraseñas humanas adivinables,
// así que no hace falta un KDF lento como scrypt.
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Resuelve el token (header Authorization o ?key=) a un usuario, o null. */
function authenticateToken(req) {
  const header = req.headers.authorization || '';
  const bearer = header.match(/^Bearer\s+(\S+)$/i)?.[1];
  const token = bearer || req.query.key;
  if (!token) return null;

  const row = db.prepare(`
    SELECT t.id AS token_id, u.id, u.username, u.name, u.role
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;

  db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?")
    .run(row.token_id);
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

// Esquema de un movimiento, compartido por la herramienta de registro.
// Es la misma forma que acepta importBatch/(POST /api/import).
const movementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bien').describe('Movimiento de bienes físicos'),
    type: z.enum(['entrada', 'salida']).describe('entrada = donación recibida, salida = despacho/distribución'),
    item_name: z.string().min(1).describe('Nombre del artículo. Usa el nombre EXACTO del catálogo si existe (consúltalo con donativos_consultar_stock); si no existe, se crea.'),
    category: z.string().optional().describe('Categoría (solo para artículos nuevos): Alimentos, Medicinas, Ropa, Higiene, Agua, Refugio...'),
    unit: z.string().optional().describe('Unidad de medida (solo para artículos nuevos): kg, unidades, litros, cajas...'),
    quantity: z.number().positive().describe('Cantidad, en la unidad del artículo'),
    party: z.string().optional().describe('Donante (entrada) o destino (salida)'),
    notes: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha del movimiento, YYYY-MM-DD'),
  }),
  z.object({
    kind: z.literal('dinero').describe('Movimiento de dinero'),
    type: z.enum(['entrada', 'salida']),
    amount: z.number().positive().describe('Monto'),
    currency: z.enum(['USD', 'EUR', 'VES']).describe('VES = bolívares'),
    party: z.string().optional().describe('Donante (entrada) o destino (salida)'),
    notes: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha del movimiento, YYYY-MM-DD'),
  }),
]);

// Respuesta estándar de herramienta: texto + datos estructurados.
function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Construye un servidor MCP ligado al usuario autenticado.
 * Se crea uno por petición (modo stateless): es barato y garantiza que
 * cada llamada opera con la identidad correcta.
 */
function buildServer(user) {
  const server = new McpServer({ name: 'donativos-mcp-server', version: '1.0.0' });

  server.registerTool(
    'donativos_consultar_stock',
    {
      title: 'Consultar stock de bienes',
      description: `Devuelve el inventario actual de bienes del centro de acopio: cada artículo con su categoría, unidad, total de entradas, total de salidas y stock disponible.

Úsala antes de registrar movimientos para conocer los nombres exactos de los artículos del catálogo, o para responder preguntas como "¿cuánto arroz queda?".`,
      inputSchema: {
        filtro: z.string().optional()
          .describe('Texto para filtrar por nombre o categoría (ej: "arroz", "Medicinas"). Omitir para ver todo.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ filtro }) => {
      let stock = getStock();
      if (filtro) {
        const f = filtro.trim().toLowerCase();
        stock = stock.filter((r) =>
          r.name.toLowerCase().includes(f) || r.category.toLowerCase().includes(f));
      }
      return toolResult({ articulos: stock, total: stock.length });
    },
  );

  server.registerTool(
    'donativos_consultar_dinero',
    {
      title: 'Consultar dinero disponible',
      description: 'Devuelve el saldo de dinero por moneda (USD, EUR, VES): total recibido, total entregado y disponible.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult({ saldos: getMoneyBalances() }),
  );

  server.registerTool(
    'donativos_historial',
    {
      title: 'Ver historial de movimientos',
      description: 'Devuelve los movimientos más recientes (bienes o dinero), del más nuevo al más viejo, con quién los registró y donante/destino.',
      inputSchema: {
        tipo: z.enum(['bienes', 'dinero']).default('bienes').describe('Qué historial consultar'),
        limite: z.number().int().min(1).max(200).default(30).describe('Cuántos movimientos devolver'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tipo, limite }) => {
      const rows = tipo === 'bienes'
        ? db.prepare(`
            SELECT m.id, m.type, i.name AS item, m.quantity, i.unit, m.party, m.notes, m.date, u.name AS registrado_por
            FROM movements m JOIN items i ON i.id = m.item_id JOIN users u ON u.id = m.user_id
            ORDER BY m.date DESC, m.id DESC LIMIT ?
          `).all(limite)
        : db.prepare(`
            SELECT mm.id, mm.type, mm.amount, mm.currency, mm.party, mm.notes, mm.date, u.name AS registrado_por
            FROM money_movements mm JOIN users u ON u.id = mm.user_id
            ORDER BY mm.date DESC, mm.id DESC LIMIT ?
          `).all(limite);
      return toolResult({ movimientos: rows, total: rows.length });
    },
  );

  server.registerTool(
    'donativos_registrar_movimientos',
    {
      title: 'Registrar movimientos de donativos',
      description: `Registra uno o varios movimientos (entradas y salidas de bienes y/o dinero) en el inventario.

El lote es TRANSACCIONAL: si algún movimiento es inválido (p. ej. una salida mayor que el stock disponible), no se registra ninguno y el error indica cuál falló.

Antes de llamar: consulta donativos_consultar_stock para usar los nombres exactos del catálogo y no crear artículos duplicados. Confirma con el usuario los movimientos que vas a registrar antes de ejecutar esta herramienta.

Los movimientos quedan registrados a nombre de ${user.name} (dueño del token).`,
      inputSchema: {
        movimientos: z.array(movementSchema).min(1)
          .describe('Lista de movimientos a registrar'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ movimientos }) => {
      try {
        const results = importBatch(movimientos, user.id);
        return toolResult({ registrados: results.length, detalle: results });
      } catch (e) {
        return toolError(`${e.message}. No se registró ningún movimiento del lote (rollback completo).`);
      }
    },
  );

  return server;
}

/** Monta el endpoint /mcp en la app Express existente. */
export function mountMcp(app) {
  app.post('/mcp', async (req, res) => {
    const user = authenticateToken(req);
    if (!user) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Token no válido. Genera uno en la pestaña Cuenta de la app y envíalo como "Authorization: Bearer <token>".' },
        id: null,
      });
    }

    try {
      const server = buildServer(user);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: sin sesiones MCP
        enableJsonResponse: true,      // respuestas JSON simples, sin SSE
      });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('Error en /mcp:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Error interno del servidor MCP' },
          id: null,
        });
      }
    }
  });

  // En modo stateless no hay stream de servidor ni sesiones que borrar:
  // GET y DELETE no aplican.
  const methodNotAllowed = (req, res) => res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Método no permitido: este servidor MCP es stateless (solo POST)' },
    id: null,
  });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
