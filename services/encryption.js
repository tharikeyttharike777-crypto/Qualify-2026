/**
 * Serviço de encriptação para credenciais bancárias
 * Usa AES para armazenar dados sensíveis de forma segura
 */

const CryptoJS = require('crypto-js');

class EncryptionService {
    constructor() {
        this.key = process.env.ENCRYPTION_KEY;
        if (!this.key) {
            console.warn('⚠️ ENCRYPTION_KEY não definida! Credenciais não serão criptografadas.');
        }
    }

    /**
     * Encripta um valor usando AES
     */
    encrypt(value) {
        if (!this.key) {
            console.warn('⚠️ Encriptação desativada - ENCRYPTION_KEY não definida');
            return value;
        }
        return CryptoJS.AES.encrypt(value, this.key).toString();
    }

    /**
     * Descriptografa um valor
     */
    decrypt(encryptedValue) {
        if (!this.key) {
            return encryptedValue;
        }
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedValue, this.key);
            return bytes.toString(CryptoJS.enc.Utf8);
        } catch (error) {
            console.error('Erro ao descriptografar:', error.message);
            return null;
        }
    }

    /**
     * Verifica se a chave de encriptação está configurada
     */
    isConfigured() {
        return !!this.key;
    }
}

module.exports = new EncryptionService();
