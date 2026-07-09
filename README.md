# Acopio — Donativos Venezuela

Control de inventario de donativos para la emergencia del terremoto de
Venezuela (junio 2026). Registra **entradas** (donaciones recibidas) y
**salidas** (despachos) de bienes y dinero; el stock se calcula solo a
partir de los movimientos, así que siempre hay trazabilidad completa.

## Stack

- **Backend:** Node.js + Express + SQLite (better-sqlite3)
- **Frontend:** HTML/CSS/JS vanilla, sin build step
- **Auth:** usuarios con contraseña (scrypt) y sesiones por cookie

Todo corre en un único proceso Node. La base de datos es un archivo
(`data/donativos.db`): respaldarla es copiar ese archivo.

## Ejecutar en local

```bash
npm install
npm start          # o `npm run dev` para reinicio automático al editar
```

Abre `http://localhost:3000`. En el primer arranque se crea el usuario
**admin** con contraseña `cambiame123` (o el valor de la variable de
entorno `ADMIN_PASSWORD` si está definida). **Cámbiala nada más entrar**
en la pestaña *Cuenta*.

## Roles

| Rol        | Puede                                                        |
|------------|--------------------------------------------------------------|
| voluntario | Registrar entradas/salidas, crear artículos, ver todo         |
| admin      | Todo lo anterior + gestionar usuarios y borrar movimientos    |

## Desplegar en internet

La app está lista para desplegarse en cualquier servicio que acepte un
Dockerfile (Railway, Fly.io, Render...). Puntos clave:

1. Define `ADMIN_PASSWORD` como variable de entorno antes del primer
   arranque (o cambia la contraseña por defecto de inmediato).
1. Para la función de registro con IA (opcional), define `LLM_API_KEY`
   (key de OpenRouter o de cualquier proveedor OpenAI-compatible).
   Opcionales: `LLM_BASE_URL` (default `https://openrouter.ai/api/v1`)
   y `LLM_MODEL` (default `anthropic/claude-haiku-4.5`). Sin key, la
   app funciona igual — solo esa función queda desactivada.
2. Monta un **volumen persistente** en `/app/data` — ahí vive la base de
   datos; sin volumen, se pierde en cada redeploy.
3. El servicio debe exponer el puerto de la variable `PORT` (Railway y
   Render la inyectan solos; la app la lee automáticamente).

## Estructura

```
donativos/
├── server/
│   ├── index.js    # servidor Express + rutas de la API
│   ├── db.js       # esquema SQLite + seed del admin inicial
│   └── auth.js     # contraseñas (scrypt) y sesiones
├── public/         # frontend estático (lo que ve el navegador)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── data/           # base de datos SQLite (gitignored)
└── Dockerfile
```

## Respaldo de datos

Copia `data/donativos.db` a un lugar seguro con regularidad. En un
despliegue Docker: `docker cp <contenedor>:/app/data/donativos.db .`
