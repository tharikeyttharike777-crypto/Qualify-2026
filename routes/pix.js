/**
 * Rotas de PIX
 * Endpoints para geração e consulta de cobranças PIX
 */

const express = require('express');
const router = express.Router();
const interBankService = require('../services/interBank');

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
                error: 'Configuração bancária não encontrada para esta empresa',
                code: 'BANK_CONFIG_NOT_FOUND',
                message: 'Configure as credenciais do Banco Inter em Configurações > Integrações Bancárias'
            });
        }

        const config = configDoc.data();

        if (!config.ativo) {
            return res.status(400).json({
                error: 'Integração bancária está desativada',
                code: 'BANK_INTEGRATION_DISABLED'
            });
        }

        // Adiciona ID da empresa ao config
        config.id = empresaId;
        req.bankConfig = config;
        next();

    } catch (error) {
        console.error('Erro ao carregar config bancária:', error);
        res.status(500).json({
            error: 'Erro ao carregar configuração bancária',
            code: 'BANK_CONFIG_ERROR'
        });
    }
}

/**
 * POST /api/pix/cob - Criar cobrança PIX imediata
 */
router.post('/cob', loadBankConfig, async (req, res) => {
    try {
        const { valor, descricao, pagador, expiracao } = req.body;

        // Validações
        if (!valor || valor <= 0) {
            return res.status(400).json({ error: 'Valor inválido' });
        }

        if (!pagador || (!pagador.cpf && !pagador.cnpj)) {
            return res.status(400).json({ error: 'CPF ou CNPJ do pagador é obrigatório' });
        }

        if (!pagador.nome) {
            return res.status(400).json({ error: 'Nome do pagador é obrigatório' });
        }

        // Cria cobrança no Banco Inter
        const resultado = await interBankService.criarPixImediato(req.bankConfig, {
            valor: parseFloat(valor),
            descricao,
            pagador,
            expiracao: expiracao || 3600
        });

        // Salva cobrança no Firestore
        const db = req.app.get('db');
        const empresaId = req.bankConfig.id;

        await db.collection('empresas').doc(empresaId)
            .collection('cobrancas').add({
                tipo: 'pix',
                tipoCobranca: 'imediata',
                txid: resultado.txid,
                invoiceId: req.body.invoiceId || resultado.txid,
                valor: parseFloat(valor),
                descricao,
                pagador,
                status: 'pendente',
                qrcode: resultado.qrcode,
                imagemQrcode: resultado.imagemQrcode,
                banco: 'inter',
                criadaEm: new Date(),
                expiracao: resultado.expiracao
            });

        res.json({
            success: true,
            txid: resultado.txid,
            qrcode: resultado.qrcode,
            imagemQrcode: resultado.imagemQrcode,
            status: resultado.status,
            valor: resultado.valor
        });

    } catch (error) {
        console.error('Erro ao criar PIX imediato:', error);
        res.status(500).json({
            error: error.message || 'Erro ao gerar cobrança PIX',
            code: 'PIX_CREATION_ERROR'
        });
    }
});

/**
 * POST /api/pix/cobv - Criar cobrança PIX com vencimento
 */
router.post('/cobv', loadBankConfig, async (req, res) => {
    try {
        const { valor, descricao, pagador, vencimento, diasAposVencimento, invoiceId } = req.body;

        // Validações
        if (!valor || valor <= 0) {
            return res.status(400).json({ error: 'Valor inválido' });
        }

        if (!vencimento) {
            return res.status(400).json({ error: 'Data de vencimento é obrigatória' });
        }

        if (!pagador || (!pagador.cpf && !pagador.cnpj)) {
            return res.status(400).json({ error: 'CPF ou CNPJ do pagador é obrigatório' });
        }

        // Cria cobrança no Banco Inter
        const resultado = await interBankService.criarPixVencimento(req.bankConfig, {
            valor: parseFloat(valor),
            descricao,
            pagador,
            vencimento,
            diasAposVencimento: diasAposVencimento || 30
        });

        // Salva cobrança no Firestore
        const db = req.app.get('db');
        const empresaId = req.bankConfig.id;

        await db.collection('empresas').doc(empresaId)
            .collection('cobrancas').add({
                tipo: 'pix',
                tipoCobranca: 'vencimento',
                txid: resultado.txid,
                invoiceId: invoiceId || resultado.txid,
                valor: parseFloat(valor),
                descricao,
                pagador,
                vencimento,
                status: 'pendente',
                qrcode: resultado.qrcode,
                imagemQrcode: resultado.imagemQrcode,
                banco: 'inter',
                criadaEm: new Date()
            });

        res.json({
            success: true,
            txid: resultado.txid,
            qrcode: resultado.qrcode,
            imagemQrcode: resultado.imagemQrcode,
            status: resultado.status,
            valor: resultado.valor,
            vencimento: resultado.vencimento
        });

    } catch (error) {
        console.error('Erro ao criar PIX com vencimento:', error);
        res.status(500).json({
            error: error.message || 'Erro ao gerar cobrança PIX',
            code: 'PIX_CREATION_ERROR'
        });
    }
});

/**
 * GET /api/pix/:txid - Consultar status de cobrança PIX
 */
router.get('/:txid', loadBankConfig, async (req, res) => {
    try {
        const { txid } = req.params;
        const tipo = req.query.tipo || 'cob';

        const resultado = await interBankService.consultarPix(req.bankConfig, txid, tipo);

        // Atualiza status no Firestore se mudou
        if (resultado.status === 'paga') {
            const db = req.app.get('db');
            const empresaId = req.bankConfig.id;

            const cobrancaRef = db.collection('empresas').doc(empresaId)
                .collection('cobrancas').where('txid', '==', txid);

            const snapshot = await cobrancaRef.get();

            if (!snapshot.empty) {
                const docRef = snapshot.docs[0].ref;
                await docRef.update({
                    status: 'paga',
                    dataPagamento: new Date(),
                    pixRecebidos: resultado.pix
                });
            }
        }

        res.json(resultado);

    } catch (error) {
        console.error('Erro ao consultar PIX:', error);
        res.status(500).json({
            error: error.message || 'Erro ao consultar cobrança',
            code: 'PIX_QUERY_ERROR'
        });
    }
});

module.exports = router;
