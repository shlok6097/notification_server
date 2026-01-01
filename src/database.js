const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

class DatabaseService {
  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
    
    // Generate unique worker ID for this instance
    this.workerId = `worker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * CONCURRENCY-SAFE: Claim and fetch unprocessed notifications
   * Uses FOR UPDATE SKIP LOCKED to prevent race conditions
   * @param {number} batchSize - Number of notifications to claim
   * @returns {Promise<Array>} Array of claimed notification objects
   */
  async claimUnprocessedNotifications(batchSize = 50) {
    try {
      const { data, error } = await this.supabase
        .rpc('claim_unprocessed_notifications', { 
          batch_limit: batchSize,
          worker_id: this.workerId
        });

      if (error) {
        throw new Error(`Failed to claim notifications: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      console.error('❌ Database error claiming notifications:', error.message);
      throw error;
    }
  }

  /**
   * Get active FCM tokens for a specific user
   * @param {string} userId - User UUID
   * @returns {Promise<Array>} Array of active FCM token objects
   */
  async getUserActiveFcmTokens(userId) {
    try {
      const { data, error } = await this.supabase
        .rpc('get_user_active_fcm_tokens', { p_user_id: userId });

      if (error) {
        throw new Error(`Failed to fetch FCM tokens: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      console.error(`❌ Database error fetching FCM tokens for user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Mark a notification as processed (atomic operation)
   * @param {string} notificationId - Notification UUID
   * @returns {Promise<boolean>} Success status
   */
  async markNotificationProcessed(notificationId) {
    try {
      const { data, error } = await this.supabase
        .rpc('mark_notification_processed', { notification_id: notificationId });

      if (error) {
        throw new Error(`Failed to mark notification as processed: ${error.message}`);
      }

      return data === true;
    } catch (error) {
      console.error(`❌ Database error marking notification ${notificationId} as processed:`, error.message);
      throw error;
    }
  }

  /**
   * Deactivate invalid FCM tokens
   * @param {Array<string>} tokenIds - Array of token IDs to deactivate
   * @returns {Promise<number>} Number of tokens deactivated
   */
  async deactivateInvalidTokens(tokenIds) {
    if (!tokenIds || tokenIds.length === 0) {
      return 0;
    }

    try {
      const { data, error } = await this.supabase
        .rpc('deactivate_fcm_tokens', { token_ids: tokenIds });

      if (error) {
        throw new Error(`Failed to deactivate tokens: ${error.message}`);
      }

      return data || 0;
    } catch (error) {
      console.error('❌ Database error deactivating tokens:', error.message);
      return 0;
    }
  }

  /**
   * Get notification queue statistics
   * @returns {Promise<Object>} Queue statistics
   */
  async getQueueStats() {
    try {
      const { data, error } = await this.supabase
        .rpc('get_queue_statistics');

      if (error) {
        throw new Error(`Failed to fetch queue stats: ${error.message}`);
      }

      return data?.[0] || { 
        total_notifications: 0, 
        processed_notifications: 0, 
        pending_notifications: 0,
        processing_notifications: 0,
        oldest_pending: null,
        newest_notification: null
      };
    } catch (error) {
      console.error('❌ Database error fetching queue stats:', error.message);
      return { 
        total_notifications: 0, 
        processed_notifications: 0, 
        pending_notifications: 0,
        processing_notifications: 0,
        oldest_pending: null,
        newest_notification: null
      };
    }
  }

  /**
   * Comprehensive health check for database connection and tables
   * @returns {Promise<Object>} Health check results
   */
  async healthCheck() {
    try {
      const { data, error } = await this.supabase
        .rpc('notification_system_health_check');

      if (error) {
        console.error('❌ Database health check failed:', error.message);
        return { healthy: false, components: [] };
      }

      const healthy = data?.every(component => component.status === 'healthy') || false;
      
      return {
        healthy,
        components: data || [],
        workerId: this.workerId
      };
    } catch (error) {
      console.error('❌ Database health check failed:', error.message);
      return { healthy: false, components: [], error: error.message };
    }
  }

  /**
   * Clean up old processed notifications (maintenance)
   * @param {number} daysOld - Age threshold in days
   * @returns {Promise<number>} Number of notifications cleaned up
   */
  async cleanupOldNotifications(daysOld = 30) {
    try {
      const { data, error } = await this.supabase
        .rpc('cleanup_old_notifications', { days_old: daysOld });

      if (error) {
        throw new Error(`Failed to cleanup notifications: ${error.message}`);
      }

      return data || 0;
    } catch (error) {
      console.error('❌ Database error during cleanup:', error.message);
      return 0;
    }
  }

  /**
   * Reset stuck notifications (recovery mechanism)
   * Notifications that have been processing for too long without completion
   * @param {number} timeoutMinutes - Processing timeout in minutes
   * @returns {Promise<number>} Number of notifications reset
   */
  async resetStuckNotifications(timeoutMinutes = 30) {
    try {
      const { data, error } = await this.supabase
        .from('notification_queue')
        .update({ 
          processing_started_at: null 
        })
        .eq('processed', false)
        .not('processing_started_at', 'is', null)
        .lt('processing_started_at', new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString())
        .select('id');

      if (error) {
        throw new Error(`Failed to reset stuck notifications: ${error.message}`);
      }

      return data?.length || 0;
    } catch (error) {
      console.error('❌ Database error resetting stuck notifications:', error.message);
      return 0;
    }
  }
}

module.exports = DatabaseService;