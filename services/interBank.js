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
            console.warn('⚠️ Criptografia NÃO está ativa - retornando valor original');
            return encryptedValue;
        }

        try {
            const decrypted = encryptionService.decrypt(encryptedValue);
            if (!decrypted) {
                console.error('❌ Descriptografia retornou null/vazio - valor pode não estar criptografado');
                console.error('   Valor original length:', encryptedValue?.length);
                // Se falhou ao descriptografar, assume que não está criptografado
                return encryptedValue;
            }
            console.log('✅ Descriptografia OK - length original:', encryptedValue?.length, '-> length final:', decrypted.length);
            return decrypted;
        } catch (error) {
            console.error('❌ Erro ao descriptografar:', error.message);
            return encryptedValue;
        }
    }

    /**
     * Cria agente HTTPS com certificados mTLS
     */
    createHttpsAgent(certContent, keyContent) {
        // Garante que os certificados são Buffers ou strings válidas
        const cert = Buffer.isBuffer(certContent) ? certContent : Buffer.from(certContent, 'utf8');
        const key = Buffer.isBuffer(keyContent) ? keyContent : Buffer.from(keyContent, 'utf8');

        console.log('🔐 Criando HTTPS Agent com certificados:');
        console.log('   - Cert é Buffer:', Buffer.isBuffer(cert));
        console.log('   - Cert length:', cert.length);
        console.log('   - Cert começa com:', cert.toString('utf8').substring(0, 30));
        console.log('   - Key é Buffer:', Buffer.isBuffer(key));
        console.log('   - Key length:', key.length);

        return new https.Agent({
            cert: cert,
            key: key,
            rejectUnauthorized: false, // Importante para ambientes cloud como Render
            pfx: undefined // Garante que não usa pfx
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
            console.log('🔑 Criptografia ativa:', encryptionService.isConfigured());
            const clientId = this.decryptCredential(empresaConfig.clientId);
            const clientSecret = this.decryptCredential(empresaConfig.clientSecret);

            console.log('📋 Credenciais obtidas:');
            console.log('   - Client ID criptografado length:', empresaConfig.clientId?.length || 0);
            console.log('   - Client ID descriptografado length:', clientId?.length || 0);
            console.log('   - Client Secret criptografado length:', empresaConfig.clientSecret?.length || 0);
            console.log('   - Client Secret descriptografado length:', clientSecret?.length || 0);
            console.log('   - Chave PIX:', empresaConfig.chavePix || 'NÃO DEFINIDA');
            console.log('   - Sandbox:', empresaConfig.sandbox);
            console.log('   - Tem certBase64:', !!empresaConfig.certBase64);
            console.log('   - Tem keyBase64:', !!empresaConfig.keyBase64);

            // Lê certificados (podem estar em base64 no Firestore ou em arquivos)
            let certContent, keyContent;

            if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
                // Certificados armazenados em base64 - manter como Buffer
                certContent = Buffer.from(empresaConfig.certBase64, 'base64');
                keyContent = Buffer.from(empresaConfig.keyBase64, 'base64');
                console.log('✅ Certificados carregados do Firestore (como Buffer)');
                console.log('   - Cert Buffer length:', certContent.length);
                console.log('   - Key Buffer length:', keyContent.length);
                console.log('   - Cert preview:', certContent.toString('utf8').substring(0, 50));
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

            // IMPORTANTE: trim() para remover espaços invisíveis de copiar/colar
            const clientIdClean = clientId.trim();
            const clientSecretClean = clientSecret.trim();

            console.log('🔍 Credenciais limpas:');
            console.log('   - Client ID length após trim:', clientIdClean.length);
            console.log('   - Client Secret length após trim:', clientSecretClean.length);

            const params = new URLSearchParams();
            params.append('client_id', clientIdClean);
            params.append('client_secret', clientSecretClean);
            params.append('grant_type', 'client_credentials');

            // ESCOPO APENAS PIX - boleto removido temporariamente
            const SCOPE_COBRANCA = 'cob.write cob.read';
            params.append('scope', SCOPE_COBRANCA);

            console.log('');
            console.log('╔══════════════════════════════════════════════════════════════╗');
            console.log('║           📋 ESCOPO SENDO ENVIADO AO BANCO INTER              ║');
            console.log('╠══════════════════════════════════════════════════════════════╣');
            console.log('║ SCOPE:', SCOPE_COBRANCA);
            console.log('╚══════════════════════════════════════════════════════════════╝');
            console.log('');

            console.log('📤 Enviando request de token...');
            console.log('   - Params:', params.toString().replace(clientSecretClean, '***SECRET***'));

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
            console.error('');
            console.error('╔══════════════════════════════════════════════════════════════╗');
            console.error('║         ❌❌❌ ERRO BANCO INTER - DETALHES COMPLETOS ❌❌❌          ║');
            console.error('╠══════════════════════════════════════════════════════════════╣');
            console.error('║ Empresa ID:', empresaId);
            console.error('║ Mensagem:', error.message);
            console.error('║ Código:', error.code || 'N/A');
            if (error.response) {
                console.error('║ HTTP Status:', error.response.status);
                console.error('║ Status Text:', error.response.statusText);
                console.error('║ Response Headers:', JSON.stringify(error.response.headers, null, 2));
                console.error('║ Response Data (RAW):', JSON.stringify(error.response.data, null, 2));
                console.error('║ Error Description:', error.response.data?.error_description || 'N/A');
                console.error('║ Error:', error.response.data?.error || 'N/A');
                console.error('║ Message:', error.response.data?.message || 'N/A');
            }
            if (error.request) {
                console.error('║ Request foi enviada mas sem resposta');
            }
            console.error('╚══════════════════════════════════════════════════════════════╝');
            console.error('');

            throw new Error(`Falha na autenticação com Banco Inter: ${error.response?.data?.error_description || error.response?.data?.message || error.message}`);
        }
    }

    /**
     * Cria cobrança PIX imediata (cob)
     */
    async criarPixImediato(empresaConfig, dados) {
        const accessToken = await this.getAccessToken(empresaConfig);
        const baseUrl = this.getBaseUrl(empresaConfig.sandbox);

        // CRÍTICO: Carregar certificados como BUFFER para mTLS funcionar
        let certContent, keyContent;
        if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
            certContent = Buffer.from(empresaConfig.certBase64, 'base64');
            keyContent = Buffer.from(empresaConfig.keyBase64, 'base64');
            console.log('🔐 Certificados carregados para PIX (Buffer):');
            console.log('   - Cert Buffer length:', certContent.length);
            console.log('   - Key Buffer length:', keyContent.length);
        } else {
            throw new Error('Certificados não configurados para esta empresa');
        }

        const httpsAgent = this.createHttpsAgent(certContent, keyContent);
        console.log('✅ httpsAgent criado para requisição PIX');

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

        // Adiciona endereço se disponível (evita erro 400)
        if (dados.pagador.endereco) {
            payload.devedor.logradouro = dados.pagador.endereco.logradouro || '';
            payload.devedor.cidade = dados.pagador.endereco.cidade || '';
            payload.devedor.uf = dados.pagador.endereco.uf || '';
            payload.devedor.cep = dados.pagador.endereco.cep?.replace(/\D/g, '') || '';
        }

        // Se for CNPJ ao invés de CPF
        if (dados.pagador.cnpj) {
            delete payload.devedor.cpf;
            payload.devedor.cnpj = dados.pagador.cnpj.replace(/\D/g, '');
        }

        console.log('📤 Enviando requisição PIX para Banco Inter:');
        console.log('   - URL:', url);
        console.log('   - Payload:', JSON.stringify(payload, null, 2));

        // Função para fazer a requisição (usada no retry)
        const fazerRequisicao = async (token) => {
            console.log('');
            console.log('╔══════════════════════════════════════════════════════════════╗');
            console.log('║     🔒 VERIFICAÇÃO mTLS ANTES DA REQUISIÇÃO PIX              ║');
            console.log('╠══════════════════════════════════════════════════════════════╣');
            console.log('║ httpsAgent existe:', !!httpsAgent);
            console.log('║ httpsAgent options.cert existe:', !!httpsAgent?.options?.cert);
            console.log('║ httpsAgent options.key existe:', !!httpsAgent?.options?.key);
            console.log('║ Token length:', token?.length || 0);
            console.log('╚══════════════════════════════════════════════════════════════╝');
            console.log('');

            const axiosConfig = {
                httpsAgent: httpsAgent,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            };

            console.log('🔐 Enviando PIX com Agent mTLS:', !!axiosConfig.httpsAgent);

            return await axios.put(url, payload, axiosConfig);
        };

        try {
            const response = await fazerRequisicao(accessToken);
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
            // RETRY AUTOMÁTICO EM CASO DE 401
            if (error.response?.status === 401) {
                console.warn('⚠️ Token rejeitado (401), limpando cache e tentando novamente...');

                // Limpa cache do token
                this.limparCache(empresaConfig.id);

                // Obtém novo token
                const novoToken = await this.getAccessToken(empresaConfig);
                console.log('✅ Novo token obtido, retentando requisição...');

                try {
                    const retryResponse = await fazerRequisicao(novoToken);
                    const cobranca = retryResponse.data;

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
                } catch (retryError) {
                    console.error('❌ Retry também falhou:', retryError.response?.data || retryError.message);
                    throw new Error(`Falha ao criar cobrança PIX (após retry): ${retryError.response?.data?.detail || retryError.message}`);
                }
            }

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

        // CRÍTICO: Carregar certificados como BUFFER para mTLS funcionar
        let certContent, keyContent;
        if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
            certContent = Buffer.from(empresaConfig.certBase64, 'base64');
            keyContent = Buffer.from(empresaConfig.keyBase64, 'base64');
            console.log('🔐 Certificados carregados para PIX Vencimento (Buffer)');
        } else {
            throw new Error('Certificados não configurados para esta empresa');
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

        // CRÍTICO: Carregar certificados como BUFFER para mTLS funcionar
        let certContent, keyContent;
        if (empresaConfig.certBase64 && empresaConfig.keyBase64) {
            certContent = Buffer.from(empresaConfig.certBase64, 'base64');
            keyContent = Buffer.from(empresaConfig.keyBase64, 'base64');
        } else {
            throw new Error('Certificados não configurados para esta empresa');
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

    /**
     * Testa conexão completa - autentica e tenta acessar endpoint de cobrança
     */
    async testarConexaoCompleta(empresaConfig) {
        console.log('🧪 Iniciando teste de conexão completa...');

        try {
            // Passo 1: Obter token
            const accessToken = await this.getAccessToken(empresaConfig);
            console.log('✅ Passo 1: Token obtido com sucesso');

            // Passo 2: Testar acesso ao endpoint de boletos (apenas GET para listar)
            const baseUrl = this.getBaseUrl(empresaConfig.sandbox);
            const certContent = Buffer.from(empresaConfig.certBase64, 'base64');
            const keyContent = Buffer.from(empresaConfig.keyBase64, 'base64');
            const httpsAgent = this.createHttpsAgent(certContent, keyContent);

            // Tenta listar boletos (não precisa criar nada)
            try {
                const testUrl = `${baseUrl}/cobranca/v3/boletos?dataInicial=${new Date().toISOString().split('T')[0]}&dataFinal=${new Date().toISOString().split('T')[0]}`;
                console.log('🔍 Testando endpoint de boletos:', testUrl);

                const response = await axios.get(testUrl, {
                    httpsAgent,
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('✅ Passo 2: Acesso ao endpoint de boletos OK');
                console.log('   - Status:', response.status);

                return {
                    success: true,
                    tokenOk: true,
                    boletoEndpointOk: true,
                    message: 'Conexão completa testada com sucesso!'
                };
            } catch (boletoError) {
                console.warn('⚠️ Endpoint de boletos falhou, testando PIX...');

                // Tenta endpoint de PIX
                try {
                    const pixUrl = `${baseUrl}/pix/v2/cob`;
                    console.log('🔍 Testando endpoint de PIX:', pixUrl);

                    // Apenas verifica se o endpoint responde (vai dar 400 sem payload, mas não 401)
                    const pixResponse = await axios.get(`${baseUrl}/pix/v2/loc`, {
                        httpsAgent,
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    console.log('✅ Passo 2: Acesso ao endpoint de PIX OK');
                    return {
                        success: true,
                        tokenOk: true,
                        pixEndpointOk: true,
                        message: 'Conexão completa testada com sucesso!'
                    };
                } catch (pixError) {
                    // Se for 401, o token não tem permissão
                    if (pixError.response?.status === 401) {
                        throw new Error('Token não tem permissão para endpoints de cobrança');
                    }
                    // Outros erros (400, 404) são aceitáveis - significa que chegou no endpoint
                    console.log('✅ Passo 2: Endpoint respondeu (erro esperado sem payload)');
                    return {
                        success: true,
                        tokenOk: true,
                        endpointReached: true,
                        message: 'Conexão testada - endpoints acessíveis!'
                    };
                }
            }

        } catch (error) {
            console.error('❌ Teste de conexão falhou:', error.message);
            throw error;
        }
    }
}

module.exports = new InterBankService();
