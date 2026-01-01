require('dotenv').config();

const config = {
  // Supabase Configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  // Firebase Configuration
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  },

  // Worker Configuration
  worker: {
    batchSize: parseInt(process.env.BATCH_SIZE) || 50,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS) || 5000,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  },
};

// Validation
function validateConfig() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('💥 CRITICAL: Missing required environment variables:', missing.join(', '));
    console.error('💥 Server cannot start without proper configuration');
    process.exit(1);
  }

  if (!config.supabase.url.includes('supabase.co')) {
    console.error('💥 CRITICAL: Invalid Supabase URL format');
    process.exit(1);
  }

  if (!config.firebase.clientEmail.includes('@')) {
    console.error('💥 CRITICAL: Invalid Firebase client email format');
    process.exit(1);
  }

  if (!config.firebase.privateKey.includes('BEGIN PRIVATE KEY')) {
    console.error('💥 CRITICAL: Invalid Firebase private key format');
    process.exit(1);
  }

  // Validate numeric configs
  if (isNaN(config.worker.batchSize) || config.worker.batchSize < 1 || config.worker.batchSize > 1000) {
    console.error('💥 CRITICAL: BATCH_SIZE must be a number between 1 and 1000');
    process.exit(1);
  }

  if (isNaN(config.worker.pollIntervalMs) || config.worker.pollIntervalMs < 1000) {
    console.error('💥 CRITICAL: POLL_INTERVAL_MS must be at least 1000ms');
    process.exit(1);
  }

  console.log('✅ Configuration validated successfully');
  console.log(`📊 Worker config: Batch=${config.worker.batchSize}, Poll=${config.worker.pollIntervalMs}ms`);
}

module.exports = { config, validateConfig };