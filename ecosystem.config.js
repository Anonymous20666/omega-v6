module.exports = {
  apps: [
    {
      name: 'omega-v5-test',
      script: 'index.js',
      cwd: '/opt/Omega-v5-test',
      interpreter: 'node',
      interpreter_args: '--expose-gc --max-old-space-size=1536',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      restart_delay: 8000,
      max_restarts: 20,
      min_uptime: '30s',
      max_memory_restart: '1400M',
      kill_timeout: 10000,
      listen_timeout: 20000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/opt/Omega-v5-test/data/logs/pm2-out.log',
      error_file: '/opt/Omega-v5-test/data/logs/pm2-err.log',
      merge_logs: true,
      log_type: 'json',
      env: {
        NODE_ENV: 'production',
      },
    }
  ]
};
