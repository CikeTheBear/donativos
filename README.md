# Acopio

**Control de inventario de donativos para centros de acopio en emergencias.**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/noTeUd?referralCode=9xNKTS&utm_medium=integration&utm_source=template&utm_campaign=acopio)

Nacida durante la emergencia del terremoto de Venezuela (junio 2026), esta app
permite a cualquier centro de acopio llevar el registro de **entradas**
(donaciones recibidas) y **salidas** (despachos) de bienes y dinero, con
trazabilidad completa: el stock nunca se edita a mano, siempre se calcula a
partir de los movimientos, así que siempre se sabe quién registró qué, cuándo
y de dónde vino o a dónde fue.

## Funciones

- **Inventario de bienes** por artículo, categoría y unidad, y **dinero** por
  moneda (USD, EUR, VES), con historial completo de movimientos.
- **Multi-usuario** con dos roles: *voluntario* (registra) y *admin* (además
  gestiona usuarios y puede borrar registros).
- **Registro por lenguaje natural (opcional)**: pega una lista escrita a mano
  ("50 kg de arroz de la iglesia, $100 de María...") y un LLM la convierte en
  movimientos que revisas y confirmas. Compatible con cualquier proveedor
  OpenAI-compatible (OpenRouter, Groq, Ollama...). Nada se registra sin
  revisión humana.
- **Servidor MCP integrado** (`/mcp`): conecta un asistente de IA (Claude,
  Hermes, o cualquier cliente MCP) para consultar stock y registrar
  movimientos conversando. Autenticación por tokens personales que cada
  usuario gestiona desde la app.
- **Pensada para condiciones reales de emergencia**: funciona bien en
  teléfonos, no carga nada de internet salvo la propia app (útil con
  conexiones inestables), y la base de datos es un único archivo fácil de
  respaldar.

## Despliega tu propio centro

Cada centro de acopio corre su **propia instancia** con su propia base de
datos — tus datos son tuyos y de nadie más.

### Con un clic (recomendado)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/noTeUd?referralCode=9xNKTS&utm_medium=integration&utm_source=template&utm_campaign=acopio)

El template ya trae el volumen de datos y el dominio configurados. Solo te
pedirá la contraseña del admin y, opcionalmente, el nombre de tu centro.
Al terminar: entra con el usuario `admin`, crea a tus voluntarios en la
pestaña *Usuarios*, y a registrar.

### A mano (Railway u otro proveedor)

1. Haz fork de este repo (o úsalo directo).
2. En [railway.app](https://railway.app): **New Project → Deploy from GitHub
   repo** y elige el repo.
3. Añade un **Volume** montado en `/app/data` (crítico: sin él, los datos se
   pierden en cada redeploy).
4. En **Variables**, define:

   | Variable | Obligatoria | Descripción |
   |---|---|---|
   | `ADMIN_PASSWORD` | ✅ | Contraseña inicial del usuario `admin` |
   | `PORT` | ✅ | `3000` |
   | `CENTER_TITLE` | — | Nombre de tu centro/causa (ej: "Acopio San Cristóbal") |
   | `CENTER_SUBTITLE` | — | Subtítulo (ej: "Inundaciones · 2026") |
   | `LLM_API_KEY` | — | Key de OpenRouter (u otro) para el registro con IA |
   | `LLM_BASE_URL` | — | Default: `https://openrouter.ai/api/v1` |
   | `LLM_MODEL` | — | Default: `anthropic/claude-haiku-4.5` |

5. **Settings → Networking → Generate Domain** (puerto 3000).
6. Entra con usuario `admin` y tu `ADMIN_PASSWORD`, y crea los usuarios de
   tus voluntarios en la pestaña *Usuarios*.

Cualquier servicio que acepte un Dockerfile (Fly.io, Render, un VPS con
Docker) funciona igual: monta un volumen persistente en `/app/data` y define
las mismas variables.

### En local (desarrollo)

```bash
npm install
npm start        # http://localhost:3000 — admin / cambiame123
```

## Conectar un asistente de IA (MCP)

1. En la app: **Cuenta → Tokens de acceso (MCP) → Crear token**.
2. En tu cliente MCP, añade un servidor HTTP remoto:
   - URL: `https://TU-DOMINIO/mcp`
   - Header: `Authorization: Bearer <tu-token>`
   - (Clientes sin soporte de headers: `https://TU-DOMINIO/mcp?key=<tu-token>`)

Herramientas disponibles: `donativos_consultar_stock`,
`donativos_consultar_dinero`, `donativos_historial`,
`donativos_registrar_movimientos`, y (solo admins)
`donativos_borrar_movimientos` y `donativos_borrar_articulo`.

## Stack

Node.js + Express + SQLite (better-sqlite3), frontend vanilla sin build step,
sesiones por cookie con contraseñas scrypt. Un solo proceso, una sola
dependencia de infraestructura (un volumen para el archivo de BD).

```
donativos/
├── server/
│   ├── index.js      # Express + rutas de la API
│   ├── db.js         # esquema SQLite + seed del admin
│   ├── auth.js       # contraseñas y sesiones
│   ├── inventory.js  # lógica de inventario (compartida API/MCP)
│   ├── llm.js        # interpretación de texto libre (OpenAI-compatible)
│   └── mcp.js        # servidor MCP remoto + tokens
├── public/           # frontend estático
└── data/             # base de datos (gitignored — respalda este archivo)
```

## Respaldos

Toda la información vive en `data/donativos.db`. Respaldar = copiar ese
archivo. En Railway: `railway ssh -- cat /app/data/donativos.db > respaldo.db`
o descárgalo con el flujo que prefieras, con regularidad.

## Licencia

[MIT](LICENSE) — úsala, adáptala y compártela. Si le das uso en una
emergencia real, me alegra saberlo: [@CikeTheBear](https://github.com/CikeTheBear).
