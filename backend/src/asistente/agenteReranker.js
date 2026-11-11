/**
 * Agente Reranker del Pipeline Multi-Agente
 * Toma los candidatos del Buscador (top-K por categoría) y selecciona el mejor
 * producto de cada categoría según: compatibilidad, presupuesto y score semántico.
 *
 * Flujo:
 * 1. Agrupar candidatos por categoría (normalizando nombres)
 * 2. Para cada categoría, seleccionar el mejor producto según presupuesto + score
 * 3. Aplicar filtros de compatibilidad determinísticos (socket CPU↔placa, etc.)
 * 4. Devolver configuracion_propuesta con 7 slots
 */

const servicioCompatibilidad = require('../servicios/servicioCompatibilidad');

// ── Normalizar nombre de categoría a clave interna ──

const MAPA_CATEGORIAS = {
  procesador: 'procesador',
  cpu: 'procesador',
  placa_madre: 'placa_madre',
  'placa madre': 'placa_madre',
  motherboard: 'placa_madre',
  ram: 'ram',
  memoria: 'ram',
  almacenamiento: 'almacenamiento',
  disco: 'almacenamiento',
  ssd: 'almacenamiento',
  hdd: 'almacenamiento',
  gpu: 'gpu',
  grafica: 'gpu',
  video: 'gpu',
  tarjeta_grafica: 'gpu',
  'tarjeta grafica': 'gpu',
  'tarjeta de video': 'gpu',
  fuente: 'fuente',
  fuente_de_poder: 'fuente',
  'fuente de poder': 'fuente',
  psu: 'fuente',
  case: 'case',
  gabinete: 'case',
  chasis: 'case',
};

function normalizarCategoria(nombre) {
  if (!nombre) return null;
  const clave = nombre.toLowerCase().trim();
  return MAPA_CATEGORIAS[clave] || clave;
}

// ── Specs de un candidato (desde specsMap de BD o campos del producto) ──

function specsDe(candidato, specsMap) {
  const producto = candidato.producto || {};
  const id = candidato.id ?? producto.id;
  const bd = specsMap ? (servicioCompatibilidad.convertirComponenteBD({ id }, specsMap) || {}) : {};

  // El specsMap de BD tiene prioridad; si falta, se usan campos del producto.
  return {
    socket: bd.socket ?? producto.socket ?? null,
    ram_tipo: bd.ram_tipo ?? producto.ram_tipo ?? producto.ram_type ?? null,
    form_factor: bd.form_factor ?? producto.form_factor ?? null,
    m2_slots: bd.m2_slots ?? producto.m2_slots ?? null,
    tipo_almacenamiento: bd.tipo_almacenamiento ?? producto.tipo_almacenamiento ?? null,
    tdp_w: bd.tdp_w ?? producto.tdp_w ?? null,
    longitud_mm: bd.longitud_mm ?? producto.longitud_mm ?? null,
    wattage: bd.wattage ?? producto.wattage ?? null,
    max_gpu_mm: bd.max_gpu_mm ?? producto.max_gpu_mm ?? null,
    compatibilidad_placa: bd.compatibilidad_placa ?? producto.compatibilidad_placa ?? null,
  };
}

function infoCandidato(candidato, specsMap) {
  const producto = candidato.producto || {};
  return {
    id: candidato.id ?? producto.id,
    producto,
    specs: specsDe(candidato, specsMap),
    precio: producto.precio_usd || 0,
    stock: producto.stock || 0,
    score: candidato.score || 0,
  };
}

// ── Seleccionar el mejor candidato de una categoría ──
// Prioriza: (1) stock disponible, (2) dentro del presupuesto de categoría,
// (3) mejor score / cercanía al presupuesto. Aplica un filtro de compatibilidad
// opcional; si el filtro deja la lista vacía, se relaja (el Double-Check avisará).

