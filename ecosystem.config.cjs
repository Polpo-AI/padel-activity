module.exports = {
  apps: [
    {
      name: 'padel-api',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--env-file=/root/padel-staging/.env --import tsx',
      cwd: '/root/padel-staging',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'padel-worker',
      script: 'src/workers/wave.worker.ts',
      interpreter: 'node',
      interpreter_args: '--env-file=/root/padel-staging/.env --import tsx',
      cwd: '/root/padel-staging',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
