/**
 * Controlador del Asistente IA
 * Orquesta los 5 endpoints: nuevaSesion, procesarMensaje,
 * validarConfiguracion, obtenerHistorial, obtenerSesion.
 */

const servicioSesion = require('./servicioSesion');
const servicioCuestionario = require('./servicioCuestionario');
const sistemaPrompt = require('./sistemaPrompt');
const servicioLLM = require('./servicioLLM');
const servicioSemaforo = require('./servicioSemaforo');
const servicioCompatibilidad = require('../servicios/servicioCompatibilidad');
const agenteBuscador = require('./agenteBuscador');
const agenteReranker = require('./agenteReranker');
const utilIntencion = require('./utilIntencion');
const servicioConfigIA = require('./servicioConfigIA');
const { sanitizarInput } = require('../utilidades/sanitizacion');
const { ejecutarQuery } = require('../configuracion/baseDatos');

// ── 1. POST /nueva-sesion ──

async function nuevaSesion(req, res) {
  try {
    const { usuario_id } = req.body || {};
    const { sesion_id, perfil_previo } = await servicioSesion.crearSesion(usuario_id || null);

    return res.status(201).json({
      exito: true,
      sesion_id,
      perfil_previo,
    });
  } catch (error) {
    console.error('[Asistente] Error en nuevaSesion:', error.message);
    return res.status(500).json({ exito: false, mensaje: 'Error interno. Intenta de nuevo.' });
  }
}

// ── 2. POST /mensaje (MAIN ORCHESTRATOR) ──

