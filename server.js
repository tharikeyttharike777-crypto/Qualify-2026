/**
 * QUALIFY Banking API - Servidor Principal
 * Backend para integrações bancárias multi-tenant
 * Suporta: Banco Inter, extensível para outros
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');

// Inicialização do Firebase Admin
const initFirebaseAdmin = () => {
    try {
        const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
        const serviceAccount = require(serviceAccountPath);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        console.log('✅ Firebase Admin inicializado com sucesso');
        return admin.firestore();
    } catch (error) {
        console.error('❌ Erro ao inicializar Firebase Admin:', error.message);
        console.log('⚠️  Certifique-se de que o arquivo serviceAccountKey.json existe no diretório backend/');
        process.exit(1);
    }
};

const db = initFirebaseAdmin();

// Inicialização do Express
const app = express();

// Middleware de CORS - permite todas as origens em desenvolvimento
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500').split(',');
app.use(cors({
    origin: (origin, callback) => {
        // Em desenvolvimento, permite qualquer origem (incluindo file://)
        if (process.env.NODE_ENV === 'development' || !origin) {
            return callback(null, true);
        }

        if (allowedOrigins.some(allowed => origin.startsWith(allowed.trim()))) {
            return callback(null, true);
        }

        console.warn(`⚠️ CORS bloqueou origem: ${origin}`);
        return callback(new Error('Não permitido por CORS'), false);
    },
    credentials: true
}));

// Parsing de JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Disponibiliza db globalmente para as rotas
app.set('db', db);

// Rotas
const pixRoutes = require('./routes/pix');
const boletoRoutes = require('./routes/boleto');
const configRoutes = require('./routes/config');
const webhookRoutes = require('./routes/webhook');

app.use('/api/pix', pixRoutes);
app.use('/api/boleto', boletoRoutes);
app.use('/api/config', configRoutes);
app.use('/api/webhook', webhookRoutes);

// Rota de health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: {
            firebase: !!db,
            inter: true,
            asaas: false // Placeholder para expansão futura
        }
    });
});

// Rota de status de invoice (compatibilidade com pix-checkout.js existente)
app.get('/api/invoices/:invoiceId/status', async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const empresaId = req.query.empresaId;

        if (!empresaId) {
            return res.status(400).json({ error: 'empresaId é obrigatório' });
        }

        // Busca cobrança no Firestore
        const cobrancaRef = db.collection('empresas').doc(empresaId)
            .collection('cobrancas').where('invoiceId', '==', invoiceId);

        const snapshot = await cobrancaRef.get();

        if (snapshot.empty) {
            return res.status(404).json({ error: 'Cobrança não encontrada' });
        }

        const cobranca = snapshot.docs[0].data();

        res.json({
            invoiceId,
            status: cobranca.status || 'pendente',
            valor: cobranca.valor,
            dataPagamento: cobranca.dataPagamento || null
        });

    } catch (error) {
        console.error('Erro ao consultar status:', error);
        res.status(500).json({ error: 'Erro interno ao consultar status' });
    }
});

// Middleware de tratamento de erros
app.use((err, req, res, next) => {
    console.error('❌ Erro não tratado:', err);
    res.status(500).json({
        error: 'Erro interno do servidor',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Rota 404
app.use((req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
});

// Inicialização do servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║          QUALIFY Banking API - v1.0.0                      ║
╠════════════════════════════════════════════════════════════╣
║  🚀 Servidor rodando em: http://localhost:${PORT}             ║
║  📦 Ambiente: ${(process.env.NODE_ENV || 'development').padEnd(42)}║
║  🔐 Firebase: Conectado                                    ║
║  🏦 Bancos suportados: Inter (+ extensível)                ║
╚════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
