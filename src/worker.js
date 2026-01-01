const DatabaseService = require('./database');
const FCMService = require('./fcm');
const HealthServer = require('./health-server');
const { config } = require('./config');

class NotificationWorker {
  constructor() {
    this.database = new DatabaseService();
    this.fcm = new FCMService();
    this.healthServer = new HealthServer(this);
    this.isRunning = false;
    this.stats = {
      processed: 0,
      failed: 0,
      tokensDeactivated: 0,
      startTime: new Date(),
    };
    this.maintenanceInterval = null;
  }

  /**
   * Start the notification worker
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️ Worker is already running');
      return;
    }

    console.log('🚀 Starting AcademiXsphere Notification Worker...');
    console.log(`📊 Configuration: Batch size: ${config.worker.batchSize}, Poll interval: ${config.worker.pollIntervalMs}ms`);
    console.log(`🆔 Worker ID: ${this.database.workerId}`);
    
    // FIXED: Setup signal handlers first
    this.setupSignalHandlers();
    
    this.isRunning = true;
    this.stats.startTime = new Date();
    
    // Reset any stuck notifications from previous runs
    await this.recoverStuckNotifications();
    
    // Start the main processing loop
    this.processLoop();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
    
    // Start optional health server
    this.healthServer.start();
    
    console.log('✅ Notification Worker started successfully');
  }

  /**
   * Stop the notification worker
   */
  stop() {
    console.log('🛑 Stopping Notification Worker...');
    this.isRunning = false;
    
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
    
    // Stop health server
    this.healthServer.stop();
  }

  /**
   * CONCURRENCY-SAFE: Main processing loop
   */
  async processLoop() {
    while (this.isRunning) {
      try {
        await this.processBatch();
        
        // Wait before next poll
        await this.sleep(config.worker.pollIntervalMs);
      } catch (error) {
        console.error('❌ Error in processing loop:', error.message);
        this.stats.failed++;
        
        // Wait longer on error to avoid rapid retries
        await this.sleep(config.worker.pollIntervalMs * 2);
      }
    }
    
    console.log('✅ Processing loop stopped');
  }

  /**
   * CONCURRENCY-SAFE: Process a batch of notifications using row-level locking
   */
  async processBatch() {
    // Use the new concurrency-safe claim function
    const notifications = await this.database.claimUnprocessedNotifications(config.worker.batchSize);
    
    if (notifications.length === 0) {
      return; // No notifications to process
    }

    console.log(`📦 Processing batch of ${notifications.length} notifications`);
    
    // Process notifications in parallel for better throughput
    const promises = notifications.map(notification => this.processNotification(notification));
    const results = await Promise.allSettled(promises);
    
    // Count results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    this.stats.processed += successful;
    this.stats.failed += failed;
    
    if (failed > 0) {
      console.log(`⚠️ Batch completed: ${successful} successful, ${failed} failed`);
    }
  }

  /**
   * FIXED: Process a single notification with proper error handling
   * @param {Object} notification - Notification object from database
   */
  async processNotification(notification) {
    try {
      // Get active FCM tokens for the user
      const tokens = await this.database.getUserActiveFcmTokens(notification.user_id);
      
      if (tokens.length === 0) {
        console.log(`⚠️ No active FCM tokens for user ${notification.user_id}, marking as processed`);
        await this.database.markNotificationProcessed(notification.id);
        return;
      }

      // Send FCM notification
      const result = await this.fcm.sendToMultipleTokens(tokens, notification);
      
      // Log results
      console.log(`📱 Sent "${notification.title}" to ${tokens.length} tokens: ${result.successCount} success, ${result.failureCount} failed`);
      
      // CRITICAL: Deactivate invalid tokens
      if (result.invalidTokenIds && result.invalidTokenIds.length > 0) {
        const deactivatedCount = await this.database.deactivateInvalidTokens(result.invalidTokenIds);
        this.stats.tokensDeactivated += deactivatedCount;
        console.log(`🧹 Deactivated ${deactivatedCount} invalid FCM tokens`);
      }

      // ALWAYS mark as processed (best-effort delivery)
      // Even if all FCM sends failed, we don't want to retry forever
      const marked = await this.database.markNotificationProcessed(notification.id);
      
      if (!marked) {
        console.warn(`⚠️ Failed to mark notification ${notification.id} as processed`);
      }
      
      console.log(`✅ Processed notification ${notification.id} for user ${notification.user_id}`);
      
    } catch (error) {
      console.error(`❌ Error processing notification ${notification.id}:`, error.message);
      
      // Try to mark as processed even on error to prevent infinite retries
      try {
        await this.database.markNotificationProcessed(notification.id);
        console.log(`⚠️ Marked failed notification ${notification.id} as processed to prevent retry loop`);
      } catch (markError) {
        console.error(`❌ Failed to mark notification ${notification.id} as processed:`, markError.message);
      }
      
      throw error; // Re-throw for batch counting
    }
  }