function elegirMejor(infos, presupuestoCategoria, filtroCompat) {
  if (!infos || infos.length === 0) return null;

  let pool = infos;
  if (typeof filtroCompat === 'function') {
    const filtrados = infos.filter(filtroCompat);
    if (filtrados.length > 0) pool = filtrados;
  }

  const ordenados = [...pool].sort((a, b) => {
    // 1) Stock disponible primero (los "a pedido" tienen stock 0)
    const stockA = a.stock > 0 ? 1 : 0;
    const stockB = b.stock > 0 ? 1 : 0;
    if (stockA !== stockB) return stockB - stockA;

    if (presupuestoCategoria) {
      const dentroA = a.precio <= presupuestoCategoria ? 1 : 0;
      const dentroB = b.precio <= presupuestoCategoria ? 1 : 0;
      if (dentroA !== dentroB) return dentroB - dentroA;
      if (dentroA) return (b.score - a.score) || (b.precio - a.precio);
      return Math.abs(a.precio - presupuestoCategoria) - Math.abs(b.precio - presupuestoCategoria);
    }
    return b.score - a.score;
  });

  return ordenados[0] || null;
}

// ── Consumo estimado del sistema (para dimensionar la fuente) ──

function estimarConsumo(seleccion) {
  return servicioCompatibilidad.calcularConsumoTotal({
    procesador: seleccion.procesador ? { tdp_w: seleccion.procesador.specs.tdp_w } : null,
    gpu: seleccion.gpu ? { tdp_w: seleccion.gpu.specs.tdp_w } : null,
    placa_madre: seleccion.placa_madre ? { tdp_w: seleccion.placa_madre.specs.tdp_w } : null,
    ram: seleccion.ram ? [{}] : [],
    almacenamiento: seleccion.almacenamiento ? {} : null,
  });
}

// ── Distribución de presupuesto por uso ──
// Porcentaje del presupuesto TOTAL que debe ir a cada categoría

