/**
 * Controlador de Configuración del sistema (solo admin).
 *
 * Centraliza los parámetros globales almacenados en la tabla `configuracion`
 * (clave/valor): margen de ganancia por defecto, tasa de IGV, tipo de cambio USD/PEN
 * y su modo (manual/automático), número de WhatsApp de ventas, modelos y API keys de
 * los proveedores de IA (NVIDIA/Gemini) y el token de consulta de DNI. Los valores
 * sensibles (API keys, token DNI) se guardan cifrados y nunca se devuelven al cliente.
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');
const { CLAVES, DEFAULTS_ENRIQUECIMIENTO, parsearBooleanoConfiguracion } = require('../asistente/servicioConfigIA');
const { encriptar } = require('../utilidades/encriptacion');

/** Valida un margen de ganancia: número entre 0 y 100, o null si es inválido. */
function parseMargen(valor) {
  const numero = Number(valor);
  if (Number.isNaN(numero)) return null;
  if (numero < 0 || numero > 100) return null;
  return numero;
}

/** Valida un porcentaje (ej. IGV): número entre 0 y 100, o null si es inválido. */
function parsePorcentaje(valor) {
  const numero = Number(valor);
  if (Number.isNaN(numero)) return null;
  if (numero < 0 || numero > 100) return null;
  return numero;
}

/** Valida un tipo de cambio: número mayor a 0, o null si es inválido. */
function parseTipoCambio(valor) {
  const numero = Number(valor);
  if (Number.isNaN(numero)) return null;
  if (numero <= 0) return null;
  return numero;
}

// Número de WhatsApp de ventas: solo dígitos (código país + número), 8 a 15 dígitos.
function parseNumeroWhatsApp(valor) {
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).replace(/[^\d]/g, '');
  if (!/^\d{8,15}$/.test(limpio)) return null;
  return limpio;
}

/** Lee de BD las claves de configuración comercial y las devuelve indexadas por clave. */
async function obtenerMapaConfiguracion() {
  const resultado = await ejecutarQuery(
    "SELECT clave, valor, updated_at FROM configuracion WHERE clave IN ('margen_ganancia', 'margen_ganancia_default', 'tasa_igv', 'tipo_cambio_usd_pen', 'modo_tipo_cambio', 'whatsapp_numero_ventas')",
    []
  );

  return resultado.rows.reduce((acc, row) => {
    acc[row.clave] = row;
    return acc;
  }, {});
}

/** Upsert manual de una clave de configuración: intenta UPDATE y, si no existe, hace INSERT. */
async function guardarConfiguracion(clave, valor, descripcion) {
  const actualizado = await ejecutarQuery(
    `UPDATE configuracion
     SET valor = $1
     WHERE clave = $2
     RETURNING clave, valor, updated_at`,
    [String(valor), clave]
  );

  if (actualizado.rows.length > 0) {
    return actualizado.rows[0];
  }

  const insertado = await ejecutarQuery(
    `INSERT INTO configuracion (clave, valor, descripcion)
     VALUES ($1, $2, $3)
     RETURNING clave, valor, updated_at`,
    [clave, String(valor), descripcion]
  );

  return insertado.rows[0];
}

/** Arma el objeto de respuesta de configuración comercial, aplicando defaults cuando falta un valor. */
function construirPayloadConfiguracion(mapa) {
  const margenPorDefecto = parseMargen(mapa.margen_ganancia_default?.valor ?? mapa.margen_ganancia?.valor);
  const tasaIgv = parsePorcentaje(mapa.tasa_igv?.valor);
  const tipoCambio = parseTipoCambio(mapa.tipo_cambio_usd_pen?.valor);
  const modoRaw = mapa.modo_tipo_cambio?.valor;
  const modoCambio = (modoRaw === 'manual' || modoRaw === 'automatico') ? modoRaw : 'manual';

  const updatedAt = [
    mapa.margen_ganancia_default?.updated_at,
    mapa.margen_ganancia?.updated_at,
    mapa.tasa_igv?.updated_at,
    mapa.tipo_cambio_usd_pen?.updated_at,
  ].find(Boolean);

  // Número de WhatsApp de ventas: fuente de verdad en BD; fallback al .env.
  const whatsappNumeroVentas = parseNumeroWhatsApp(mapa.whatsapp_numero_ventas?.valor)
    ?? parseNumeroWhatsApp(process.env.WHATSAPP_NUMERO_ASESOR)
    ?? '';

  return {
    exito: true,
    margen_ganancia: margenPorDefecto ?? 20,
    margen_ganancia_default: margenPorDefecto ?? 20,
    tasa_igv: tasaIgv ?? 18,
    tipo_cambio_usd_pen: tipoCambio ?? 3.75,
    modo_tipo_cambio: modoCambio,
    whatsapp_numero_ventas: whatsappNumeroVentas,
    updated_at: updatedAt ?? null,
  };
}

