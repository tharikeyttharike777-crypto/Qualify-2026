/**
 * Rotas de Boleto
 * Endpoints para geração e consulta de boletos
 * TODO: Implementar integração completa com Banco Inter
 */

const express = require('express');
const router = express.Router();

/**
 * Middleware para carregar configuração bancária da empresa
 */
async function loadBankConfig(req, res, next) {
    try {
        const empresaId = req.body.empresaId || req.query.empresaId || req.params.empresaId;

        if (!empresaId) {
            return res.status(400).json({
                error: 'empresaId é obrigatório',
                code: 'MISSING_COMPANY_ID'
            });
        }

        const db = req.app.get('db');
        const configRef = db.collection('empresas').doc(empresaId)
            .collection('configuracaoBancaria').doc('inter');

        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            return res.status(404).json({
                error: 'Configuração bancária não encontrada',
                code: 'BANK_CONFIG_NOT_FOUND'
            });
        }

        const config = configDoc.data();
        config.id = empresaId;
        req.bankConfig = config;
        next();

    } catch (error) {
        console.error('Erro ao carregar config:', error);
        res.status(500).json({ error: 'Erro ao carregar configuração bancária' });
    }
}

/**
 * POST /api/boleto - Criar boleto
 */
router.post('/', loadBankConfig, async (req, res) => {
    try {
        const { valor, descricao, pagador, vencimento } = req.body;

        // Validações básicas
        if (!valor || valor <= 0) {
            return res.status(400).json({ error: 'Valor inválido' });
        }

        if (!vencimento) {
            return res.status(400).json({ error: 'Data de vencimento é obrigatória' });
        }

        // TODO: Implementar integração com API de Boletos do Banco Inter
        // Por enquanto, retorna placeholder

        const nossoNumero = `QUALIFY${Date.now()}`;

        // Salva no Firestore
        const db = req.app.get('db');
        const empresaId = req.bankConfig.id;

        const docRef = await db.collection('empresas').doc(empresaId)
            .collection('cobrancas').add({
                tipo: 'boleto',
                nossoNumero,
                valor: parseFloat(valor),
                descricao,
                pagador,
                vencimento,
                status: 'pendente',
                banco: 'inter',
                criadaEm: new Date()
            });

        res.json({
            success: true,
            id: docRef.id,
            nossoNumero,
            message: 'Boleto criado - integração completa em desenvolvimento',
            linhaDigitavel: null, // Será preenchido quando integração estiver completa
            codigoBarras: null,
            pdfUrl: null
        });

    } catch (error) {
        console.error('Erro ao criar boleto:', error);
        res.status(500).json({ error: error.message || 'Erro ao gerar boleto' });
    }
});

/**
 * GET /api/boleto/:nossoNumero - Consultar boleto
 */
router.get('/:nossoNumero', loadBankConfig, async (req, res) => {
    try {
        const { nossoNumero } = req.params;
        const db = req.app.get('db');
        const empresaId = req.bankConfig.id;

        const snapshot = await db.collection('empresas').doc(empresaId)
            .collection('cobrancas')
            .where('nossoNumero', '==', nossoNumero)
            .get();

        if (snapshot.empty) {
            return res.status(404).json({ error: 'Boleto não encontrado' });
        }

        const boleto = snapshot.docs[0].data();
        boleto.id = snapshot.docs[0].id;

        res.json(boleto);

    } catch (error) {
        console.error('Erro ao consultar boleto:', error);
        res.status(500).json({ error: 'Erro ao consultar boleto' });
    }
});

module.exports = router;
