/**
 * Rotas de Configuração Bancária
 * Endpoints para gerenciar credenciais bancárias por empresa
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const encryptionService = require('../services/encryption');
const interBankService = require('../services/interBank');

// Configuração do Multer para upload de certificados
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 // 50KB máximo para certificados
    },
    fileFilter: (req, file, cb) => {
        // Aceita .crt, .key, .pem
        const allowedExtensions = ['.crt', '.key', '.pem'];
        const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));

        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não permitido. Use .crt, .key ou .pem'));
        }
    }
});

/**
 * GET /api/config/:empresaId/bancaria
 * Retorna configuração bancária (sem dados sensíveis)
 */
router.get('/:empresaId/bancaria', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const db = req.app.get('db');

        const configRef = db.collection('empresas').doc(empresaId)
            .collection('configuracaoBancaria').doc('inter');

        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            return res.json({
                configurado: false,
                banco: null
            });
        }

        const config = configDoc.data();

        // Diagnóstico detalhado (sem expor dados sensíveis)
        const diagnostico = {
            clientIdLength: config.clientId?.length || 0,
            clientSecretLength: config.clientSecret?.length || 0,
            certBase64Length: config.certBase64?.length || 0,
            keyBase64Length: config.keyBase64?.length || 0,
            ultimoTesteStatus: config.ultimoTesteStatus || null,
            ultimoTesteErro: config.ultimoTesteErro || null
        };

        // Retorna dados públicos apenas
        res.json({
            configurado: true,
            banco: 'inter',
            ativo: config.ativo || false,
            chavePix: config.chavePix || null,
            sandbox: config.sandbox || false,
            temCertificado: !!(config.certBase64 && config.keyBase64),
            temCredenciais: !!(config.clientId && config.clientSecret),
            ultimoTeste: config.ultimoTeste || null,
            atualizadoEm: config.atualizadoEm || null,
            diagnostico: diagnostico
        });

    } catch (error) {
        console.error('Erro ao buscar config:', error);
        res.status(500).json({ error: 'Erro ao buscar configuração' });
    }
});

/**
 * POST /api/config/:empresaId/bancaria/inter
 * Salva ou atualiza configuração do Banco Inter
 */
router.post('/:empresaId/bancaria/inter',
    upload.fields([
        { name: 'certificado', maxCount: 1 },
        { name: 'chavePrivada', maxCount: 1 }
    ]),
    async (req, res) => {
        try {
            const { empresaId } = req.params;
            const { clientId, clientSecret, chavePix, sandbox } = req.body;
            const db = req.app.get('db');

            // Busca configuração existente
            const configRef = db.collection('empresas').doc(empresaId)
                .collection('configuracaoBancaria').doc('inter');
            const existingDoc = await configRef.get();
            const existingConfig = existingDoc.exists ? existingDoc.data() : {};

            // Validações - só exige se não tem credenciais salvas
            const temCredenciaisSalvas = !!(existingConfig.clientId && existingConfig.clientSecret);

            if (!clientId && !temCredenciaisSalvas) {
                return res.status(400).json({
                    error: 'Client ID é obrigatório'
                });
            }

            if (!clientSecret && !temCredenciaisSalvas) {
                return res.status(400).json({
                    error: 'Client Secret é obrigatório'
                });
            }

            if (!chavePix) {
                return res.status(400).json({
                    error: 'Chave PIX é obrigatória'
                });
            }

            // Prepara dados para salvar (mantém existentes se não enviados)
            const configData = {
                banco: 'inter',
                clientId: clientId ? encryptionService.encrypt(clientId) : existingConfig.clientId,
                clientSecret: clientSecret ? encryptionService.encrypt(clientSecret) : existingConfig.clientSecret,
                chavePix: chavePix,
                sandbox: sandbox === 'true' || sandbox === true,
                ativo: false, // Será ativado após teste
                atualizadoEm: new Date()
            };

            // Processa certificados se enviados (mantém existentes se não enviados)
            if (req.files) {
                if (req.files.certificado && req.files.certificado[0]) {
                    const certBuffer = req.files.certificado[0].buffer;
                    configData.certBase64 = certBuffer.toString('base64');
                } else if (existingConfig.certBase64) {
                    configData.certBase64 = existingConfig.certBase64;
                }

                if (req.files.chavePrivada && req.files.chavePrivada[0]) {
                    const keyBuffer = req.files.chavePrivada[0].buffer;
                    configData.keyBase64 = keyBuffer.toString('base64');
                } else if (existingConfig.keyBase64) {
                    configData.keyBase64 = existingConfig.keyBase64;
                }
            } else {
                // Mantém certificados existentes se não foram enviados novos
                if (existingConfig.certBase64) configData.certBase64 = existingConfig.certBase64;
                if (existingConfig.keyBase64) configData.keyBase64 = existingConfig.keyBase64;
            }

            // Salva no Firestore
            await configRef.set(configData, { merge: true });

            // Limpa cache de tokens
            interBankService.limparCache(empresaId);

            res.json({
                success: true,
                message: 'Configuração salva. Execute o teste de conexão para ativar.',
                temCertificado: !!(configData.certBase64 && configData.keyBase64)
            });

        } catch (error) {
            console.error('Erro ao salvar config:', error);
            res.status(500).json({ error: error.message || 'Erro ao salvar configuração' });
        }
    }
);

