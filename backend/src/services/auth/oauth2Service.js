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

  async generateAccessToken(userEmail, retryCount = 0) {
    try {
      if (!this.auth) {
        await this.initialize();
      }

      // Create JWT for domain-wide delegation
      const client = await this.auth.getClient();
      client.subject = userEmail;

      // Get access token with refresh logic
      let accessToken;
      try {
        accessToken = await client.getAccessToken();

        // If token is expired or will expire soon, refresh it
        if (!accessToken.token || (accessToken.expiry_date && accessToken.expiry_date - Date.now() < 300000)) {
          logger.info('Token expired or will expire soon, refreshing...', { userEmail });
          await client.refreshAccessToken();
          accessToken = await client.getAccessToken();
        }
      } catch (tokenError) {
        logger.warn('Token refresh failed, reinitializing client...', { userEmail, error: tokenError.message });

        // Reinitialize client and try again
        await this.initialize();
        const newClient = await this.auth.getClient();
        newClient.subject = userEmail;
        accessToken = await newClient.getAccessToken();
        client = newClient;
      }

      if (!accessToken.token) {
        throw new Error('Failed to obtain access token after refresh');
      }

      // VALIDATE TOKEN FORMAT - Should be OAuth2 access token starting with "ya29."
      const token = accessToken.token;
      if (!token.startsWith('ya29.')) {
        logger.error('Invalid token format - not an OAuth2 access token', {
          userEmail,
          tokenLength: token.length,
          tokenPreview: token.substring(0, 20),
          expectedFormat: 'ya29.xxxx...'
        });
        throw new Error('Generated token is not a valid OAuth2 access token');
      }

      logger.info('OAuth2 access token generated successfully', {
        userEmail,
        tokenLength: token.length,
        tokenPreview: token.substring(0, 20),
        tokenExpiry: accessToken.expiry_date ? new Date(accessToken.expiry_date).toISOString() : 'unknown',
        retryCount
      });

      return {
        token: token, // Return RAW OAuth2 access token, NOT XOAUTH2 formatted string
        expiresAt: accessToken.expiry_date ? new Date(accessToken.expiry_date) : new Date(Date.now() + 3600000),
      };
    } catch (error) {
      // Retry once on token errors
      if (retryCount === 0 && (error.message.includes('expired') || error.message.includes('invalid'))) {
        logger.warn('Token error detected, retrying once...', { userEmail, error: error.message });
        return this.generateAccessToken(userEmail, retryCount + 1);
      }

      logger.error('Failed to generate OAuth2 access token', {
        userEmail,
        error: error.message,
        retryCount,
        stack: error.stack
      });
      throw error;
    }
  }

  // Keep old method for backward compatibility, but use new implementation
  async generateXOAuth2Token(userEmail, retryCount = 0) {
    return this.generateAccessToken(userEmail, retryCount);
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
