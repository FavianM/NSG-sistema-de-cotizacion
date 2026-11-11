/**
 * Módulo de Encriptación
 * 
 * Proporciona funciones para encriptar y desencriptar datos sensibles
 * usando AES-256-CBC.
 * 
 * Uso:
 * - Encriptar emails y teléfonos antes de almacenar en BD
 * - Desencriptar al recuperar datos sensibles
 * 
 * Requisitos: 10.1, 10.2, 10.3, 10.4
 */

const crypto = require('crypto');

// Algoritmo de encriptación
const ALGORITMO = 'aes-256-cbc';
const IV_LENGTH = 16; // Longitud del vector de inicialización

/**
 * Obtiene la clave de encriptación desde variables de entorno
 * La clave debe ser un string hexadecimal de 64 caracteres (32 bytes)
 */
function obtenerClaveEncriptacion() {
  const claveHex = process.env.ENCRYPTION_KEY;
  
  if (!claveHex) {
    throw new Error('ENCRYPTION_KEY no está definida en variables de entorno');
  }
  
  if (claveHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY debe ser un string hexadecimal de 64 caracteres (32 bytes)');
  }
  
  return Buffer.from(claveHex, 'hex');
}

/**
 * Encripta un texto usando AES-256-CBC
 * 
 * @param {string} texto - Texto plano a encriptar
 * @returns {string} Texto encriptado en formato "iv:contenido_encriptado"
 * 
 * @example
 * const emailEncriptado = encriptar('cliente@ejemplo.com');
 * // Retorna: "a1b2c3d4e5f6....:f7e8d9c0b1a2...."
 */
function encriptar(texto) {
  if (!texto || typeof texto !== 'string') {
    throw new Error('El texto a encriptar debe ser un string no vacío');
  }
  
  try {
    const clave = obtenerClaveEncriptacion();
    
    // Generar vector de inicialización aleatorio
    const iv = crypto.randomBytes(IV_LENGTH);
    
    // Crear cipher
    const cipher = crypto.createCipheriv(ALGORITMO, clave, iv);
    
    // Encriptar
    let encriptado = cipher.update(texto, 'utf8', 'hex');
    encriptado += cipher.final('hex');
    
    // Retornar IV + contenido encriptado
    return iv.toString('hex') + ':' + encriptado;
  } catch (error) {
    throw new Error(`Error al encriptar: ${error.message}`);
  }
}

/**
 * Desencripta un texto encriptado con AES-256-CBC
 * 
 * @param {string} textoEncriptado - Texto en formato "iv:contenido_encriptado"
 * @returns {string} Texto plano desencriptado
 * 
 * @example
 * const email = desencriptar('a1b2c3d4e5f6....:f7e8d9c0b1a2....');
 * // Retorna: "cliente@ejemplo.com"
 */
function desencriptar(textoEncriptado) {
  if (!textoEncriptado || typeof textoEncriptado !== 'string') {
    throw new Error('El texto a desencriptar debe ser un string no vacío');
  }
  
  if (!textoEncriptado.includes(':')) {
    throw new Error('Formato de texto encriptado inválido (debe contener ":")');
  }
  
  try {
    const clave = obtenerClaveEncriptacion();
    
    // Separar IV y contenido
    const [ivHex, contenido] = textoEncriptado.split(':');
    
    if (!ivHex || !contenido) {
      throw new Error('Formato de texto encriptado inválido');
    }
    
    // Convertir IV de hex a buffer
    const iv = Buffer.from(ivHex, 'hex');
    
    if (iv.length !== IV_LENGTH) {
      throw new Error(`IV debe tener ${IV_LENGTH} bytes`);
    }
    
    // Crear decipher
    const decipher = crypto.createDecipheriv(ALGORITMO, clave, iv);
    
    // Desencriptar
    let desencriptado = decipher.update(contenido, 'hex', 'utf8');
    desencriptado += decipher.final('utf8');
    
    return desencriptado;
  } catch (error) {
    throw new Error(`Error al desencriptar: ${error.message}`);
  }
}

/**
 * Genera una clave de encriptación aleatoria
 * Útil para generar ENCRYPTION_KEY inicial
 * 
 * @returns {string} Clave hexadecimal de 64 caracteres
 * 
 * @example
 * const nuevaClave = generarClaveEncriptacion();
 * console.log('ENCRYPTION_KEY=' + nuevaClave);
 */
function generarClaveEncriptacion() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Genera un hash determinístico de un texto para búsqueda segura.
 * Usa HMAC-SHA256 con la clave de encriptación.
 * A diferencia de encriptar(), este resultado es siempre el mismo para el mismo input.
 *
 * @param {string} texto - Texto a hashear
 * @returns {string} Hash hexadecimal de 64 caracteres
 */
function hashBusqueda(texto) {
  if (!texto || typeof texto !== 'string') {
    throw new Error('El texto a hashear debe ser un string no vacío');
  }
  const claveHex = process.env.ENCRYPTION_KEY;
  if (!claveHex) throw new Error('ENCRYPTION_KEY no está definida');
  return crypto.createHmac('sha256', Buffer.from(claveHex, 'hex'))
    .update(texto.toLowerCase().trim())
    .digest('hex');
}

module.exports = {
  encriptar,
  desencriptar,
  generarClaveEncriptacion,
  hashBusqueda
};
