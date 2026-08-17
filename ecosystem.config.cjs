// PM2 Ecosystem Config — committed to repo, no secrets here
// Secrets live in ~/.env on the server and are injected at runtime
module.exports = {
  apps: [
    {
      name: 'tat',
      // Use babel-node from node_modules so PM2 doesn't need it globally
      script: 'node_modules/.bin/babel-node',
      args: 'index.js',

      instances: 1,
      exec_mode: 'fork',

      // Restart policy
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 10,

      // Logging
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // env_production is activated with: pm2 start ecosystem.config.cjs --env production
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
