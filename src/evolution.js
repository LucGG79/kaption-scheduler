/**
 * Cliente da Evolution API v2 (conferido no código-fonte oficial):
 *   POST /message/sendText/{instância}   { number, text }
 *   POST /message/sendMedia/{instância}  { number, mediatype, mimetype, fileName, caption, media(base64) }
 *   GET  /instance/connectionState/{instância} → { instance: { state: 'open' | 'connecting' | 'close' } }
 *   GET  /instance/fetchInstances → [{ name, connectionStatus, … }] (sem instância configurada:
 *        usa a única conectada)
 * Autenticação pelo cabeçalho `apikey`.
 *
 * Erros carregam `sent`: false quando com certeza não saiu (pode repetir);
 * 'maybe' quando o pedido chegou e a resposta se perdeu (não repete).
 */

export class EvolutionError extends Error {
  constructor(message, { sent = false, status = null, permanent = false } = {}) {
    super(message);
    Object.assign(this, { sent, status, permanent });
  }
}

/** Destino no formato que a Evolution aceita: número, grupo (@g.us) ou @lid. */
export function toEvolutionNumber(recipient) {
  const value = String(recipient ?? '').trim();
  if (/^[\d-]+@g\.us$/.test(value) || /^\d+@lid$/.test(value)) return value;
  const user = value.replace(/@(c\.us|s\.whatsapp\.net)$/, '').replace(/\D/g, '');
  if (user.length < 8 || user.length > 15) throw new EvolutionError('Destinatário inválido.', { permanent: true });
  return user;
}

export function createEvolution({ url, apiKey, instance, fetchImpl = fetch, timeoutMs = 30000 }) {
  const base = String(url || '').replace(/\/+$/, '');
  let found = instance || null; // configurada ou descoberta

  async function call(method, route, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method, headers: { apikey: apiKey, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Sem conexão (DNS, recusada): não chegou. Prazo esgotado: pode ter chegado.
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new EvolutionError(timedOut ? 'A Evolution API não respondeu a tempo.' : `Não foi possível falar com a Evolution API: ${error.message}`,
        { sent: timedOut ? 'maybe' : false });
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const detail = typeof data === 'object' ? JSON.stringify(data?.response?.message ?? data?.message ?? data).slice(0, 300) : String(data).slice(0, 300);
      // 4xx: a Evolution recusou o pedido (número sem WhatsApp, chave errada…): não saiu.
      // 5xx: falha interna; pode ter sido depois de entregar ao WhatsApp.
      throw new EvolutionError(`Evolution API respondeu ${response.status}: ${detail}`,
        { sent: response.status >= 500 ? 'maybe' : false, status: response.status, permanent: response.status >= 400 && response.status < 500 && response.status !== 429 });
    }
    return data;
  }

  const messageId = data => data?.key?.id || data?.message?.key?.id || null;

  /** Instância a usar: a configurada ou, sem ela, a única conectada (open). */
  async function instanceName() {
    if (found) return encodeURIComponent(found);
    const list = await call('GET', '/instance/fetchInstances');
    const all = (Array.isArray(list) ? list : []).map(item => item?.instance || item).filter(item => item?.name);
    const open = all.filter(item => (item.connectionStatus || item.status || item.state) === 'open');
    if (open.length === 1) { found = open[0].name; return encodeURIComponent(found); }
    if (!open.length) throw new EvolutionError(all.length ? `Nenhuma instância conectada na Evolution (${all.map(i => i.name).join(', ')}).` : 'Nenhuma instância na Evolution.', { status: 'no_instance' });
    throw new EvolutionError(`Há ${open.length} instâncias conectadas (${open.map(i => i.name).join(', ')}). Defina EVOLUTION_INSTANCE com a do seu número.`, { status: 'many_instances', permanent: true });
  }

  return {
    async state() {
      let data;
      try {
        data = await call('GET', `/instance/connectionState/${await instanceName()}`);
      } catch (error) {
        // Instância descoberta sumiu (renomeada/recriada): procura de novo na próxima.
        if (error.status === 404 && !instance) found = null;
        throw error;
      }
      return data?.instance?.state || data?.state || 'unknown';
    },
    instance: () => found,
    async sendText(recipient, text) {
      return messageId(await call('POST', `/message/sendText/${await instanceName()}`, { number: toEvolutionNumber(recipient), text }));
    },
    async sendDocument(recipient, { name: fileName, type, base64, caption }) {
      const mime = type || 'application/octet-stream';
      const mediatype = /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : 'document';
      return messageId(await call('POST', `/message/sendMedia/${await instanceName()}`, {
        number: toEvolutionNumber(recipient), mediatype, mimetype: mime, fileName, media: base64,
        ...(caption ? { caption } : {}),
      }));
    },
  };
}
