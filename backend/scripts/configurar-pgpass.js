/**
 * Script para configurar pgpass en Windows
 * Evita que PostgreSQL pida contraseña interactivamente
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuración desde .env
require('dotenv').config();

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '5432';
const DB_NAME = process.env.DB_NAME || 'nsg_cotizaciones';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD;

// SEGURIDAD: sin fallback de contraseña; debe venir del .env
if (!DB_PASSWORD) {
  console.error('❌ DB_PASSWORD no está definida en .env; no se generará pgpass.conf');
  process.exit(1);
}

// Ruta del archivo pgpass en Windows
const pgpassPath = path.join(os.homedir(), 'AppData', 'Roaming', 'postgresql', 'pgpass.conf');

// Contenido del archivo pgpass
// Formato: hostname:port:database:username:password
const pgpassContent = `${DB_HOST}:${DB_PORT}:${DB_NAME}:${DB_USER}:${DB_PASSWORD}
${DB_HOST}:${DB_PORT}:*:${DB_USER}:${DB_PASSWORD}
`;

try {
  // Crear directorio si no existe
  const pgpassDir = path.dirname(pgpassPath);
  if (!fs.existsSync(pgpassDir)) {
    fs.mkdirSync(pgpassDir, { recursive: true });
    console.log('✓ Directorio creado:', pgpassDir);
  }

  // Escribir archivo pgpass
  fs.writeFileSync(pgpassPath, pgpassContent, { encoding: 'utf8' });
  console.log('✓ Archivo pgpass.conf creado exitosamente');
  console.log('  Ubicación:', pgpassPath);
  console.log('\n💡 Ahora PostgreSQL no pedirá contraseña interactivamente');
  console.log('⚠️  IMPORTANTE: Este archivo contiene contraseñas en texto plano');
  console.log('   Solo úsalo en entorno de desarrollo local\n');

} catch (error) {
  console.error('❌ Error al crear pgpass.conf:', error.message);
  process.exit(1);
}
