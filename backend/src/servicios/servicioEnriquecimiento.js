'use strict';

/**
 * Servicio de Enriquecimiento (Icecat + Deltron) — REEMPLAZA al enriquecimiento
 * por IA (servicioEnriquecimientoIA), que era impreciso.
 *
 * Por cada producto pendiente:
 *   1. Descarga la ficha de Deltron (1 sola petición) -> MPN + imagen.
 *   2. Consulta Icecat por MPN + marca (con variantes). Si responde 200 con
 *      features -> usa Icecat (datos oficiales). Si 403/404/sin-datos -> usa las
 *      Especificaciones scrapeadas de Deltron (mismo HTML).
 *   3. Mapea las features (en español) a las columnas tipadas de specs_*
 *      (compatibilidad) y guarda la ficha curada en specs_*.ficha_tecnica (JSONB)
 *      + la imagen en productos.imagen_url.
 *
 * Procesamiento secuencial en segundo plano, con delays (gentil con Deltron).
 * Interfaz compatible con el flujo previo: encolarProductos(), reactivarDesdeDB(),
 * estado().
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');
const icecat = require('./servicioIcecat');
const deltron = require('./servicioDeltronSpecs');

const DELAY_DELTRON_MS = Number(process.env.ENRIQUECIMIENTO_DELAY_DELTRON_MS || 2500);
const DELAY_ICECAT_MS = Number(process.env.ENRIQUECIMIENTO_DELAY_ICECAT_MS || 1500);
const MAX_FEATURES_FICHA = 40; // curaduría: no guardar el JSON completo

const TABLA_SPECS = {
  procesador: 'specs_procesador',
  placa_madre: 'specs_placa_madre',
  ram: 'specs_ram',
  almacenamiento: 'specs_almacenamiento',
  gpu: 'specs_gpu',
  fuente: 'specs_fuente',
  case: 'specs_case',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Condición SQL para detectar una ficha_tecnica "vacía": NULL, '{}' o sin grupos.
 * La importación deja '{}' por defecto, así que NULL no alcanza para detectarla.
 * @param {string} expr columna o expresión JSONB (p. ej. 'ficha_tecnica' o un COALESCE)
 */
const COND_FICHA_VACIA = (expr) =>
  `(${expr} IS NULL OR ${expr} = '{}'::jsonb OR COALESCE(jsonb_array_length(${expr}->'grupos'), 0) = 0)`;

/**
 * Condición SQL para detectar una imagen de IceCat que NO está en el tamaño
 * objetivo (gallery_mediums = 500x500). Cubre tanto las chicas (gallery_lows /
 * gallery_thumbs) como las muy grandes (gallery = 2000x2000), para reemplazarlas
 * por la media. No toca imágenes de Deltron ni URLs manuales.
 * @param {string} expr columna o expresión de texto con la URL
 */
const COND_IMAGEN_ICECAT_REDIMENSIONAR = (expr) =>
  `(${expr} LIKE '%images.icecat.biz%' AND ${expr} NOT LIKE '%gallery_mediums%')`;