async function procesarMensaje(req, res) {
  try {
    const { sesion_id, mensaje, usuario_id } = req.body || {};

    // Validación de entrada
    if (!sesion_id) {
      return res.status(400).json({ exito: false, mensaje: 'sesion_id es requerido' });
    }
    if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
      return res.status(400).json({ exito: false, mensaje: 'Mensaje vacío' });
    }

    // Sanitizar input
    const mensajeSanitizado = sanitizarInput(mensaje);
    if (!mensajeSanitizado) {
      return res.status(400).json({ exito: false, mensaje: 'Mensaje vacío después de sanitizar' });
    }

    // Verificar que la sesión existe ANTES de guardar el mensaje
    const sesionCheck = await ejecutarQuery(
      'SELECT sesion_id FROM asistente_sesiones WHERE sesion_id = $1',
      [sesion_id]
    );
    if (sesionCheck.rows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: 'Sesión no encontrada' });
    }

    // Guardar mensaje del usuario
    await servicioSesion.guardarMensaje(sesion_id, 'user', mensajeSanitizado);

    // Obtener historial (últimos 8 mensajes)
    const historial = await servicioSesion.obtenerHistorialMensajes(sesion_id, 8);

    // Obtener parámetros financieros
    const { margen, igv, tipoCambio } = await servicioSesion.obtenerParametrosFinancieros();

    // Obtener catálogo de productos
    const productos = await servicioSesion.obtenerProductosDisponibles();

    // Construir estado del cuestionario
    const cuestionario = servicioCuestionario.construirEstadoCuestionario(historial);

    // Construir contexto de conversación
    const contextoConversacion = servicioCuestionario.construirContextoConversacion(cuestionario, historial);

    // Leer configuración de IA dinámicamente desde BD (con fallback a .env)
    const configIA = await servicioConfigIA.obtenerConfigIA();

    // ── Gate de scope: temas comerciales/negociación → derivar a asesor humano ──
    // El asistente solo arma/cotiza PCs. El chat sigue activo para temas de PC.
    if (utilIntencion.detectarNegociacion(mensajeSanitizado)) {
      const respuestaDeriva = {
        respuesta:
          'Para precios especiales, descuentos, garantía o financiamiento te conviene un asesor humano. Te puedo conectar por WhatsApp. Mientras tanto, seguimos armando tu PC cuando quieras.',
        quick_replies: ['Seguir armando mi PC', 'Hablar con un asesor'],
        perfil_usuario: cuestionario.uso || null,
        requiere_asesor: true,
      };
      await servicioSesion.guardarMensaje(sesion_id, 'assistant', respuestaDeriva.respuesta, {
        quick_replies: respuestaDeriva.quick_replies,
        requiere_asesor: true,
      });
      return res.json({
        exito: true,
        respuesta: respuestaDeriva.respuesta,
        quick_replies: respuestaDeriva.quick_replies,
        perfil_usuario: respuestaDeriva.perfil_usuario,
        requiere_asesor: true,
        configuracion_propuesta: null,
        semaforo: null,
      });
    }

    // ── Armado determinístico de la configuración (NO lo hace la IA) ──
    // Se construye cuando el cuestionario está completo y el usuario quiere verla.
    const quiereCotizar = utilIntencion.detectarIntencionCotizar(mensajeSanitizado);
    // Datos mínimos para armar: uso + presupuesto. Resolución y multitarea son
    // refinamientos opcionales (el motor usa defaults sensatos si faltan).
    const listoParaArmar = Boolean(cuestionario.uso && cuestionario.presupuestoPen);
    let configRaw = null;
    let configNarracion = null;

    if (listoParaArmar && quiereCotizar && productos && productos.length > 0) {
      try {
        const clasificacionLike = {
          uso_principal: cuestionario.uso,
          presupuesto_pen: cuestionario.presupuestoPen,
          resolucion: cuestionario.resolucion,
          multitarea_stream: cuestionario.multitarea,
          perfil: null,
        };
        const candidatos = await agenteBuscador.buscarProductos(
          clasificacionLike,
          productos,
          ejecutarQuery,
          configIA.nvidia_api_key
        );
        if (candidatos && candidatos.size > 0) {
          // Traer specs de todos los candidatos para imponer compatibilidad al armar
          const idsCandidatos = [];
          for (const items of candidatos.values()) {
            for (const c of items) idsCandidatos.push(c.id ?? c.producto?.id);
          }
          let specsMap = null;
          try {
            specsMap = await servicioCompatibilidad.obtenerMapaSpecsPorIds(idsCandidatos, ejecutarQuery);
          } catch (errorSpecs) {
            console.warn('[Asistente] No se pudieron cargar specs de candidatos:', errorSpecs.message);
          }
          const armado = await agenteReranker.rerank(clasificacionLike, candidatos, { tipoCambio, margen, igv, specsMap });
          configRaw = armado?.configuracion_propuesta || null;
        }
      } catch (errorArmado) {
        console.warn('[Asistente] Armado determinístico falló:', errorArmado.message);
      }

      if (configRaw) {
        const enriquecida = enriquecerPreciosPEN(configRaw, productos, margen, igv, tipoCambio);
        configNarracion = formatearConfigParaNarrar(enriquecida, cuestionario.presupuestoPen);
      }
    }

    // Config actual del cotizador (si el frontend la envía) → contexto para el LLM
    const configActualNarracion = formatearConfigActual(req.body?.configuracion_actual, productos, margen, igv, tipoCambio);

    // Construir system prompt con la config armada y/o la actual
    const systemPrompt = sistemaPrompt.construirSystemPrompt({
      productos,
      tipoCambio,
      margen,
      igv,
      contextoConversacion,
      configuracionArmada: configNarracion,
      configuracionActual: configActualNarracion,
    });

    // ── Conversador: único modelo de IA (TEXTO PLANO). Proveedor según modo_activo ──
    // Devuelve solo el mensaje; los quick_replies/perfil se derivan determinísticamente.
    let textoConversador;
    try {
      const prioridad = configIA.modo_activo === 'gemini' ? ['gemini', 'nvidia'] : ['nvidia', 'gemini'];
      const r = await servicioLLM.generarTextoConPrioridad({
        systemPrompt,
        historial,
        mensajeActual: mensajeSanitizado,
        configIA,
        prioridadProveedores: prioridad,
      });
      textoConversador = r.texto;
    } catch (errorLLM) {
      const msg =
        errorLLM.tipo === 'rate_limit'
          ? 'El servicio de IA esta saturado. Intenta en un momento.'
          : 'El servicio de IA no esta disponible temporalmente.';
      return res.status(502).json({ exito: false, mensaje: msg });
    }

    const datosPerfil = { uso_principal: cuestionario.uso, presupuesto_pen: cuestionario.presupuestoPen };
    const respuestaLLM = {
      respuesta: (textoConversador || '').trim() || 'No pude generar una respuesta. Intenta de nuevo o consulta con un asesor.',
      // Quick replies y perfil: determinísticos, no del LLM.
      quick_replies: derivarQuickReplies(cuestionario, configRaw),
      perfil_usuario: configRaw ? agenteReranker.inferirPerfil(datosPerfil) : null,
      requiere_asesor: false,
      // La configuración SIEMPRE la decide el motor determinístico, nunca la IA.
      configuracion_propuesta: configRaw,
    };

    let semaforo = null;
    let validacion = null;
    let configuracionGuardada = null;

    // Si el motor armó una configuración → Double-Check determinístico
    if (respuestaLLM.configuracion_propuesta && typeof respuestaLLM.configuracion_propuesta === 'object') {
      const configParaValidar = respuestaLLM.configuracion_propuesta;

      // Double-Check con servicioCompatibilidad
      try {
        validacion = await servicioCompatibilidad.validarConfiguracionConBD(configParaValidar, ejecutarQuery);
      } catch (errorCompat) {
        console.error('[Asistente] Error en Double-Check:', errorCompat.message);
        validacion = { compatible: false, errores: ['Error al validar compatibilidad'], advertencias: [] };
      }

      // Siempre devolver la config (con warnings si no es compatible — decisión de usuario)
      const esValida = validacion && validacion.compatible;
      configuracionGuardada = await servicioSesion.guardarConfiguracion(
        sesion_id,
        configParaValidar,
        esValida,
        1
      );

      // Enriquecer con precios en PEN
      respuestaLLM.configuracion_propuesta = enriquecerPreciosPEN(
        configParaValidar,
        productos,
        margen,
        igv,
        tipoCambio
      );

      // Calcular semáforo (necesitamos los componentes normalizados con specs)
      try {
        const mapa = await servicioCompatibilidad.obtenerMapaComponentesDesdeBD(configParaValidar, ejecutarQuery);
        const normalizados = {
          procesador: servicioCompatibilidad.convertirComponenteBD(configParaValidar.procesador, mapa),
          placa_madre: servicioCompatibilidad.convertirComponenteBD(configParaValidar.placa_madre, mapa),
          ram: (configParaValidar.ram || []).map((r) => servicioCompatibilidad.convertirComponenteBD(r, mapa)).filter(Boolean),
          almacenamiento: Array.isArray(configParaValidar.almacenamiento)
            ? configParaValidar.almacenamiento.map((a) => servicioCompatibilidad.convertirComponenteBD(a, mapa)).filter(Boolean)
            : servicioCompatibilidad.convertirComponenteBD(configParaValidar.almacenamiento, mapa),
          gpu: servicioCompatibilidad.convertirComponenteBD(configParaValidar.gpu, mapa),
          fuente: servicioCompatibilidad.convertirComponenteBD(configParaValidar.fuente, mapa),
          case: servicioCompatibilidad.convertirComponenteBD(configParaValidar.case, mapa),
        };

        semaforo = servicioSemaforo.calcularSemaforo(normalizados);
      } catch (errorSemaforo) {
        console.error('[Asistente] Error calculando semáforo:', errorSemaforo.message);
      }

      // Incluir advertencias de validación en la respuesta
      if (validacion && !validacion.compatible) {
        respuestaLLM.configuracion_propuesta.validacion = {
          compatible: false,
          errores: validacion.errores,
          advertencias: validacion.advertencias,
        };
      }
    }

    // Actualizar estado de sesión
    try {
      const nuevoEstado = cuestionario.completo
        ? 'listo_para_cotizar'
        : 'cuestionario';
      // perfil_usuario tiene un CHECK en BD: solo basico|intermedio|avanzado|gamer_full.
      // Nunca guardar el uso (p.ej. 'gaming') como perfil.
      const PERFILES_VALIDOS = ['basico', 'intermedio', 'avanzado', 'gamer_full'];
      const perfilParaGuardar = PERFILES_VALIDOS.includes(respuestaLLM.perfil_usuario)
        ? respuestaLLM.perfil_usuario
        : null;
      const presupuesto = cuestionario.presupuestoPen || null;

      await servicioSesion.actualizarEstadoSesion(sesion_id, nuevoEstado, perfilParaGuardar, presupuesto);
    } catch (errorSesion) {
      console.error('[Asistente] Error actualizando sesión:', errorSesion.message);
    }

    // Guardar mensaje del asistente
    const metadataAsistente = {
      quick_replies: respuestaLLM.quick_replies,
      perfil_usuario: respuestaLLM.perfil_usuario,
      requiere_asesor: respuestaLLM.requiere_asesor,
    };
    if (semaforo) metadataAsistente.semaforo = semaforo;
    if (configuracionGuardada) metadataAsistente.configuracion_id = configuracionGuardada.id;

    await servicioSesion.guardarMensaje(sesion_id, 'assistant', respuestaLLM.respuesta, metadataAsistente);

    // Construir respuesta al frontend
    const respuesta = {
      exito: true,
      respuesta: respuestaLLM.respuesta,
      quick_replies: respuestaLLM.quick_replies,
      perfil_usuario: respuestaLLM.perfil_usuario,
      requiere_asesor: respuestaLLM.requiere_asesor,
      configuracion_propuesta: respuestaLLM.configuracion_propuesta,
      semaforo,
    };

    return res.json(respuesta);
  } catch (error) {
    console.error('[Asistente] Error no manejado en procesarMensaje:', error);
    return res.status(500).json({ exito: false, mensaje: 'Error interno. Intenta de nuevo.' });
  }
}

