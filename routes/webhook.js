/**
 * Rotas de Webhook
 * Recebe notificações de pagamento dos bancos
 */

const express = require('express');
const router = express.Router();

/**
 * POST /api/webhook/inter/pix
 * Webhook do Banco Inter para notificações PIX
 */
router.post('/inter/pix', async (req, res) => {
    try {
        console.log('📨 Webhook PIX recebido:', JSON.stringify(req.body, null, 2));

        const { pix } = req.body;

        if (!pix || !Array.isArray(pix)) {
            return res.status(200).send('OK'); // Inter espera 200 mesmo sem dados
        }

        const db = req.app.get('db');

        for (const pagamento of pix) {
            const { txid, valor, horario, pagador } = pagamento;

            if (!txid) continue;

            console.log(`💰 Pagamento PIX recebido: ${txid} - R$ ${valor}`);

            // Busca cobrança em todas as empresas (webhook não envia empresaId)
            // Isso é uma limitação - idealmente, usaríamos um identificador no txid
            const empresasSnapshot = await db.collection('empresas').get();

            for (const empresaDoc of empresasSnapshot.docs) {
                const cobrancaSnapshot = await db.collection('empresas')
                    .doc(empresaDoc.id)
                    .collection('cobrancas')
                    .where('txid', '==', txid)
                    .get();

                if (!cobrancaSnapshot.empty) {
                    const cobrancaRef = cobrancaSnapshot.docs[0].ref;

                    await cobrancaRef.update({
                        status: 'paga',
                        dataPagamento: new Date(horario),
                        valorPago: parseFloat(valor),
                        pagadorInfo: pagador || null,
                        webhookRecebido: new Date()
                    });

                    console.log(`✅ Cobrança ${txid} marcada como PAGA (empresa: ${empresaDoc.id})`);
                    break;
                }
            }
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Erro ao processar webhook PIX:', error);
        res.status(200).send('OK'); // Retorna 200 para evitar retentativas
    }
});

/**
 * POST /api/webhook/inter/boleto
 * Webhook do Banco Inter para notificações de Boleto
 */
router.post('/inter/boleto', async (req, res) => {
    try {
        console.log('📨 Webhook Boleto recebido:', JSON.stringify(req.body, null, 2));

        // TODO: Implementar processamento de webhook de boleto
        // Estrutura similar ao PIX

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Erro ao processar webhook Boleto:', error);
        res.status(200).send('OK');
    }
});

/**
 * GET /api/webhook/health
 * Verificação de saúde para webhooks
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        endpoints: {
            'inter/pix': 'ativo',
            'inter/boleto': 'ativo'
        }
    });
});

module.exports = router;