const DISTRIBUCION = {
  gaming_1080p:  { procesador: 0.21, gpu: 0.26, ram: 0.16, almacenamiento: 0.12, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
  gaming_1440p:  { procesador: 0.24, gpu: 0.30, ram: 0.18, almacenamiento: 0.12, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
  gaming_4k:     { procesador: 0.24, gpu: 0.34, ram: 0.20, almacenamiento: 0.14, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
  edicion_video: { procesador: 0.24, gpu: 0.27, ram: 0.20, almacenamiento: 0.16, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
  diseno_3d:     { procesador: 0.22, gpu: 0.32, ram: 0.18, almacenamiento: 0.14, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
  oficina:       { procesador: 0.25, gpu: 0.12, ram: 0.18, almacenamiento: 0.12, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
  default:       { procesador: 0.22, gpu: 0.26, ram: 0.16, almacenamiento: 0.12, placa_madre: 0.14, fuente: 0.06, case: 0.06 },
};

function obtenerDistribucion(uso, resolucion) {
  if (uso === 'gaming') {
    if (resolucion === '4k') return DISTRIBUCION.gaming_4k;
    if (resolucion === '1440p') return DISTRIBUCION.gaming_1440p;
    return DISTRIBUCION.gaming_1080p;
  }
  if (uso === 'edicion_video') return DISTRIBUCION.edicion_video;
  if (uso === 'diseno_3d') return DISTRIBUCION.diseno_3d;
  if (uso === 'oficina') return DISTRIBUCION.oficina;
  return DISTRIBUCION.default;
}

// ── Función principal ──

async function rerank(clasificacion, candidatosPorCategoria, { tipoCambio, margen, igv, specsMap } = {}) {
  const uso = clasificacion.uso_principal || 'default';
  const resolucion = clasificacion.resolucion;
  const distribucion = obtenerDistribucion(uso, resolucion);

  // Calcular presupuesto total en USD
  const presupuestoUsd = clasificacion.presupuesto_pen
    ? clasificacion.presupuesto_pen / tipoCambio / ((1 + margen / 100) * (1 + igv / 100))
    : null;

  // Normalizar candidatos por categoría → info enriquecida con specs
  const infosPorCat = new Map();
  for (const [clave, items] of candidatosPorCategoria) {
    const cat = normalizarCategoria(clave);
    if (cat && items && items.length > 0) {
      infosPorCat.set(cat, items.map((i) => infoCandidato(i, specsMap)));
    }
  }

  const presupuestoCat = (cat) => (presupuestoUsd ? presupuestoUsd * (distribucion[cat] || 0.10) : null);
  const seleccion = {};

  // 1) Procesador
  seleccion.procesador = elegirMejor(infosPorCat.get('procesador'), presupuestoCat('procesador'));
  const cpuSocket = seleccion.procesador?.specs?.socket || null;

  // 2) Placa madre — debe compartir socket con el CPU
  seleccion.placa_madre = elegirMejor(
    infosPorCat.get('placa_madre'),
    presupuestoCat('placa_madre'),
    cpuSocket ? (i) => !i.specs.socket || i.specs.socket === cpuSocket : null
  );
  const placaRamTipo = seleccion.placa_madre?.specs?.ram_tipo || null;
  const placaFormFactor = seleccion.placa_madre?.specs?.form_factor || null;
  const placaM2 = Number(seleccion.placa_madre?.specs?.m2_slots || 0);

  // 3) RAM — tipo (DDR4/DDR5) debe coincidir con la placa
  seleccion.ram = elegirMejor(
    infosPorCat.get('ram'),
    presupuestoCat('ram'),
    placaRamTipo ? (i) => !i.specs.ram_tipo || i.specs.ram_tipo === placaRamTipo : null
  );

  // 4) Almacenamiento — si la placa no tiene M.2, evitar M.2/NVMe
  seleccion.almacenamiento = elegirMejor(
    infosPorCat.get('almacenamiento'),
    presupuestoCat('almacenamiento'),
    placaM2 <= 0 && seleccion.placa_madre
      ? (i) => !/m\.2|nvme/i.test(String(i.specs.tipo_almacenamiento || ''))
      : null
  );

  // 5) GPU
  seleccion.gpu = elegirMejor(infosPorCat.get('gpu'), presupuestoCat('gpu'));
  const gpuLargo = Number(seleccion.gpu?.specs?.longitud_mm || 0);

  // 6) Fuente — wattaje suficiente para el consumo estimado
  const consumoEstimado = estimarConsumo(seleccion);
  seleccion.fuente = elegirMejor(
    infosPorCat.get('fuente'),
    presupuestoCat('fuente'),
    consumoEstimado > 0 ? (i) => !i.specs.wattage || Number(i.specs.wattage) >= consumoEstimado : null
  );

  // 7) Case — soporta el form factor de la placa y el largo de la GPU
  seleccion.case = elegirMejor(
    infosPorCat.get('case'),
    presupuestoCat('case'),
    (i) => {
      if (placaFormFactor && i.specs.compatibilidad_placa) {
        const soportados = servicioCompatibilidad
          .parsearListaFormFactor(i.specs.compatibilidad_placa)
          .map((ff) => servicioCompatibilidad.normalizarFormFactor(ff));
        const ffPlaca = servicioCompatibilidad.normalizarFormFactor(placaFormFactor);
        if (soportados.length > 0 && ffPlaca && !soportados.includes(ffPlaca)) return false;
      }
      const maxGpu = Number(i.specs.max_gpu_mm || 0);
      if (gpuLargo > 0 && maxGpu > 0 && gpuLargo > maxGpu) return false;
      return true;
    }
  );

  const idDe = (sel) => (sel && sel.id ? { id: sel.id } : null);

  return {
    configuracion_propuesta: {
      procesador: idDe(seleccion.procesador),
      placa_madre: idDe(seleccion.placa_madre),
      ram: seleccion.ram ? [{ id: seleccion.ram.id }] : [],
      almacenamiento: idDe(seleccion.almacenamiento),
      gpu: idDe(seleccion.gpu),
      fuente: idDe(seleccion.fuente),
      case: idDe(seleccion.case),
    },
    perfil: clasificacion.perfil || inferirPerfil(clasificacion),
    confianza: 0.7,
    alternativas: [],
  };
}

// ── Fallback: misma lógica determinística (sin specsMap) ──

function rerankFallback(clasificacion, candidatosPorCategoria, opciones) {
  return rerank(clasificacion, candidatosPorCategoria, opciones || {});
}

// ── Inferir perfil ──

function inferirPerfil(clasificacion) {
  const p = clasificacion.presupuesto_pen;
  const uso = clasificacion.uso_principal;

  if (!p) {
    if (uso === 'oficina') return 'basico';
    if (uso === 'gaming' || uso === 'diseno_3d') return 'avanzado';
    return 'intermedio';
  }
  if (p <= 3000) return 'basico';
  if (p <= 5000) return 'intermedio';
  if (p <= 8000) return 'avanzado';
  return 'gamer_full';
}

module.exports = {
  rerank,
  rerankFallback,
  obtenerDistribucion,
  inferirPerfil,
};