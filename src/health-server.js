/**
 * Optional Health Check Server
 * 
 * Simple HTTP server that provides health and metrics endpoints
 * for monitoring the notification worker.
 * 
 * Usage: Set ENABLE_HEALTH_SERVER=true in environment
 */

const http = require('http');
const { config } = require('./config');

class HealthServer {
  constructor(worker) {
    this.worker = worker;
    this.server = null;
    this.port = process.env.HEALTH_PORT || 3000;
  }

  start() {
    if (!process.env.ENABLE_HEALTH_SERVER) {
      return; // Health server disabled
    }

    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      
      if (req.url === '/health') {
        this.handleHealth(req, res);
      } else if (req.url === '/metrics') {
        this.handleMetrics(req, res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.listen(this.port, () => {
      console.log(`🏥 Health server listening on port ${this.port}`);
    });
  }

  async handleHealth(req, res) {
    try {
      const dbHealth = await this.worker.database.healthCheck();
      const fcmHealth = await this.worker.fcm.healthCheck();
      
      const healthy = dbHealth.healthy && fcmHealth && this.worker.isRunning;
      
      res.writeHead(healthy ? 200 : 503);
      res.end(JSON.stringify({
        status: healthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        worker: {
          running: this.worker.isRunning,
          workerId: this.worker.database.workerId
        },
        database: dbHealth,
        fcm: { healthy: fcmHealth }
      }));
    } catch (error) {
      res.writeHead(503);
      res.end(JSON.stringify({
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  }

  async handleMetrics(req, res) {
    try {
      const stats = this.worker.getStats();
      const queueStats = await this.worker.database.getQueueStats();
      
      res.writeHead(200);
      res.end(JSON.stringify({
        worker: stats,
        queue: queueStats,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      console.log('🏥 Health server stopped');
    }
  }
}

module.exports = HealthServer;