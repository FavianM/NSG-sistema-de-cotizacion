/**
 * Servicio de Semáforo de Capacidades del Asistente IA
 * Puntúa del 1 al 10 cada categoría basándose en specs reales de la DB.
 * Recibe componentes enriquecidos (con specs) desde servicioCompatibilidad.
 */

// ── Valores de referencia (high-end = 10) ──

const REF = {
  vram_gb: { max: 24, min: 2 },
  nucleos: { max: 24, min: 4 },
  hilos: { max: 32, min: 4 },
  frecuencia_boost_ghz: { max: 5.8, min: 3.0 },
  capacidad_gb_ram: { max: 64, min: 8 },
  tdp_w_gpu: { max: 450, min: 75 },
};

/**
 * Normaliza un valor a escala 1-10.
 * 0 si no hay dato, clamp a [1, 10] en caso contrario.
 */
function normalizar(valor, { max, min }) {
  if (valor === null || valor === undefined || valor <= 0) return 5; // Default si no hay dato
  const rango = max - min;
  if (rango <= 0) return 5;
  const puntaje = 1 + ((valor - min) / rango) * 9;
  return Math.max(1, Math.min(10, Math.round(puntaje)));
}

// ── Scoring por categoría ──

function scoreGaming(gpu, cpu) {
  const vram = normalizar(Number(gpu?.vram_gb) || 0, REF.vram_gb);
  const tdpGpu = normalizar(Number(gpu?.tdp_w) || 0, REF.tdp_w_gpu);
  const boostCpu = normalizar(Number(cpu?.frecuencia_boost_ghz) || 0, REF.frecuencia_boost_ghz);

  // GPU-heavy: vram 40%, tdp 30%, cpu boost 30%
  return Math.round(vram * 0.4 + tdpGpu * 0.3 + boostCpu * 0.3);
}

function scoreEdicionVideo(cpu, ram) {
  const nucleos = normalizar(Number(cpu?.nucleos) || 0, REF.nucleos);
  const hilos = normalizar(Number(cpu?.hilos) || 0, REF.hilos);
  const ramTotal = calcularRamTotalGb(ram);
  const ramScore = normalizar(ramTotal, REF.capacidad_gb_ram);

  // CPU cores 35%, threads 30%, RAM 35%
  return Math.round(nucleos * 0.35 + hilos * 0.3 + ramScore * 0.35);
}

function scoreProductividad(cpu) {
  const boost = normalizar(Number(cpu?.frecuencia_boost_ghz) || 0, REF.frecuencia_boost_ghz);
  const nucleos = normalizar(Number(cpu?.nucleos) || 0, REF.nucleos);

  // Single-core boost 70%, cores 30%
  return Math.round(boost * 0.7 + nucleos * 0.3);
}

function scoreStreaming(gpu, cpu) {
  const vram = normalizar(Number(gpu?.vram_gb) || 0, REF.vram_gb);
  const tdpGpu = normalizar(Number(gpu?.tdp_w) || 0, REF.tdp_w_gpu);
  const nucleos = normalizar(Number(cpu?.nucleos) || 0, REF.nucleos);

  // GPU encoding 40% + 20%, CPU for OBS 40%
  return Math.round(vram * 0.4 + tdpGpu * 0.2 + nucleos * 0.4);
}

function scoreRenderizado3d(gpu) {
  const vram = normalizar(Number(gpu?.vram_gb) || 0, REF.vram_gb);
  const tdpGpu = normalizar(Number(gpu?.tdp_w) || 0, REF.tdp_w_gpu);

  // VRAM 70%, TDP 30%
  return Math.round(vram * 0.7 + tdpGpu * 0.3);
}

// ── Utilidades ──

function calcularRamTotalGb(ram) {
  if (!ram) return 0;
  if (Array.isArray(ram)) {
    return ram.reduce((total, modulo) => {
      return total + (Number(modulo?.capacidad_gb) || 0);
    }, 0);
  }
  return Number(ram.capacidad_gb) || 0;
}

/**
 * Extrae los specs relevantes desde el mapa de componentes enriquecidos de BD.
 * Cada componente en el mapa tiene campos como: cpu_tdp_w, gpu_vram_gb, etc.
 */
function extraerSpecsDesdeMapa(componentesNormalizados) {
  const cpu = componentesNormalizados.procesador || {};
  const gpu = componentesNormalizados.gpu || {};
  const ram = componentesNormalizados.ram || [];

  return {
    cpu: {
      nucleos: Number(cpu.nucleos || cpu.cpu_nucleos || 0) || null,
      hilos: Number(cpu.hilos || 0) || null,
      frecuencia_boost_ghz: Number(cpu.frecuencia_boost_ghz || 0) || null,
      tdp_w: Number(cpu.tdp_w || cpu.cpu_tdp_w || 0) || null,
    },
    gpu: {
      vram_gb: Number(gpu.vram_gb || 0) || null,
      tdp_w: Number(gpu.tdp_w || gpu.gpu_tdp_w || 0) || null,
    },
    ram: Array.isArray(ram)
      ? ram.map((r) => ({ capacidad_gb: Number(r.capacidad_gb || 0) || null }))
      : [{ capacidad_gb: Number(ram.capacidad_gb || 0) || null }],
  };
}

// ── Función principal ──

/**
 * Calcula el semáforo de capacidades (1-10 cada categoría).
 * Recibe el objeto de componentes normalizados (con specs desde BD)
 * retornado por servicioCompatibilidad.validarConfiguracionConBD().
 */
function calcularSemaforo(componentesNormalizados) {
  const { cpu, gpu, ram } = extraerSpecsDesdeMapa(componentesNormalizados);

  return {
    gaming: scoreGaming(gpu, cpu),
    edicion_video: scoreEdicionVideo(cpu, ram),
    productividad: scoreProductividad(cpu),
    streaming: scoreStreaming(gpu, cpu),
    renderizado_3d: scoreRenderizado3d(gpu),
  };
}

module.exports = {
  calcularSemaforo,
  // Exportar funciones individuales para testeo
  scoreGaming,
  scoreEdicionVideo,
  scoreProductividad,
  scoreStreaming,
  scoreRenderizado3d,
};
