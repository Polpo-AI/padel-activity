/**
 * PM2 ECOSYSTEM CONFIG — Padel Bot
 *
 * Deploy: pm2 start ecosystem.config.js --env production
 * Reload:  pm2 reload padel-bot
 * Logs:    pm2 logs padel-bot
 * Monitor: pm2 monit
 */

module.exports = {
    apps: [
        {
            name: 'padel-bot',
            script: 'dist/index.js',
            cwd: '/var/www/padel-bot',

            // ── Restart automatico ───────────────────
            watch: false,                    // no watch in prod
            autorestart: true,
            max_restarts: 10,               // max 10 restart in finestra
            min_uptime: '10s',              // considera "up" dopo 10s
            restart_delay: 3000,            // aspetta 3s prima di riavviare

            // ── Memoria ──────────────────────────────
            max_memory_restart: '512M',     // riavvia se supera 512MB

            // ── Ambiente ─────────────────────────────
            env: {
                NODE_ENV: 'development',
                PORT: 3000,
            },
            env_production: {
                NODE_ENV: 'production',
                PORT: 3000,
            },

            // ── Log ──────────────────────────────────
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            error_file: '/var/log/padel-bot/error.log',
            out_file: '/var/log/padel-bot/out.log',
            merge_logs: true,

            // ── Graceful shutdown ─────────────────────
            kill_timeout: 5000,             // aspetta 5s per shutdown pulito
            listen_timeout: 10000,          // timeout per "ready" signal

            // ── Cluster mode off ─────────────────────
            // Baileys non supporta cluster (sessione WA è singola)
            instances: 1,
            exec_mode: 'fork',
        },
    ],
};