// ── 3. POST /validar-configuracion ──

async function validarConfiguracion(req, res) {
  try {
    const { producto_ids } = req.body || {};

    if (!producto_ids || typeof producto_ids !== 'object') {
      return res.status(400).json({ valida: false, errores: ['producto_ids es requerido'] });
    }

    // Construir objeto de componentes con IDs
    const componentes = {
      procesador: producto_ids.procesador ? { id: producto_ids.procesador } : null,
      placa_madre: producto_ids.placa_madre ? { id: producto_ids.placa_madre } : null,
      ram: (producto_ids.ram || []).map((id) => ({ id })),
      almacenamiento: producto_ids.almacenamiento ? { id: producto_ids.almacenamiento } : null,
      gpu: producto_ids.gpu ? { id: producto_ids.gpu } : null,
      fuente: producto_ids.fuente ? { id: producto_ids.fuente } : null,
      case: producto_ids.case ? { id: producto_ids.case } : null,
    };

    const resultado = await servicioCompatibilidad.validarConfiguracionConBD(componentes, ejecutarQuery);

    return res.json({
      valida: resultado.compatible,
      errores: resultado.errores,
      advertencias: resultado.advertencias,
    });
  } catch (error) {
    console.error('[Asistente] Error en validarConfiguracion:', error.message);
    return res.status(500).json({ valida: false, errores: ['Error interno al validar'] });
  }
}