// ---------------------------------------------------------------------------
// Utilidades de parseo / normalización
//
// Convierten el texto libre de las fichas (Icecat/Deltron) a los tipos que
// esperan las columnas specs_*:
//   quitarAcentos / norm  -> texto sin acentos, en minúsculas y recortado (para comparar).
//   pInt / pFloat         -> primer entero / decimal presente en la cadena.
//   pCapacidadGb          -> capacidad normalizada a GB (convierte TB a GB).
//   pBool                 -> true/false a partir de "sí/no/integrado/dedicado/...".
//   pRamTipo              -> tipo de RAM canónico (DDR3/DDR4/DDR5).
//   pFormFactor           -> factor de forma canónico (ATX/MICRO-ATX/MINI-ITX/E-ATX).
//   pSocket               -> socket normalizado (AM5, LGA1700, etc.).
//   pTexto                -> texto recortado o null si queda vacío.
//   pPcie                 -> versión PCIe normalizada ("4.0", "5.0").
// ---------------------------------------------------------------------------
function quitarAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function norm(s) {
  return quitarAcentos(String(s || '')).toLowerCase().trim();
}
function pInt(v) {
  const m = String(v ?? '').replace(/[\s,]/g, '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}
function pFloat(v) {
  const m = String(v ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function pCapacidadGb(v) {
  const s = String(v ?? '');
  const tb = s.match(/(\d+(?:\.\d+)?)\s*tb/i);
  if (tb) return Math.round(parseFloat(tb[1]) * 1024);
  const gb = s.match(/(\d+(?:\.\d+)?)\s*gb/i);
  if (gb) return Math.round(parseFloat(gb[1]));
  return pInt(v);
}
function pBool(v) {
  const t = norm(v);
  if (!t) return null;
  if (/^(si|sí|s|yes|y|true|1|integrad)/.test(t) || t.includes('integrad')) return true;
  if (/^(no|n|false|0|discret|dedicad)/.test(t)) return false;
  return null;
}
function pRamTipo(v) {
  const m = norm(v).match(/ddr\s?([345])/);
  return m ? `DDR${m[1]}` : null;
}
function pFormFactor(v) {
  const t = norm(v);
  if (t.includes('e-atx') || t.includes('eatx') || t.includes('extended atx')) return 'E-ATX';
  if (t.includes('micro') && t.includes('atx')) return 'MICRO-ATX';
  if (t.includes('matx') || t.includes('m-atx')) return 'MICRO-ATX';
  if (t.includes('mini') && t.includes('itx')) return 'MINI-ITX';
  if (t.includes('atx')) return 'ATX';
  return null;
}
function pSocket(v) {
  const m = norm(v).match(/\b(am5|am4|am3\+?|lga\s?\d{3,4}|tr4|strx4|fm2\+?)\b/);
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : (String(v || '').trim() || null);
}
function pTexto(v) {
  const s = String(v ?? '').trim();
  return s || null;
}
function pPcie(v) {
  // Versión PCIe: "PCIe 4.0", "Gen5", "5.0" -> "4.0"/"5.0". Evita conteos sueltos.
  const m = String(v ?? '').match(/(?:gen\s*)?([2-6])(?:\.0)?\b/i);
  return m ? `${m[1]}.0` : null;
}

// ---------------------------------------------------------------------------
// Aplana las FeaturesGroups a [{label, labelNorm, valor, grupo}]
// ---------------------------------------------------------------------------
function planoFeatures(featuresGroups) {
  const plano = [];
  for (const g of featuresGroups || []) {
    const grupo = g?.FeatureGroup?.Name?.Value || '';
    for (const f of g?.Features || []) {
      const label = f?.Feature?.Name?.Value || '';
      const valor = f?.PresentationValue ?? f?.RawValue ?? '';
      if (label) plano.push({ label, labelNorm: norm(label), valor: String(valor), grupo });
    }
  }
  return plano;
}

// Reglas de mapeo feature->columna tipada (claves lógicas que lee upsertSpecs).
// Para cada campo: primer feature cuyo labelNorm cumpla el predicado gana.
const MAPEO = {
  procesador: [
    ['socket', (l) => l.includes('socket'), pSocket],
    ['cpu_nucleos', (l) => l.includes('nucleo') && !l.includes('subproceso') && !l.includes('hilo'), pInt],
    ['cpu_hilos', (l) => l.includes('subproceso') || l.includes('hilo') || l.includes('thread'), pInt],
    ['cpu_frecuencia_base_ghz', (l) => (l.includes('frecuencia') && l.includes('base')) || l.includes('velocidad de reloj del procesador') || l === 'frecuencia', pFloat],
    ['cpu_frecuencia_boost_ghz', (l) => l.includes('turbo') || l.includes('boost') || (l.includes('frecuencia') && (l.includes('max') || l.includes('máx'))), pFloat],
    ['cpu_tdp_w', (l) => l.includes('tdp') || l.includes('diseno termico') || l.includes('potencia de diseno'), pInt],
    ['arquitectura', (l) => l.includes('arquitectura') || l.includes('nombre en clave') || l.includes('familia'), pTexto],
    ['cpu_graficos_integrados', (l) => l.includes('grafico') || l.includes('graphics') || l.includes('gpu integrad'), pBool],
  ],
  placa_madre: [
    ['socket', (l) => l.includes('socket'), pSocket],
    ['mb_chipset', (l) => l.includes('chipset'), pTexto],
    ['mb_form_factor', (l) => l.includes('factor de forma') || l.includes('form factor'), pFormFactor],
    ['mb_ram_tipo', (l) => l.includes('tipos de memoria') || l.includes('tipo de memoria') || l.includes('tecnologia de memoria'), pRamTipo],
    ['mb_max_ram_gb', (l) => l.includes('memoria interna maxima') || l.includes('maximo de memoria') || (l.includes('memoria') && l.includes('maxima')), pCapacidadGb],
    ['mb_slots_ram', (l) => l.includes('ranuras de memoria') || (l.includes('numero') && l.includes('ranura')), pInt],
    ['mb_pcie_version', (l) => (l.includes('pci express') || l.includes('pcie') || l.includes('version de pci')) && (l.includes('version') || l.includes('gen')) && !l.includes('ranura') && !l.includes('cantidad') && !l.includes('numero'), pPcie],
    ['mb_m2_slots', (l) => l.includes('m.2') || l.includes('m2'), pInt],
  ],
  ram: [
    ['ram_tipo', (l) => l.includes('tipo') && l.includes('memoria') || l.includes('tecnologia de memoria'), pRamTipo],
    ['ram_capacidad_gb', (l) => l.includes('memoria interna') || l.includes('capacidad'), pCapacidadGb],
    ['ram_velocidad_mhz', (l) => l.includes('velocidad de memoria') || (l.includes('memoria') && l.includes('reloj')) || l.includes('frecuencia'), pInt],
    ['ram_latencia', (l) => l.includes('latencia') || l.includes('cas'), pTexto],
    ['ram_cantidad_modulos', (l) => l.includes('modulo') || l.includes('cantidad de'), pInt],
  ],
  almacenamiento: [
    ['storage_capacidad_gb', (l) => l.includes('capacidad'), pCapacidadGb],
    ['storage_interfaz', (l) => l.includes('interfaz') || l.includes('interface'), pTexto],
    ['storage_form_factor', (l) => l.includes('factor de forma') || l.includes('form factor'), pTexto],
    ['storage_tipo', (l) => l.includes('tipo de disco') || l === 'tipo' || l.includes('tipo de unidad'), pTexto],
    ['storage_velocidad_lectura_mbps', (l) => l.includes('lectura'), pInt],
    ['storage_velocidad_escritura_mbps', (l) => l.includes('escritura'), pInt],
  ],
  gpu: [
    ['gpu_chipset', (l) => l.includes('procesador grafico') || l.includes('familia') || l.includes('gpu') || l.includes('modelo'), pTexto],
    ['gpu_vram_gb', (l) => (l.includes('memoria') && (l.includes('discreta') || l.includes('tamano') || l.includes('gpu'))) || l.includes('vram'), pCapacidadGb],
    ['gpu_vram_tipo', (l) => l.includes('tipo de memoria'), pTexto],
    ['gpu_bus_bits', (l) => l.includes('bus') || l.includes('ancho de banda'), pInt],
    ['gpu_boost_mhz', (l) => l.includes('boost') || l.includes('turbo') || l.includes('reloj'), pInt],
    ['gpu_tdp_w', (l) => l.includes('tdp') || l.includes('consumo') || l.includes('potencia'), pInt],
    ['gpu_longitud_mm', (l) => l.includes('longitud') || l.includes('largo'), pInt],
    ['gpu_fuente_recomendada_w', (l) => l.includes('fuente') && (l.includes('recomendad') || l.includes('alimentacion')), pInt],
  ],
  fuente: [
    ['psu_wattage', (l) => l.includes('potencia') || l.includes('vatios') || l.includes('salida de energia') || l.includes('wattage'), pInt],
    ['psu_certificacion', (l) => l.includes('certificac') || l.includes('80 plus') || l.includes('80plus') || l.includes('eficiencia'), pTexto],
    ['psu_modular', (l) => l.includes('modular'), pTexto],
    ['psu_form_factor', (l) => l.includes('factor de forma') || l.includes('form factor'), pFormFactor],
    ['psu_pcie_conectores', (l) => l.includes('pcie') || l.includes('pci-e') || l.includes('pci express'), pInt],
    ['psu_sata_conectores', (l) => l.includes('sata'), pInt],
  ],
  case: [
    ['case_form_factor', (l) => l.includes('factor de forma') || l.includes('tipo de chasis') || l.includes('form factor'), pFormFactor],
    ['case_color', (l) => l === 'color' || l.includes('color'), pTexto],
    ['case_panel_lateral', (l) => l.includes('panel lateral') || l.includes('material lateral'), pTexto],
    ['case_max_gpu_mm', (l) => (l.includes('tarjeta grafica') || l.includes('gpu') || l.includes('vga')) && (l.includes('long') || l.includes('mm') || l.includes('max')), pInt],
    ['case_max_cooler_mm', (l) => (l.includes('cooler') || l.includes('disipador') || l.includes('cpu')) && (l.includes('alt') || l.includes('mm') || l.includes('max')), pInt],
    ['case_ventiladores_incluidos', (l) => l.includes('ventilador') || l.includes('fan'), pInt],
  ],
};

/** Extrae las columnas tipadas (claves lógicas para upsertSpecs) desde las features. */
function extraerTipadas(categoria, plano) {
  const reglas = MAPEO[categoria] || [];
  const out = {};
  for (const [campo, test, parse] of reglas) {
    if (out[campo] != null) continue;
    const hit = plano.find((f) => test(f.labelNorm));
    if (hit) {
      const val = parse(hit.valor);
      if (val != null && val !== '') out[campo] = val;
    }
  }
  return out;
}

// Grupos a excluir de la ficha curada (logística/empaque, no specs técnicas).
const GRUPOS_EXCLUIR = ['logist', 'embalaje', 'empaque', 'packaging', 'peso y dim', 'weight', 'sostenib', 'sustainab', 'garantia comercial'];

/** Curaduría: ficha compacta (no el JSON completo) para mostrar. */
function curarFicha(featuresGroups) {
  const grupos = [];
  let total = 0;
  for (const g of featuresGroups || []) {
    const nombre = g?.FeatureGroup?.Name?.Value || 'General';
    if (GRUPOS_EXCLUIR.some((k) => norm(nombre).includes(k))) continue;
    const items = [];
    for (const f of g?.Features || []) {
      const label = f?.Feature?.Name?.Value;
      const valor = f?.PresentationValue;
      if (!label || valor == null || valor === '') continue;
      items.push({ etiqueta: String(label), valor: String(valor) });
      total++;
      if (total >= MAX_FEATURES_FICHA) break;
    }
    if (items.length) grupos.push({ nombre: String(nombre), items });
    if (total >= MAX_FEATURES_FICHA) break;
  }
  return { grupos };
}

/**
 * Imagen desde el response de Icecat (Gallery / Image).
 * Se prefiere el tamaño MEDIO (Pic500x500 = 500x500, gallery_mediums): se ve bien
 * al ampliarla a pantalla completa sin sobrecargar el navegador al renderizar
 * muchas tarjetas (la versión grande pesa ~1.5MB c/u). Solo se cae a otros tamaños
 * si el medio no existe.
 */
function extraerImagenIcecat(data) {
  try {
    const d = data?.data;
    if (Array.isArray(d?.Gallery) && d.Gallery.length) {
      const g = d.Gallery[0];
      return g.Pic500x500 || g.Pic || g.LowPic || g.ThumbPic || null;
    }
    return d?.Image?.Pic500x500 || d?.Image?.Pic || d?.Image?.HighPic || d?.Image?.LowPic || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enriquecimiento de un producto
// ---------------------------------------------------------------------------
/**
 * @param {Object} item { id_producto, codigo_proveedor, marca, categoria }
 * @returns {Promise<Object>} resultado { id_producto, fuente, features, ok, ... }
 */
async function enriquecerProducto(item) {
  const { id_producto, codigo_proveedor, marca, categoria } = item;
  const tabla = TABLA_SPECS[categoria];
  if (!tabla) return { id_producto, ok: false, motivo: 'categoria_no_principal' };

  // 1) Deltron: 1 petición -> MPN + imagen.
  const dl = await deltron.descargarHtmlDeltron(codigo_proveedor);
  if (!dl.html) {
    await marcarEstado(id_producto, 'fallido');
    return { id_producto, ok: false, fuente: 'deltron', motivo: dl.error || ('http_' + dl.status) };
  }
  const datosMpn = deltron.extraerMpnDeHtml(dl.html, codigo_proveedor);
  const imagenDeltron = deltron.extraerImagenDeHtml(dl.html);

  // 2) Icecat (si hay MPN y credenciales).
  let featuresGroups = null;
  let fuente = null;
  let imagen = null;

  if (datosMpn.mpn && icecat.credencialesPresentes()) {
    const r = await icecat.consultarIcecatConVariantes({ mpn: datosMpn.mpn, marca, sleep: () => sleep(DELAY_ICECAT_MS) });
    const fg = r?.data?.data?.FeaturesGroups;
    if (r.status === 200 && Array.isArray(fg) && fg.length) {
      featuresGroups = fg;
      fuente = 'icecat';
      imagen = extraerImagenIcecat(r.data);
    }
  }

  // 3) Fallback: especificaciones de Deltron (mismo HTML).
  if (!featuresGroups) {
    const ficha = deltron.construirFichaDeHtml(dl.html, codigo_proveedor, marca);
    const fg = ficha?.data?.data?.FeaturesGroups;
    if (Array.isArray(fg) && fg.length) {
      featuresGroups = fg;
      fuente = 'deltron-scraping';
      imagen = ficha.imagen;
    }
  }

  if (!featuresGroups) {
    await marcarEstado(id_producto, 'fallido');
    return { id_producto, ok: false, fuente: fuente || 'ninguna', motivo: 'sin_features' };
  }

  // 4) Mapear + guardar.
  const plano = planoFeatures(featuresGroups);
  const tipadas = extraerTipadas(categoria, plano);
  const ficha = curarFicha(featuresGroups);
  const imagenFinal = imagen || imagenDeltron || null;

  await guardarEnriquecimiento({ id_producto, categoria, tabla, tipadas, ficha, imagen: imagenFinal, fuente });

  return {
    id_producto,
    ok: true,
    fuente,
    mpn: datosMpn.mpn,
    features: plano.length,
    tipadas: Object.keys(tipadas).length,
    imagen: Boolean(imagenFinal),
  };
}

/** Escribe specs tipadas (COALESCE), ficha_tecnica JSONB, imagen y estado. */
async function guardarEnriquecimiento({ id_producto, categoria, tabla, tipadas, ficha, imagen, fuente }) {
  // SEGURIDAD: el nombre de tabla solo puede provenir de la allowlist;
  // nunca interpolar un valor que no esté en TABLA_SPECS.
  if (!Object.values(TABLA_SPECS).includes(tabla)) {
    throw new Error(`Tabla de specs no permitida: ${tabla}`);
  }

  // require diferido para evitar ciclo de carga con servicioImportacion.
  const { upsertSpecs } = require('./servicioImportacion');

  // Columnas tipadas (reutiliza el contrato existente; COALESCE conserva lo previo).
  await upsertSpecs(ejecutarQuery, categoria, id_producto, tipadas);

  // ficha_tecnica JSONB en la tabla specs de la categoría.
  await ejecutarQuery(
    `UPDATE ${tabla} SET ficha_tecnica = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id_producto = $1`,
    [id_producto, JSON.stringify({ fuente, ...ficha })]
  );

  // Imagen + estado del producto.
  await ejecutarQuery(
    `UPDATE productos
       SET imagen_url = COALESCE($2, imagen_url),
           estado_enriquecimiento = 'enriquecido',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id_producto, imagen]
  );
}

async function marcarEstado(id_producto, estado) {
  try {
    await ejecutarQuery(
      `UPDATE productos SET estado_enriquecimiento = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id_producto, estado]
    );
  } catch (_) { /* no-op */ }
}

/**
 * Complementa un componente que llegó COMPLETO del CSV (estado 'csv'):
 * obtiene la ficha técnica (Icecat con fallback a scraping Deltron) + la imagen,
 * y escribe ÚNICAMENTE ficha_tecnica + imagen_url.
 *
 * NO toca las columnas tipadas (socket, nucleos, chipset, etc.): el CSV es la
 * fuente autoritativa de esas y alimentan la compatibilidad. Tampoco cambia
 * estado_enriquecimiento (sigue 'csv').
 *
 * No pisa una imagen_url existente (COALESCE(imagen_url, $imagen)): respeta la URL
 * cargada manualmente por el admin.
 *
 * @param {Object} item { id_producto, codigo_proveedor, marca, categoria }
 */
async function complementarFichaEImagen(item) {
  const { id_producto, codigo_proveedor, marca, categoria } = item;
  const tabla = TABLA_SPECS[categoria];
  if (!tabla) return { id_producto, ok: false, complemento: true, motivo: 'categoria_no_principal' };

  // 1) Deltron: 1 petición -> MPN + imagen + (posible) ficha de fallback.
  const dl = await deltron.descargarHtmlDeltron(codigo_proveedor);
  if (!dl.html) {
    return { id_producto, ok: false, complemento: true, fuente: 'deltron', motivo: dl.error || ('http_' + dl.status) };
  }
  const datosMpn = deltron.extraerMpnDeHtml(dl.html, codigo_proveedor);
  const imagenDeltron = deltron.extraerImagenDeHtml(dl.html);

  // 2) Icecat (si hay MPN y credenciales): ficha oficial + imagen.
  let featuresGroups = null;
  let fuente = null;
  let imagen = null;
  if (datosMpn.mpn && icecat.credencialesPresentes()) {
    const r = await icecat.consultarIcecatConVariantes({ mpn: datosMpn.mpn, marca, sleep: () => sleep(DELAY_ICECAT_MS) });
    const fg = r?.data?.data?.FeaturesGroups;
    if (r.status === 200 && Array.isArray(fg) && fg.length) {
      featuresGroups = fg;
      fuente = 'icecat';
      imagen = extraerImagenIcecat(r.data);
    }
  }

  // 3) Fallback: especificaciones scrapeadas de Deltron (mismo HTML).
  if (!featuresGroups) {
    const fichaDeltron = deltron.construirFichaDeHtml(dl.html, codigo_proveedor, marca);
    const fg = fichaDeltron?.data?.data?.FeaturesGroups;
    if (Array.isArray(fg) && fg.length) {
      featuresGroups = fg;
      fuente = 'deltron-scraping';
      imagen = fichaDeltron.imagen;
    }
  }

  const imagenFinal = imagen || imagenDeltron || null;

  // Si no se obtuvo ficha NI imagen, no hay nada que complementar.
  if (!featuresGroups && !imagenFinal) {
    return { id_producto, ok: false, complemento: true, fuente: 'ninguna', motivo: 'sin_datos' };
  }

  // 4) Escribir ficha_tecnica solo si la actual está vacía (NULL, '{}' o sin
  //    grupos). No pisa una ficha real ya existente.
  if (featuresGroups) {
    const ficha = curarFicha(featuresGroups);
    await ejecutarQuery(
      `UPDATE ${tabla}
          SET ficha_tecnica = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
        WHERE id_producto = $1
          AND ${COND_FICHA_VACIA('ficha_tecnica')}`,
      [id_producto, JSON.stringify({ fuente, ...ficha })]
    );
  }

  // 5) Imagen: rellenar si está vacía y REDIMENSIONAR si la guardada es de IceCat
  //    en un tamaño distinto al medio (chica o muy grande). No pisar una URL manual
  //    ni una de Deltron. No toca specs tipadas ni estado.
  if (imagenFinal) {
    await ejecutarQuery(
      `UPDATE productos
          SET imagen_url = CASE
                WHEN imagen_url IS NULL THEN $2
                WHEN ${COND_IMAGEN_ICECAT_REDIMENSIONAR('imagen_url')} THEN $2
                ELSE imagen_url
              END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id_producto, imagenFinal]
    );
  }

  return {
    id_producto,
    ok: true,
    complemento: true,
    fuente: fuente || 'ninguna',
    ficha: Boolean(featuresGroups),
    imagen: Boolean(imagenFinal),
  };
}

// ---------------------------------------------------------------------------
// Cola en segundo plano (secuencial, gentil con Deltron)
// ---------------------------------------------------------------------------
const _estado = { cola: [], procesando: false, ok: 0, fallidos: 0, total: 0, actual: null };

/**
 * Agrega productos válidos a la cola de enriquecimiento y arranca el procesamiento
 * en segundo plano si no estaba activo. Descarta items sin id, sin código de
 * proveedor o de una categoría que no sea componente principal.
 */
function encolarProductos(items) {
  const validos = (items || []).filter((i) => i && i.id_producto && i.codigo_proveedor && TABLA_SPECS[i.categoria]);
  if (!validos.length) return;
  _estado.cola.push(...validos);
  _estado.total += validos.length;
  if (!_estado.procesando) _procesarCola();
}

/**
 * Bucle secuencial que procesa la cola de a un producto por vez. Según el flag
 * `complemento` del item, ejecuta el enriquecimiento completo o solo el complemento
 * de ficha+imagen. Espera DELAY_DELTRON_MS entre productos para no saturar a Deltron.
 */
async function _procesarCola() {
  if (_estado.procesando) return;
  _estado.procesando = true;
  while (_estado.cola.length > 0) {
    const item = _estado.cola.shift();
    _estado.actual = item.codigo_proveedor;
    try {
      const r = item.complemento ? await complementarFichaEImagen(item) : await enriquecerProducto(item);
      if (r.ok) _estado.ok++; else _estado.fallidos++;
    } catch (err) {
      _estado.fallidos++;
      console.warn('[Enriquecimiento] error', item.codigo_proveedor, err.message);
      // El modo complemento no debe degradar el estado de un producto 'csv' válido.
      if (!item.complemento) await marcarEstado(item.id_producto, 'fallido');
    }
    await sleep(DELAY_DELTRON_MS); // ritmo entre productos
  }
  _estado.actual = null;
  _estado.procesando = false;
}

/**
 * Re-encola al arrancar el server:
 *  - Productos 'pendiente' -> enriquecimiento completo (specs + ficha + imagen).
 *  - Componentes principales (no 'pendiente') a los que les falta ficha_tecnica,
 *    les falta imagen, o tienen una imagen de IceCat en tamaño no-medio ->
 *    complemento (ficha + imagen 500x500, sin tocar las columnas tipadas).
 */
async function reactivarDesdeDB(db = ejecutarQuery) {
  try {
    const { rows: pendientes } = await db(
      `SELECT p.id AS id_producto, p.codigo_proveedor, c.nombre AS categoria, m.nombre AS marca
         FROM productos p
         JOIN categorias c ON c.id = p.id_categoria
         LEFT JOIN marcas m ON m.id = p.id_marca
        WHERE p.estado_enriquecimiento = 'pendiente'
          AND c.es_componente_principal = true`
    );
    if (pendientes.length) {
      encolarProductos(pendientes.map((r) => ({
        id_producto: r.id_producto,
        codigo_proveedor: r.codigo_proveedor,
        marca: r.marca || '',
        categoria: r.categoria,
      })));
    }

    const { rows: porComplementar } = await db(
      `SELECT p.id AS id_producto, p.codigo_proveedor, c.nombre AS categoria, m.nombre AS marca
         FROM productos p
         JOIN categorias c ON c.id = p.id_categoria
         LEFT JOIN marcas m ON m.id = p.id_marca
         LEFT JOIN specs_procesador sp ON sp.id_producto = p.id
         LEFT JOIN specs_placa_madre sm ON sm.id_producto = p.id
         LEFT JOIN specs_ram sr ON sr.id_producto = p.id
         LEFT JOIN specs_almacenamiento sa ON sa.id_producto = p.id
         LEFT JOIN specs_gpu sg ON sg.id_producto = p.id
         LEFT JOIN specs_fuente sf ON sf.id_producto = p.id
         LEFT JOIN specs_case sc ON sc.id_producto = p.id
        WHERE p.estado_enriquecimiento <> 'pendiente'
          AND c.es_componente_principal = true
          AND (
                p.imagen_url IS NULL
                OR ${COND_IMAGEN_ICECAT_REDIMENSIONAR('p.imagen_url')}
                OR ${COND_FICHA_VACIA(`COALESCE(sp.ficha_tecnica, sm.ficha_tecnica, sr.ficha_tecnica, sa.ficha_tecnica,
                            sg.ficha_tecnica, sf.ficha_tecnica, sc.ficha_tecnica)`)}
          )`
    );
    if (porComplementar.length) {
      encolarProductos(porComplementar.map((r) => ({
        id_producto: r.id_producto,
        codigo_proveedor: r.codigo_proveedor,
        marca: r.marca || '',
        categoria: r.categoria,
        complemento: true,
      })));
    }

    return pendientes.length + porComplementar.length;
  } catch (err) {
    console.warn('[Enriquecimiento] reactivarDesdeDB falló:', err.message);
    return 0;
  }
}

/** Devuelve una instantánea del estado de la cola (para el endpoint de monitoreo). */
function estado() {
  return {
    procesando: _estado.procesando,
    en_cola: _estado.cola.length,
    procesados_ok: _estado.ok,
    fallidos: _estado.fallidos,
    total: _estado.total,
    actual: _estado.actual,
  };
}

module.exports = {
  enriquecerProducto,
  encolarProductos,
  reactivarDesdeDB,
  estado,
  // exportadas para pruebas
  extraerTipadas,
  curarFicha,
  planoFeatures,
};
