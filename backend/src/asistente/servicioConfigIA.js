/**
 * Servicio de Configuración de IA
 * Lee dinámicamente la configuración del asistente y del enriquecimiento desde la tabla `configuracion`.
 * Permite cambiar la configuración sin reiniciar el servidor.
 * Usa valores del .env como fallback si no hay registros en BD.
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');
const { desencriptar } = require('../utilidades/encriptacion');

const CLAVES = {
  MODO_ACTIVO: 'ia_modo_activo',
  GEMINI_MODEL: 'ia_gemini_model',
  NVIDIA_MODEL: 'ia_nvidia_model',
  NVIDIA_CLASSIFIER_MODEL: 'ia_nvidia_classifier_model',
  NVIDIA_EMBEDDING_MODEL: 'ia_nvidia_embedding_model',
  NVIDIA_RERANKER_MODEL: 'ia_nvidia_reranker_model',
  GEMINI_API_KEY_ENC: 'ia_gemini_api_key_enc',
  NVIDIA_API_KEY_ENC: 'ia_nvidia_api_key_enc',
  ENRIQUECIMIENTO_PRIORIDAD: 'ia_enriquecimiento_prioridad',
  ENRIQUECIMIENTO_GEMINI_MODEL: 'ia_enriquecimiento_gemini_model',
  ENRIQUECIMIENTO_NVIDIA_MODEL: 'ia_enriquecimiento_nvidia_model',
  ENRIQUECIMIENTO_GEMINI_HABILITADO: 'ia_enriquecimiento_gemini_habilitado',
  ENRIQUECIMIENTO_NVIDIA_HABILITADO: 'ia_enriquecimiento_nvidia_habilitado',
};

// Proveedores de conversador válidos. Arquitectura single-AI: un único modelo
// conversa; los motores determinísticos (compatibilidad, armado) corren aparte.
const PROVEEDORES_VALIDOS = ['nvidia', 'gemini'];

function normalizarModoActivo(valor) {
  const texto = String(valor || '').trim().toLowerCase();
  if (PROVEEDORES_VALIDOS.includes(texto)) return texto;
  // Valores legados ('pipeline') o desconocidos → proveedor por defecto.
  return DEFAULTS.modo_activo;
}

const DEFAULTS = {
  modo_activo: PROVEEDORES_VALIDOS.includes(String(process.env.IA_MODO_ACTIVO || '').toLowerCase())
    ? String(process.env.IA_MODO_ACTIVO).toLowerCase()
    : 'nvidia',
  gemini_model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  nvidia_model: process.env.NVIDIA_MODEL || 'mistralai/mistral-small-4-119b-2603',
  nvidia_classifier_model: process.env.NVIDIA_CLASSIFIER_MODEL || 'meta/llama-3.2-3b-instruct',
  nvidia_embedding_model: process.env.NVIDIA_EMBEDDING_MODEL || 'nvidia/nv-embed-v1',
  nvidia_reranker_model: process.env.NVIDIA_RERANKER_MODEL || 'nvidia/rerank-qa-mistral-4b',
};

const DEFAULTS_ENRIQUECIMIENTO = {
  prioridad: process.env.ENRICHMENT_PROVIDER_PRIORITY || 'nvidia,gemini',
  gemini_model: process.env.ENRICHMENT_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  nvidia_model: process.env.ENRICHMENT_NVIDIA_MODEL || process.env.NVIDIA_MODEL || 'mistralai/mistral-small-4-119b-2603',
  gemini_habilitado: process.env.ENRICHMENT_ENABLE_GEMINI === 'true',
  nvidia_habilitado: process.env.ENRICHMENT_ENABLE_NVIDIA !== 'false',
};

function parsearPrioridad(valor) {
  const texto = String(valor || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const prioridad = [];
  for (const proveedor of texto) {
    if ((proveedor === 'nvidia' || proveedor === 'gemini') && !prioridad.includes(proveedor)) {
      prioridad.push(proveedor);
    }
  }

  return prioridad.length > 0 ? prioridad : ['nvidia', 'gemini'];
}

function parsearBooleanoConfiguracion(valor, fallback = false) {
  if (typeof valor === 'boolean') return valor;

  const texto = String(valor ?? '').trim().toLowerCase();
  if (['true', '1', 'si', 'sí', 'yes'].includes(texto)) return true;
  if (['false', '0', 'no'].includes(texto)) return false;

  return fallback;
}

function filtrarPrioridadPorHabilitacion(prioridad, habilitacion) {
  const prioridadFiltrada = (Array.isArray(prioridad) ? prioridad : [])
    .filter((proveedor) => habilitacion[proveedor] !== false);

  if (prioridadFiltrada.length > 0) return prioridadFiltrada;

  return ['nvidia', 'gemini'].filter((proveedor) => habilitacion[proveedor] !== false);
}

function desencriptarApiKey(mapa, claveConfig, fallbackEnv, etiquetaLog) {
  let apiKey = fallbackEnv || '';

  if (mapa[claveConfig]) {
    try {
      apiKey = desencriptar(mapa[claveConfig]);
    } catch (errDec) {
      console.warn(`[ConfigIA] No se pudo desencriptar ${etiquetaLog}, usando .env:`, errDec.message);
    }
  }

  return apiKey;
}

async function obtenerConfigIA() {
  try {
    const { rows } = await ejecutarQuery(
      `SELECT clave, valor FROM configuracion WHERE clave = ANY($1)`,
      [[
        CLAVES.MODO_ACTIVO,
        CLAVES.GEMINI_MODEL,
        CLAVES.NVIDIA_MODEL,
        CLAVES.NVIDIA_CLASSIFIER_MODEL,
        CLAVES.NVIDIA_EMBEDDING_MODEL,
        CLAVES.NVIDIA_RERANKER_MODEL,
        CLAVES.GEMINI_API_KEY_ENC,
        CLAVES.NVIDIA_API_KEY_ENC,
      ]]
    );

    const mapa = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const modoActivo = normalizarModoActivo(mapa[CLAVES.MODO_ACTIVO] || DEFAULTS.modo_activo);

    return {
      modo_activo: modoActivo,
      gemini_model: mapa[CLAVES.GEMINI_MODEL] || DEFAULTS.gemini_model,
      nvidia_model: mapa[CLAVES.NVIDIA_MODEL] || DEFAULTS.nvidia_model,
      // Campos legados de modelos auxiliares: conservados como passthrough para
      // compatibilidad de la config admin. El flujo single-AI no los usa.
      nvidia_classifier_model: mapa[CLAVES.NVIDIA_CLASSIFIER_MODEL] || DEFAULTS.nvidia_classifier_model,
      nvidia_embedding_model: mapa[CLAVES.NVIDIA_EMBEDDING_MODEL] || DEFAULTS.nvidia_embedding_model,
      nvidia_reranker_model: mapa[CLAVES.NVIDIA_RERANKER_MODEL] || DEFAULTS.nvidia_reranker_model,
      // pipeline multi-agente eliminado: el armado de config es determinístico.
      pipeline_enabled: false,
      gemini_api_key: desencriptarApiKey(mapa, CLAVES.GEMINI_API_KEY_ENC, process.env.GEMINI_API_KEY, 'gemini_api_key'),
      nvidia_api_key: desencriptarApiKey(mapa, CLAVES.NVIDIA_API_KEY_ENC, process.env.NVIDIA_API_KEY, 'nvidia_api_key'),
    };
  } catch (error) {
    console.warn('[ConfigIA] Error leyendo BD, usando defaults del .env:', error.message);
    return {
      modo_activo: DEFAULTS.modo_activo,
      gemini_model: DEFAULTS.gemini_model,
      nvidia_model: DEFAULTS.nvidia_model,
      nvidia_classifier_model: DEFAULTS.nvidia_classifier_model,
      nvidia_embedding_model: DEFAULTS.nvidia_embedding_model,
      nvidia_reranker_model: DEFAULTS.nvidia_reranker_model,
      pipeline_enabled: false,
      gemini_api_key: process.env.GEMINI_API_KEY || '',
      nvidia_api_key: process.env.NVIDIA_API_KEY || '',
    };
  }
}

async function obtenerConfigIAEnriquecimiento() {
  try {
    const { rows } = await ejecutarQuery(
      `SELECT clave, valor FROM configuracion WHERE clave = ANY($1)`,
      [[
        CLAVES.ENRIQUECIMIENTO_PRIORIDAD,
        CLAVES.ENRIQUECIMIENTO_GEMINI_MODEL,
        CLAVES.ENRIQUECIMIENTO_NVIDIA_MODEL,
        CLAVES.ENRIQUECIMIENTO_GEMINI_HABILITADO,
        CLAVES.ENRIQUECIMIENTO_NVIDIA_HABILITADO,
        CLAVES.GEMINI_API_KEY_ENC,
        CLAVES.NVIDIA_API_KEY_ENC,
      ]]
    );

    const mapa = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const proveedoresHabilitados = {
      gemini: parsearBooleanoConfiguracion(mapa[CLAVES.ENRIQUECIMIENTO_GEMINI_HABILITADO], DEFAULTS_ENRIQUECIMIENTO.gemini_habilitado),
      nvidia: parsearBooleanoConfiguracion(mapa[CLAVES.ENRIQUECIMIENTO_NVIDIA_HABILITADO], DEFAULTS_ENRIQUECIMIENTO.nvidia_habilitado),
    };
    const prioridadBase = parsearPrioridad(mapa[CLAVES.ENRIQUECIMIENTO_PRIORIDAD] || DEFAULTS_ENRIQUECIMIENTO.prioridad);

    return {
      prioridad_proveedores: filtrarPrioridadPorHabilitacion(prioridadBase, proveedoresHabilitados),
      prioridad_proveedores_raw: mapa[CLAVES.ENRIQUECIMIENTO_PRIORIDAD] || DEFAULTS_ENRIQUECIMIENTO.prioridad,
      gemini_model: mapa[CLAVES.ENRIQUECIMIENTO_GEMINI_MODEL] || DEFAULTS_ENRIQUECIMIENTO.gemini_model,
      nvidia_model: mapa[CLAVES.ENRIQUECIMIENTO_NVIDIA_MODEL] || DEFAULTS_ENRIQUECIMIENTO.nvidia_model,
      gemini_habilitado: proveedoresHabilitados.gemini,
      nvidia_habilitado: proveedoresHabilitados.nvidia,
      gemini_api_key: desencriptarApiKey(mapa, CLAVES.GEMINI_API_KEY_ENC, process.env.GEMINI_API_KEY, 'gemini_api_key'),
      nvidia_api_key: desencriptarApiKey(mapa, CLAVES.NVIDIA_API_KEY_ENC, process.env.NVIDIA_API_KEY, 'nvidia_api_key'),
    };
  } catch (error) {
    console.warn('[ConfigIA] Error leyendo config de enriquecimiento, usando defaults del .env:', error.message);
    const proveedoresHabilitados = {
      gemini: DEFAULTS_ENRIQUECIMIENTO.gemini_habilitado,
      nvidia: DEFAULTS_ENRIQUECIMIENTO.nvidia_habilitado,
    };
    const prioridadBase = parsearPrioridad(DEFAULTS_ENRIQUECIMIENTO.prioridad);
    return {
      prioridad_proveedores: filtrarPrioridadPorHabilitacion(prioridadBase, proveedoresHabilitados),
      prioridad_proveedores_raw: DEFAULTS_ENRIQUECIMIENTO.prioridad,
      gemini_model: DEFAULTS_ENRIQUECIMIENTO.gemini_model,
      nvidia_model: DEFAULTS_ENRIQUECIMIENTO.nvidia_model,
      gemini_habilitado: proveedoresHabilitados.gemini,
      nvidia_habilitado: proveedoresHabilitados.nvidia,
      gemini_api_key: process.env.GEMINI_API_KEY || '',
      nvidia_api_key: process.env.NVIDIA_API_KEY || '',
    };
  }
}

module.exports = {
  obtenerConfigIA,
  obtenerConfigIAEnriquecimiento,
  parsearPrioridad,
  parsearBooleanoConfiguracion,
  filtrarPrioridadPorHabilitacion,
  CLAVES,
  DEFAULTS,
  DEFAULTS_ENRIQUECIMIENTO,
};
