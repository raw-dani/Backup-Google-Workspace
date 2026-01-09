const { GoogleAuth } = require('google-auth-library');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/oauth2.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

class OAuth2Service {
  constructor() {
    this.auth = null;
    this.serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    this.keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || './service-account-key.json';
    this.domainWideDelegationUser = null;
  }

  async initialize() {
    try {
      this.auth = new GoogleAuth({
        keyFile: this.keyFile,
        scopes: ['https://mail.google.com/'],
      });

      logger.info('OAuth2 service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize OAuth2 service', { error: error.message });
      throw error;
    }
  }

  async generateXOAuth2Token(userEmail) {
    try {
      if (!this.auth) {
        await this.initialize();
      }

      // Create JWT for domain-wide delegation
      const client = await this.auth.getClient();
      client.subject = userEmail;

      // Get access token
      const accessToken = await client.getAccessToken();

      if (!accessToken.token) {
        throw new Error('Failed to obtain access token');
      }

      // Generate XOAUTH2 token
      const xoauth2Token = Buffer.from(
        `user=${userEmail}\x01auth=Bearer ${accessToken.token}\x01\x01`
      ).toString('base64');

      logger.info('XOAUTH2 token generated successfully', { userEmail });

      return {
        token: xoauth2Token,
        expiresAt: accessToken.rescored ? new Date(Date.now() + 3600000) : null, // 1 hour
      };
    } catch (error) {
      logger.error('Failed to generate XOAUTH2 token', {
        userEmail,
        error: error.message
      });
      throw error;
    }
  }

  async validateServiceAccount() {
    try {
      if (!this.auth) {
        await this.initialize();
      }

      const client = await this.auth.getClient();
      const token = await client.getAccessToken();

      if (!token.token) {
        throw new Error('Service account validation failed');
      }

      logger.info('Service account validated successfully');
      return true;
    } catch (error) {
      logger.error('Service account validation failed', { error: error.message });
      return false;
    }
  }

  async getImpersonatedClient(userEmail) {
    try {
      if (!this.auth) {
        await this.initialize();
      }

      const client = await this.auth.getClient();
      client.subject = userEmail;

      return client;
    } catch (error) {
      logger.error('Failed to get impersonated client', {
        userEmail,
        error: error.message
      });
      throw error;
    }
  }

  // Refresh token if needed
  async refreshTokenIfNeeded(userEmail) {
    try {
      const client = await this.getImpersonatedClient(userEmail);
      const token = await client.getAccessToken();

      // Check if token is expired or will expire soon (within 5 minutes)
      if (token.rescored || (token.expiry_date && token.expiry_date - Date.now() < 300000)) {
        logger.info('Refreshing access token', { userEmail });
        await client.refreshAccessToken();
        return await client.getAccessToken();
      }

      return token;
    } catch (error) {
      logger.error('Failed to refresh token', { userEmail, error: error.message });
      throw error;
    }
  }
}

const oauth2Service = new OAuth2Service();

module.exports = {
  OAuth2Service,
  oauth2Service,
};