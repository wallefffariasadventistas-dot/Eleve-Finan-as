# Eleve — Sistema Financeiro Automatizado

Sistema pessoal para registrar despesas de **viagem**, **departamento** e **pessoais**,
lançadas automaticamente via Telegram (foto, nota de voz, comprovante ou texto) e sincronizadas
em tempo real via Firebase. Despesas de viagem e departamento são sempre reembolsáveis;
pessoais nunca são. Um clique envia as pendentes de reembolso por e-mail.

## Arquitetura

```
eleve/
├── functions/         Backend (Cloud Functions) — webhook do Telegram, IA, reembolso
│   └── src/
│       ├── telegram/  Recebimento e roteamento de mensagens
│       ├── ai/        Extração de dados de foto/PDF/texto/áudio (Claude + Google Speech)
│       ├── firestore/ Modelo de dados (despesas, relatórios de viagem, estado de conversa)
│       └── reimbursement/  Envio para reembolso (e-mail)
├── webapp/            Frontend (Firebase Hosting) — dashboard, despesas, relatórios de viagem
├── firestore.rules    Regras de segurança do banco
└── storage.rules      Regras de segurança dos arquivos (recibos)
```

Fluxo de uma despesa enviada por Telegram:
1. Você manda foto/nota de voz/PDF/texto para o seu bot no Telegram.
2. O webhook (`telegramWebhook`) recebe, baixa a mídia e chama a IA (Claude lê imagem/PDF
   nativamente; áudio é transcrito primeiro pelo Google Speech-to-Text).
3. A IA devolve valor, data, categoria e (quando possível) o tipo de despesa.
4. Se faltar informação (tipo de despesa, relatório de viagem, ou valor incerto), o próprio
   bot pergunta de volta com botões.
5. A despesa é gravada no Firestore, o comprovante original vai para o Storage, e tudo aparece
   em tempo real no dashboard web (celular ou computador).
6. Quando quiser, envie as despesas pendentes de reembolso (viagem + departamento) para a
   secretária com um clique, por e-mail.

## Pré-requisitos

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- Uma conta Google/Firebase (você já tem o projeto criado)
- Um bot no Telegram, criado pelo [@BotFather](https://t.me/BotFather)

## 1. Configurar o Firebase

No [console do Firebase](https://console.firebase.google.com/), no seu projeto:

1. **Authentication** → Sign-in method → ative **E-mail/senha** → crie um usuário para você
   (esse é o único login do sistema).
2. **Firestore Database** → criar banco (modo produção, região `southamerica-east1` ou a mais
   próxima de você).
3. **Storage** → ativar (mesma região do Firestore).
4. **Configurações do projeto** → **Seus apps** → adicionar um app **Web** → copie o objeto de
   configuração e cole em `webapp/js/firebase-config.js`.
5. Atualize `.firebaserc` com o `projectId` do seu projeto.
6. Faça login e vincule o projeto localmente:
   ```
   firebase login
   firebase use --add
   ```

## 2. Criar o bot no Telegram

1. No Telegram, procure **@BotFather** e mande `/newbot`. Escolha um nome e um username
   terminado em "bot" (ex: `EleveSevenBot`).
2. Ele devolve um **token** de acesso à API — é o `TELEGRAM_BOT_TOKEN`.
3. Mande qualquer mensagem para o seu bot novo, depois procure **@userinfobot**, mande
   `/start` e anote o **Id** numérico que ele devolve — é o `TELEGRAM_OWNER_CHAT_ID` (só esse
   chat consegue lançar despesas pelo bot).
4. Escolha uma frase qualquer só sua para ser o `TELEGRAM_WEBHOOK_SECRET` (usado só para o
   Telegram provar que é ele quem está chamando o webhook, não precisa decorar).

## 3. Configurar as credenciais do backend

```
cd functions
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
firebase functions:secrets:set TELEGRAM_OWNER_CHAT_ID
firebase functions:secrets:set TELEGRAM_WEBHOOK_SECRET
firebase functions:secrets:set ANTHROPIC_API_KEY
```

Opcional (reembolso por e-mail):
```
firebase functions:secrets:set SMTP_HOST
firebase functions:secrets:set SMTP_PORT
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
firebase functions:secrets:set SECRETARY_EMAIL
firebase functions:secrets:set FROM_EMAIL
```

A chave da Anthropic (Claude) é gerada em [console.anthropic.com](https://console.anthropic.com/settings/keys).
A transcrição de áudio usa o Google Cloud Speech-to-Text, que já vem habilitado
automaticamente para o mesmo projeto do Firebase — não precisa de chave extra, só ative a
API "Cloud Speech-to-Text" uma vez em console.cloud.google.com para o seu projeto.

## 4. Instalar dependências e publicar

```
cd functions && npm install && cd ..
firebase deploy
```

Isso publica as Cloud Functions, o frontend (Hosting) e as regras de segurança.
A URL do dashboard será `https://<project-id>.web.app`.

## 5. Registrar o webhook do bot

Depois do deploy, aponte o bot para a Cloud Function (troque `<TOKEN>`, `<SECRET>` e a URL
pela sua):

```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<region>-<project-id>.cloudfunctions.net/telegramWebhook" \
  -d "secret_token=<SECRET>"
```

`<SECRET>` é o mesmo valor que você definiu em `TELEGRAM_WEBHOOK_SECRET`.

## 6. Testar

1. Abra a URL do Hosting, entre com o e-mail/senha criado no passo 1.
2. Pelo Telegram, mande uma foto de um recibo qualquer para o seu bot.
3. O bot deve responder perguntando o tipo de despesa (se não for óbvio) e confirmar o
   lançamento. A despesa aparece no dashboard em tempo real.

## Rodando localmente (emuladores, sem custo)

```
cd functions
npm run build:watch    # em um terminal
firebase emulators:start --only functions,firestore,storage,hosting   # em outro
```

O webhook do Telegram não alcança o emulador local diretamente (o Telegram precisa de uma URL
pública) — para testar o fluxo de ponta a ponta durante o desenvolvimento, use um túnel
(ex: `ngrok http 5001`) apontando para a função local e registre esse túnel como webhook
temporário, ou teste chamando `enviarParaReembolso` e as funções de Firestore direto pelo
dashboard.
