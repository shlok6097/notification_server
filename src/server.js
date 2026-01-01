#!/usr/bin/env node

/**
 * AcademiXsphere Notification Worker - PRODUCTION READY
 * 
 * A dedicated background worker that processes notification queue
 * and sends FCM notifications to users.
 * 
 * FIXED ARCHITECTURE:
 * DB Event → notification_queue → This Worker → FCM → User Device
 * 
 * CRITICAL SAFEGUARDS:
 * - Row-level locking prevents duplicate processing
 * - Graceful shutdown handles SIGTERM/SIGINT
 * - Config validation crashes fast on invalid setup
 * - Invalid FCM tokens are automatically deactivated
 * - Multiple workers can run safely
 */

const { validateConfig } = require('./config');
const NotificationWorker = require('./worker');

async function main() {
  try {
    console.log('🎓 AcademiXsphere Notification Worker - PRODUCTION READY');
    console.log('=====================================================');
    console.log(`📅 Started at: ${new Date().toISOString()}`);
    console.log(`🖥️ Node.js version: ${process.version}`);
    console.log(`📁 Working directory: ${process.cwd()}`);
    console.log(`🔧 Process ID: ${process.pid}`);
    
    // CRITICAL: Validate configuration before starting
    validateConfig();
    
    // Create and start worker (signal handlers setup inside worker)
    const worker = new NotificationWorker();
    await worker.start();
    
    // Keep the process alive
    process.stdin.resume();
    
  } catch (error) {
    console.error('💥 CRITICAL: Failed to start notification worker:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Start the worker
main();