// ── 4. GET /historial/:usuario_id ──

async function obtenerHistorial(req, res) {
  try {
    const usuario_id = req.params.usuario_id;
    if (!usuario_id) {
      return res.status(400).json({ exito: false, mensaje: 'usuario_id es requerido' });
    }

    const sesiones = await servicioSesion.obtenerSesionesUsuario(Number(usuario_id));
    return res.json({ exito: true, sesiones });
  } catch (error) {
    console.error('[Asistente] Error en obtenerHistorial:', error.message);
    return res.status(500).json({ exito: false, mensaje: 'Error interno. Intenta de nuevo.' });
  }
}

// ── 5. GET /sesion/:sesion_id ──

async function obtenerSesion(req, res) {
  try {
    const sesion_id = req.params.sesion_id;
    if (!sesion_id) {
      return res.status(400).json({ exito: false, mensaje: 'sesion_id es requerido' });
    }

    const mensajes = await servicioSesion.obtenerHistorialMensajes(sesion_id, 100);
    return res.json({ exito: true, mensajes });
  } catch (error) {
    console.error('[Asistente] Error en obtenerSesion:', error.message);
    return res.status(500).json({ exito: false, mensaje: 'Error interno. Intenta de nuevo.' });
  }
}

// ── Utilidad: quick replies determinísticos (no del LLM) ──

function derivarQuickReplies(cuestionario, configRaw) {
  if (configRaw) {
    return ['Aplicar al cotizador', 'Ajustar presupuesto', 'Comparar alternativas', 'Hablar con un asesor'];
  }
  // Con uso + presupuesto ya se puede armar: ofrecer ver ahora o afinar detalles.
  const listoParaArmar = Boolean(cuestionario.uso && cuestionario.presupuestoPen);
  if (listoParaArmar) {
    const siguiente = servicioCuestionario.construirSiguientePregunta(cuestionario);
    const refinamiento = siguiente && Array.isArray(siguiente.quick_replies)
      ? siguiente.quick_replies.slice(0, 3)
      : [];
    return ['Ver mi configuración', ...refinamiento].slice(0, 5);
  }
  // Falta uso o presupuesto: pedir el siguiente dato.
  const siguiente = servicioCuestionario.construirSiguientePregunta(cuestionario);
  if (siguiente && Array.isArray(siguiente.quick_replies) && siguiente.quick_replies.length > 0) {
    return siguiente.quick_replies.slice(0, 5);
  }
  return [];
}

// ── Utilidad: formatear config armada por el motor para que el LLM la narre ──