/** GET /api/configuracion/margen — devuelve margen, IGV, tipo de cambio, modo y WhatsApp de ventas. */
async function obtenerMargen(req, res) {
  try {
    const mapaConfiguracion = await obtenerMapaConfiguracion();
    return res.json(construirPayloadConfiguracion(mapaConfiguracion));
  } catch (error) {
    console.error('Error al obtener margen:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo obtener la configuracion de margen',
    });
  }
}

/**
 * PUT /api/configuracion/margen
 * Actualiza margen por defecto (y su alias legacy), y opcionalmente IGV, tipo de cambio
 * y número de WhatsApp de ventas. Valida rangos antes de persistir; devuelve la config resultante.
 */
async function actualizarMargen(req, res) {
  try {
    const nuevoMargen = parseMargen(
      req.body?.margen_ganancia_default ?? req.body?.margen_ganancia
    );
    const nuevaTasaIgv = req.body?.tasa_igv === undefined
      ? undefined
      : parsePorcentaje(req.body?.tasa_igv);
    const nuevoTipoCambio = req.body?.tipo_cambio_usd_pen === undefined
      ? undefined
      : parseTipoCambio(req.body?.tipo_cambio_usd_pen);
    const nuevoNumeroWhatsApp = req.body?.whatsapp_numero_ventas === undefined
      ? undefined
      : parseNumeroWhatsApp(req.body?.whatsapp_numero_ventas);

    if (nuevoMargen === null || (req.body?.tasa_igv !== undefined && nuevaTasaIgv === null) || (req.body?.tipo_cambio_usd_pen !== undefined && nuevoTipoCambio === null)) {
      return res.status(400).json({
        error: 'Dato invalido',
        mensaje: 'margen_ganancia_default/tasa_igv deben estar entre 0 y 100 y tipo_cambio_usd_pen debe ser mayor a 0',
      });
    }

    if (req.body?.whatsapp_numero_ventas !== undefined && nuevoNumeroWhatsApp === null) {
      return res.status(400).json({
        error: 'Dato invalido',
        mensaje: 'whatsapp_numero_ventas debe contener entre 8 y 15 digitos (incluye codigo de pais)',
      });
    }

    await guardarConfiguracion('margen_ganancia_default', nuevoMargen, 'Porcentaje de margen por defecto para cotizaciones');
    await guardarConfiguracion('margen_ganancia', nuevoMargen, 'Compatibilidad con clientes legacy');

    if (nuevaTasaIgv !== undefined) {
      await guardarConfiguracion('tasa_igv', nuevaTasaIgv, 'Porcentaje de IGV aplicado al precio neto');
    }

    if (nuevoTipoCambio !== undefined) {
      await guardarConfiguracion('tipo_cambio_usd_pen', nuevoTipoCambio, 'Tipo de cambio referencial USD a PEN');
    }

    if (nuevoNumeroWhatsApp !== undefined) {
      await guardarConfiguracion('whatsapp_numero_ventas', nuevoNumeroWhatsApp, 'Numero de WhatsApp del area de ventas (codigo pais + numero)');
    }

    const mapaConfiguracion = await obtenerMapaConfiguracion();
    const payload = construirPayloadConfiguracion(mapaConfiguracion);
    return res.json({
      mensaje: 'Margen actualizado correctamente',
      ...payload,
    });
  } catch (error) {
    console.error('Error al actualizar margen:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo actualizar la configuracion de margen',
    });
  }
}

