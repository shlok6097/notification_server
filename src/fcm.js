const admin = require('firebase-admin');
const { config } = require('./config');

class FCMService {
  constructor() {
    this.messaging = null;
    this.initializeFirebase();
  }

  /**
   * Initialize Firebase Admin SDK (SAFE)
   */
  initializeFirebase() {
    try {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: config.firebase.projectId,
            clientEmail: config.firebase.clientEmail,
            privateKey: config.firebase.privateKey.replace(/\\n/g, '\n'),
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
   * ✅ SAFE FCM SEND (NO /batch, NO sendMulticast)
   * Sends notifications one-by-one in parallel
   */
  async sendToMultipleTokens(tokens, notification) {
    if (!tokens || tokens.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        results: [],
        invalidTokenIds: [],
      };
    }

    let successCount = 0;
    let failureCount = 0;
    const results = [];
    const invalidTokenIds = [];

    await Promise.all(
      tokens.map(async (tokenObj) => {
        try {
          const message = {
            token: tokenObj.fcm_token,
            notification: {
              title: notification.title,
              body: notification.body,
            },
            data: this.sanitizeDataPayload(notification.payload),
            android: {
              priority: 'high',
              notification: {
                channelId: 'academixsphere_notifications',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
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
                },
              },
            },
          };

          const messageId = await this.messaging.send(message);

          successCount++;
          results.push({
            tokenId: tokenObj.id,
            token: tokenObj.fcm_token,
            platform: tokenObj.platform,
            success: true,
            messageId,
          });
        } catch (error) {
          failureCount++;

          // Permanently invalid tokens
          if (
            error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokenIds.push(tokenObj.id);
          }

          results.push({
            tokenId: tokenObj.id,
            token: tokenObj.fcm_token,
            platform: tokenObj.platform,
            success: false,
            error: error.message,
            errorCode: error.code,
          });
        }
      })
    );

    return {
      successCount,
      failureCount,
      results,
      invalidTokenIds,
    };
  }

  /**
   * Ensure payload is FCM-safe (strings only)
   */
  sanitizeDataPayload(payload) {
    if (!payload || typeof payload !== 'object') return {};

    const sanitized = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== null && value !== undefined) {
        sanitized[key] = String(value).slice(0, 4000);
      }
    }
    return sanitized;
  }

  /**
   * Validate token format (basic)
   */
  isValidToken(token) {
    return typeof token === 'string' && token.length > 50 && token.length < 500;
  }

  /**
   * Health check
   */
  async healthCheck() {
    return !!this.messaging;
  }

  /**
   * Stats
   */
  getStats() {
    return {
      initialized: !!this.messaging,
      projectId: config.firebase.projectId,
      healthy: !!this.messaging,
    };
  }
}

module.exports = FCMService;
