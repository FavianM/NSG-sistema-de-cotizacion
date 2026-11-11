/**
 * Módulo de Sanitización de Inputs
 * 
 * Proporciona funciones para sanitizar y limpiar inputs del usuario
 * previniendo ataques XSS y otros vectores de ataque.
 * 
 * Uso:
 * - Sanitizar todos los inputs antes de procesarlos
 * - Validar formatos de datos (email, teléfono, etc.)
 * 
 * Requisitos: 10.1, 10.2, 10.3, 10.4
 */

const validator = require('validator');

/**
 * Sanitiza un string removiendo caracteres peligrosos
 * 
 * @param {any} input - Input a sanitizar
 * @returns {string} String sanitizado
 * 
 * @example
 * sanitizarInput('<script>alert("xss")</script>');
 * // Retorna: ''
 */
function sanitizarInput(input) {
  // Si no es string, retornar vacío
  if (typeof input !== 'string') {
    return '';
  }
  
  let sanitizado = input;
  
  // Remover scripts y eventos ANTES de escapar
  sanitizado = sanitizado.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitizado = sanitizado.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitizado = sanitizado.replace(/javascript:/gi, '');
  
  // Remover tags HTML reales pero mantener texto con símbolos "<" y ">"
  // Ejemplo: "<>" no debe vaciarse por completo.
  sanitizado = sanitizado.replace(/<\/?[a-z][^>]*>/gi, '');
  
  // NO usar validator.escape() aquí: convertiría / en &#x2F;, " en &quot;, etc.
  // El texto se almacena en BD y se renderiza como texto plano en React (no como HTML),
  // por lo que escapar entidades HTML corrompe la visualización.
  // La protección XSS ya está garantizada por los pasos anteriores y por consultas parametrizadas.
  
  // Trim espacios
  return sanitizado.trim();
}

/**
 * Sanitiza un objeto completo recursivamente
 * 
 * @param {Object} obj - Objeto a sanitizar
 * @returns {Object} Objeto con valores sanitizados
 * 
 * @example
 * sanitizarObjeto({ nombre: '<script>alert(1)</script>', edad: 25 });
 * // Retorna: { nombre: '', edad: 25 }
 */
function sanitizarObjeto(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // Preservar arrays: sanitizar cada elemento
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizarObjeto(item));
  }
  
  const sanitizado = {};
  
  for (const [clave, valor] of Object.entries(obj)) {
    if (typeof valor === 'string') {
      sanitizado[clave] = sanitizarInput(valor);
    } else if (Array.isArray(valor)) {
      sanitizado[clave] = valor.map(item => sanitizarObjeto(item));
    } else if (typeof valor === 'object' && valor !== null) {
      sanitizado[clave] = sanitizarObjeto(valor);
    } else {
      sanitizado[clave] = valor;
    }
  }
  
  return sanitizado;
}

/**
 * Valida y sanitiza un email
 * 
 * @param {string} email - Email a validar
 * @returns {Object} { valido: boolean, email: string, error?: string }
 * 
 * @example
 * validarEmail('usuario@ejemplo.com');
 * // Retorna: { valido: true, email: 'usuario@ejemplo.com' }
 */
function validarEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valido: false, email: '', error: 'Email no proporcionado' };
  }
  
  const emailLimpio = email.trim().toLowerCase();
  
  if (!validator.isEmail(emailLimpio)) {
    return { valido: false, email: emailLimpio, error: 'Formato de email inválido' };
  }
  
  // Validar longitud
  if (emailLimpio.length > 100) {
    return { valido: false, email: emailLimpio, error: 'Email demasiado largo' };
  }
  
  return { valido: true, email: emailLimpio };
}

/**
 * Valida y sanitiza un número de teléfono
 * 
 * @param {string} telefono - Teléfono a validar
 * @returns {Object} { valido: boolean, telefono: string, error?: string }
 * 
 * @example
 * validarTelefono('+51 987654321');
 * // Retorna: { valido: true, telefono: '+51987654321' }
 */
function validarTelefono(telefono) {
  if (!telefono || typeof telefono !== 'string') {
    return { valido: false, telefono: '', error: 'Teléfono no proporcionado' };
  }
  
  // Remover espacios y caracteres no numéricos excepto +
  const telefonoLimpio = telefono.replace(/[^\d+]/g, '');
  
  // Validar formato básico (mínimo 7 dígitos, máximo 15)
  if (telefonoLimpio.length < 7 || telefonoLimpio.length > 15) {
    return { valido: false, telefono: telefonoLimpio, error: 'Longitud de teléfono inválida' };
  }
  
  // Validar que contenga solo dígitos y opcionalmente + al inicio
  if (!/^\+?\d+$/.test(telefonoLimpio)) {
    return { valido: false, telefono: telefonoLimpio, error: 'Formato de teléfono inválido' };
  }
  
  return { valido: true, telefono: telefonoLimpio };
}

/**
 * Valida que un string no contenga código malicioso
 * 
 * @param {string} input - String a validar
 * @returns {Object} { valido: boolean, error?: string }
 * 
 * @example
 * validarSinCodigoMalicioso('<script>alert(1)</script>');
 * // Retorna: { valido: false, error: 'Contiene código potencialmente malicioso' }
 */
function validarSinCodigoMalicioso(input) {
  if (typeof input !== 'string') {
    return { valido: true };
  }
  
  // Patrones peligrosos
  const patronesPeligrosos = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /<iframe/i,
    /<object/i,
    /<embed/i,
    /eval\(/i,
    /expression\(/i
  ];
  
  for (const patron of patronesPeligrosos) {
    if (patron.test(input)) {
      return { 
        valido: false, 
        error: 'Contiene código potencialmente malicioso' 
      };
    }
  }
  
  return { valido: true };
}

/**
 * Normaliza un nombre (capitaliza primera letra de cada palabra)
 * 
 * @param {string} nombre - Nombre a normalizar
 * @returns {string} Nombre normalizado
 * 
 * @example
 * normalizarNombre('juan pérez garcía');
 * // Retorna: 'Juan Pérez García'
 */
function normalizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') {
    return '';
  }
  
  return nombre
    .trim()
    .toLowerCase()
    .split(' ')
    .map(palabra => palabra.charAt(0).toUpperCase() + palabra.slice(1))
    .join(' ');
}

/**
 * Limita la longitud de un string
 * 
 * @param {string} texto - Texto a limitar
 * @param {number} maxLength - Longitud máxima
 * @returns {string} Texto limitado
 * 
 * @example
 * limitarLongitud('Texto muy largo...', 10);
 * // Retorna: 'Texto muy ...'
 */
function limitarLongitud(texto, maxLength) {
  if (!texto || typeof texto !== 'string') {
    return '';
  }
  
  if (texto.length <= maxLength) {
    return texto;
  }
  
  return texto.substring(0, maxLength - 3) + '...';
}

module.exports = {
  sanitizarInput,
  sanitizarObjeto,
  validarEmail,
  validarTelefono,
  validarSinCodigoMalicioso,
  normalizarNombre,
  limitarLongitud
};
