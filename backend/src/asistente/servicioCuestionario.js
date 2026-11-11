/**
 * Servicio de Cuestionario del Asistente IA
 * Lógica pura (sin DB, sin LLM) para detectar campos del cuestionario
 * desde el historial de mensajes y construir el contexto de conversación.
 */

// ── Diccionarios de detección ──

const PATRONES_USO = [
  { patron: /\b(gaming|juego|jugar|gam[eé]r|fps|esport)\b/i, uso: 'gaming' },
  { patron: /\b(edici[oó]n|video|premiere|davinci|after effects|renderizar video)\b/i, uso: 'edicion_video' },
  { patron: /\b(dise[ñn]o|render|3d|blender|autocad|maya|cinema 4d|zbrush)\b/i, uso: 'diseno_3d' },
  { patron: /\b(oficina|estudio|universidad|trabajo|navegaci[oó]n|documento|excel|word)\b/i, uso: 'oficina' },
];

const PATRONES_PRESUPUESTO = /\b[Ss/]?\s*(\d{3,5})\b/;

const PATRONES_RESOLUCION = [
  { patron: /\b4k|2160p|uhd\b/i, resolucion: '4k' },
  { patron: /\b1440p|2k\b/i, resolucion: '1440p' },
  { patron: /\b1080p|full\s*hd|fhd\b/i, resolucion: '1080p' },
];

const PATRONES_MULTITAREA = [
  { patron: /\b(s[ií]|stream|grabar|obs|twitch|youtube|simult[aá]neo)\b/i, multitarea: true },
  { patron: /\b(no\s*(?:necesito|quiero|hago)|sin streaming|no stream|no gras)\b/i, multitarea: false },
];

// ── Funciones de detección ──

function detectarUsoPrincipal(historial) {
  for (const msg of historial) {
    if (msg.rol !== 'user') continue;
    for (const { patron, uso } of PATRONES_USO) {
      if (patron.test(msg.contenido)) return uso;
    }
  }
  return null;
}

function extraerPresupuestoPen(historial) {
  for (const msg of historial) {
    if (msg.rol !== 'user') continue;
    const match = msg.contenido.match(PATRONES_PRESUPUESTO);
    if (match) {
      const monto = parseInt(match[1], 10);
      if (monto >= 500 && monto <= 50000) return monto;
    }
  }
  return null;
}

function detectarResolucion(historial) {
  for (const msg of historial) {
    if (msg.rol !== 'user') continue;
    for (const { patron, resolucion } of PATRONES_RESOLUCION) {
      if (patron.test(msg.contenido)) return resolucion;
    }
  }
  return null;
}

function detectarMultitarea(historial) {
  for (const msg of historial) {
    if (msg.rol !== 'user') continue;
    for (const { patron, multitarea } of PATRONES_MULTITAREA) {
      if (patron.test(msg.contenido)) return multitarea;
    }
  }
  return null;
}

// ── Campos relevantes según uso ──

function camposRelevantesPorUso(uso) {
  const base = ['uso', 'presupuesto'];
  if (!uso) return [...base, 'resolucion', 'multitarea'];

  if (uso === 'gaming') return [...base, 'resolucion', 'multitarea'];
  if (uso === 'edicion_video') return [...base, 'resolucion'];
  if (uso === 'diseno_3d') return [...base, 'resolucion', 'multitarea'];
  return base;
}

// ── Construcción del estado del cuestionario ──

function construirEstadoCuestionario(historial) {
  const uso = detectarUsoPrincipal(historial);
  const presupuesto = extraerPresupuestoPen(historial);
  const resolucion = detectarResolucion(historial);
  const multitarea = detectarMultitarea(historial);

  const relevantes = camposRelevantesPorUso(uso);

  const detectados = {
    uso,
    presupuesto,
    presupuestoPen: presupuesto,
    resolucion,
    multitarea,
  };

  const faltantes = relevantes.filter((campo) => {
    const val = detectados[campo];
    return val === null || val === undefined;
  });

  const completo = faltantes.length === 0;

  return { ...detectados, faltantes, completo };
}

// ── Construcción de siguiente pregunta (determinística, sin LLM) ──

const PREGUNTAS_CUESTIONARIO = {
  uso: {
    respuesta: '¿Para qué vas a usar principalmente tu PC?',
    quick_replies: ['Gaming', 'Edición de video', 'Diseño 3D / Render', 'Oficina / Estudio'],
  },
  presupuesto: {
    respuesta: '¿Cuál es tu presupuesto aproximado en soles (S/)?',
    quick_replies: ['S/ 2000–3000', 'S/ 3000–5000', 'S/ 5000–8000', 'S/ 8000+'],
  },
  resolucion: {
    respuesta: '¿En qué resolución vas a jugar o trabajar?',
    quick_replies: ['1080p (Full HD)', '1440p (2K)', '4K (Ultra HD)'],
  },
  multitarea: {
    respuesta: '¿Vas a hacer streaming o grabar mientras juegas/trabajas?',
    quick_replies: ['Sí, stream + juego', 'No, solo juego/trabajo'],
  },
};

function construirSiguientePregunta(cuestionario) {
  if (cuestionario.faltantes.length === 0) return null;
  const siguienteCampo = cuestionario.faltantes[0];
  return PREGUNTAS_CUESTIONARIO[siguienteCampo] || null;
}

// ── Contexto para el system prompt ──

function construirContextoConversacion(cuestionario, historial) {
  const detectedFields = {};
  const labels = {
    uso: 'Uso principal',
    presupuestoPen: 'Presupuesto PEN',
    resolucion: 'Resolución',
    multitarea: 'Multitarea/streaming',
  };

  for (const [campo, valor] of Object.entries(cuestionario)) {
    if (campo === 'faltantes' || campo === 'completo') continue;
    if (valor !== null && valor !== undefined) {
      detectedFields[labels[campo] || campo] = valor;
    }
  }

  return {
    campos_detectados: detectedFields,
    campos_faltantes: cuestionario.faltantes,
    cuestionario_completo: cuestionario.completo,
  };
}

module.exports = {
  construirEstadoCuestionario,
  construirSiguientePregunta,
  construirContextoConversacion,
  // Exportar detectores para testeo
  detectarUsoPrincipal,
  extraerPresupuestoPen,
  detectarResolucion,
  detectarMultitarea,
};