/**
 * POST /api/config/:empresaId/bancaria/testar
 * Testa conexão com o banco
 */
router.post('/:empresaId/bancaria/testar', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const db = req.app.get('db');

        // Busca configuração
        const configRef = db.collection('empresas').doc(empresaId)
            .collection('configuracaoBancaria').doc('inter');

        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            return res.status(404).json({
                error: 'Configuração não encontrada',
                success: false
            });
        }

        const config = configDoc.data();
        config.id = empresaId;

        // Tenta obter token (isso valida credenciais e certificados)
        await interBankService.getAccessToken(config);

        // Se chegou aqui, conexão OK - ativa integração
        await configRef.update({
            ativo: true,
            ultimoTeste: new Date(),
            ultimoTesteStatus: 'sucesso'
        });

        res.json({
            success: true,
            message: 'Conexão com Banco Inter estabelecida com sucesso!',
            ativo: true
        });

    } catch (error) {
        console.error('Erro no teste de conexão:', error);

        // Salva falha no Firestore
        try {
            const db = req.app.get('db');
            const { empresaId } = req.params;

            await db.collection('empresas').doc(empresaId)
                .collection('configuracaoBancaria').doc('inter')
                .update({
                    ativo: false,
                    ultimoTeste: new Date(),
                    ultimoTesteStatus: 'falha',
                    ultimoTesteErro: error.message
                });
        } catch (e) {
            console.error('Erro ao salvar status de falha:', e);
        }

        res.status(400).json({
            success: false,
            error: error.message || 'Falha na conexão com Banco Inter',
            details: 'Verifique Client ID, Client Secret e certificados'
        });
    }
});

/**
 * GET /api/config/:empresaId/bancaria/debug
 * Endpoint de diagnóstico para verificar estado das credenciais
 */
router.get('/:empresaId/bancaria/debug', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const db = req.app.get('db');

        const configRef = db.collection('empresas').doc(empresaId)
            .collection('configuracaoBancaria').doc('inter');

        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            return res.json({ error: 'Configuração não encontrada' });
        }

        const config = configDoc.data();

        // Testa descriptografia
        const encryptionActive = encryptionService.isConfigured();
        let clientIdDecrypted = null;
        let clientSecretDecrypted = null;
        let decryptError = null;

        try {
            clientIdDecrypted = encryptionService.decrypt(config.clientId);
            clientSecretDecrypted = encryptionService.decrypt(config.clientSecret);
        } catch (e) {
            decryptError = e.message;
        }

        res.json({
            encryptionKeyConfigured: encryptionActive,
            clientId: {
                storedLength: config.clientId?.length || 0,
                decryptedLength: clientIdDecrypted?.length || 0,
                decryptedPreview: clientIdDecrypted ? clientIdDecrypted.substring(0, 8) + '...' : null
            },
            clientSecret: {
                storedLength: config.clientSecret?.length || 0,
                decryptedLength: clientSecretDecrypted?.length || 0,
                decryptSuccess: !!clientSecretDecrypted
            },
            certificates: {
                certBase64Length: config.certBase64?.length || 0,
                keyBase64Length: config.keyBase64?.length || 0
            },
            chavePix: config.chavePix,
            sandbox: config.sandbox,
            decryptError: decryptError
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/config/:empresaId/bancaria/inter
 * Remove configuração bancária
 */
router.delete('/:empresaId/bancaria/inter', async (req, res) => {
    try {
        const { empresaId } = req.params;
        const db = req.app.get('db');

        await db.collection('empresas').doc(empresaId)
            .collection('configuracaoBancaria').doc('inter')
            .delete();

        // Limpa cache
        interBankService.limparCache(empresaId);

        res.json({
            success: true,
            message: 'Configuração removida com sucesso'
        });

    } catch (error) {
        console.error('Erro ao remover config:', error);
        res.status(500).json({ error: 'Erro ao remover configuração' });
    }
});

/**
 * GET /api/config/:empresaId/bancos-disponiveis
 * Lista bancos disponíveis para integração
 */
router.get('/:empresaId/bancos-disponiveis', (req, res) => {
    res.json({
        bancos: [
            {
                id: 'inter',
                nome: 'Banco Inter',
                logo: '/assets/images/bancos/inter.png',
                funcionalidades: ['pix', 'boleto'],
                status: 'disponivel',
                requerCertificado: true
            },
            {
                id: 'asaas',
                nome: 'Asaas',
                logo: '/assets/images/bancos/asaas.png',
                funcionalidades: ['pix', 'boleto', 'cartao'],
                status: 'em_breve',
                requerCertificado: false
            },
            {
                id: 'pagarme',
                nome: 'Pagar.me',
                logo: '/assets/images/bancos/pagarme.png',
                funcionalidades: ['pix', 'boleto', 'cartao'],
                status: 'em_breve',
                requerCertificado: false
            }
        ]
    });
});

module.exports = router;