/** PUT /api/configuracion/modo-tipo-cambio — fija el modo de obtención del TC en 'manual' o 'automatico'. */
async function actualizarModoTipoCambio(req, res) {
  try {
    const { modo } = req.body ?? {};

    if (modo !== 'manual' && modo !== 'automatico') {
      return res.status(400).json({
        error: 'Dato inválido',
        mensaje: "El modo debe ser 'manual' o 'automatico'",
      });
    }

    await guardarConfiguracion(
      'modo_tipo_cambio',
      modo,
      'Modo de obtención del tipo de cambio USD/PEN: manual o automatico'
    );

    return res.json({
      exito: true,
      modo_tipo_cambio: modo,
      mensaje: 'Modo de tipo de cambio actualizado correctamente',
    });
  } catch (error) {
    console.error('Error al actualizar modo de tipo de cambio:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo actualizar el modo de tipo de cambio',
    });
  }
}

// Arquitectura single-AI: el único modelo es el conversador (nvidia o gemini).
const MODOS_VALIDOS = ['nvidia', 'gemini'];
const MODELOS_REQUERIDOS_POR_MODO = {
  nvidia: ['nvidia_model'],
  gemini: ['gemini_model'],
};

const DEFAULTS_IA = {
  modo_activo: ['nvidia', 'gemini'].includes(String(process.env.IA_MODO_ACTIVO || '').toLowerCase())
    ? String(process.env.IA_MODO_ACTIVO).toLowerCase()
    : 'nvidia',
  gemini_model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  nvidia_model: process.env.NVIDIA_MODEL || 'mistralai/mistral-small-4-119b-2603',
};

const PROVEEDORES_ENRIQUECIMIENTO_VALIDOS = ['nvidia', 'gemini'];

/** Normaliza la prioridad de proveedores de enriquecimiento: lista separada por comas, en minúsculas, sin duplicados ni proveedores no válidos. */
function normalizarPrioridadEnriquecimiento(valor) {
  const prioridad = String(valor || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const deduplicada = prioridad.filter((proveedor, indice) =>
    PROVEEDORES_ENRIQUECIMIENTO_VALIDOS.includes(proveedor) && prioridad.indexOf(proveedor) === indice
  );

  return deduplicada;
}

/** GET /api/configuracion/ia/modelos — devuelve el proveedor activo (nvidia/gemini) y el modelo configurado de cada uno. */
async function obtenerModelosIA(req, res) {
  try {
    const { rows } = await ejecutarQuery(
      `SELECT clave, valor FROM configuracion WHERE clave = ANY($1)`,
      [[
        CLAVES.MODO_ACTIVO,
        CLAVES.GEMINI_MODEL,
        CLAVES.NVIDIA_MODEL,
      ]]
    );

    const mapa = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const modoGuardado = mapa[CLAVES.MODO_ACTIVO];
    const modoActivo = MODOS_VALIDOS.includes(modoGuardado) ? modoGuardado : DEFAULTS_IA.modo_activo;

    return res.json({
      exito: true,
      modo_activo: modoActivo,
      gemini_model: mapa[CLAVES.GEMINI_MODEL] || DEFAULTS_IA.gemini_model,
      nvidia_model: mapa[CLAVES.NVIDIA_MODEL] || DEFAULTS_IA.nvidia_model,
    });
  } catch (error) {
    console.error('[ConfigIA] Error al obtener modelos IA:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo obtener la configuración de modelos de IA',
    });
  }
}

/**
 * PUT /api/configuracion/ia/modelos
 * Fija el proveedor de IA activo y su modelo. Exige que venga el modelo requerido por
 * el modo elegido (nvidia_model si nvidia, gemini_model si gemini) antes de persistir.
 */
