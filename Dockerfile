FROM node:24-alpine
WORKDIR /app
# PORT: o Render define sozinho (padrão 10000). DATA_DIR: onde montar o disco persistente.
ENV NODE_ENV=production DATA_DIR=/data PORT=10000 TZ=America/Sao_Paulo
RUN apk add --no-cache tzdata && mkdir -p /data
COPY package.json ./
COPY src ./src
# Roda como root: o disco persistente do Render pode chegar sem permissão de
# escrita para outro usuário (a documentação não garante).
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
