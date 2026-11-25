import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createEvolution, toEvolutionNumber } from '../src/evolution.js';
import { createWorker } from '../src/worker.js';
import { createApp } from '../src/app.js';

const TOKEN = 'token-de-teste-com-mais-de-24-chars';

/** Evolution API falsa com as rotas reais da v2. */
async function fakeEvolution(t) {
  const calls = [];
  const state = { connection: 'open', fail: null, instances: [{ name: 'minha', connectionStatus: 'open' }] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = { method: req.method, url: req.url, apikey: req.headers.apikey, body: body ? JSON.parse(body) : null };
    calls.push(call);
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/instance/fetchInstances') return reply(200, state.instances);
    const conn = /^\/instance\/connectionState\/(.+)$/.exec(req.url);
    if (conn) return state.instances.some(i => i.name === decodeURIComponent(conn[1])) ? reply(200, { instance: { instanceName: conn[1], state: state.connection } }) : reply(404, { response: { message: ['not found'] } });
    const f = req.url.startsWith('/message/') ? state.fail : null;
    if (f) { if (f.once) state.fail = null; return f.hang ? undefined : reply(f.status, { response: { message: [f.message] } }); }
    if (req.url === '/message/sendText/minha' || req.url === '/message/sendMedia/minha') {
      return reply(201, { key: { remoteJid: `${call.body.number}@s.whatsapp.net`, fromMe: true, id: `MSG${calls.length}` }, status: 'PENDING' });
    }
    reply(404, { message: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, state };
}

async function setup(t, { clock = { now: Date.now() }, timeoutMs, instance = 'minha' } = {}) {
  const evo = await fakeEvolution(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaption-'));
  const now = () => clock.now;
  const store = openStore({ dataDir, now });
  const evolution = createEvolution({ url: evo.url, apiKey: 'evo-key', instance, timeoutMs });
  const worker = createWorker({ store, evolution, now, retryMs: 30000 });
  const app = createApp({ store, evolution, token: TOKEN, now, maxFileBytes: 2 * 1048576 });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => { app.close(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, route, body, token = TOKEN) => {
    const res = await fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { evo, store, worker, api, clock, dataDir };
}

test('destinatário: número, grupo e @lid no formato da Evolution', () => {
  assert.equal(toEvolutionNumber('556291949054@c.us'), '556291949054');
  assert.equal(toEvolutionNumber('+55 62 99194-9054'), '5562991949054');
  assert.equal(toEvolutionNumber('120363025246125486@g.us'), '120363025246125486@g.us');
  assert.equal(toEvolutionNumber('123456789012345@lid'), '123456789012345@lid');
  assert.throws(() => toEvolutionNumber('Fulano'), /inválido/);
});

test('agenda, envia na hora pela Evolution e informa "sent"', async (t) => {
  const h = await setup(t);
  const at = h.clock.now + 60000;
  const created = await h.api('POST', '/v1/schedules', { id: 'req-00000001', to: '556291949054@c.us', chatName: 'Cliente', text: 'Bom dia!', at });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.status, 'pending');

  await h.worker.tick();
  assert.equal(h.evo.calls.length, 0, 'antes da hora não chama a Evolution');

  h.clock.now = at + 1000;
  await h.worker.tick();
  const send = h.evo.calls.find(c => c.url === '/message/sendText/minha');
  assert.deepEqual(send.body, { number: '556291949054', text: 'Bom dia!' });
  assert.equal(send.apikey, 'evo-key');
  const { body } = await h.api('GET', '/v1/schedules?ids=req-00000001');
  assert.equal(body.items[0].status, 'sent');
  assert.equal(body.items[0].messageIds.length, 1);

  await h.worker.tick();
  assert.equal(h.evo.calls.filter(c => c.url.startsWith('/message/')).length, 1, 'nunca envia duas vezes');
});

test('pedido repetido (resposta perdida) não duplica; mesmo id com outro conteúdo é recusado', async (t) => {
  const h = await setup(t);
  const body = { id: 'req-00000002', to: '5562991949054', text: 'Oi', at: h.clock.now + 60000 };
  assert.equal((await h.api('POST', '/v1/schedules', body)).status, 201);
  assert.equal((await h.api('POST', '/v1/schedules', body)).status, 200);
  assert.equal((await h.api('POST', '/v1/schedules', { ...body, text: 'Outro' })).status, 409);
  assert.equal(h.store.list().length, 1);
});

test('sem token ou com token errado: 401; /health responde sem token', async (t) => {
  const h = await setup(t);
  assert.equal((await h.api('GET', '/v1/schedules', null, 'errado')).status, 401);
  assert.equal((await h.api('GET', '/health', null, '')).status, 200);
});

test('WhatsApp desconectado na Evolution: não envia e tenta de novo depois', async (t) => {
  const h = await setup(t);
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000003', to: '5562991949054', text: 'Oi', at });
  h.evo.state.connection = 'close';
  h.clock.now = at + 1000;
  await h.worker.tick();
  let item = h.store.get('req-00000003');
  assert.equal(item.status, 'pending');
  assert.match(item.error, /desconectado/);
  assert.equal(h.evo.calls.filter(c => c.url.startsWith('/message/')).length, 0);

  h.evo.state.connection = 'open';
  h.clock.now += 31000;
  await h.worker.tick();
  item = h.store.get('req-00000003');
  assert.equal(item.status, 'sent');
});

test('Evolution recusa (4xx): falha sem repetir; erro 5xx: "incerta", sem repetir', async (t) => {
  const h = await setup(t);
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000004', to: '5562988887777', text: 'Oi', at });
  h.evo.state.fail = { status: 400, message: 'exists: false', once: true };
  h.clock.now = at + 1000;
  await h.worker.tick();
  assert.equal(h.store.get('req-00000004').status, 'failed');
  assert.match(h.store.get('req-00000004').error, /400/);

  await h.api('POST', '/v1/schedules', { id: 'req-00000005', to: '5562988887777', text: 'Oi', at: h.clock.now + 1000 });
  h.evo.state.fail = { status: 500, message: 'boom', once: true };
  h.clock.now += 2000;
  await h.worker.tick();
  assert.equal(h.store.get('req-00000005').status, 'uncertain');
  h.clock.now += 60000;
  await h.worker.tick();
  assert.equal(h.evo.calls.filter(c => c.url === '/message/sendText/minha').length, 2, 'cada um tentou uma única vez');
});

test('Evolution não responde a tempo: "incerta" (pode ter saído), nunca repete', async (t) => {
  const h = await setup(t, { timeoutMs: 300 });
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000006', to: '5562991949054', text: 'Oi', at });
  h.evo.state.fail = { hang: true };
  h.clock.now = at + 1000;
  await h.worker.tick();
  assert.equal(h.store.get('req-00000006').status, 'uncertain');
});

test('fora do ar por mais que o limite: "missed", não envia atrasado', async (t) => {
  const h = await setup(t);
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000007', to: '5562991949054', text: 'Oi', at });
  h.clock.now = at + 31 * 60000;
  await h.worker.tick();
  assert.equal(h.store.get('req-00000007').status, 'missed');
  assert.equal(h.evo.calls.filter(c => c.url.startsWith('/message/')).length, 0);
});

test('cancelar antes da hora: não envia; cancelar o que já saiu não muda nada', async (t) => {
  const h = await setup(t);
  const at = h.clock.now + 60000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000008', to: '5562991949054', text: 'Oi', at });
  const del = await h.api('DELETE', '/v1/schedules/req-00000008');
  assert.equal(del.body.item.status, 'canceled');
  h.clock.now = at + 1000;
  await h.worker.tick();
  assert.equal(h.evo.calls.filter(c => c.url.startsWith('/message/')).length, 0);
});

test('texto + documento (em partes de base64): texto primeiro, depois o documento com nome e tipo', async (t) => {
  const h = await setup(t);
  const bytes = Buffer.from('%PDF-1.4 conteúdo de teste com acentuação ✓'.repeat(50));
  // Partes que não são múltiplas de 3 bytes: cada uma é base64 independente.
  const parts = [bytes.subarray(0, 100), bytes.subarray(100)].map(part => part.toString('base64'));
  const at = h.clock.now + 1000;
  const created = await h.api('POST', '/v1/schedules', { id: 'req-00000009', to: '120363025246125486@g.us', text: 'Segue o contrato',
    at, attachment: { name: 'Contrato.pdf', type: 'application/pdf', size: bytes.length, chunks: parts } });
  assert.equal(created.status, 201);
  h.clock.now = at + 1000;
  await h.worker.tick();
  const sends = h.evo.calls.filter(c => c.url.startsWith('/message/'));
  assert.deepEqual(sends.map(c => c.url), ['/message/sendText/minha', '/message/sendMedia/minha']);
  const media = sends[1].body;
  assert.equal(media.number, '120363025246125486@g.us', 'grupo');
  assert.equal(media.mediatype, 'document');
  assert.equal(media.fileName, 'Contrato.pdf');
  assert.equal(media.mimetype, 'application/pdf');
  assert.ok(Buffer.from(media.media, 'base64').equals(bytes), 'arquivo íntegro');
  assert.equal(h.store.get('req-00000009').status, 'sent');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'files', 'req-00000009.bin')), false, 'arquivo apagado após o envio');
});

test('documento falha sem chegar à Evolution: repete só o documento, sem repetir o texto', async (t) => {
  const h = await setup(t);
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000010', to: '5562991949054', text: 'Segue',
    at, attachment: { name: 'a.pdf', type: 'application/pdf', chunks: [Buffer.from('abc').toString('base64')] } });
  h.clock.now = at + 1000;
  // Texto passa; o documento recebe 429 (limite), que não é definitivo.
  let n = 0;
  const original = h.evo.state;
  Object.defineProperty(original, 'fail', { configurable: true, get() { return n++ === 1 ? { status: 429, message: 'rate' } : null; }, set() {} });
  await h.worker.tick();
  assert.equal(h.store.get('req-00000010').status, 'pending');
  h.clock.now += 31000;
  await h.worker.tick();
  const sends = h.evo.calls.filter(c => c.url.startsWith('/message/')).map(c => c.url);
  assert.deepEqual(sends, ['/message/sendText/minha', '/message/sendMedia/minha', '/message/sendMedia/minha']);
  assert.equal(h.store.get('req-00000010').status, 'sent');
});