async function actualizarModelosIA(req, res) {
  try {
    const {
      modo_activo,
      gemini_model,
      nvidia_model,
    } = req.body || {};

    if (!modo_activo || !MODOS_VALIDOS.includes(modo_activo)) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'MODO_INVALIDO',
        mensaje: `El modo debe ser uno de: ${MODOS_VALIDOS.join(', ')}`,
      });
    }

    const valoresRecibidos = {
      gemini_model,
      nvidia_model,
    };

    const camposRequeridos = MODELOS_REQUERIDOS_POR_MODO[modo_activo];
    for (const campo of camposRequeridos) {
      const valor = valoresRecibidos[campo];
      if (!valor || typeof valor !== 'string' || valor.trim() === '') {
        return res.status(400).json({
          error: 'Dato inválido',
          codigo: 'MODELO_INVALIDO',
          mensaje: `El campo '${campo}' es requerido para el modo '${modo_activo}'`,
          campo,
        });
      }
    }

    const mapaClaveBD = {
      modo_activo: CLAVES.MODO_ACTIVO,
      gemini_model: CLAVES.GEMINI_MODEL,
      nvidia_model: CLAVES.NVIDIA_MODEL,
    };

    const entradas = [
      ['modo_activo', modo_activo],
      ['gemini_model', gemini_model],
      ['nvidia_model', nvidia_model],
    ];

    for (const [campo, valor] of entradas) {
      if (valor !== undefined && valor !== null) {
        await ejecutarQuery(
          `INSERT INTO configuracion (clave, valor)
           VALUES ($1, $2)
           ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
          [mapaClaveBD[campo], String(valor).trim()]
        );
      }
    }

    const { rows } = await ejecutarQuery(
      `SELECT clave, valor FROM configuracion WHERE clave = ANY($1)`,
      [[
        CLAVES.MODO_ACTIVO,
        CLAVES.GEMINI_MODEL,
        CLAVES.NVIDIA_MODEL,
      ]]
    );
    const mapa = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));

    return res.json({
      exito: true,
      mensaje: 'Configuración de IA actualizada correctamente',
      modo_activo: mapa[CLAVES.MODO_ACTIVO] || DEFAULTS_IA.modo_activo,
      gemini_model: mapa[CLAVES.GEMINI_MODEL] || DEFAULTS_IA.gemini_model,
      nvidia_model: mapa[CLAVES.NVIDIA_MODEL] || DEFAULTS_IA.nvidia_model,
    });
  } catch (error) {
    console.error('[ConfigIA] Error al actualizar modelos IA:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo actualizar la configuración de modelos de IA',
    });
  }
}

/**
 * GET /api/configuracion/ia/api-keys
 * Informa solo SI cada proveedor tiene su API key configurada (booleanos); nunca
 * devuelve el valor de la clave, que se guarda cifrado.
 */
async function obtenerApiKeysIA(req, res) {
  try {
    const { rows } = await ejecutarQuery(
      `SELECT clave, valor FROM configuracion WHERE clave = ANY($1)`,
      [[CLAVES.GEMINI_API_KEY_ENC, CLAVES.NVIDIA_API_KEY_ENC]]
    );

    const mapa = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));

    return res.json({
      exito: true,
      gemini_configurada: !!mapa[CLAVES.GEMINI_API_KEY_ENC],
      nvidia_configurada: !!mapa[CLAVES.NVIDIA_API_KEY_ENC],
    });
  } catch (error) {
    console.error('[ConfigIA] Error al obtener estado de API keys:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo obtener el estado de las claves API de IA',
    });
  }
}

/**
 * PUT /api/configuracion/ia/api-keys
 * Guarda cifradas las API keys de Gemini y/o NVIDIA. Acepta actualizar una o ambas;
 * rechaza el envío de una clave vacía.
 */
async function actualizarApiKeysIA(req, res) {
  try {
    const { gemini_api_key, nvidia_api_key } = req.body || {};

    const geminiValida = gemini_api_key && typeof gemini_api_key === 'string' && gemini_api_key.trim() !== '';
    const nvidiaValida = nvidia_api_key && typeof nvidia_api_key === 'string' && nvidia_api_key.trim() !== '';
    const geminiEnviada = 'gemini_api_key' in (req.body || {});
    const nvidiaEnviada = 'nvidia_api_key' in (req.body || {});

    if (!geminiEnviada && !nvidiaEnviada) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'API_KEY_INVALIDA',
        mensaje: 'Debe enviar al menos una clave API (gemini_api_key o nvidia_api_key)',
      });
    }

    if (geminiEnviada && !geminiValida) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'API_KEY_INVALIDA',
        mensaje: 'El campo gemini_api_key no puede estar vacío',
        campo: 'gemini_api_key',
      });
    }

    if (nvidiaEnviada && !nvidiaValida) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'API_KEY_INVALIDA',
        mensaje: 'El campo nvidia_api_key no puede estar vacío',
        campo: 'nvidia_api_key',
      });
    }

    if (geminiValida) {
      const encriptada = encriptar(gemini_api_key.trim());
      await ejecutarQuery(
        `INSERT INTO configuracion (clave, valor)
         VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [CLAVES.GEMINI_API_KEY_ENC, encriptada]
      );
    }

    if (nvidiaValida) {
      const encriptada = encriptar(nvidia_api_key.trim());
      await ejecutarQuery(
        `INSERT INTO configuracion (clave, valor)
         VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [CLAVES.NVIDIA_API_KEY_ENC, encriptada]
      );
    }

    return res.json({ exito: true });
  } catch (error) {
    console.error('[ConfigIA] Error al actualizar API keys:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudieron guardar las claves API de IA',
    });
  }
}

/** GET /api/configuracion/ia/enriquecimiento — devuelve prioridad de proveedores, modelos y flags de habilitación del enriquecimiento IA. */
async function obtenerModelosIAEnriquecimiento(req, res) {
  try {
    const { rows } = await ejecutarQuery(
      `SELECT clave, valor FROM configuracion WHERE clave = ANY($1)`,
      [[
        CLAVES.ENRIQUECIMIENTO_PRIORIDAD,
        CLAVES.ENRIQUECIMIENTO_GEMINI_MODEL,
        CLAVES.ENRIQUECIMIENTO_NVIDIA_MODEL,
        CLAVES.ENRIQUECIMIENTO_GEMINI_HABILITADO,
        CLAVES.ENRIQUECIMIENTO_NVIDIA_HABILITADO,
      ]]
    );

    const mapa = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const prioridad = mapa[CLAVES.ENRIQUECIMIENTO_PRIORIDAD] || DEFAULTS_ENRIQUECIMIENTO.prioridad;

    return res.json({
      exito: true,
      prioridad_proveedores: prioridad,
      gemini_model: mapa[CLAVES.ENRIQUECIMIENTO_GEMINI_MODEL] || DEFAULTS_ENRIQUECIMIENTO.gemini_model,
      nvidia_model: mapa[CLAVES.ENRIQUECIMIENTO_NVIDIA_MODEL] || DEFAULTS_ENRIQUECIMIENTO.nvidia_model,
      gemini_habilitado: parsearBooleanoConfiguracion(mapa[CLAVES.ENRIQUECIMIENTO_GEMINI_HABILITADO], DEFAULTS_ENRIQUECIMIENTO.gemini_habilitado),
      nvidia_habilitado: parsearBooleanoConfiguracion(mapa[CLAVES.ENRIQUECIMIENTO_NVIDIA_HABILITADO], DEFAULTS_ENRIQUECIMIENTO.nvidia_habilitado),
    });
  } catch (error) {
    console.error('[ConfigIA] Error al obtener modelos de enriquecimiento IA:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo obtener la configuración de enriquecimiento de IA',
    });
  }
}

/**
 * PUT /api/configuracion/ia/enriquecimiento
 * Actualiza la prioridad de proveedores, sus modelos y flags de habilitación para el
 * enriquecimiento. Exige al menos un proveedor habilitado y su modelo correspondiente.
 */
async function actualizarModelosIAEnriquecimiento(req, res) {
  try {
    const {
      prioridad_proveedores,
      gemini_model,
      nvidia_model,
      gemini_habilitado,
      nvidia_habilitado,
    } = req.body || {};

    const prioridadNormalizada = normalizarPrioridadEnriquecimiento(prioridad_proveedores);
    const geminiHabilitadoNormalizado = parsearBooleanoConfiguracion(gemini_habilitado, DEFAULTS_ENRIQUECIMIENTO.gemini_habilitado);
    const nvidiaHabilitadoNormalizado = parsearBooleanoConfiguracion(nvidia_habilitado, DEFAULTS_ENRIQUECIMIENTO.nvidia_habilitado);

    if (!prioridad_proveedores || prioridadNormalizada.length === 0) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'PRIORIDAD_INVALIDA',
        mensaje: 'La prioridad debe incluir al menos un proveedor válido: nvidia, gemini',
      });
    }

    if (!geminiHabilitadoNormalizado && !nvidiaHabilitadoNormalizado) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'PROVEEDORES_DESHABILITADOS',
        mensaje: 'Debe haber al menos un proveedor habilitado para el enriquecimiento',
      });
    }

    if (nvidiaHabilitadoNormalizado && (!nvidia_model || typeof nvidia_model !== 'string' || nvidia_model.trim() === '')) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'MODELO_INVALIDO',
        mensaje: "El campo 'nvidia_model' es requerido cuando NVIDIA está habilitado",
        campo: 'nvidia_model',
      });
    }

    if (geminiHabilitadoNormalizado && (!gemini_model || typeof gemini_model !== 'string' || gemini_model.trim() === '')) {
      return res.status(400).json({
        error: 'Dato inválido',
        codigo: 'MODELO_INVALIDO',
        mensaje: "El campo 'gemini_model' es requerido cuando Gemini está habilitado",
        campo: 'gemini_model',
      });
    }

    const entradas = [
      [CLAVES.ENRIQUECIMIENTO_PRIORIDAD, prioridadNormalizada.join(',')],
      [CLAVES.ENRIQUECIMIENTO_NVIDIA_HABILITADO, String(nvidiaHabilitadoNormalizado)],
      [CLAVES.ENRIQUECIMIENTO_GEMINI_HABILITADO, String(geminiHabilitadoNormalizado)],
      [CLAVES.ENRIQUECIMIENTO_NVIDIA_MODEL, (nvidia_model || DEFAULTS_ENRIQUECIMIENTO.nvidia_model).trim()],
      [CLAVES.ENRIQUECIMIENTO_GEMINI_MODEL, (gemini_model || DEFAULTS_ENRIQUECIMIENTO.gemini_model).trim()],
    ];

    for (const [clave, valor] of entradas) {
      await ejecutarQuery(
        `INSERT INTO configuracion (clave, valor)
         VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [clave, valor]
      );
    }

    return res.json({
      exito: true,
      mensaje: 'Configuración de enriquecimiento IA actualizada correctamente',
      prioridad_proveedores: prioridadNormalizada.join(','),
      gemini_model: (gemini_model || DEFAULTS_ENRIQUECIMIENTO.gemini_model).trim(),
      nvidia_model: (nvidia_model || DEFAULTS_ENRIQUECIMIENTO.nvidia_model).trim(),
      gemini_habilitado: geminiHabilitadoNormalizado,
      nvidia_habilitado: nvidiaHabilitadoNormalizado,
    });
  } catch (error) {
    console.error('[ConfigIA] Error al actualizar modelos de enriquecimiento IA:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo actualizar la configuración de enriquecimiento de IA',
    });
  }
}

