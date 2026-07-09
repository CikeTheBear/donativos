# Imagen de producción para Railway / Fly.io / Render.
# alpine = variante mínima de Linux; suficiente porque la app no
# necesita nada del sistema más allá de Node.
FROM node:22-alpine

WORKDIR /app

# Copiamos primero solo los manifests e instalamos dependencias:
# Docker cachea esta capa y no reinstala nada si solo cambió el código.
COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# La BD vive en /app/data — montar ahí un volumen persistente al
# desplegar (en Railway se configura en su UI, no aquí: su builder
# rechaza la directiva VOLUME de Docker).
EXPOSE 3000
CMD ["node", "server/index.js"]
