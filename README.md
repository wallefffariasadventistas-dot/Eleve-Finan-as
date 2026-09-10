# Eleve — Sistema Financeiro Automatizado

Sistema pessoal para registrar despesas de **viagem**, **departamento** e **pessoais**,
lançadas automaticamente via WhatsApp (foto, áudio, comprovante ou texto) e sincronizadas
em tempo real via Firebase. Despesas de viagem e departamento são sempre reembolsáveis;
pessoais nunca são. Um clique envia as pendentes de reembolso por e-mail ou WhatsApp.

## Arquitetura

```
eleve/
├── functions/         Backend (Cloud Functions) — webhook do WhatsApp, IA, reembolso
│   └── src/
│       ├── whatsapp/  Recebimento e roteamento de mensagens
│       ├── ai/        Extração de dados de foto/PDF/texto/áudio (Claude + Google Speech)
│       ├── firestore/ Modelo de dados (despesas, relatórios de viagem, estado de conversa)
│       └── reimbursement/  Envio para reembolso (e-mail / WhatsApp)
├── webapp/            Frontend (Firebase Hosting) — dashboard, despesas, relatórios de viagem
├── firestore.rules    Regras de segurança do banco
└── storage.rules      Regras de segurança dos arquivos (recibos)
```

Fluxo de uma despesa enviada por WhatsApp:
1. Você manda foto/áudio/PDF/texto para o número do Eleve.
2. O webhook (`whatsappWebhook`) recebe, baixa a mídia e chama a IA (Claude lê imagem/PDF
   nativamente; áudio é transcrito primeiro pelo Google Speech-to-Text).
3. A IA devolve valor, data, categoria e (quando possível) o tipo de despesa.
4. Se faltar informação (tipo de despesa, relatório de viagem, ou valor incerto), o próprio
   WhatsApp pergunta de volta com botões.
5. A despesa é gravada no Firestore, o comprovante original vai para o Storage, e tudo aparece
   em tempo real no dashboard web (celular ou computador).
6. Quando quiser, envie as despesas pendentes de reembolso (viagem + departamento) para a
   secretária com um clique, por e-mail ou WhatsApp.

## Pré-requisitos

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- Uma conta Google/Firebase (você já tem o projeto criado)
- Uma conta no [Meta for Developers](https://developers.facebook.com/)

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

## 2. Configurar o WhatsApp (Meta Cloud API)

1. Crie um App em [developers.facebook.com/apps](https://developers.facebook.com/apps) →
   tipo "Business" → adicione o produto **WhatsApp**.
2. Em **WhatsApp > API Setup**, anote o **Phone Number ID** (número de testes já vem pronto
   para os primeiros envios; para produção, verifique um número de negócios).
3. Gere um **token de acesso** (comece com o temporário para testar; depois gere um
   [token permanente via System User](https://developers.facebook.com/docs/whatsapp/business-management-api/get-started)
   para produção).
4. Guarde o seu próprio número de WhatsApp (o que vai lançar despesas) em formato
   internacional só com dígitos, ex: `5511999999999` — é o `WHATSAPP_OWNER_NUMBER`.
5. Depois do primeiro `firebase deploy` (passo 4), volte aqui em **WhatsApp > Configuration**
   e configure o **Webhook**:
   - Callback URL: `https://<region>-<project-id>.cloudfunctions.net/whatsappWebhook`
   - Verify token: o mesmo valor que você definir em `WHATSAPP_VERIFY_TOKEN`
   - Inscreva-se no campo `messages`.

## 3. Configurar as credenciais do backend

Copie `functions/.env.example` para orientação e defina cada secret em produção:

```
cd functions
firebase functions:secrets:set WHATSAPP_TOKEN
firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
firebase functions:secrets:set WHATSAPP_VERIFY_TOKEN
firebase functions:secrets:set WHATSAPP_OWNER_NUMBER
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

Opcional (reembolso por WhatsApp para a secretária):
```
firebase functions:secrets:set WHATSAPP_SECRETARY_NUMBER
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

## 5. Testar

1. Abra a URL do Hosting, entre com o e-mail/senha criado no passo 1.
2. Pelo seu WhatsApp (o número em `WHATSAPP_OWNER_NUMBER`), mande uma foto de um recibo
   qualquer para o número de testes do WhatsApp Cloud API.
3. O bot deve responder perguntando o tipo de despesa (se não for óbvio) e confirmar o
   lançamento. A despesa aparece no dashboard em tempo real.

## Rodando localmente (emuladores, sem custo)

```
cd functions
npm run build:watch    # em um terminal
firebase emulators:start --only functions,firestore,storage,hosting   # em outro
```

O webhook do WhatsApp não alcança o emulador local diretamente (a Meta precisa de uma URL
pública) — para testar o fluxo de ponta a ponta durante o desenvolvimento, use um túnel
(ex: `ngrok http 5001`) apontando para a função local, ou teste chamando `enviarParaReembolso`
e as funções de Firestore direto pelo dashboard.