const CLAVE_TOKEN_DNI = 'decolecta_api_token_enc';

// Estado del token de consulta de DNI (decolecta). No expone el valor (es secreto).
async function obtenerEstadoTokenDni(req, res) {
  try {
    const { rows } = await ejecutarQuery('SELECT valor FROM configuracion WHERE clave = $1', [CLAVE_TOKEN_DNI]);
    const configurado = !!(rows[0]?.valor && String(rows[0].valor).trim()) || !!process.env.DECOLECTA_API_TOKEN;
    return res.json({ exito: true, configurado });
  } catch (error) {
    console.error('Error al obtener estado del token DNI:', error);
    return res.status(500).json({ error: 'Error interno', mensaje: 'No se pudo obtener el estado del token de DNI' });
  }
}

// Guarda (encriptado) el token de decolecta. Solo admin.
async function actualizarTokenDni(req, res) {
  try {
    const token = req.body?.token;
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).json({ error: 'Dato inválido', mensaje: 'El token es requerido' });
    }
    await ejecutarQuery(
      `INSERT INTO configuracion (clave, valor)
       VALUES ($1, $2)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [CLAVE_TOKEN_DNI, encriptar(token.trim())]
    );
    return res.json({ exito: true, mensaje: 'Token de consulta de DNI actualizado' });
  } catch (error) {
    console.error('Error al actualizar token DNI:', error);
    return res.status(500).json({ error: 'Error interno', mensaje: 'No se pudo guardar el token de DNI' });
  }
}

module.exports = {
  obtenerMargen,
  actualizarMargen,
  actualizarModoTipoCambio,
  obtenerEstadoTokenDni,
  actualizarTokenDni,
  obtenerModelosIA,
  actualizarModelosIA,
  obtenerApiKeysIA,
  actualizarApiKeysIA,
  obtenerModelosIAEnriquecimiento,
  actualizarModelosIAEnriquecimiento,
};
