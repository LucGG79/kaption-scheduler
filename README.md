# Kaption Scheduler

Envia as mensagens agendadas da extensão Kaption pela **Evolution API**, na hora marcada,
sem depender do computador ligado. Sem dependências externas (Node 24 + SQLite embutido).

## Como funciona

1. Na extensão, com "Enviar agendamentos pelo servidor" ativo, o agendamento (texto e
   documento) vai para este servidor.
2. A cada 5 segundos o servidor envia o que venceu: confere se o WhatsApp está conectado
   na Evolution e chama `sendText` / `sendMedia`.
3. A extensão acompanha o estado (Agendada → Enviada) e avisa quando termina.

Regras de segurança contra mensagem duplicada:
- Se a Evolution **com certeza não recebeu** o pedido (sem conexão, WhatsApp desconectado,
  limite 429), o servidor tenta de novo a cada 30 s.
- Se o pedido **pode ter chegado** (sem resposta, erro 5xx, servidor reiniciado no meio),
  vira "Confira a conversa" e **não** é repetido.
- Se passar de `MAX_LATE_MINUTES` (padrão 30) sem conseguir enviar, vira "Prazo encerrado":
  nada sai fora de hora.

## Instalação no Render (1 clique)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/LucGG79/kaption-scheduler)

1. Clique no botão acima (entre na sua conta do Render).
2. Preencha **EVOLUTION_URL** (endereço da sua Evolution) e **EVOLUTION_API_KEY**
   (variável `AUTHENTICATION_API_KEY` do serviço da Evolution, aba Environment).
   A instância é descoberta sozinha (a única conectada); o `KAPTION_TOKEN` é gerado sozinho.
3. **Apply**. Já vem com plano pago Starter e disco de 1 GB em `/data` (o gratuito dorme e
   apaga a fila, não serve).
4. Quando ficar "Live": copie o **endereço** do serviço e o **KAPTION_TOKEN** (aba Environment).

Observações do Render: com disco, cada deploy deixa o serviço fora do ar por alguns segundos
(o que vencer nesse intervalo sai logo em seguida).

## Na extensão

Configurações da Kaption → **Envio pelo servidor (Evolution API)**:
endereço do servidor + token → **Testar conexão** (deve mostrar "Servidor e WhatsApp
conectados") → ative a chave → Salvar.

## API (usada pela extensão)

Todas as rotas, menos `/health`, exigem `Authorization: Bearer <KAPTION_TOKEN>`.

| Método | Rota | O quê |
|---|---|---|
| POST | `/v1/schedules` | cria `{ id, to, chatName, text, at, attachment? }` (idempotente pelo `id`) |
| GET | `/v1/schedules?ids=a,b` | estados |
| DELETE | `/v1/schedules/:id` | cancela se ainda não começou |
| GET | `/v1/status` | conexão do WhatsApp na Evolution |
| GET | `/health` | servidor no ar |

## Testes

`npm test` (nesta pasta) — usa uma Evolution API simulada com as rotas reais da v2.
