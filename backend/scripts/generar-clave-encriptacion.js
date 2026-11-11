/**
 * Script para generar una clave de encriptación AES-256
 * 
 * Uso:
 *   node scripts/generar-clave-encriptacion.js
 * 
 * Este script genera una clave hexadecimal de 64 caracteres (32 bytes)
 * que puede ser usada como ENCRYPTION_KEY en el archivo .env
 */

const { generarClaveEncriptacion } = require('../src/utilidades/encriptacion');

console.log('\n=== Generador de Clave de Encriptación AES-256 ===\n');

const clave = generarClaveEncriptacion();

console.log('Clave generada exitosamente:');
console.log('\nENCRYPTION_KEY=' + clave);

console.log('\n📋 Instrucciones:');
console.log('1. Copia la línea completa de arriba');
console.log('2. Pégala en tu archivo .env');
console.log('3. NUNCA compartas esta clave públicamente');
console.log('4. Usa una clave diferente para producción\n');

console.log('⚠️  IMPORTANTE:');
console.log('- Esta clave es de 64 caracteres hexadecimales (32 bytes)');
console.log('- Se usa para encriptar datos sensibles (emails, teléfonos)');
console.log('- Si pierdes esta clave, NO podrás desencriptar los datos');
console.log('- Guarda una copia segura de la clave de producción\n');
