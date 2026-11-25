/**
 * API HTTP usada pela extensão. Toda rota (menos /health) exige
 * `Authorization: Bearer <KAPTION_TOKEN>`.
 *
 *   POST   /v1/schedules        cria (idempotente pelo `id` do pedido)
 *   GET    /v1/schedules?ids=a,b estados atuais
 *   DELETE /v1/schedules/:id    cancela, se ainda não começou a enviar
 *   GET    /v1/status           conexão do WhatsApp na Evolution API
 *   GET    /health              servidor no ar (sem dados)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { toEvolutionNumber } from './evolution.js';

const ID = /^[a-zA-Z0-9_-]{8,80}$/;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const fail = (status, message) => Object.assign(new Error(message), { status });

function sameToken(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw fail(413, `Pedido maior que ${Math.round(maxBytes / 1048576)} MB. Use um documento menor.`);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fail(400, 'JSON inválido.'); }
}

/** Visão pública de um agendamento (sem o conteúdo do arquivo). */
const view = item => item && {
  id: item.id, status: item.status, at: item.at, attempts: item.attempts, error: item.error,
  sentAt: item.sentAt, messageIds: item.messageIds, updatedAt: item.updatedAt,
};

export function validateSchedule(body, { now = Date.now, maxFileBytes }) {
  if (!body || typeof body !== 'object') throw fail(400, 'Pedido vazio.');
  const { id, to, chatName = null, text = '', at, attachment = null } = body;
  if (typeof id !== 'string' || !ID.test(id)) throw fail(400, 'Identificador do agendamento inválido.');
  let recipient;
  try { recipient = toEvolutionNumber(to); } catch { throw fail(400, 'Destinatário inválido. Abra a conversa no WhatsApp para a extensão identificar o número.'); }
  if (typeof text !== 'string' || text.length > 4096) throw fail(400, 'Mensagem inválida.');
  if (!Number.isFinite(at) || at <= now() - 60000) throw fail(400, 'Escolha um horário no futuro.');
  let file = null;
  let meta = null;
  if (attachment != null) {
    const { name, type = '', size, chunks } = attachment;
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || !Array.isArray(chunks) || !chunks.length ||
        chunks.some(chunk => typeof chunk !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk))) throw fail(400, 'Documento inválido.');
    file = Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')));
    if (!file.length || (Number.isSafeInteger(size) && size !== file.length)) throw fail(400, 'O documento não chegou inteiro. Anexe de novo.');
    if (file.length > maxFileBytes) throw fail(413, `Documento maior que ${Math.round(maxFileBytes / 1048576)} MB.`);
    meta = { name: name.trim(), type: String(type).slice(0, 120), size: file.length, sha256: crypto.createHash('sha256').update(file).digest('hex') };
  }
  if (!text.trim() && !file) throw fail(400, 'Escreva a mensagem ou anexe um documento.');
  return { item: { id, recipient, chatName: typeof chatName === 'string' ? chatName.slice(0, 200) : null, text: text.trim(), at, attachment: meta }, file };
}

export function createApp({ store, evolution, token, now = Date.now, maxFileBytes = 30 * 1048576, log = () => {} }) {
  const maxBody = Math.ceil(maxFileBytes * 1.4) + 1048576; // base64 + JSON

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    // CORS: a extensão chama do service worker; a origem é chrome-extension://.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return json(res, 204);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!sameToken(auth, token)) throw fail(401, 'Token da Kaption inválido.');

    if (req.method === 'GET' && url.pathname === '/v1/status') {
      let state;
      try { state = await evolution.state(); } catch (error) { return json(res, 200, { ok: false, state: 'unreachable', error: error.message }); }
      return json(res, 200, { ok: state === 'open', state, instance: evolution.instance?.() || null });
    }

    if (req.method === 'POST' && url.pathname === '/v1/schedules') {
      const body = await readJson(req, maxBody);
      const { item, file } = validateSchedule(body, { now, maxFileBytes });
      const existing = store.get(item.id);
      if (existing) {
        // Mesmo pedido repetido (resposta perdida): devolve o que já existe.
        const same = existing.recipient === item.recipient && existing.text === item.text && existing.at === item.at &&
          (existing.attachment?.sha256 || null) === (item.attachment?.sha256 || null);
        if (!same) throw fail(409, 'Este identificador já pertence a outro agendamento.');
        return json(res, 200, { item: view(existing) });
      }
      const saved = store.insert(item, file);
      log('agendada', saved.id, new Date(saved.at).toISOString());
      return json(res, 201, { item: view(saved) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/schedules') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(id => ID.test(id)).slice(0, 200);
      return json(res, 200, { items: store.list(ids).map(view) });
    }

    const match = /^\/v1\/schedules\/([a-zA-Z0-9_-]{8,80})$/.exec(url.pathname);
    if (match && req.method === 'GET') {
      const item = store.get(match[1]);
      if (!item) throw fail(404, 'Agendamento não encontrado.');
      return json(res, 200, { item: view(item) });
    }
    if (match && req.method === 'DELETE') {
      const item = store.get(match[1]);
      if (!item) return json(res, 200, { item: null });
      if (item.status === 'pending') {
        if (!store.claim(item.id, 'pending', 'canceled')) throw fail(409, 'O envio acabou de começar. Aguarde o resultado.');
        store.dropFile(item.id);
        return json(res, 200, { item: view(store.get(item.id)) });
      }
      if (item.status === 'sending') throw fail(409, 'O envio já começou. Aguarde o resultado antes de remover.');
      return json(res, 200, { item: view(item) }); // já terminou: nada a cancelar
    }
    throw fail(404, 'Rota não encontrada.');
  }

  return http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (!error.status) log('erro', error.stack || error.message);
      json(res, error.status || 500, { error: error.status ? error.message : 'Erro interno do servidor.' });
    });
  });
}
