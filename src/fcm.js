const admin = require('firebase-admin');
const { config } = require('./config');

class FCMService {
  constructor() {
    this.initializeFirebase();
  }

  /**
   * Initialize Firebase Admin SDK
   */
  initializeFirebase() {
    try {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: config.firebase.projectId,
            privateKey: config.firebase.privateKey,
            clientEmail: config.firebase.clientEmail,
          }),
        });
      }
      
      this.messaging = admin.messaging();
      console.log('✅ Firebase Admin SDK initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
      throw error;
    }
  }

  /**
   * Send FCM notification to multiple tokens (FIXED: Proper error handling)
   * @param {Array} tokens - Array of FCM token objects with id and fcm_token
   * @param {Object} notification - Notification payload
   * @returns {Promise<Object>} Batch send results with token tracking
   */
  async sendToMultipleTokens(tokens, notification) {
    if (!tokens || tokens.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        results: [],
        invalidTokenIds: []
      };
    }

    // Extract just the token strings for FCM
    const tokenStrings = tokens.map(t => t.fcm_token);

    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: this.sanitizeDataPayload(notification.payload),
      android: {
        priority: 'high',
        notification: {
          channelId: 'academixsphere_notifications',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK', // For Flutter apps
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
            },
            sound: 'default',
            badge: 1,
            'content-available': 1, // For background processing
          },
        },
      },
      tokens: tokenStrings,
    };

    try {
      const response = await this.messaging.sendMulticast(message);
      
      // Map results back to token objects with IDs
      const results = response.responses.map((result, index) => ({
        tokenId: tokens[index].id,
        token: tokens[index].fcm_token,
        platform: tokens[index].platform,
        success: result.success,
        messageId: result.messageId,
        error: result.error?.message,
        errorCode: result.error?.code,
      }));

      // Identify invalid tokens that should be deactivated
      const invalidTokenIds = this.getInvalidTokenIds(results);

      return {
        successCount: response.successCount,
        failureCount: response.failureCount,
        results,
        invalidTokenIds
      };
    } catch (error) {
      console.error('❌ FCM batch send error:', error.message);
      
      // Return failure for all tokens
      return {
        successCount: 0,
        failureCount: tokens.length,
        results: tokens.map(token => ({
          tokenId: token.id,
          token: token.fcm_token,
          platform: token.platform,
          success: false,
          error: error.message,
          errorCode: error.code,
        })),
        invalidTokenIds: [] // Don't mark as invalid on network errors
      };
    }
  }

  /**
   * FIXED: Sanitize data payload for FCM (all values must be strings, small size)
   * @param {Object} payload - Raw payload object
   * @returns {Object} Sanitized payload
   */
  sanitizeDataPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    const sanitized = {};
    const maxValueLength = 4000; // FCM limit per value
    let totalSize = 0;
    const maxTotalSize = 4000; // Conservative total limit
    
    for (const [key, value] of Object.entries(payload)) {
      if (value !== null && value !== undefined && totalSize < maxTotalSize) {
        let stringValue = String(value);
        
        // Truncate if too long
        if (stringValue.length > maxValueLength) {
          stringValue = stringValue.substring(0, maxValueLength - 3) + '...';
        }
        
        // Only add if we haven't exceeded total size
        if (totalSize + key.length + stringValue.length < maxTotalSize) {
          sanitized[key] = stringValue;
          totalSize += key.length + stringValue.length;
        }
      }
    }

    return sanitized;
  }

  /**
   * FIXED: Get invalid token IDs that should be deactivated
   * @param {Array} results - FCM send results
   * @returns {Array} Token IDs that should be deactivated
   */
  getInvalidTokenIds(results) {
    const invalidTokenIds = [];
    
    results.forEach(result => {
      if (!result.success && result.errorCode) {
        // These error codes indicate the token is permanently invalid
        const invalidErrorCodes = [
          'messaging/invalid-registration-token',
          'messaging/registration-token-not-registered',
          'messaging/invalid-argument',
        ];
        
        if (invalidErrorCodes.includes(result.errorCode)) {
          invalidTokenIds.push(result.tokenId);
        }
      }
    });
    
    return invalidTokenIds;
  }

  /**
   * Validate FCM token format
   * @param {string} token - FCM token to validate
   * @returns {boolean} Is valid token
   */
  isValidToken(token) {
    return typeof token === 'string' && 
           token.length > 50 && 
           token.length < 500 &&
           /^[A-Za-z0-9_-]+$/.test(token); // Basic format check
  }

  /**
   * Health check for FCM service
   * @returns {Promise<boolean>} Service status
   */
  async healthCheck() {
    try {
      // Verify Firebase Admin is initialized
      if (!this.messaging) {
        return false;
      }
      
      // Try to validate a dummy token format
      const dummyToken = 'a'.repeat(152); // Valid length
      return this.isValidToken(dummyToken);
    } catch (error) {
      console.error('❌ FCM health check failed:', error.message);
      return false;
    }
  }

  /**
   * Get FCM service statistics
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      initialized: !!this.messaging,
      projectId: config.firebase.projectId,
      serviceHealthy: !!this.messaging
    };
  }
}

module.exports = FCMService;