/**
 * Servicio de consulta de DNI (RENIEC) vía decolecta.
 *
 * El token se lee de la tabla `configuracion` (clave `decolecta_api_token`),
 * editable por admin, con fallback a `process.env.DECOLECTA_API_TOKEN`.
 * Nunca se expone el token al frontend: este servicio corre server-side y la
 * ruta que lo usa está protegida (rate-limit + Turnstile).
 *
 * Respuesta de decolecta: { first_name, first_last_name, second_last_name, full_name, document_number }.
 * El `full_name` viene en orden APELLIDOS NOMBRES, así que armamos nombre_completo
 * nosotros como `nombre + ' ' + apellidos`.
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');
const { desencriptar } = require('../utilidades/encriptacion');

const DECOLECTA_URL = process.env.DECOLECTA_DNI_URL || 'https://api.decolecta.com/v1/reniec/dni';
const TIMEOUT_MS = 8000;
const CLAVE_TOKEN = 'decolecta_api_token_enc';

async function obtenerToken() {
  try {
    const r = await ejecutarQuery('SELECT valor FROM configuracion WHERE clave = $1', [CLAVE_TOKEN]);
    const valor = r.rows[0]?.valor;
    if (valor && String(valor).trim()) {
      try { return desencriptar(valor); } catch { /* valor corrupto → usar fallback */ }
    }
  } catch (_) {
    // Si la tabla/clave no existe, se usa el fallback de entorno.
  }
  return process.env.DECOLECTA_API_TOKEN || null;
}

/**
 * Consulta un DNI en decolecta.
 * @param {string} dni - 8 dígitos
 * @returns {Promise<{exito:boolean, status?:number, error?:string, datos?:{nombre,apellidos,nombre_completo}}>}
 */
async function consultarDni(dni) {
  const token = await obtenerToken();
  if (!token) {
    return { exito: false, status: 503, error: 'El servicio de consulta de DNI no está configurado' };
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const url = `${DECOLECTA_URL}?numero=${encodeURIComponent(dni)}`;
    const respuesta = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controlador.signal,
    });

    if (respuesta.status === 404) {
      return { exito: false, status: 404, error: 'No se encontraron datos para ese DNI' };
    }
    if (!respuesta.ok) {
      return { exito: false, status: 502, error: 'No se pudo consultar el DNI' };
    }

    const data = await respuesta.json();
    const nombre = String(data.first_name || '').trim();
    const apellidos = [data.first_last_name, data.second_last_name]
      .filter(Boolean)
      .map((s) => String(s).trim())
      .join(' ')
      .trim();

    if (!nombre && !apellidos) {
      return { exito: false, status: 404, error: 'No se encontraron datos para ese DNI' };
    }

    return {
      exito: true,
      datos: {
        nombre,
        apellidos,
        nombre_completo: `${nombre} ${apellidos}`.replace(/\s+/g, ' ').trim(),
      },
    };
  } catch (_) {
    return { exito: false, status: 502, error: 'Servicio de consulta de DNI no disponible' };
  } finally {
    clearTimeout(temporizador);
  }
}

module.exports = { consultarDni };
