require('dotenv').config();

const { pool, initSchema } = require('./db');

async function main() {
  await initSchema();
  console.log('Esquema PostgreSQL listo (tabla transactions).');
  await pool.end();
}

main().catch(async (err) => {
  console.error('No se pudo inicializar la base de datos:');
  console.error(err.message);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