test('reinício no meio de um envio: vira "incerta", nunca reenvia sozinho', async (t) => {
  const h = await setup(t);
  await h.api('POST', '/v1/schedules', { id: 'req-00000011', to: '5562991949054', text: 'Oi', at: h.clock.now + 1000 });
  h.store.claim('req-00000011', 'pending', 'sending');
  h.store.recover();
  assert.equal(h.store.get('req-00000011').status, 'uncertain');
});

test('validação: horário passado, sem conteúdo e documento grande são recusados', async (t) => {
  const h = await setup(t);
  assert.equal((await h.api('POST', '/v1/schedules', { id: 'req-00000012', to: '5562991949054', text: 'Oi', at: h.clock.now - 120000 })).status, 400);
  assert.equal((await h.api('POST', '/v1/schedules', { id: 'req-00000013', to: '5562991949054', text: '  ', at: h.clock.now + 1000 })).status, 400);
  assert.equal((await h.api('POST', '/v1/schedules', { id: 'req-00000014', to: 'Fulano', text: 'Oi', at: h.clock.now + 1000 })).status, 400);
  const big = Buffer.alloc(3 * 1048576, 1).toString('base64');
  assert.equal((await h.api('POST', '/v1/schedules', { id: 'req-00000015', to: '5562991949054', at: h.clock.now + 1000,
    attachment: { name: 'g.bin', chunks: [big] } })).status, 413);
});

