/**
 * Serviço de integração com Banco Inter
 * Suporta OAuth 2.0 com mTLS para PIX e Boletos
 */

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const encryptionService = require('./encryption');

class InterBankService {
    constructor() {
        this.baseUrlSandbox = process.env.INTER_API_URL_SANDBOX || 'https://cdpj-sandbox.partners.uatinter.co';
        this.baseUrlProduction = process.env.INTER_API_URL_PRODUCTION || 'https://cdpj.partners.bancointer.com.br';
        this.tokenCache = new Map(); // Cache de tokens por empresa
    }

    /**
     * Obtém a URL base conforme ambiente
     */
    getBaseUrl(sandbox = false) {
        return sandbox ? this.baseUrlSandbox : this.baseUrlProduction;
    }

    /**
     * Descriptografa credenciais armazenadas (usa o serviço centralizado)
     */
    decryptCredential(encryptedValue) {
        // Se criptografia não estiver ativa, retorna o valor como está
        if (!encryptionService.isConfigured()) {
            return encryptedValue;
        }
        const decrypted = encryptionService.decrypt(encryptedValue);
        if (!decrypted) {
            // Se falhou ao descriptografar, assume que não está criptografado
            return encryptedValue;
        }
        return decrypted;
    }

    /**
     * Cria agente HTTPS com certificados mTLS
     */
    createHttpsAgent(certContent, keyContent) {
        return new https.Agent({
            cert: certContent,
            key: keyContent,
            rejectUnauthorized: true
        });
    }

