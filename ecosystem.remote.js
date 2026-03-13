module.exports = {
  apps: [
    {
      name: "padel-api",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--env-file=.env --import tsx",
      cwd: "/root/padel-staging",
      env_file: ".env",
      env: { NODE_ENV: "production" }
    },
    {
      name: "padel-worker",
      script: "src/worker.ts",
      interpreter: "node",
      interpreter_args: "--env-file=.env --import tsx",
      cwd: "/root/padel-staging",
      env_file: ".env",
      env: { NODE_ENV: "production" }
    }
  ]
};
