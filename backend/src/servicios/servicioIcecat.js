'use strict';

/**
 * Servicio Icecat — cliente de la API live de Icecat.
 *
 * Consulta especificaciones oficiales por MPN (ProductCode) + Marca (Brand),
 * ambos obligatorios. Soporta variantes de MPN como fallback cuando el código
 * extraído de Deltron trae prefijos/sufijos (IN-, "(BULK)", etc.).
 *
 * Promovido desde el POC validado (scripts/poc-icecat/cliente-icecat.js).
 * Credenciales en backend/.env: ICECAT_API_TOKEN, ICECAT_CONTENT_TOKEN,
 * ICECAT_SHOPNAME y (opcional, solo Full Icecat) ICECAT_APP_KEY.
 */

// Usa fetch nativo (Node 18+). No requiere dependencias externas.
const URL_API = 'https://live.icecat.biz/api';
const TIMEOUT_MS = Number(process.env.ICECAT_TIMEOUT_MS || 15000);

/** Lee las credenciales y opciones de Icecat desde variables de entorno. */
function obtenerConfig() {
  return {
    apiToken: process.env.ICECAT_API_TOKEN,
    contentToken: process.env.ICECAT_CONTENT_TOKEN,
    shopname: process.env.ICECAT_SHOPNAME,
    appKey: process.env.ICECAT_APP_KEY || '',
    lang: process.env.ICECAT_LANG || 'ES',
  };
}

/** Indica si están las 3 credenciales mínimas para consultar Icecat (token, content-token, shopname). */
function credencialesPresentes() {
  const c = obtenerConfig();
  return Boolean(c.apiToken && c.contentToken && c.shopname);
}

/**
 * Una consulta directa a Icecat por MPN + marca.
 * Devuelve { ok, status, consulta, data } sin lanzar excepción.
 */
async function consultarIcecat({ mpn, marca, lang }) {
  const config = obtenerConfig();
  const idioma = lang || config.lang;

  const params = new URLSearchParams({
    lang: idioma,
    shopname: config.shopname,
    ProductCode: mpn,
    Brand: marca,
  });
  if (config.appKey) params.set('app_key', config.appKey);

  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(`${URL_API}?${params.toString()}`, {
      headers: {
        'api-token': config.apiToken,
        'content-token': config.contentToken,
      },
      signal: controlador.signal,
    });
    let data = null;
    try { data = await respuesta.json(); } catch (_) { data = null; }
    return {
      ok: respuesta.status === 200,
      status: respuesta.status,
      fuente: 'icecat',
      consulta: { mpn, marca, lang: idioma },
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      fuente: 'icecat',
      consulta: { mpn, marca, lang: idioma },
      error: err.name === 'AbortError' ? 'timeout' : (err.message || 'error_desconocido'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Genera variantes limpias de un MPN. El original siempre va primero, para no
 * arriesgar los MPN que ya funcionan (muchos reales empiezan con 2 letras +
 * guión: GP-P650G, MZ-77E500E).
 */
function variantesMpn(mpn) {
  const variantes = [];
  const agregar = (v) => {
    const limpio = String(v || '').trim();
    if (limpio && !variantes.includes(limpio)) variantes.push(limpio);
  };
  agregar(mpn);
  agregar(String(mpn).replace(/\s*\([^)]*\)/g, '')); // sin "(BULK)"
  agregar(String(mpn).replace(/^IN-/, '')); // prefijo Deltron Intel
  agregar(String(mpn).replace(/\s*\([^)]*\)/g, '').replace(/^IN-/, ''));
  agregar(String(mpn).split('/')[0]); // último recurso
  return variantes;
}

/**
 * Consulta con fallback de variantes: prueba el MPN original y, si da 404,
 * prueba variantes limpias hasta encontrar (200 o 403) o agotarlas.
 * @param {function} [sleep] - espera opcional entre intentos (rate limit).
 */
async function consultarIcecatConVariantes({ mpn, marca, lang, sleep }) {
  const variantes = variantesMpn(mpn);
  let ultimo = null;

  for (let i = 0; i < variantes.length; i++) {
    const candidato = variantes[i];
    const r = await consultarIcecat({ mpn: candidato, marca, lang });
    r.mpn_usado = candidato;
    r.mpn_original = mpn;
    ultimo = r;

    if (r.status === 200 || r.status === 403) return r; // encontrado
    if (i < variantes.length - 1 && typeof sleep === 'function') await sleep();
  }
  return ultimo;
}

module.exports = {
  consultarIcecat,
  consultarIcecatConVariantes,
  variantesMpn,
  credencialesPresentes,
  obtenerConfig,
};