    /**
     * Obtém token OAuth 2.0 do Banco Inter
     */
    async getAccessToken(empresaConfig) {
        const empresaId = empresaConfig.id;

        // Verifica cache
        const cached = this.tokenCache.get(empresaId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.accessToken;
        }

        try {
            console.log('🔐 Iniciando autenticação Inter para empresa:', empresaId);

            // Descriptografa credenciais
            const clientId = this.decryptCredential(empresaConfig.clientId);
            const clientSecret = this.decryptCredential(empresaConfig.clientSecret);

            console.log('📋 Credenciais obtidas:');
            console.log('   - Client ID length:', clientId?.length || 0);
            console.log('   - Client Secret length:', clientSecret?.length || 0);
            console.log('   - Chave PIX:', empresaConfig.chavePix || 'NÃO DEFINIDA');
            console.log('   - Sandbox:', empresaConfig.sandbox);
            console.log('   - Tem certBase64:', !!empresaConfig.certBase64);
            console.log('   - Tem keyBase64:', !!empresaConfig.keyBase64);

            // Lê certificados (podem estar em base64 no Firestore ou em arquivos)
            let certContent, keyContent;

            if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
                // Certificados armazenados em base64
                certContent = Buffer.from(empresaConfig.certBase64, 'base64').toString('utf8');
                keyContent = Buffer.from(empresaConfig.keyBase64, 'base64').toString('utf8');
                console.log('✅ Certificados carregados do Firestore');
                console.log('   - Cert length:', certContent?.length || 0);
                console.log('   - Key length:', keyContent?.length || 0);
            } else if (empresaConfig.certPath && empresaConfig.keyPath) {
                // Certificados em arquivos locais
                const certsDir = path.join(__dirname, '..', 'certs', empresaId);
                certContent = fs.readFileSync(path.join(certsDir, 'cert.crt'), 'utf8');
                keyContent = fs.readFileSync(path.join(certsDir, 'cert.key'), 'utf8');
                console.log('✅ Certificados carregados de arquivos locais');
            } else {
                console.error('❌ Certificados não encontrados!');
                throw new Error('Certificados não configurados para esta empresa');
            }

            const httpsAgent = this.createHttpsAgent(certContent, keyContent);
            const baseUrl = this.getBaseUrl(empresaConfig.sandbox);

            // Request de token
            const tokenUrl = `${baseUrl}/oauth/v2/token`;
            console.log('🌐 URL de token:', tokenUrl);

            const params = new URLSearchParams();
            params.append('client_id', clientId);
            params.append('client_secret', clientSecret);
            params.append('grant_type', 'client_credentials');
            params.append('scope', 'cob.write pix.write');

            console.log('📤 Enviando request de token...');

            const response = await axios.post(tokenUrl, params, {
                httpsAgent,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            const { access_token, expires_in } = response.data;

            // Armazena em cache
            this.tokenCache.set(empresaId, {
                accessToken: access_token,
                expiresAt: Date.now() + ((expires_in - 60) * 1000) // Expira 1 min antes
            });

            console.log(`✅ Token obtido para empresa ${empresaId}`);
            return access_token;

        } catch (error) {
            console.error(`❌ Erro ao obter token para empresa ${empresaId}:`);
            console.error('   - Mensagem:', error.message);
            if (error.response) {
                console.error('   - Status:', error.response.status);
                console.error('   - Data:', JSON.stringify(error.response.data));
            }
            throw new Error(`Falha na autenticação com Banco Inter: ${error.response?.data?.error_description || error.message}`);
        }
    }

    /**
     * Cria cobrança PIX imediata (cob)
     */
    async criarPixImediato(empresaConfig, dados) {
        const accessToken = await this.getAccessToken(empresaConfig);
        const baseUrl = this.getBaseUrl(empresaConfig.sandbox);

        // Descriptografa e prepara certificados
        let certContent, keyContent;
        if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
            certContent = Buffer.from(empresaConfig.certBase64, 'base64').toString('utf8');
            keyContent = Buffer.from(empresaConfig.keyBase64, 'base64').toString('utf8');
        }

        const httpsAgent = this.createHttpsAgent(certContent, keyContent);

        const txid = this.gerarTxId();
        const url = `${baseUrl}/pix/v2/cob/${txid}`;

        const payload = {
            calendario: {
                expiracao: dados.expiracao || 3600 // 1 hora padrão
            },
            devedor: {
                cpf: dados.pagador.cpf?.replace(/\D/g, ''),
                nome: dados.pagador.nome
            },
            valor: {
                original: dados.valor.toFixed(2)
            },
            chave: empresaConfig.chavePix,
            solicitacaoPagador: dados.descricao || 'Cobrança QUALIFY'
        };

        // Se for CNPJ ao invés de CPF
        if (dados.pagador.cnpj) {
            delete payload.devedor.cpf;
            payload.devedor.cnpj = dados.pagador.cnpj.replace(/\D/g, '');
        }

        try {
            const response = await axios.put(url, payload, {
                httpsAgent,
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const cobranca = response.data;

            return {
                txid: cobranca.txid,
                status: cobranca.status,
                qrcode: cobranca.pixCopiaECola,
                imagemQrcode: cobranca.imagemQrcode ?
                    `data:image/png;base64,${cobranca.imagemQrcode}` : null,
                valor: cobranca.valor?.original,
                criacao: cobranca.calendario?.criacao,
                expiracao: cobranca.calendario?.expiracao
            };

        } catch (error) {
            console.error('❌ Erro ao criar PIX:', error.response?.data || error.message);
            throw new Error(`Falha ao criar cobrança PIX: ${error.response?.data?.detail || error.message}`);
        }
    }

    /**
     * Cria cobrança PIX com vencimento (cobv)
     */
    async criarPixVencimento(empresaConfig, dados) {
        const accessToken = await this.getAccessToken(empresaConfig);
        const baseUrl = this.getBaseUrl(empresaConfig.sandbox);

        let certContent, keyContent;
        if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
            certContent = Buffer.from(empresaConfig.certBase64, 'base64').toString('utf8');
            keyContent = Buffer.from(empresaConfig.keyBase64, 'base64').toString('utf8');
        }

        const httpsAgent = this.createHttpsAgent(certContent, keyContent);

        const txid = this.gerarTxId();
        const url = `${baseUrl}/pix/v2/cobv/${txid}`;

        const payload = {
            calendario: {
                dataDeVencimento: dados.vencimento, // formato YYYY-MM-DD
                validadeAposVencimento: dados.diasAposVencimento || 30
            },
            devedor: {
                cpf: dados.pagador.cpf?.replace(/\D/g, ''),
                nome: dados.pagador.nome
            },
            valor: {
                original: dados.valor.toFixed(2)
            },
            chave: empresaConfig.chavePix,
            solicitacaoPagador: dados.descricao || 'Cobrança QUALIFY'
        };

        if (dados.pagador.cnpj) {
            delete payload.devedor.cpf;
            payload.devedor.cnpj = dados.pagador.cnpj.replace(/\D/g, '');
        }

        console.log('📤 Enviando requisição PIX para Banco Inter:');
        console.log('   - URL:', url);
        console.log('   - Payload:', JSON.stringify(payload, null, 2));

        try {
            const response = await axios.put(url, payload, {
                httpsAgent,
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('✅ Resposta do Banco Inter:', response.status);

            const cobranca = response.data;

            return {
                txid: cobranca.txid,
                status: cobranca.status,
                qrcode: cobranca.pixCopiaECola,
                imagemQrcode: cobranca.imagemQrcode ?
                    `data:image/png;base64,${cobranca.imagemQrcode}` : null,
                valor: cobranca.valor?.original,
                vencimento: cobranca.calendario?.dataDeVencimento
            };

        } catch (error) {
            console.error('❌ Erro ao criar PIX com vencimento:', error.response?.data || error.message);
            throw new Error(`Falha ao criar cobrança PIX: ${error.response?.data?.detail || error.message}`);
        }
    }

    /**
     * Consulta status de uma cobrança PIX
     */
    async consultarPix(empresaConfig, txid, tipo = 'cob') {
        const accessToken = await this.getAccessToken(empresaConfig);
        const baseUrl = this.getBaseUrl(empresaConfig.sandbox);

        let certContent, keyContent;
        if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
            certContent = Buffer.from(empresaConfig.certBase64, 'base64').toString('utf8');
            keyContent = Buffer.from(empresaConfig.keyBase64, 'base64').toString('utf8');
        }

        const httpsAgent = this.createHttpsAgent(certContent, keyContent);

        const endpoint = tipo === 'cobv' ? 'cobv' : 'cob';
        const url = `${baseUrl}/pix/v2/${endpoint}/${txid}`;

        try {
            const response = await axios.get(url, {
                httpsAgent,
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            const cobranca = response.data;

            // Mapeia status do Inter para status interno
            let statusInterno = 'pendente';
            if (cobranca.status === 'CONCLUIDA') statusInterno = 'paga';
            else if (cobranca.status === 'REMOVIDA_PELO_USUARIO_RECEBEDOR') statusInterno = 'cancelada';
            else if (cobranca.status === 'REMOVIDA_PELO_PSP') statusInterno = 'cancelada';

            return {
                txid: cobranca.txid,
                status: statusInterno,
                statusOriginal: cobranca.status,
                valor: cobranca.valor?.original,
                pix: cobranca.pix || [] // Array de pagamentos recebidos
            };

        } catch (error) {
            console.error('❌ Erro ao consultar PIX:', error.response?.data || error.message);
            throw new Error(`Falha ao consultar cobrança: ${error.response?.data?.detail || error.message}`);
        }
    }

    /**
     * Gera TXID único para PIX
     */
    gerarTxId() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let txid = '';
        for (let i = 0; i < 32; i++) {
            txid += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return txid;
    }

    /**
     * Limpa token do cache (útil quando credenciais são atualizadas)
     */
    limparCache(empresaId) {
        this.tokenCache.delete(empresaId);
        console.log(`🗑️ Cache de token limpo para empresa ${empresaId}`);
    }
}

module.exports = new InterBankService();
