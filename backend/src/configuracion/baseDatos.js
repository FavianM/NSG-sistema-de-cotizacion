// Validación de variables de conexión obligatorias en TODOS los entornos.
// No hay defaults: si falta cualquier DB_* esencial, fallar ruidosamente en
// lugar de caer en localhost/5432/neondb y confundir diagnóstico. Esto vuelve
// la configuración 100% explícita por variables de entorno ( portable entre
// cuentas/proveedores: solo se cambian DB_* al migrar).
const REQUIERE = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const faltantes = REQUIERE.filter((k) => !process.env[k]);
if (faltantes.length) {
  throw new Error(`Faltan variables de entorno obligatorias de base de datos: ${faltantes.join(', ')}`);
}

// Selección de driver por entorno:
// - producción (@neondatabase/serverless): conecta a Neon por HTTPS (puerto 443)
//   para esquivar el bloqueo del puerto 5432 en hosting compartido (Ninja/cPanel).
// - dev/local/test (pg): conexión TCP estándar a PostgreSQL local, sin cambios.
// Ambos exponen una API Pool idéntica (query/connect), por lo que los consumidores
// no notan la diferencia.
const esProduccion = process.env.NODE_ENV === 'production';
let pool;

if (esProduccion) {
  const { Pool: NeonPool } = require('@neondatabase/serverless');
  // El host directo de Neon se transforma al endpoint "-pooler" (PgBouncer, HTTPS/443).
  // DB_USE_POOLER=false permite forzar el host directo si hace falta debugging.
  const host = process.env.DB_HOST;
  const usarPooler = process.env.DB_USE_POOLER !== 'false';
  const hostPooler = !usarPooler || host.includes('-pooler')
    ? host
    : host.replace('.', '-pooler.', 1);
  const connectionString = `postgresql://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASSWORD)}@${hostPooler}/${encodeURIComponent(process.env.DB_NAME)}?sslmode=require`;
  // Neon maneja TLS sobre WSS internamente; no se configuran ssl/max/timeout manuales
  // (evita doble pooling sobre PgBouncer del endpoint -pooler).
  pool = new NeonPool({ connectionString });
} else {
  const { Pool: PgPool } = require('pg');
  pool = new PgPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    // TLS hacia PostgreSQL para despliegues no locales (DB_SSL=true)
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  });
}

pool.on('connect', () => console.log('Conectado a PostgreSQL'));
pool.on('error', (err) => {
  console.error('Error en PostgreSQL:', err);
  process.exit(-1);
});

/**
 * Ejecuta una consulta parametrizada contra el pool de PostgreSQL.
 * Registra en consola las queries que superan 1s para detectar cuellos de botella.
 * @param {string} texto - SQL con placeholders ($1, $2, ...); nunca concatenar valores directamente.
 * @param {Array} [parametros] - Valores que reemplazan los placeholders (previene inyección SQL).
 * @returns {Promise<import('pg').QueryResult>} Resultado de la consulta.
 */
const ejecutarQuery = async (texto, parametros) => {
  const inicio = Date.now();
  try {
    const resultado = await pool.query(texto, parametros);
    const duracion = Date.now() - inicio;
    if (duracion > 1000) {
      console.warn(`Query lenta (${duracion}ms):`, texto);
    }
    return resultado;
  } catch (error) {
    console.error('Error en query:', error);
    throw error;
  }
};

/**
 * Ejecuta una serie de operaciones dentro de una transacción SQL.
 * Hace COMMIT si el callback termina sin error y ROLLBACK ante cualquier fallo,
 * garantizando atomicidad. Siempre libera el cliente al pool (bloque finally).
 * @param {(cliente: import('pg').PoolClient) => Promise<any>} callback - Recibe el cliente
 *        transaccional; todas las queries internas deben usar ese cliente, no el pool.
 * @returns {Promise<any>} Lo que retorne el callback.
 */
const ejecutarTransaccion = async (callback) => {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await callback(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
};

module.exports = { pool, ejecutarQuery, ejecutarTransaccion };
