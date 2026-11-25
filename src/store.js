/**
 * Agendamentos guardados em SQLite (node:sqlite, sem dependências). Os
 * documentos anexados ficam como arquivos na pasta de dados, ao lado do banco,
 * e são apagados quando o agendamento termina.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['pending', 'sending', 'sent', 'partial', 'failed', 'uncertain', 'missed', 'canceled'];
export const OPEN = new Set(['pending', 'sending']);

export function openStore({ dataDir, now = Date.now }) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'kaption.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      chat_name TEXT,
      text TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      attachment TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER,
      error TEXT,
      message_ids TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules (status, at);
  `);

  const fileOf = id => path.join(dataDir, 'files', `${id}.bin`);
  const row = r => r && {
    id: r.id, recipient: r.recipient, chatName: r.chat_name, text: r.text, at: r.at,
    attachment: r.attachment ? JSON.parse(r.attachment) : null, status: r.status, attempts: r.attempts,
    retryAt: r.retry_at, error: r.error, messageIds: r.message_ids ? JSON.parse(r.message_ids) : [],
    createdAt: r.created_at, updatedAt: r.updated_at, sentAt: r.sent_at,
  };

  const get = id => row(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));

  function insert(item, fileBytes) {
    if (fileBytes) fs.writeFileSync(fileOf(item.id), fileBytes);
    db.prepare(`INSERT INTO schedules (id, recipient, chat_name, text, at, attachment, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(item.id, item.recipient, item.chatName || null, item.text || '',
      item.at, item.attachment ? JSON.stringify(item.attachment) : null, now(), now());
    return get(item.id);
  }

  function update(id, changes) {
    const map = { status: 'status', attempts: 'attempts', retryAt: 'retry_at', error: 'error', sentAt: 'sent_at', messageIds: 'message_ids' };
    const keys = Object.keys(changes).filter(key => map[key]);
    if (!keys.length) return get(id);
    const values = keys.map(key => (key === 'messageIds' ? JSON.stringify(changes[key]) : changes[key] ?? null));
    db.prepare(`UPDATE schedules SET ${keys.map(key => `${map[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, now(), id);
    return get(id);
  }

  /** Troca de estado só se ainda estiver no esperado (evita dois envios). */
  function claim(id, from, to) {
    const result = db.prepare('UPDATE schedules SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, now(), id, from);
    return result.changes === 1;
  }

  const due = (at = now()) => db.prepare(`SELECT * FROM schedules WHERE status = 'pending' AND at <= ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY at`)
    .all(at, at).map(row);

  const list = ids => (ids?.length
    ? db.prepare(`SELECT * FROM schedules WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare('SELECT * FROM schedules ORDER BY at DESC LIMIT 200').all()).map(row);

  const readFile = id => fs.readFileSync(fileOf(id));
  const dropFile = id => fs.rmSync(fileOf(id), { force: true });

  /** Envio interrompido (servidor reiniciou no meio): pode ter saído, não repete. */
  function recover() {
    for (const item of db.prepare("SELECT * FROM schedules WHERE status = 'sending'").all().map(row)) {
      update(item.id, { status: 'uncertain', error: 'O servidor reiniciou durante o envio. Confira a conversa antes de reagendar.' });
    }
  }

  return { get, insert, update, claim, due, list, readFile, dropFile, recover, close: () => db.close() };
}
