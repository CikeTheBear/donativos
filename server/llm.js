// llm.js — Interpretación de donativos en lenguaje natural.
//
// Agnóstico de proveedor: habla el formato "OpenAI-compatible"
// (/chat/completions), que es el estándar de facto que exponen
// OpenRouter, Groq, Together, Ollama y compañía. El proveedor y el
// modelo se eligen por variables de entorno, sin tocar código:
//
//   LLM_BASE_URL  (default: https://openrouter.ai/api/v1)
//   LLM_API_KEY   (obligatoria — sin ella la función de IA se desactiva)
//   LLM_MODEL     (default: anthropic/claude-haiku-4.5, en ids de OpenRouter)
//
// Pedimos JSON con response_format json_schema, pero como su
// cumplimiento varía según modelo/proveedor, NO confiamos en él:
// validamos la respuesta con zod y fallamos claro si no cumple.
// La red de seguridad final sigue siendo la vista previa humana.

import { z } from 'zod';

const BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
const MODEL = process.env.LLM_MODEL || 'anthropic/claude-haiku-4.5';

// ── Validación con zod: la verdad sobre qué acepta la app ──────────
const goodsSchema = z.object({
  kind: z.literal('bien'),
  type: z.enum(['entrada', 'salida']),
  item_name: z.string().min(1),
  category: z.string(),
  unit: z.string(),
  quantity: z.number(),
  party: z.string(),
  notes: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const moneySchema = z.object({
  kind: z.literal('dinero'),
  type: z.enum(['entrada', 'salida']),
  amount: z.number(),
  currency: z.enum(['USD', 'EUR', 'VES']),
  party: z.string(),
  notes: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const responseSchema = z.object({
  movements: z.array(z.discriminatedUnion('kind', [goodsSchema, moneySchema])),
});

// ── JSON Schema para response_format (dialecto OpenAI "strict") ────
// Exige additionalProperties:false y todos los campos en required.
// Usamos enum de un valor en vez de const por compatibilidad: no todos
// los proveedores implementan const en modo estricto.
const MOVEMENTS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['movements'],
  properties: {
    movements: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'type', 'item_name', 'category', 'unit', 'quantity', 'party', 'notes', 'date'],
            properties: {
              kind: { type: 'string', enum: ['bien'] },
              type: { type: 'string', enum: ['entrada', 'salida'] },
              item_name: { type: 'string', description: 'Nombre del artículo. Si coincide con uno del catálogo, usar EXACTAMENTE el nombre del catálogo.' },
              category: { type: 'string', description: 'Alimentos, Medicinas, Ropa, Higiene, Agua, Refugio u otra.' },
              unit: { type: 'string', description: 'kg, unidades, litros, cajas, paquetes...' },
              quantity: { type: 'number' },
              party: { type: 'string', description: 'Donante (entrada) o destino (salida). Cadena vacía si no se menciona.' },
              notes: { type: 'string', description: 'Detalles extra. Cadena vacía si no hay.' },
              date: { type: 'string', description: 'YYYY-MM-DD. Si el texto no la menciona, la fecha de hoy.' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'type', 'amount', 'currency', 'party', 'notes', 'date'],
            properties: {
              kind: { type: 'string', enum: ['dinero'] },
              type: { type: 'string', enum: ['entrada', 'salida'] },
              amount: { type: 'number' },
              currency: { type: 'string', enum: ['USD', 'EUR', 'VES'] },
              party: { type: 'string' },
              notes: { type: 'string' },
              date: { type: 'string' },
            },
          },
        ],
      },
    },
  },
};

function buildSystemPrompt(catalog) {
  const today = new Date().toISOString().slice(0, 10);
  return `Eres el asistente de registro de un centro de acopio de donativos
para la emergencia del terremoto de Venezuela. Convierte el texto del usuario en
movimientos de inventario estructurados. Responde ÚNICAMENTE con el JSON pedido.

Reglas:
- Hoy es ${today}. Resuelve fechas relativas ("ayer", "el lunes") a YYYY-MM-DD.
- Si no se indica si es entrada o salida, asume "entrada" (lo habitual es registrar
  donaciones recibidas). Palabras como "enviamos", "despachamos", "entregamos"
  indican salida.
- "Bs", "bolívares" → VES. "$", "dólares" → USD. "€", "euros" → EUR.
- Si un artículo coincide con uno del catálogo (aunque esté escrito distinto:
  mayúsculas, plural, abreviado), usa EXACTAMENTE el nombre, categoría y unidad
  del catálogo. Solo inventa un artículo nuevo si de verdad no existe.
- No inventes cantidades: si una línea no tiene cantidad clara, usa 0 para que
  el humano la corrija en la revisión.

Catálogo actual de artículos:
${JSON.stringify(catalog)}`;
}

/**
 * Interpreta texto libre y devuelve movimientos propuestos (validados).
 * @param {string} text - El texto que pegó el usuario.
 * @param {Array} catalog - Artículos existentes, para reutilizar nombres.
 */
export async function parseDonations(text, catalog) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(catalog) },
        { role: 'user', content: text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'movimientos', strict: true, schema: MOVEMENTS_JSON_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    // Los proveedores OpenAI-compatibles devuelven { error: { message } }.
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `el proveedor LLM respondió ${res.status}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('el proveedor LLM devolvió una respuesta vacía');

  // Algunos modelos envuelven el JSON en un bloque markdown pese al
  // response_format: lo toleramos quitando el envoltorio si existe.
  const cleaned = content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('el modelo no devolvió JSON válido — reintenta o prueba otro modelo (LLM_MODEL)');
  }

  // Validación real: aquí es donde la app decide qué acepta, no el proveedor.
  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues[0];
    throw new Error(`el modelo devolvió una estructura inesperada (${detail.path.join('.')}: ${detail.message}) — reintenta o prueba otro modelo`);
  }

  return result.data.movements;
}
