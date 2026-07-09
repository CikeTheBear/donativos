// llm.js — Interpretación de donativos en lenguaje natural con Claude.
//
// El usuario pega texto libre ("50 kg de arroz de la iglesia, $200 en
// efectivo...") y Claude lo convierte en movimientos estructurados.
// Usamos "structured outputs" de la API: le pasamos un JSON Schema y la
// API GARANTIZA que la respuesta lo cumple — no hay que parsear texto
// con regex ni manejar respuestas malformadas.
//
// Importante: esta función solo PROPONE movimientos. Nunca escribe en la
// base de datos; eso ocurre en /api/import después de que un humano
// revisa y confirma. El LLM estructura, la persona decide.

import Anthropic from '@anthropic-ai/sdk';

// Schema de lo que Claude debe devolver. anyOf permite dos formas de
// movimiento (bienes y dinero) dentro del mismo array. Structured
// outputs exige additionalProperties:false y todos los campos required.
const MOVEMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['movements'],
  properties: {
    movements: {
      type: 'array',
      items: {
        anyOf: [
          {
            // Movimiento de bienes (comida, medicinas, ropa...)
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'type', 'item_name', 'category', 'unit', 'quantity', 'party', 'notes', 'date'],
            properties: {
              kind: { const: 'bien' },
              type: { type: 'string', enum: ['entrada', 'salida'] },
              item_name: { type: 'string', description: 'Nombre del artículo. Si coincide con uno del catálogo, usar EXACTAMENTE el nombre del catálogo.' },
              category: { type: 'string', description: 'Categoría: Alimentos, Medicinas, Ropa, Higiene, Agua, Refugio u otra.' },
              unit: { type: 'string', description: 'Unidad de medida: kg, unidades, litros, cajas, paquetes...' },
              quantity: { type: 'number' },
              party: { type: 'string', description: 'Donante (entrada) o destino (salida). Cadena vacía si no se menciona.' },
              notes: { type: 'string', description: 'Detalles extra que no caben en otros campos. Cadena vacía si no hay.' },
              date: { type: 'string', description: 'Fecha YYYY-MM-DD. Si el texto no la menciona, usar la fecha de hoy.' },
            },
          },
          {
            // Movimiento de dinero
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'type', 'amount', 'currency', 'party', 'notes', 'date'],
            properties: {
              kind: { const: 'dinero' },
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

/**
 * Interpreta texto libre y devuelve movimientos propuestos.
 * @param {string} text - El texto que pegó el usuario.
 * @param {Array} catalog - Artículos existentes, para que Claude reutilice
 *   nombres exactos en vez de crear duplicados ("Arroz" vs "arroz blanco").
 */
export async function parseDonations(text, catalog) {
  // El cliente lee ANTHROPIC_API_KEY del entorno automáticamente.
  const client = new Anthropic();

  const today = new Date().toISOString().slice(0, 10);

  const system = `Eres el asistente de registro de un centro de acopio de donativos
para la emergencia del terremoto de Venezuela. Convierte el texto del usuario en
movimientos de inventario estructurados.

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

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    output_config: { format: { type: 'json_schema', schema: MOVEMENTS_SCHEMA } },
    messages: [{ role: 'user', content: text }],
  });

  // stop_reason distinto de end_turn = respuesta incompleta o rechazada:
  // mejor fallar claro que devolver datos a medias.
  if (response.stop_reason !== 'end_turn') {
    throw new Error(`La interpretación no se completó (${response.stop_reason})`);
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return JSON.parse(textBlock.text).movements;
}
