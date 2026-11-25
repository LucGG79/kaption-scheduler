/**
 * Kaption Scheduler — envia as mensagens agendadas pela Evolution API.
 *
 * Variáveis de ambiente:
 *   KAPTION_TOKEN        senha que a extensão usa (obrigatória, 24+ caracteres)
 *   EVOLUTION_URL        ex.: https://evolution.seudominio.com
 *   EVOLUTION_API_KEY    chave da Evolution (global ou da instância)
 *   EVOLUTION_INSTANCE   opcional: nome da instância (sem ela, usa a única conectada)
 *   DATA_DIR             pasta do banco e dos documentos (padrão /data; no Render, o Disk)
 *   PORT                 o Render define (padrão 10000)
 *   MAX_LATE_MINUTES     até quanto tempo depois do horário ainda envia (padrão 30)
 *   MAX_FILE_MB          tamanho máximo do documento (padrão 30)
 */

import fs from 'node:fs';
import path from 'node:path';
import { openStore } from './store.js';
import { createEvolution } from './evolution.js';
import { createWorker } from './worker.js';
import { createApp } from './app.js';

const env = process.env;
const missing = ['KAPTION_TOKEN', 'EVOLUTION_URL', 'EVOLUTION_API_KEY'].filter(key => !env[key]);
if (missing.length) {
  console.error(`[kaption] Faltam variáveis de ambiente: ${missing.join(', ')}`);
  process.exit(1);
}
if (env.KAPTION_TOKEN.length < 24) {
  console.error('[kaption] KAPTION_TOKEN precisa de pelo menos 24 caracteres (gere com: openssl rand -hex 24).');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), '[kaption]', ...args);
const dataDir = env.DATA_DIR || '/data';
// Sem gravar no disco, a fila se perderia num reinício: melhor nem subir.
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.write-test'), String(Date.now()));
  fs.rmSync(path.join(dataDir, '.write-test'));
} catch (error) {
  console.error(`[kaption] Não consigo gravar em ${dataDir} (${error.message}). No Render, adicione um Disk com Mount Path ${dataDir}.`);
  process.exit(1);
}
const store = openStore({ dataDir });
store.recover();
const evolution = createEvolution({ url: env.EVOLUTION_URL, apiKey: env.EVOLUTION_API_KEY, instance: env.EVOLUTION_INSTANCE });
const worker = createWorker({ store, evolution, log, maxLateMs: Number(env.MAX_LATE_MINUTES || 30) * 60000 });
const app = createApp({ store, evolution, token: env.KAPTION_TOKEN, log, maxFileBytes: Number(env.MAX_FILE_MB || 30) * 1048576 });

const port = Number(env.PORT || 10000);
app.listen(port, () => log(`no ar na porta ${port}, instância: ${env.EVOLUTION_INSTANCE || 'a conectada (automático)'}`));
const timer = setInterval(() => worker.tick().catch(error => log('erro no ciclo', error.message)), 5000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(timer);
    app.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
