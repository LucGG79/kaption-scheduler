/**
 * Executor: a cada poucos segundos envia o que venceu. Um item por vez, com
 * a troca pending → sending gravada antes de chamar a Evolution, para que dois
 * ciclos (ou um reinício) nunca enviem a mesma mensagem duas vezes.
 */

export function createWorker({ store, evolution, now = Date.now, maxLateMs = 30 * 60000, retryMs = 30000, maxAttempts = 10, log = () => {} }) {
  let running = false;

  async function sendOne(item) {
    if (!store.claim(item.id, 'pending', 'sending')) return;
    const attempts = item.attempts + 1;
    store.update(item.id, { attempts, error: null });
    const ids = [...item.messageIds];
    const textDone = ids.length > 0; // texto já saiu numa tentativa anterior
    try {
      if (item.text && !textDone) ids.push(await evolution.sendText(item.recipient, item.text) || 'sem-id');
      if (item.attachment) {
        try {
          const base64 = store.readFile(item.id).toString('base64');
          ids.push(await evolution.sendDocument(item.recipient, { ...item.attachment, base64 }) || 'sem-id');
        } catch (error) {
          if (item.text) {
            // Texto entregue, documento não: não repete o texto.
            store.update(item.id, { messageIds: ids });
            if (error.sent === false && !error.permanent) throw Object.assign(error, { keepText: true });
            store.update(item.id, { status: 'partial', error: `Texto enviado, mas o documento não: ${error.message}` });
            log('parcial', item.id, error.message);
            return;
          }
          throw error;
        }
      }
      store.update(item.id, { status: 'sent', sentAt: now(), messageIds: ids, error: null });
      store.dropFile(item.id);
      log('enviada', item.id);
    } catch (error) {
      if (error.sent === false && !error.permanent && attempts < maxAttempts && now() - item.at < maxLateMs) {
        store.update(item.id, { status: 'pending', retryAt: now() + retryMs, error: error.message, ...(error.keepText ? { messageIds: ids } : {}) });
        log('nova tentativa', item.id, error.message);
      } else if (error.sent === 'maybe') {
        store.update(item.id, { status: 'uncertain', error: `${error.message} Pode ter sido enviada: confira a conversa antes de reagendar.` });
        log('incerta', item.id, error.message);
      } else {
        store.update(item.id, { status: 'failed', error: error.message });
        store.dropFile(item.id);
        log('falhou', item.id, error.message);
      }
    }
  }

  /** Um ciclo: confere a conexão uma vez e envia o que venceu. */
  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = store.due(now());
      if (!due.length) return;
      for (const item of due) {
        if (now() - item.at > maxLateMs) {
          store.update(item.id, { status: 'missed', error: `O WhatsApp ficou indisponível por mais de ${Math.round(maxLateMs / 60000)} min depois do horário. A mensagem não foi enviada fora de hora; reagende.` });
          store.dropFile(item.id);
        }
      }
      const ready = store.due(now());
      if (!ready.length) return;
      let state = 'unknown';
      try { state = await evolution.state(); } catch (error) { state = `erro: ${error.message}`; }
      if (state !== 'open') {
        // Sem conexão com o WhatsApp: nada é enviado; tenta de novo depois.
        for (const item of ready) store.update(item.id, { retryAt: now() + retryMs, error: `WhatsApp desconectado na Evolution API (${state}). Tentando de novo.` });
        return;
      }
      for (const item of ready) await sendOne(item);
    } finally {
      running = false;
    }
  }

  return { tick };
}