test('/v1/status mostra a conexão do WhatsApp na Evolution', async (t) => {
  const h = await setup(t);
  assert.deepEqual((await h.api('GET', '/v1/status')).body, { ok: true, state: 'open', instance: 'minha' });
  h.evo.state.connection = 'connecting';
  assert.deepEqual((await h.api('GET', '/v1/status')).body, { ok: false, state: 'connecting', instance: 'minha' });
});

test('sem EVOLUTION_INSTANCE: usa sozinho a única instância conectada', async (t) => {
  const h = await setup(t, { instance: null });
  h.evo.state.instances = [{ name: 'antiga', connectionStatus: 'close' }, { name: 'minha', connectionStatus: 'open' }];
  assert.deepEqual((await h.api('GET', '/v1/status')).body, { ok: true, state: 'open', instance: 'minha' });
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000020', to: '5562991949054', text: 'Oi', at });
  h.clock.now = at + 1000;
  await h.worker.tick();
  assert.equal(h.store.get('req-00000020').status, 'sent');
  assert.ok(h.evo.calls.some(c => c.url === '/message/sendText/minha'));
});

test('sem instância conectada: não envia e explica; várias conectadas: pede para escolher', async (t) => {
  const h = await setup(t, { instance: null });
  h.evo.state.instances = [{ name: 'minha', connectionStatus: 'close' }];
  const status = (await h.api('GET', '/v1/status')).body;
  assert.equal(status.ok, false);
  assert.match(status.error, /Nenhuma instância conectada/);
  const at = h.clock.now + 1000;
  await h.api('POST', '/v1/schedules', { id: 'req-00000021', to: '5562991949054', text: 'Oi', at });
  h.clock.now = at + 1000;
  await h.worker.tick();
  assert.equal(h.store.get('req-00000021').status, 'pending', 'espera reconectar');
  assert.equal(h.evo.calls.filter(c => c.url.startsWith('/message/')).length, 0);

  h.evo.state.instances = [{ name: 'a', connectionStatus: 'open' }, { name: 'b', connectionStatus: 'open' }];
  assert.match((await h.api('GET', '/v1/status')).body.error, /2 instâncias conectadas \(a, b\)/);
});
