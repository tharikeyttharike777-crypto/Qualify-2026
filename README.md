# Backend QUALIFY Banking API

## Descrição
Backend Node.js/Express para integrações bancárias multi-tenant do sistema QUALIFY.

## Requisitos
- Node.js 18+
- Firebase Admin SDK (serviceAccountKey.json)
- Certificados mTLS do Banco Inter (por empresa)

## Instalação

```bash
cd backend
npm install
```

## Configuração

1. Copie `.env.example` para `.env`:
```bash
cp .env.example .env
```

2. Edite o `.env` com suas configurações

3. Baixe o arquivo `serviceAccountKey.json` do Firebase Console:
   - Acesse: Console Firebase > Configurações > Contas de Serviço
   - Clique em "Gerar nova chave privada"
   - Salve como `backend/serviceAccountKey.json`

4. Gere uma chave de encriptação:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Executar

```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

O servidor estará disponível em `http://localhost:4000`

## Endpoints

### Health Check
- `GET /api/health` - Status do servidor

### PIX
- `POST /api/pix/cob` - Criar cobrança PIX imediata
- `POST /api/pix/cobv` - Criar cobrança PIX com vencimento
- `GET /api/pix/:txid` - Consultar status de cobrança

### Boleto
- `POST /api/boleto` - Criar boleto
- `GET /api/boleto/:nossoNumero` - Consultar boleto

### Configuração
- `GET /api/config/:empresaId/bancaria` - Ver configuração
- `POST /api/config/:empresaId/bancaria/inter` - Salvar credenciais Inter
- `POST /api/config/:empresaId/bancaria/testar` - Testar conexão
- `DELETE /api/config/:empresaId/bancaria/inter` - Remover configuração

### Webhooks
- `POST /api/webhook/inter/pix` - Receber notificações PIX
- `POST /api/webhook/inter/boleto` - Receber notificações Boleto

## Estrutura de Pastas

```
backend/
├── package.json
├── server.js           # Servidor Express
├── .env.example        # Exemplo de variáveis de ambiente
├── routes/
│   ├── pix.js         # Rotas PIX
│   ├── boleto.js      # Rotas Boleto
│   ├── config.js      # Rotas de Configuração
│   └── webhook.js     # Webhooks
├── services/
│   ├── interBank.js   # Cliente Banco Inter
│   └── encryption.js  # Serviço de encriptação
└── README.md
```

## Configuração Multi-Empresa

Cada empresa configura suas próprias credenciais no Firestore:

```
empresas/{empresaId}/configuracaoBancaria/inter
{
  clientId: "encrypted...",
  clientSecret: "encrypted...",
  chavePix: "email@empresa.com",
  certBase64: "...",
  keyBase64: "...",
  ativo: true,
  sandbox: false
}
```

## Segurança

- Credenciais são encriptadas com AES antes de salvar
- Certificados são armazenados em base64 no Firestore
- CORS configurado para domínios permitidos
- Firebase Admin SDK para autenticação
