FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Versiones exactas del lockfile y sin scripts de instalación (los módulos nativos traen binarios precompilados).
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY proto ./proto
# Sin privilegios de root dentro del contenedor.
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