  /**
   * Recovery mechanism: Reset stuck notifications from previous runs
   */
  async recoverStuckNotifications() {
    try {
      const resetCount = await this.database.resetStuckNotifications(30); // 30 minute timeout
      if (resetCount > 0) {
        console.log(`🔄 Reset ${resetCount} stuck notifications from previous runs`);
      }
    } catch (error) {
      console.error('❌ Failed to reset stuck notifications:', error.message);
    }
  }

  /**
   * Start health monitoring with comprehensive checks
   */
  startHealthMonitoring() {
    setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        const queueStats = await this.database.getQueueStats();
        const uptime = Math.floor((new Date() - this.stats.startTime) / 1000);
        
        console.log(`💓 Health Check - Uptime: ${uptime}s, Pending: ${queueStats.pending_notifications}, Processing: ${queueStats.processing_notifications}, Processed: ${this.stats.processed}, Failed: ${this.stats.failed}, Tokens Deactivated: ${this.stats.tokensDeactivated}`);
        
        // Comprehensive health checks
        const dbHealth = await this.database.healthCheck();
        const fcmHealthy = await this.fcm.healthCheck();
        
        if (!dbHealth.healthy) {
          console.error('❌ Database health check failed:', dbHealth.components);
        }
        
        if (!fcmHealthy) {
          console.error('❌ FCM health check failed');
        }
        
        // Alert on high queue backlog
        if (queueStats.pending_notifications > 1000) {
          console.warn(`⚠️ High queue backlog: ${queueStats.pending_notifications} pending notifications`);
        }
        
        // Alert on old stuck notifications
        if (queueStats.processing_notifications > 100) {
          console.warn(`⚠️ Many notifications stuck in processing: ${queueStats.processing_notifications}`);
        }
        
      } catch (error) {
        console.error('❌ Health monitoring error:', error.message);
      }
    }, 60000); // Every minute
  }

  /**
   * Start maintenance tasks (cleanup, recovery)
   */
  startMaintenanceTasks() {
    this.maintenanceInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        // Clean up old processed notifications (every hour)
        const cleanedUp = await this.database.cleanupOldNotifications(7); // 7 days
        if (cleanedUp > 0) {
          console.log(`🧹 Cleaned up ${cleanedUp} old processed notifications`);
        }
        
        // Reset stuck notifications (every hour)
        const resetCount = await this.database.resetStuckNotifications(30); // 30 minutes
        if (resetCount > 0) {
          console.log(`🔄 Reset ${resetCount} stuck notifications`);
        }
        
      } catch (error) {
        console.error('❌ Maintenance task error:', error.message);
      }
    }, 3600000); // Every hour
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get comprehensive worker statistics
   * @returns {Object} Current stats
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Math.floor((new Date() - this.stats.startTime) / 1000),
      isRunning: this.isRunning,
      workerId: this.database.workerId,
      processRate: this.stats.processed / Math.max(1, Math.floor((new Date() - this.stats.startTime) / 1000)) * 60, // per minute
    };
  }

  /**
   * FIXED: Graceful shutdown handler with proper signal handling
   */
  async gracefulShutdown(signal = 'SIGTERM') {
    console.log(`🔄 Received ${signal}, initiating graceful shutdown...`);
    
    // Stop accepting new work
    this.stop();
    
    // Wait for current operations to complete
    console.log('⏳ Waiting for current operations to complete...');
    await this.sleep(5000);
    
    // Final health report
    const stats = this.getStats();
    console.log('📊 Final Statistics:', {
      processed: stats.processed,
      failed: stats.failed,
      tokensDeactivated: stats.tokensDeactivated,
      uptime: `${stats.uptime}s`,
      processRate: `${stats.processRate.toFixed(2)}/min`
    });
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  }

  /**
   * FIXED: Setup signal handlers for graceful shutdown
   */
  setupSignalHandlers() {
    // Handle SIGTERM (Docker, Kubernetes, systemd)
    process.on('SIGTERM', () => {
      this.gracefulShutdown('SIGTERM');
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      this.gracefulShutdown('SIGINT');
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('💥 Uncaught Exception:', error);
      this.gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      this.gracefulShutdown('UNHANDLED_REJECTION');
    });
  }
}

module.exports = NotificationWorker;
// ===== WORKER BOOTSTRAP (REQUIRED) =====
(async () => {
  try {
    const worker = new NotificationWorker();
    await worker.start();
  } catch (error) {
    console.error('💥 Failed to start Notification Worker:', error);
    process.exit(1);
  }
})();
