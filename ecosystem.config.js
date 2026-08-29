module.exports = {
  apps: [
    {
      name: 'bulkpublish-web',
      script: './dist/server/entry.mjs',
      env: {
        HOST: '0.0.0.0',
        PORT: 4321,
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
    },
    {
      name: 'bulkpublish-worker',
      script: './workers/entry.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
    },
  ],
};
