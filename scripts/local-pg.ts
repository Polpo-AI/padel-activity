/**
 * Avvia un Postgres reale embedded per i test di integrazione locali.
 * Uso: npx tsx scripts/local-pg.ts   (resta in foreground finché non viene ucciso)
 *
 * Porta 5433 per non collidere con eventuali Postgres di sistema.
 * I dati vivono in .pgdata-test/ (gitignored, usa e getta).
 */
import EmbeddedPostgres from 'embedded-postgres';

async function main() {
    const pg = new EmbeddedPostgres({
        databaseDir: './.pgdata-test',
        user: 'padel_user',
        password: 'padel_password',
        port: 5433,
        persistent: false,
    });

    // Idempotente: se il cluster esiste già (PG_VERSION presente), salta initdb
    const { existsSync } = await import('fs');
    if (!existsSync('./.pgdata-test/PG_VERSION')) {
        console.log('[local-pg] Inizializzo cluster...');
        await pg.initialise();
    } else {
        console.log('[local-pg] Cluster esistente — riuso .pgdata-test');
    }
    console.log('[local-pg] Avvio server su :5433...');
    await pg.start();
    await pg.createDatabase('padel_db').catch(() => { /* già esistente */ });
    console.log('[local-pg] PRONTO — postgresql://padel_user:***@localhost:5433/padel_db');

    const stop = async () => {
        console.log('[local-pg] Stop...');
        await pg.stop().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // resta vivo
    setInterval(() => {}, 60_000);
}

main().catch(err => { console.error('[local-pg] ERRORE:', err); process.exit(1); });