function formatearConfigParaNarrar(enriquecida, presupuestoPen) {
  if (!enriquecida) return null;
  const lineas = [];
  const fmt = (pen) => `S/${Math.round(pen || 0).toLocaleString('es-PE')}`;
  const item = (label, comp) => {
    if (!comp || !comp.nombre) return;
    lineas.push(`- ${label}: ${comp.nombre} (${fmt(comp.precio_pen)})`);
  };

  item('Procesador', enriquecida.procesador);
  item('Placa madre', enriquecida.placa_madre);
  (enriquecida.ram || []).forEach((r) => item('RAM', r));
  item('Almacenamiento', enriquecida.almacenamiento);
  item('GPU', enriquecida.gpu);
  item('Fuente', enriquecida.fuente);
  item('Case', enriquecida.case);

  if (enriquecida.precio_total_pen) {
    lineas.push(`Total estimado: ${fmt(enriquecida.precio_total_pen)}`);
    if (presupuestoPen) {
      const pct = Math.round((enriquecida.precio_total_pen / presupuestoPen) * 100);
      lineas.push(`Presupuesto del usuario: ${fmt(presupuestoPen)} (la propuesta es ~${pct}% del presupuesto).`);
    }
  }

  return lineas.length > 0 ? lineas.join('\n') : null;
}

// ── Utilidad: formatear la config que el usuario ya tiene en el cotizador ──

function formatearConfigActual(configuracionActual, productos, margen, igv, tipoCambio) {
  if (!configuracionActual || typeof configuracionActual !== 'object') return null;

  const productosMap = new Map((productos || []).map((p) => [p.id, p]));
  const factor = (1 + margen / 100) * (1 + igv / 100) * tipoCambio;
  const fmt = (usd) => `S/${Math.round((usd || 0) * factor).toLocaleString('es-PE')}`;

  const nombreDe = (comp) => {
    if (!comp) return null;
    if (comp.nombre) {
      const precio = comp.precio_usd != null ? ` (${fmt(comp.precio_usd)})` : '';
      return `${comp.nombre}${precio}`;
    }
    if (comp.id) {
      const prod = productosMap.get(Number(comp.id));
      if (prod) return `${prod.nombre} (${fmt(prod.precio_usd)})`;
    }
    return null;
  };

  const lineas = [];
  const push = (label, comp) => {
    const n = nombreDe(comp);
    if (n) lineas.push(`- ${label}: ${n}`);
  };

  push('Procesador', configuracionActual.procesador);
  push('Placa madre', configuracionActual.placa_madre);
  (configuracionActual.ram || []).forEach((r) => push('RAM', r));
  const alm = Array.isArray(configuracionActual.almacenamiento)
    ? configuracionActual.almacenamiento
    : [configuracionActual.almacenamiento];
  alm.forEach((a) => push('Almacenamiento', a));
  push('GPU', configuracionActual.gpu);
  push('Fuente', configuracionActual.fuente);
  push('Case', configuracionActual.case);

  return lineas.length > 0 ? lineas.join('\n') : null;
}

// ── Utilidad: Enriquecer precios PEN ──

function enriquecerPreciosPEN(config, productos, margen, igv, tipoCambio) {
  const productosMap = new Map(productos.map((p) => [p.id, p]));
  const factor = (1 + margen / 100) * (1 + igv / 100) * tipoCambio;

  const enriquecerComponente = (comp) => {
    if (!comp || !comp.id) return comp;
    const producto = productosMap.get(Number(comp.id));
    if (!producto) return comp;
    return {
      ...comp,
      nombre: producto.nombre,
      precio_usd: producto.precio_usd,
      precio_pen: Math.round(producto.precio_usd * factor * 100) / 100,
    };
  };

  const enriquecido = {
    procesador: enriquecerComponente(config.procesador),
    placa_madre: enriquecerComponente(config.placa_madre),
    ram: (config.ram || []).map(enriquecerComponente),
    almacenamiento: enriquecerComponente(config.almacenamiento),
    gpu: enriquecerComponente(config.gpu),
    fuente: enriquecerComponente(config.fuente),
    case: enriquecerComponente(config.case),
  };

  // Calcular precio total
  let precioTotalUsd = 0;
  const sumar = (comp) => {
    if (comp && comp.precio_usd) precioTotalUsd += comp.precio_usd;
  };

  sumar(enriquecido.procesador);
  sumar(enriquecido.placa_madre);
  (enriquecido.ram || []).forEach(sumar);
  sumar(enriquecido.almacenamiento);
  sumar(enriquecido.gpu);
  sumar(enriquecido.fuente);
  sumar(enriquecido.case);

  enriquecido.precio_total_usd = Math.round(precioTotalUsd * 100) / 100;
  enriquecido.precio_total_pen = Math.round(precioTotalUsd * factor * 100) / 100;

  return enriquecido;
}

module.exports = {
  nuevaSesion,
  procesarMensaje,
  validarConfiguracion,
  obtenerHistorial,
  obtenerSesion,
};
