'use strict';

const fs = require('fs');
const path = require('path');
const { resolverCategoria, esCategoriaPrincipal } = require('../configuracion/catalogoProductos');

const MAPA_CATEGORIAS = {
  'cpu amd ryzen': 'procesador',
  'cpu amd athlon': 'procesador',
  'cpu ci': 'procesador',
  'cpu cu': 'procesador',
  'mb ci9': 'placa_madre',
  'mb cu9': 'placa_madre',
  'mb socket am4': 'placa_madre',
  'mb socket am5': 'placa_madre',
  'mb socket i': 'placa_madre',
  'mb socket lga': 'placa_madre',
  'mem ddr4': 'ram',
  'mem ddr5': 'ram',
  'mem sodimm': 'ram',
  'mem ddr3': 'ram',
  'ssd 2.5 sata': 'almacenamiento',
  'ssd m.2 nvme': 'almacenamiento',
  'ssd m.2 sata': 'almacenamiento',
  'disco duro 3.5 sata': 'almacenamiento',
  'video, pci exp nvidia': 'gpu',
  'video, pci exp radeon': 'gpu',
  'video, pci exp intel': 'gpu',
  'video, pci express nvidia': 'gpu',
  'cases, fuente para gaming': 'fuente',
  'cases, fuente certificada': 'fuente',
  'cases, fuente para': 'fuente',
  'cases atx ver2.0': 'case',
  'cases atx ver2.0 s/fuente': 'case',
  'cases micro atx': 'case',
  'cases sin fuente p/gamers': 'case',
  'cases atx': 'case',
  'mouse usb': 'mouse',
  'mouse inalambrico': 'mouse',
  'mouse para gamers': 'mouse',
  'teclado usb': 'teclado',
  'teclado inalambrico': 'teclado',
  'teclado para gamers': 'teclado',
  'teclado+mouse combo kit': 'teclado',
  'teclado+mouse kit inalamb': 'teclado',
  'camara, webcam': 'webcam',
  'mouse pad/mat, accesorios': 'mousepad',
  'audio, auricular c/mic': 'auricular',
  'audio, parlante inalambrc': 'parlante',
  'ms windows business': 'software_windows',
  'ms windows consumer': 'software_windows',
  'ms esd windows business': 'software_windows',
  'ms esd windows consumer': 'software_windows',
  'ms esd office': 'software_office',
  'ms esd office 365': 'software_office',
  'ms office': 'software_office',
  'software, antivirus': 'software_antivirus',
  'kaspersky esd consumo': 'software_antivirus',
  'kaspersky esd business': 'software_antivirus',
  'disco duro externo 2.5': 'almacenamiento_externo',
  'disco solido externo(ssd)': 'almacenamiento_externo',
  'mem flash, usb drive': 'almacenamiento_externo',
  'ups interactivo': 'ups',
  'estabilizador de tension': 'estabilizador',
  'monitor plano': 'monitor',
  'monitor curvo': 'monitor',
  'monitor gaming plano': 'monitor',
  'monitor gaming curvo': 'monitor',
  'monitores tft': 'monitor',
  'fan cooler cpu': 'cooler_aire',
  'cooler liquido cpu': 'cooler_liquido',
  'red wifi adaptadores usb': 'conectividad',
  'red wifi router-adsl': 'conectividad',
};

const _CLAVES_ORDENADAS = Object.keys(MAPA_CATEGORIAS).sort((a, b) => b.length - a.length);

// §5.1 / §15 — Campos requeridos por categoría principal para determinar si se necesita enriquecimiento IA.
// Si alguno de estos campos está vacío tras la extracción del CSV, el producto queda como 'pendiente'.
// Requisitos: 3.1, 3.2, 3.3, 3.4
const CAMPOS_REQUERIDOS = {
  procesador:     ['socket', 'arquitectura', 'cpu_nucleos', 'cpu_hilos', 'cpu_frecuencia_base_ghz', 'cpu_frecuencia_boost_ghz', 'cpu_tdp_w'],
  placa_madre:    ['socket', 'mb_chipset', 'mb_form_factor', 'mb_ram_tipo', 'mb_max_ram_gb', 'mb_slots_ram', 'mb_m2_slots', 'mb_pcie_version'],
  ram:            ['ram_tipo', 'ram_capacidad_gb', 'ram_velocidad_mhz'],
  almacenamiento: ['storage_tipo', 'storage_capacidad_gb', 'storage_interfaz', 'storage_form_factor', 'storage_velocidad_lectura_mbps', 'storage_velocidad_escritura_mbps'],
  gpu:            ['gpu_chipset', 'gpu_vram_gb', 'gpu_bus_bits', 'gpu_boost_mhz', 'gpu_tdp_w', 'gpu_longitud_mm', 'gpu_fuente_recomendada_w'],
  fuente:         ['psu_wattage', 'psu_certificacion', 'psu_modular', 'psu_pcie_conectores', 'psu_sata_conectores'],
  case:           ['case_form_factor', 'case_max_gpu_mm', 'case_max_cooler_mm'],
};

/**
 * Retorna true si algún campo requerido de la categoría está ausente (null o '').
 * Usado para decidir si el producto necesita enriquecimiento IA.
 * @param {string} categoria
 * @param {Object} registro - objeto con los campos de specs ya combinados
 * @returns {boolean}
 */
function tieneSpecsFaltantes(categoria, registro) {
  const requeridos = CAMPOS_REQUERIDOS[categoria] || [];
  return requeridos.some((campo) => registro[campo] == null || registro[campo] === '');
}

// §5.3 — Mapa de tipos esperados por campo para construir la lista de specs faltantes.
// Usado por calcularSpecsFaltantes() para informar al LLM qué tipo de dato se espera.
// Requisitos: 3.3, 4.1, 4.2
const TIPOS_CAMPOS = {
  socket: 'string',
  arquitectura: 'string',
  cpu_nucleos: 'integer',
  cpu_hilos: 'integer',
  cpu_frecuencia_base_ghz: 'number',
  cpu_frecuencia_boost_ghz: 'number',
  cpu_tdp_w: 'integer',
  mb_chipset: 'string',
  mb_form_factor: 'string',
  mb_ram_tipo: 'string',
  mb_max_ram_gb: 'integer',
  mb_slots_ram: 'integer',
  mb_m2_slots: 'integer',
  mb_pcie_version: 'string',
  ram_tipo: 'string',
  ram_capacidad_gb: 'integer',
  ram_velocidad_mhz: 'integer',
  storage_tipo: 'string',
  storage_capacidad_gb: 'integer',
  storage_interfaz: 'string',
  storage_form_factor: 'string',
  storage_nvme_gen: 'string',
  storage_velocidad_lectura_mbps: 'integer',
  storage_velocidad_escritura_mbps: 'integer',
  gpu_chipset: 'string',
  gpu_vram_gb: 'integer',
  gpu_bus_bits: 'integer',
  gpu_boost_mhz: 'integer',
  gpu_tdp_w: 'integer',
  gpu_longitud_mm: 'integer',
  gpu_fuente_recomendada_w: 'integer',
  psu_wattage: 'integer',
  psu_certificacion: 'string',
  psu_modular: 'string',
  psu_pcie_conectores: 'integer',
  psu_sata_conectores: 'integer',
  case_form_factor: 'string',
  case_max_gpu_mm: 'integer',
  case_max_cooler_mm: 'integer',
  case_ventiladores_incluidos: 'integer',
};

/**
 * Construye la lista de campos faltantes con sus tipos esperados para una categoría y registro dados.
 * Solo incluye los campos requeridos que están ausentes (null o '').
 * @param {string} categoria
 * @param {Object} registro - objeto con los campos de specs ya combinados
 * @returns {Array<{campo: string, tipo: string}>}
 */
function calcularSpecsFaltantes(categoria, registro) {
  const requeridos = CAMPOS_REQUERIDOS[categoria] || [];
  return requeridos
    .filter((campo) => registro[campo] == null || registro[campo] === '')
    .map((campo) => ({ campo, tipo: TIPOS_CAMPOS[campo] || 'string' }));
}

/**
 * Traduce la categoría de proveedor (texto de Deltron) a la categoría interna del
 * sistema, comparando contra MAPA_CATEGORIAS. Evalúa las claves de más larga a más
 * corta (prefijo) para que la coincidencia más específica gane. Devuelve null si
 * no reconoce la categoría.
 */
function mapearCategoria(categoriaCSV) {
  const normalizada = String(categoriaCSV || '').toLowerCase().trim();
  for (const clave of _CLAVES_ORDENADAS) {
    if (normalizada.startsWith(clave)) return MAPA_CATEGORIAS[clave];
  }
  return null;
}

/** Limpia la descripción raw a un nombre legible: corta el sufijo [@@@], normaliza acentos/espacios y trunca a 200 caracteres. */
function limpiarNombre(descripcion) {
  // Mantener compatibilidad: si no conocemos la categoría, devolvemos el texto limpio completo.
  const texto = String(descripcion || '');
  const partes = texto.split('[@@@]');
  const base = partes[0];
  return normalizarTextoHumano(base)
    .replace(/\s*\[[@]?[@]?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function limpiarDescripcionBase(descripcion) {
  return limpiarNombre(descripcion)
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .trim();
}

/** Capitaliza cada palabra (Title Case), útil para normalizar nombres de marca. */
function capitalizarMarca(texto) {
  return String(texto || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Genera un nombre comercial corto y legible a partir de la descripción técnica raw.
 * Primero recorta las specs embebidas (GHz, cores, TDP, capacidades, interfaces) y
 * luego aplica reglas específicas por categoría para extraer el modelo relevante
 * (ej. "AMD Ryzen 5 5600", "MSI RTX 4060", "Kingston 16GB 3200MHz").
 */
function generarNombreComercial(categoria, descripcion, marca) {
  const texto = limpiarDescripcionBase(descripcion);
  if (!texto) return '';

  const textoSinSpecs = texto
    .replace(/\s+\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*ghz.*$/i, '')
    .replace(/,\s*\d+(?:\.\d+)?\s*ghz.*$/i, '')
    .replace(/,\s*\d+\s*cores?.*$/i, '')
    .replace(/,\s*tdp\s*:\s*\d+\s*w.*$/i, '')
    .replace(/,\s*\d+\s*w.*$/i, '')
    .replace(/,\s*\d+\s*gb\s*gddr\w+.*$/i, '')
    .replace(/,\s*\d+\s*gb\s*ddr\d.*$/i, '')
    .replace(/,\s*(?:m\.2|2\.5|3\.5|sata|nvme|pcie).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (categoria === 'procesador') {
    const match = textoSinSpecs.match(/(?:procesador\s+)?((?:amd|intel)\s+(?:ryzen\s+[3579]|athlon|pentium|celeron|core\s+i[3579])[^,]*?(?:\b\d{4,5}[a-z]{0,2}\b))/i);
    if (match) return capitalizarMarca(match[1]).replace(/Amd/g, 'AMD').replace(/Intel/g, 'Intel');
  }

  if (categoria === 'gpu') {
    const match = textoSinSpecs.match(/((?:msi|asus|gigabyte|zotac|sapphire|xfx|asrock|pny|evga|powercolor)\s+)?((?:nvidia\s+geforce\s+)?(?:rtx|gtx)\s*\d{3,4}(?:\s*ti)?|(?:amd\s+radeon\s+)?rx\s*\d{4}(?:\s*xt)?)/i);
    if (match) return `${capitalizarMarca(match[1] || marca)} ${String(match[2] || '').replace(/\s+/g, ' ').trim()}`.trim();
  }

  if (categoria === 'ram') {
    const marcaBase = capitalizarMarca((textoSinSpecs.match(/(?:memoria\s+ram\s+|memoria\s+)?(.+?)(?=\s+\d+\s*gb\b|$)/i) || [])[1] || textoSinSpecs);
    const capacidad = (texto.match(/(\d+(?:\.\d+)?)\s*gb\b/i) || [])[1] || null;
    const velocidad = (texto.match(/(\d{3,5})\s*(?:mhz|mt\/s)\b/i) || [])[1] || null;
    const partes = [marcaBase];
    if (capacidad) partes.push(`${capacidad}GB`);
    if (velocidad) partes.push(`${velocidad}MHz`);
    return partes.join(' ').trim();
  }

  if (categoria === 'almacenamiento') {
    const marcaBase = capitalizarMarca((textoSinSpecs.match(/(?:unidad(?:\s+de\s+estado\s+solido)?|disco\s+solido|disco\s+duro)?\s*(.+?)(?=\s+\d+(?:\.\d+)?\s*(?:tb|gb)\b|$)/i) || [])[1] || textoSinSpecs);
    const capacidad = (texto.match(/(\d+(?:\.\d+)?)\s*(tb|gb)\b/i) || []);
    const capacidadFormateada = capacidad[1] && capacidad[2]
      ? `${capacidad[1]}${String(capacidad[2]).toUpperCase()}`
      : null;
    return [marcaBase, capacidadFormateada].filter(Boolean).join(' ').trim();
  }

  if (categoria === 'fuente' || categoria === 'case' || categoria === 'placa_madre') {
    return capitalizarMarca(textoSinSpecs.replace(/^(fuente|case|placa madre|motherboard)\s+/i, ''));
  }

  return textoSinSpecs || texto;
}

/**
 * Genera la descripción general limpia a partir de la descripción raw de Deltron.
 * Elimina el sufijo [@@@] y todo lo que sigue, caracteres de control y normaliza espacios.
 * Trunca a 1000 caracteres. (Req 1.4, 1.9)
 */
function limpiarDescripcionGeneral(descripcionRaw) {
  const textoRaw = String(descripcionRaw || '');
  const [baseRaw, extraRaw = ''] = textoRaw.split('[@@@]');

  const base = normalizarTextoHumano(String(baseRaw || ''));
  const extra = normalizarTextoHumano(String(extraRaw || ''));

  const descripcionCompuesta = [base, extra]
    .map((parte) =>
      String(parte || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .replace(/\s*\[[@]?[@]?\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('. ');

  return descripcionCompuesta.slice(0, 1000);
}

/**
 * Interpreta el valor de stock del CSV. Convenciones de Deltron:
 *   ">20"  -> stock 21 (hay bastante), en stock.
 *   ""     -> stock 0, marcado como disponible a pedido.
 *   número -> ese stock exacto, en stock.
 * @returns {{stock: number, disponible_a_pedido: boolean}}
 */
function parsearStock(valor) {
  const v = String(valor == null ? '' : valor).trim();
  if (v === '>20') return { stock: 21, disponible_a_pedido: false };
  if (v === '') return { stock: 0, disponible_a_pedido: true };
  const n = parseInt(v, 10);
  if (!isNaN(n) && n >= 0) return { stock: n, disponible_a_pedido: false };
  return { stock: 0, disponible_a_pedido: true };
}

/** Parsea un precio del CSV a número (quita espacios y separadores de miles). Devuelve NaN si no es válido. */
function parsearPrecio(valor) {
  const bruto = String(valor == null ? '' : valor).trim();
  if (!bruto) return NaN;
  const normalizado = bruto.replace(/\s+/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalizado)) return NaN;
  return parseFloat(normalizado);
}

/**
 * Parsea una línea CSV respetando comillas dobles y comillas escapadas ("").
 * Implementación propia para no depender de una librería y manejar el formato
 * particular del export de Deltron.
 * @returns {string[]} Campos de la línea.
 */
function parsearLineaCSV(linea) {
  const campos = [];
  let actual = '';
  let dentroComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (dentroComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        dentroComillas = !dentroComillas;
      }
    } else if (c === ',' && !dentroComillas) {
      campos.push(actual);
      actual = '';
    } else {
      actual += c;
    }
  }
  campos.push(actual);
  return campos;
}

/**
 * Decodifica el buffer del CSV eligiendo la codificación correcta: intenta UTF-8 y,
 * si detecta caracteres de reemplazo (indicio de bytes ANSI/Windows-1252 mal leídos),
 * reintenta con latin1 para preservar tildes y caracteres especiales.
 */
function decodificarTextoCSV(buffer) {
  // Deltron suele venir en ANSI/Windows-1252. Si UTF-8 genera muchos �,
  // usamos latin1 para preservar tildes y caracteres especiales.
  const utf8 = buffer.toString('utf8');
  const reemplazosUtf8 = utf8.split('\uFFFD').length - 1;
  if (reemplazosUtf8 > 0) {
    return buffer.toString('latin1');
  }
  return utf8;
}

/**
 * Corrige mojibake común (secuencias tipo "Ã¡" -> "á") que aparece cuando un texto
 * latin1 se interpretó como UTF-8, y normaliza el resultado a forma NFC. Deja el
 * texto humano legible antes de guardarlo.
 */
function normalizarTextoHumano(valor) {
  let texto = String(valor || '');
  if (!texto) return '';

  const reemplazos = [
    ['Ã¡', 'á'], ['Ã©', 'é'], ['Ã­', 'í'], ['Ã³', 'ó'], ['Ãº', 'ú'],
    ['Ã', 'Á'], ['Ã‰', 'É'], ['Ã', 'Í'], ['Ã“', 'Ó'], ['Ãš', 'Ú'],
    ['Ã±', 'ñ'], ['Ã‘', 'Ñ'], ['Ã¼', 'ü'], ['Ãœ', 'Ü'],
    ['Â¿', '¿'], ['Â¡', '¡'], ['Â°', '°'], ['Â', ''],
    ['ï¿½', 'é'], ['\uFFFD', 'é'],
  ];

  for (const [origen, destino] of reemplazos) {
    texto = texto.split(origen).join(destino);
  }

  return texto.normalize('NFC');
}

/**
 * Punto de entrada del parseo de CSV. Soporta dos formatos:
 *   - CSV estructurado (tiene columna 'codigo_proveedor' en el encabezado): mapea
 *     todas las columnas de specs por nombre.
 *   - CSV Deltron raw (lista de precios): descarta separadores, encabezados repetidos
 *     y metadatos, y extrae los campos b\u00E1sicos por posici\u00F3n.
 * @param {Buffer} buffer - Contenido crudo del archivo CSV.
 * @returns {Array<object>} Filas normalizadas listas para construirRegistroNormalizado.
 */
function parsearCSV(buffer) {
  const texto = decodificarTextoCSV(buffer).replace(/^\uFEFF/, '');
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length === 0) return [];

  const limpiar = (campo) => normalizarTextoHumano(String(campo || '').replace(/^"|"$/g, '').trim());
  const encabezado = parsearLineaCSV(lineas[0]).map((c) => limpiar(c).toLowerCase());
  // Detectar CSV estructurado: tiene 'codigo_proveedor' como columna explícita en el encabezado.
  // El CSV Deltron raw no tiene encabezado con ese nombre (sus líneas de encabezado son filtradas).
  // Req 1.1: compatibilidad con el CSV estructurado existente (assets/CSV cotizador/productos.csv).
  const esCSVEstructurado = encabezado.includes('codigo_proveedor');

  if (esCSVEstructurado) {
    const idx = {
      categoria: encabezado.indexOf('categoria'),
      subcategoria: encabezado.indexOf('subcategoria'),
      categoria_proveedor: encabezado.indexOf('categoria_proveedor'),
      codigo_proveedor: encabezado.indexOf('codigo_proveedor'),
      marca: encabezado.indexOf('marca'),
      nombre: encabezado.indexOf('nombre'),
      descripcion_general: encabezado.indexOf('descripcion_general'),
      stock: encabezado.indexOf('stock'),
      disponible_a_pedido: encabezado.indexOf('disponible_a_pedido'),
      precio_base: encabezado.indexOf('precio_base'),
      socket: encabezado.indexOf('socket'),
      arquitectura: encabezado.indexOf('arquitectura'),
      cpu_nucleos: encabezado.indexOf('cpu_nucleos'),
      cpu_hilos: encabezado.indexOf('cpu_hilos'),
      cpu_frecuencia_base_ghz: encabezado.indexOf('cpu_frecuencia_base_ghz'),
      cpu_frecuencia_boost_ghz: encabezado.indexOf('cpu_frecuencia_boost_ghz'),
      cpu_tdp_w: encabezado.indexOf('cpu_tdp_w'),
      cpu_graficos_integrados: encabezado.indexOf('cpu_graficos_integrados'),
      mb_chipset: encabezado.indexOf('mb_chipset'),
      mb_form_factor: encabezado.indexOf('mb_form_factor'),
      mb_ram_tipo: encabezado.indexOf('mb_ram_tipo'),
      mb_max_ram_gb: encabezado.indexOf('mb_max_ram_gb'),
      mb_slots_ram: encabezado.indexOf('mb_slots_ram'),
      mb_m2_slots: encabezado.indexOf('mb_m2_slots'),
      mb_pcie_version: encabezado.indexOf('mb_pcie_version'),
      ram_tipo: encabezado.indexOf('ram_tipo'),
      ram_capacidad_gb: encabezado.indexOf('ram_capacidad_gb'),
      ram_velocidad_mhz: encabezado.indexOf('ram_velocidad_mhz'),
      ram_latencia: encabezado.indexOf('ram_latencia'),
      ram_cantidad_modulos: encabezado.indexOf('ram_cantidad_modulos'),
      storage_tipo: encabezado.indexOf('storage_tipo'),
      storage_capacidad_gb: encabezado.indexOf('storage_capacidad_gb'),
      storage_interfaz: encabezado.indexOf('storage_interfaz'),
      storage_form_factor: encabezado.indexOf('storage_form_factor'),
      storage_nvme_gen: encabezado.indexOf('storage_nvme_gen'),
      storage_velocidad_lectura_mbps: encabezado.indexOf('storage_velocidad_lectura_mbps'),
      storage_velocidad_escritura_mbps: encabezado.indexOf('storage_velocidad_escritura_mbps'),
      gpu_chipset: encabezado.indexOf('gpu_chipset'),
      gpu_vram_gb: encabezado.indexOf('gpu_vram_gb'),
      gpu_vram_tipo: encabezado.indexOf('gpu_vram_tipo'),
      gpu_bus_bits: encabezado.indexOf('gpu_bus_bits'),
      gpu_boost_mhz: encabezado.indexOf('gpu_boost_mhz'),
      gpu_tdp_w: encabezado.indexOf('gpu_tdp_w'),
      gpu_longitud_mm: encabezado.indexOf('gpu_longitud_mm'),
      gpu_fuente_recomendada_w: encabezado.indexOf('gpu_fuente_recomendada_w'),
      psu_wattage: encabezado.indexOf('psu_wattage'),
      psu_certificacion: encabezado.indexOf('psu_certificacion'),
      psu_modular: encabezado.indexOf('psu_modular'),
      psu_form_factor: encabezado.indexOf('psu_form_factor'),
      psu_pcie_conectores: encabezado.indexOf('psu_pcie_conectores'),
      psu_sata_conectores: encabezado.indexOf('psu_sata_conectores'),
      case_form_factor: encabezado.indexOf('case_form_factor'),
      case_color: encabezado.indexOf('case_color'),
      case_panel_lateral: encabezado.indexOf('case_panel_lateral'),
      case_max_gpu_mm: encabezado.indexOf('case_max_gpu_mm'),
      case_max_cooler_mm: encabezado.indexOf('case_max_cooler_mm'),
      case_ventiladores_incluidos: encabezado.indexOf('case_ventiladores_incluidos'),
      case_compatibilidad_placa: encabezado.indexOf('case_compatibilidad_placa'),
    };

    return lineas
      .slice(1)
      .map((linea, indice) => {
        const campos = parsearLineaCSV(linea);
        const stock = limpiar(campos[idx.stock]);
        const pedido = limpiar(campos[idx.disponible_a_pedido]).toLowerCase();
        const stockRaw = stock === '' && (pedido === 'true' || pedido === '1') ? '' : stock;

        return {
          _fila: indice + 2,
          categoria: limpiar(campos[idx.categoria]),
          subcategoria: limpiar(campos[idx.subcategoria]),
          categoria_proveedor: limpiar(campos[idx.categoria_proveedor]),
          codigo: limpiar(campos[idx.codigo_proveedor]),
          nombre_descripcion: limpiar(campos[idx.nombre]),
          descripcion_general: limpiar(campos[idx.descripcion_general]),
          stock_raw: stockRaw,
          precio_usd_raw: limpiar(campos[idx.precio_base]),
          marca: limpiar(campos[idx.marca]),
          socket: limpiar(campos[idx.socket]),
          arquitectura: limpiar(campos[idx.arquitectura]),
          cpu_nucleos: limpiar(campos[idx.cpu_nucleos]),
          cpu_hilos: limpiar(campos[idx.cpu_hilos]),
          cpu_frecuencia_base_ghz: limpiar(campos[idx.cpu_frecuencia_base_ghz]),
          cpu_frecuencia_boost_ghz: limpiar(campos[idx.cpu_frecuencia_boost_ghz]),
          cpu_tdp_w: limpiar(campos[idx.cpu_tdp_w]),
          cpu_graficos_integrados: limpiar(campos[idx.cpu_graficos_integrados]),
          mb_chipset: limpiar(campos[idx.mb_chipset]),
          mb_form_factor: limpiar(campos[idx.mb_form_factor]),
          mb_ram_tipo: limpiar(campos[idx.mb_ram_tipo]),
          mb_max_ram_gb: limpiar(campos[idx.mb_max_ram_gb]),
          mb_slots_ram: limpiar(campos[idx.mb_slots_ram]),
          mb_m2_slots: limpiar(campos[idx.mb_m2_slots]),
          mb_pcie_version: limpiar(campos[idx.mb_pcie_version]),
          ram_tipo: limpiar(campos[idx.ram_tipo]),
          ram_capacidad_gb: limpiar(campos[idx.ram_capacidad_gb]),
          ram_velocidad_mhz: limpiar(campos[idx.ram_velocidad_mhz]),
          ram_latencia: limpiar(campos[idx.ram_latencia]),
          ram_cantidad_modulos: limpiar(campos[idx.ram_cantidad_modulos]),
          storage_tipo: limpiar(campos[idx.storage_tipo]),
          storage_capacidad_gb: limpiar(campos[idx.storage_capacidad_gb]),
          storage_interfaz: limpiar(campos[idx.storage_interfaz]),
          storage_form_factor: limpiar(campos[idx.storage_form_factor]),
          storage_nvme_gen: limpiar(campos[idx.storage_nvme_gen]),
          storage_velocidad_lectura_mbps: limpiar(campos[idx.storage_velocidad_lectura_mbps]),
          storage_velocidad_escritura_mbps: limpiar(campos[idx.storage_velocidad_escritura_mbps]),
          gpu_chipset: limpiar(campos[idx.gpu_chipset]),
          gpu_vram_gb: limpiar(campos[idx.gpu_vram_gb]),
          gpu_vram_tipo: limpiar(campos[idx.gpu_vram_tipo]),
          gpu_bus_bits: limpiar(campos[idx.gpu_bus_bits]),
          gpu_boost_mhz: limpiar(campos[idx.gpu_boost_mhz]),
          gpu_tdp_w: limpiar(campos[idx.gpu_tdp_w]),
          gpu_longitud_mm: limpiar(campos[idx.gpu_longitud_mm]),
          gpu_fuente_recomendada_w: limpiar(campos[idx.gpu_fuente_recomendada_w]),
          psu_wattage: limpiar(campos[idx.psu_wattage]),
          psu_certificacion: limpiar(campos[idx.psu_certificacion]),
          psu_modular: limpiar(campos[idx.psu_modular]),
          psu_form_factor: limpiar(campos[idx.psu_form_factor]),
          psu_pcie_conectores: limpiar(campos[idx.psu_pcie_conectores]),
          psu_sata_conectores: limpiar(campos[idx.psu_sata_conectores]),
          case_form_factor: limpiar(campos[idx.case_form_factor]),
          case_color: limpiar(campos[idx.case_color]),
          case_panel_lateral: limpiar(campos[idx.case_panel_lateral]),
          case_max_gpu_mm: limpiar(campos[idx.case_max_gpu_mm]),
          case_max_cooler_mm: limpiar(campos[idx.case_max_cooler_mm]),
          case_ventiladores_incluidos: limpiar(campos[idx.case_ventiladores_incluidos]),
          case_compatibilidad_placa: limpiar(campos[idx.case_compatibilidad_placa]),
        };
      })
      .filter((fila) => fila.codigo);
  }

  // Branch Deltron raw: aplicar los tres filtros de descarte antes de procesar cada línea (§13.1)
  const filasDeltron = [];
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (esFilaSeparador(linea)) continue;
    if (esFilaEncabezado(linea)) continue;
    if (esFilaMetadata(linea)) continue;

    const campos = parsearLineaCSV(linea);
    filasDeltron.push({
      _fila: i + 1,
      categoria_proveedor: limpiar(campos[0]),
      codigo: limpiar(campos[1]),
      nombre_descripcion: limpiar(campos[2]),
      stock_raw: String(campos[3] || '').trim(),
      precio_usd_raw: String(campos[4] || '').trim(),
      marca: limpiar(campos[8]),
    });
  }
  return filasDeltron;
}

// §13.1 — Filtros de descarte para el branch Deltron raw

/**
 * Detecta líneas de separador de categoría.
 * Ejemplos: "_______________","_______________","__________________________________","__________"
 * También cubre la línea de guiones bajos del encabezado del archivo.
 */
function esFilaSeparador(linea) {
  return /^["_,\s]+$/.test(linea);
}

/**
 * Detecta líneas de encabezado de columnas repetidas por categoría.
 * Ejemplos: " ","CODIGO","ACCESORIOS","STOCK","PREC DISTRIB US $","PREC S/.","FLETE ","GARAN","MARCA"
 */
function esFilaEncabezado(linea) {
  const upper = linea.toUpperCase();
  return upper.includes('CODIGO') && upper.includes('STOCK') && upper.includes('PREC DISTRIB');
}

/**
 * Detecta líneas de metadatos del archivo (cabecera del documento).
 * Ejemplos: ,"LISTA DE PRECIOS DELTRON"  /  ,"Generada el :"  /  ,"Almacen(es) :"  /  ,"TIPO DE CAMBIO :..."
 */
function esFilaMetadata(linea) {
  const upper = linea.toUpperCase();
  return (
    upper.includes('LISTA DE PRECIOS') ||
    upper.includes('GENERADA EL') ||
    upper.includes('ALMACEN') ||
    upper.includes('TIPO DE CAMBIO')
  );
}

// ---------------------------------------------------------------------------
// Normalizadores y extractores de specs desde texto libre.
// A partir del nombre/descripción del producto detectan valores canónicos:
//   normalizarSocket/RamTipo/FormFactor -> valor estándar (AM5, DDR5, MICRO-ATX...).
//   extraerNumero        -> primer número que cumple un patrón regex.
//   extraerFrecuencias   -> frecuencias base/boost de CPU (soporta "3.5/4.2 GHz").
//   extraerCapacidadGb   -> capacidad en GB (convierte TB a GB).
//   inferirSpecsProcesadorPorModelo -> tabla de modelos Intel/AMD conocidos como
//                           respaldo cuando el texto no trae núcleos/hilos.
// ---------------------------------------------------------------------------

/** Detecta el socket del CPU/placa (AM5, AM4, LGA1700, etc.) desde texto libre. */
function normalizarSocket(texto) {
  const t = texto.toLowerCase();
  const match = t.match(/\b(am5|am4|am3\+?|lga\s?\d{3,4}|tr4|s?trx4|fm2\+?)\b/i);
  if (!match) return null;
  return match[1].toUpperCase().replace(/\s+/g, ' ');
}

/** Detecta el tipo de RAM (DDR3/DDR4/DDR5) desde texto libre. */
function normalizarRamTipo(texto) {
  const t = texto.toLowerCase();
  const match = t.match(/\b(ddr5|ddr4|ddr3)\b/i);
  return match ? match[1].toUpperCase() : null;
}

/** Detecta el factor de forma (E-ATX/ATX/MICRO-ATX/MINI-ITX) cubriendo sus variantes de escritura. */
function normalizarFormFactor(texto) {
  const t = texto.toLowerCase();
  // §14.7: cubrir variantes extendidas de E-ATX
  if (t.includes('e-atx') || t.includes('eatx') || t.includes('extended atx')) return 'E-ATX';
  // §14.7: cubrir microatx, micro-atx, matx, m-atx, micro atx
  if (
    t.includes('microatx') ||
    t.includes('micro-atx') ||
    t.includes('micro atx') ||
    t.includes('m-atx') ||
    t.includes('matx')
  ) return 'MICRO-ATX';
  // §14.7: cubrir miniitx, mini-itx, mini itx
  if (t.includes('miniitx') || t.includes('mini-itx') || t.includes('mini itx')) return 'MINI-ITX';
  if (t.includes('atx')) return 'ATX';
  return null;
}

/** Aplica un regex y devuelve el primer grupo capturado como número finito, o null. */
function extraerNumero(regex, texto) {
  const m = texto.match(regex);
  if (!m) return null;
  const valor = Number(m[1] || m[2]);
  return Number.isFinite(valor) ? valor : null;
}

/**
 * Extrae las frecuencias base y boost de un CPU. Reconoce el formato "3.5/4.2 GHz",
 * el formato "base ... GHz ... boost ... GHz" y, como respaldo, toma el mínimo como
 * base y el máximo como boost entre todos los valores en GHz encontrados.
 * @returns {{base: number|null, boost: number|null}}
 */
function extraerFrecuencias(texto) {
  const par = texto.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*ghz\b/i);
  if (par) {
    const base = Number(par[1]);
    const boost = Number(par[2]);
    return {
      base: Number.isFinite(base) ? base : null,
      boost: Number.isFinite(boost) ? boost : null,
    };
  }

  const parSeparado = texto.match(/base\D{0,12}(\d+(?:\.\d+)?)\s*ghz.*boost\D{0,12}(\d+(?:\.\d+)?)\s*ghz/i);
  if (parSeparado) {
    const base = Number(parSeparado[1]);
    const boost = Number(parSeparado[2]);
    return {
      base: Number.isFinite(base) ? base : null,
      boost: Number.isFinite(boost) ? boost : null,
    };
  }

  const matches = [...texto.matchAll(/(\d+(?:\.\d+)?)\s*ghz\b/gi)].map((m) => Number(m[1]));
  if (matches.length === 0) return { base: null, boost: null };
  if (matches.length === 1) return { base: matches[0], boost: null };
  return { base: Math.min(...matches), boost: Math.max(...matches) };
}

/**
 * Respaldo determinístico: infiere núcleos, hilos, arquitectura y gráficos
 * integrados a partir del modelo del procesador (tabla de SKUs Intel Core y AMD
 * Ryzen conocidos). Se usa cuando el texto del CSV no trae esos datos. El sufijo
 * "F" indica ausencia de gráficos integrados. Devuelve {} si el modelo no está en la tabla.
 */
function inferirSpecsProcesadorPorModelo(texto) {
  const t = String(texto || '').toLowerCase();

  const intel = t.match(/core\s+i([3579])[-\s]?(\d{5})([a-z]{0,3})/i);
  if (intel) {
    const tier = intel[1];
    const generacion = intel[2].slice(0, 2);
    const sku = intel[2];
    const sufijo = intel[3].toUpperCase();

    if (generacion === '14') {
      if (tier === '7' && sku === '14700') return { cpu_nucleos: 20, cpu_hilos: 28, arquitectura: 'Raptor Lake Refresh', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '5' && sku === '14600') return { cpu_nucleos: 14, cpu_hilos: 20, arquitectura: 'Raptor Lake Refresh', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '9' && sku === '14900') return { cpu_nucleos: 24, cpu_hilos: 32, arquitectura: 'Raptor Lake Refresh', cpu_graficos_integrados: !sufijo.includes('F') };
    }

    if (generacion === '13') {
      if (tier === '7' && sku === '13700') return { cpu_nucleos: 16, cpu_hilos: 24, arquitectura: 'Raptor Lake', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '5' && sku === '13600') return { cpu_nucleos: 14, cpu_hilos: 20, arquitectura: 'Raptor Lake', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '9' && sku === '13900') return { cpu_nucleos: 24, cpu_hilos: 32, arquitectura: 'Raptor Lake', cpu_graficos_integrados: !sufijo.includes('F') };
    }

    if (generacion === '12') {
      if (tier === '7' && sku === '12700') return { cpu_nucleos: 12, cpu_hilos: 20, arquitectura: 'Alder Lake', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '5' && sku === '12600') return { cpu_nucleos: 10, cpu_hilos: 16, arquitectura: 'Alder Lake', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '5' && sku === '12400') return { cpu_nucleos: 6, cpu_hilos: 12, arquitectura: 'Alder Lake', cpu_graficos_integrados: !sufijo.includes('F') };
      if (tier === '9' && sku === '12900') return { cpu_nucleos: 16, cpu_hilos: 24, arquitectura: 'Alder Lake', cpu_graficos_integrados: !sufijo.includes('F') };
    }
  }

  const amd = t.match(/ryzen\s+([3579])\s+(\d{4,5})([a-z]{0,3})/i);
  if (amd) {
    const tier = amd[1];
    const sku = amd[2];
    const sufijo = amd[3].toUpperCase();
    const arquitectura = sku.startsWith('8') || sku.startsWith('9') ? 'Zen 4' : null;

    if (tier === '5' && sku === '8500' && sufijo.includes('G')) return { cpu_nucleos: 6, cpu_hilos: 12, arquitectura, cpu_graficos_integrados: true };
    if (tier === '5' && sku === '5600' && (sufijo.includes('G') || sufijo.includes('GT'))) return { cpu_nucleos: 6, cpu_hilos: 12, arquitectura: 'Zen 3', cpu_graficos_integrados: true };
    if (tier === '7' && sku === '8700' && sufijo.includes('G')) return { cpu_nucleos: 8, cpu_hilos: 16, arquitectura, cpu_graficos_integrados: true };
  }

  return {};
}

/** Extrae capacidad de almacenamiento/memoria en GB (convierte TB a GB si corresponde). */
function extraerCapacidadGb(texto) {
  const tb = extraerNumero(/(\d+(?:\.\d+)?)\s*tb/i, texto);
  if (tb != null) return Math.round(tb * 1024);
  return extraerNumero(/(\d+)\s*gb/i, texto);
}

let _catalogoLocalGPU = null;

/** Convierte un valor a entero, o null si no es un número finito. */
function parsearEnteroSeguro(valor) {
  const numero = Number.parseInt(String(valor ?? '').trim(), 10);
  return Number.isFinite(numero) ? numero : null;
}

function parsearLineaCSVSimple(linea) {
  const columnas = [];
  let actual = '';
  let entreComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const char = linea[i];

    if (char === '"') {
      if (entreComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        entreComillas = !entreComillas;
      }
      continue;
    }

    if (char === ',' && !entreComillas) {
      columnas.push(actual);
      actual = '';
      continue;
    }

    actual += char;
  }

  columnas.push(actual);
  return columnas;
}

/**
 * Carga (una sola vez, con cache en memoria) un catálogo local de specs de GPU desde
 * los CSV de assets, indexado por código de proveedor y por nombre. Sirve de respaldo
 * confiable para completar specs de GPU que el texto del CSV de importación no trae.
 * Si los archivos no existen, devuelve mapas vacíos sin interrumpir la importación.
 */
function cargarCatalogoLocalGPU() {
  if (_catalogoLocalGPU) return _catalogoLocalGPU;

  const basePath = path.join(__dirname, '..', '..', 'assets', 'CSV cotizador');
  const productosPath = path.join(basePath, 'productos.csv');
  const specsPath = path.join(basePath, 'specs_gpu.csv');

  const porCodigo = new Map();
  const porNombre = new Map();

  try {
    const productos = fs.readFileSync(productosPath, 'utf8').split(/\r?\n/).slice(1);
    const specs = fs.readFileSync(specsPath, 'utf8').split(/\r?\n/).slice(1);

    const specsPorId = new Map();
    for (const linea of specs) {
      if (!linea.trim()) continue;
      const [idProducto, chipset, vramGb, vramTipo, busBits, boostMhz, tdpW, longitudMm, fuenteRecomendadaW] = linea.split(',');
      specsPorId.set(String(idProducto).trim(), {
        gpu_chipset: String(chipset || '').trim() || null,
        gpu_vram_gb: parsearEnteroSeguro(vramGb),
        gpu_vram_tipo: String(vramTipo || '').trim() || null,
        gpu_bus_bits: parsearEnteroSeguro(busBits),
        gpu_boost_mhz: parsearEnteroSeguro(boostMhz),
        gpu_tdp_w: parsearEnteroSeguro(tdpW),
        gpu_longitud_mm: parsearEnteroSeguro(longitudMm),
        gpu_fuente_recomendada_w: parsearEnteroSeguro(fuenteRecomendadaW),
      });
    }

    for (const linea of productos) {
      if (!linea.trim()) continue;
      const columnas = parsearLineaCSVSimple(linea);
      const idProducto = String(columnas[0] || '').trim();
      const codigoProveedor = String(columnas[5] || '').trim().toLowerCase();
      const nombre = String(columnas[6] || '').trim();
      const spec = specsPorId.get(idProducto);
      if (!spec) continue;
      if (codigoProveedor) porCodigo.set(codigoProveedor, spec);
      if (nombre) porNombre.set(nombre.toLowerCase(), spec);
    }
  } catch (error) {
    console.warn('[ImportacionCSV] No se pudo cargar catálogo local GPU:', error.message);
  }

  _catalogoLocalGPU = { porCodigo, porNombre };
  return _catalogoLocalGPU;
}

/** Busca specs de una GPU en el catálogo local, primero por código de proveedor y luego por nombre. */
function obtenerSpecsGpuCatalogoLocal(fila, nombreDetectado) {
  const { porCodigo, porNombre } = cargarCatalogoLocalGPU();
  const codigo = String(fila?.codigo || '').trim().toLowerCase();
  const nombre = String(nombreDetectado || fila?.descripcion_general || fila?.nombre_descripcion || '').trim().toLowerCase();
  return porCodigo.get(codigo) || porNombre.get(nombre) || {};
}

/**
 * Extrae las especificaciones técnicas tipadas de un producto a partir de su
 * nombre y categoría de proveedor, aplicando reglas de expresiones regulares
 * específicas por categoría (procesador, placa_madre, ram, almacenamiento, gpu,
 * fuente, case). Es el paso que convierte texto comercial en datos de compatibilidad.
 * @param {string} categoria - Categoría interna del producto.
 * @param {string} nombre - Nombre/descripción del producto.
 * @param {string} categoriaProveedor - Texto de categoría del proveedor (añade contexto).
 * @returns {object} Campos de specs detectados (los no hallados quedan en null); {} si la categoría no aplica.
 */
function extraerSpecs(categoria, nombre, categoriaProveedor) {
  const texto = `${nombre} ${categoriaProveedor}`;
  const textoLower = texto.toLowerCase();

  if (categoria === 'procesador') {
    const frec = extraerFrecuencias(textoLower);
    const inferidas = inferirSpecsProcesadorPorModelo(texto);
    let graficosIntegrados = null;
    if (
      textoLower.includes('sin graficos') ||
      textoLower.includes('sin gráficos') ||
      /\bi[3579]-\d{4,5}f\b/i.test(nombre)
    ) {
      graficosIntegrados = false;
    } else if (
      textoLower.includes('radeon graphics') ||
      /\bryzen\s*\d+\s*\d+g\b/i.test(textoLower) ||
      /\b\d{4,5}g\b/i.test(textoLower) ||
      textoLower.includes('intel uhd') ||
      textoLower.includes('intel iris')
    ) {
      graficosIntegrados = true;
    }

    const nucleosDetectados =
      extraerNumero(/(\d{1,2})\s*[-]?\s*cores?/i, textoLower) ||
      extraerNumero(/(\d{1,2})\s*n[uú]cleos?/i, textoLower) ||
      extraerNumero(/\b(\d{1,2})c\b/i, textoLower);

    const hilosDetectados =
      extraerNumero(/(\d{1,2})\s*[-]?\s*threads?/i, textoLower) ||
      extraerNumero(/(\d{1,2})\s*hilos?/i, textoLower) ||
      extraerNumero(/\b(\d{1,2})t\b/i, textoLower);

    const tdpDetectado = extraerNumero(/tdp\D{0,6}(\d{2,4})\s*w/i, textoLower)
      || extraerNumero(/(\d{2,4})\s*w\D{0,6}tdp/i, textoLower)
      || extraerNumero(/,\s*(\d{2,3})\s*w\/?\s*$/i, textoLower)
      || extraerNumero(/\btdp[:\s]*(\d{2,3})\s*w/i, textoLower)
      || extraerNumero(/\b(\d{2,3})\s*w\/?(?=\s|,|$)/i, textoLower);

    return {
      socket: normalizarSocket(texto),
      arquitectura: inferidas.arquitectura || null,
      cpu_nucleos: nucleosDetectados || inferidas.cpu_nucleos || null,
      cpu_hilos: hilosDetectados || inferidas.cpu_hilos || null,
      cpu_frecuencia_base_ghz: frec.base,
      cpu_frecuencia_boost_ghz: frec.boost,
      cpu_tdp_w: tdpDetectado,
      cpu_graficos_integrados: graficosIntegrados ?? inferidas.cpu_graficos_integrados ?? null,
    };
  }

  if (categoria === 'placa_madre') {
    // Req 2.2: chipset — cubre A520/B550/B650/B850/A620/X570/X670/X870/Z790/H610/H770 etc.
    // Patrón: letra(s) seguida de 3 dígitos con sufijo opcional (E, F, etc.)
    const chipsetMatch =
      texto.match(/\b([abxhz][0-9]{3}[a-z]?)\b/i) ||
      texto.match(/\b(b\d{2,3}[a-z]?)\b/i);
    return {
      socket: normalizarSocket(texto),
      mb_chipset: chipsetMatch ? chipsetMatch[1].toUpperCase() : null,
      mb_form_factor: normalizarFormFactor(texto),
      mb_ram_tipo: normalizarRamTipo(texto),
      mb_max_ram_gb: extraerNumero(/(?:hasta|max)\s*(\d{2,4})\s*gb/i, textoLower),
      mb_slots_ram: extraerNumero(/(\d)\s*(?:slots?|ranuras?)\s*(?:ram|ddr)?/i, textoLower),
      mb_m2_slots: extraerNumero(/(\d)\s*x?\s*m\.?2/i, textoLower) || (textoLower.includes('m.2') ? 1 : null),
      mb_pcie_version: (texto.match(/pcie\s*(\d(?:\.\d)?)/i) || texto.match(/pci\s*express\s*(\d(?:\.\d)?)/i) || [])[1] || null,
    };
  }

  if (categoria === 'ram') {
    const kit = textoLower.match(/(\d+)\s*x\s*(\d+)\s*gb/);
    const capacidad = kit ? Number(kit[1]) * Number(kit[2]) : extraerCapacidadGb(textoLower);
    // Req 2.3: latencia — cubre "CL16", "cl16", "16CL", "CAS 16", "CAS16"
    const latenciaMatch =
      texto.match(/\bcl[-\s]?(\d{1,2})\b/i) ||
      texto.match(/\bcas[-\s]?(\d{1,2})\b/i) ||
      texto.match(/\b(\d{1,2})[-\s]?cl\b/i);
    return {
      ram_tipo: normalizarRamTipo(texto),
      ram_capacidad_gb: capacidad,
      // Req 2.3: velocidad — cubre "3200MHz" y "3200MT/s" / "4800 MT/s"
      ram_velocidad_mhz:
        extraerNumero(/(\d{3,5})\s*mhz/i, textoLower) ||
        extraerNumero(/(\d{3,5})\s*mt\/s/i, textoLower),
      // Req 2.3: latencia normalizada a formato "CL16"
      ram_latencia: latenciaMatch ? `CL${latenciaMatch[1]}` : null,
      // Req 2.3: cantidad_modulos desde "1x16GB" o "2x8GB"
      ram_cantidad_modulos: kit ? Number(kit[1]) : null,
    };
  }

  if (categoria === 'almacenamiento') {
    const esNvme = textoLower.includes('nvme');
    const esSsd = textoLower.includes('ssd');
    const esHdd = textoLower.includes('hdd') || textoLower.includes('disco duro');
    const nvmeGen = (textoLower.match(/gen\s*([345])/i) || textoLower.match(/pcie\s*([345])\.0/i) || [])[1] || null;

    // Req 2.4 — velocidad lectura: "seq read: 7000 MB/s", "7000MB/s read", "550 MB/s" (primer valor)
    const velocidadLectura =
      extraerNumero(/(?:seq(?:uential)?\s*)?read[:\s]+(\d{3,5})\s*mb\/s/i, texto) ||
      extraerNumero(/(\d{3,5})\s*mb\/s\s*(?:read|lectura)/i, texto) ||
      extraerNumero(/(\d{3,5})\s*mb\/s/i, texto);

    // Req 2.4 — velocidad escritura: "520 MB/s write", "seq write: 520 MB/s"
    const velocidadEscritura =
      extraerNumero(/(?:seq(?:uential)?\s*)?writ[e\s]*[:\s]+(\d{3,5})\s*mb\/s/i, texto) ||
      extraerNumero(/(\d{3,5})\s*mb\/s\s*(?:writ|escritura)/i, texto) ||
      (() => {
        const pares = [...texto.matchAll(/(\d{3,5})\s*mb\/s/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
        return pares.length >= 2 ? pares[1] : null;
      })();

    return {
      storage_tipo: esNvme ? 'NVMe' : (esSsd ? 'SSD' : (esHdd ? 'HDD' : null)),
      storage_capacidad_gb: extraerCapacidadGb(textoLower),
      storage_interfaz: esNvme ? (nvmeGen ? `NVMe PCIe ${nvmeGen}.0` : 'NVMe') : (textoLower.includes('sata') ? 'SATA III' : (textoLower.includes('usb') ? 'USB' : null)),
      // Req 2.4 — form_factor ahora incluye 3.5"
      storage_form_factor: textoLower.includes('m.2') ? 'M.2' : (textoLower.includes('2.5') ? '2.5"' : (textoLower.includes('3.5') ? '3.5"' : null)),
      storage_nvme_gen: nvmeGen ? `Gen ${nvmeGen}` : null,
      storage_velocidad_lectura_mbps: velocidadLectura,
      storage_velocidad_escritura_mbps: velocidadEscritura,
    };
  }

  if (categoria === 'gpu') {
    const matchVram = texto.match(/(\d{1,2})\s*gb\s*(gddr\s*\d\w*)/i);

    // Req 2.5 — chipset completo: "NVIDIA GeForce RTX 5060 Ti", "AMD Radeon RX 9070 XT"
    const chipsetCompleto = (() => {
      const m =
        texto.match(/(nvidia\s+geforce\s+(?:rtx|gtx)\s*\d{3,4}(?:\s*ti)?)/i) ||
        texto.match(/(amd\s+radeon\s+rx\s*\d{4}(?:\s*xt)?)/i) ||
        texto.match(/(rtx\s*\d{3,4}(?:\s*ti)?|gtx\s*\d{3,4}|rx\s*\d{4}(?:\s*xt)?|arc\s*[a-z0-9]+)/i);
      return m ? m[1].replace(/\s+/g, ' ').trim().toUpperCase() : null;
    })();

    // Req 2.5 — vram_tipo: normalizar "GDDR 6" → "GDDR6", "gddr6x" → "GDDR6X"
    const vramTipo = (() => {
      const m = texto.match(/\bgddr\s*(\d\w*)\b/i);
      return m ? `GDDR${m[1].toUpperCase()}` : null;
    })();

    return {
      gpu_chipset: chipsetCompleto,
      gpu_vram_gb: matchVram ? Number(matchVram[1]) : extraerNumero(/(\d{1,2})\s*gb/i, textoLower),
      gpu_vram_tipo: vramTipo,
      // Req 2.5 — bus_bits: "256-bit", "256 bit", "256bits"
      gpu_bus_bits: extraerNumero(/(\d{2,3})\s*[-]?\s*bits?/i, texto),
      gpu_boost_mhz: extraerNumero(/boost[^0-9]{0,15}(\d{3,5})\s*mhz/i, textoLower) || extraerNumero(/(\d{3,5})\s*mhz\s*boost/i, textoLower),
      gpu_tdp_w: extraerNumero(/tdp\D{0,6}(\d{2,4})\s*w/i, textoLower),
      gpu_longitud_mm: extraerNumero(/(?:length|longitud|largo)[^0-9]{0,12}(\d{3})\s*mm/i, textoLower) || extraerNumero(/(\d{3})\s*mm/i, textoLower),
      gpu_fuente_recomendada_w: extraerNumero(/(?:fuente|psu)[^0-9]{0,20}(\d{3,4})\s*w\s*(?:recomendada|sugerida|min(?:ima)?)/i, textoLower) || extraerNumero(/(?:recomendada|sugerida|min(?:ima)?)\D{0,20}(\d{3,4})\s*w/i, textoLower),
    };
  }

  if (categoria === 'fuente') {
    // Req 2.6 — certificacion mejorada: "80plus gold", "80 plus gold", "80+ Gold" → "80+ Gold"
    const certificacion = (() => {
      const m =
        texto.match(/80\s*[+]?\s*plus\s*(bronze|gold|silver|platinum|titanium)?/i) ||
        texto.match(/80\s*\+\s*(bronze|gold|silver|platinum|titanium)?/i);
      if (!m) return null;
      const nivel = (m[1] || '').trim();
      if (!nivel) return '80+';
      return `80+ ${nivel.charAt(0).toUpperCase() + nivel.slice(1).toLowerCase()}`;
    })();

    // Req 2.6 — modular: valores legibles en lugar de snake_case
    const modular = (() => {
      if (textoLower.includes('full modular') || textoLower.includes('fully modular')) return 'Full Modular';
      if (textoLower.includes('semi') && textoLower.includes('modular')) return 'Semi Modular';
      if (
        textoLower.includes('no modular') ||
        textoLower.includes('non-modular') ||
        textoLower.includes('no-modular')
      ) return 'No Modular';
      if (textoLower.includes('modular')) return 'Modular';
      return null;
    })();

    return {
      psu_wattage: extraerNumero(/\b(\d{3,4})\s*w\b/i, textoLower),
      psu_certificacion: certificacion,
      psu_modular: modular,
      psu_form_factor: normalizarFormFactor(texto),
      psu_pcie_conectores: extraerNumero(/(\d{1,2})\s*(?:conectores?|salidas?)\s*pcie/i, textoLower),
      psu_sata_conectores: extraerNumero(/(\d{1,2})\s*(?:conectores?|salidas?)\s*sata/i, textoLower),
    };
  }

  if (categoria === 'case') {
    // Req 2.7 — color: añadir blue/azul, normalizar a español con mayúscula inicial
    const color = (() => {
      const m = texto.match(/\b(black|negro|white|blanco|gris|gray|grey|silver|plateado|red|rojo|blue|azul)\b/i);
      if (!m) return null;
      const mapa = {
        black: 'Negro', negro: 'Negro',
        white: 'Blanco', blanco: 'Blanco',
        gris: 'Gris', gray: 'Gris', grey: 'Gris',
        silver: 'Plateado', plateado: 'Plateado',
        red: 'Rojo', rojo: 'Rojo',
        blue: 'Azul', azul: 'Azul',
      };
      return mapa[m[1].toLowerCase()] || m[1];
    })();

    // Req 2.7 — panel_lateral: Vidrio Templado / Malla Metálica / Acrílico Transparente
    const panelLateral = (() => {
      if (textoLower.includes('vidrio templado') || textoLower.includes('tempered glass') || textoLower.includes(' tg ') || textoLower.endsWith(' tg')) return 'Vidrio Templado';
      if (textoLower.includes('mesh') || textoLower.includes('malla')) return 'Malla Metálica';
      if (textoLower.includes('acril') || textoLower.includes('acryl')) return 'Acrílico Transparente';
      return null;
    })();

    return {
      case_form_factor: normalizarFormFactor(texto),
      case_color: color,
      case_panel_lateral: panelLateral,
      case_max_gpu_mm: extraerNumero(/(?:gpu|vga)[^0-9]{0,20}(\d{3})\s*mm/i, textoLower),
      case_max_cooler_mm: extraerNumero(/(?:cooler|cpu cooler|altura)[^0-9]{0,20}(\d{2,3})\s*mm/i, textoLower),
      case_ventiladores_incluidos: extraerNumero(/(\d{1,2})\s*(?:ventiladores?|fans?)(?:\s*incluidos?)?/i, textoLower),
      case_compatibilidad_placa: [normalizarFormFactor(texto) || 'ATX', 'MICRO-ATX', 'MINI-ITX'].filter(Boolean).join(','),
    };
  }

  return {};
}

/**
 * Convierte una fila cruda del CSV en un registro de producto normalizado y listo
 * para persistir: resuelve la categoría interna, valida el precio, limpia nombre y
 * descripción, combina las specs (CSV explícito > extraídas del texto > catálogo local)
 * y marca si el producto necesita enriquecimiento IA por specs faltantes.
 * @returns {object|null} Registro normalizado, {error} si el precio es inválido, o null si la fila se descarta.
 */
function construirRegistroNormalizado(fila) {
  const categoriaDirecta = String(fila.categoria || '').trim().toLowerCase();
  const subcategoriaDirecta = String(fila.subcategoria || '').trim().toLowerCase();
  const categoriaMapeada = mapearCategoria(fila.categoria_proveedor);
  const categoriaEntrada = categoriaDirecta || categoriaMapeada;
  if (!categoriaEntrada) return null;

  const destino = resolverCategoria(categoriaEntrada);
  if (!destino) return null;

  const precio = parsearPrecio(fila.precio_usd_raw);
  if (!Number.isFinite(precio) || precio <= 0 || precio > 100000) {
    return { error: `precio_usd invalido: "${fila.precio_usd_raw}"` };
  }

  const descripcionBase = limpiarNombre(fila.nombre_descripcion);
  if (!descripcionBase || descripcionBase.length < 3) {
    return null;
  }

  // Para filas Deltron raw, derivar descripcion_general desde nombre_descripcion (Req 1.4, 1.9).
  // Para CSV estructurado, usar el campo descripcion_general explícito si existe.
  const descripcionGeneral = fila.descripcion_general
    ? String(fila.descripcion_general).trim()
    : limpiarDescripcionGeneral(fila.nombre_descripcion);

  const stockInfo = parsearStock(fila.stock_raw);
  const subcategoriaFinal = destino.subcategoria || subcategoriaDirecta || '';
  const nombreLimpio = generarNombreComercial(destino.categoria, descripcionBase, fila.marca || '');
  const specsDetectadas = extraerSpecs(destino.categoria, descripcionGeneral || descripcionBase, fila.categoria_proveedor || '');
  const specsCatalogoLocal = destino.categoria === 'gpu'
    ? obtenerSpecsGpuCatalogoLocal(fila, descripcionGeneral || descripcionBase)
    : {};
  const specsDesdeCSV = {
    socket: fila.socket || null,
    arquitectura: fila.arquitectura || null,
    cpu_nucleos: fila.cpu_nucleos || null,
    cpu_hilos: fila.cpu_hilos || null,
    cpu_frecuencia_base_ghz: fila.cpu_frecuencia_base_ghz || null,
    cpu_frecuencia_boost_ghz: fila.cpu_frecuencia_boost_ghz || null,
    cpu_tdp_w: fila.cpu_tdp_w || null,
    cpu_graficos_integrados: fila.cpu_graficos_integrados || null,
    mb_chipset: fila.mb_chipset || null,
    mb_form_factor: fila.mb_form_factor || null,
    mb_ram_tipo: fila.mb_ram_tipo || null,
    mb_max_ram_gb: fila.mb_max_ram_gb || null,
    mb_slots_ram: fila.mb_slots_ram || null,
    mb_m2_slots: fila.mb_m2_slots || null,
    mb_pcie_version: fila.mb_pcie_version || null,
    ram_tipo: fila.ram_tipo || null,
    ram_capacidad_gb: fila.ram_capacidad_gb || null,
    ram_velocidad_mhz: fila.ram_velocidad_mhz || null,
    ram_latencia: fila.ram_latencia || null,
    ram_cantidad_modulos: fila.ram_cantidad_modulos || null,
    storage_tipo: fila.storage_tipo || null,
    storage_capacidad_gb: fila.storage_capacidad_gb || null,
    storage_interfaz: fila.storage_interfaz || null,
    storage_form_factor: fila.storage_form_factor || null,
    storage_nvme_gen: fila.storage_nvme_gen || null,
    storage_velocidad_lectura_mbps: fila.storage_velocidad_lectura_mbps || null,
    storage_velocidad_escritura_mbps: fila.storage_velocidad_escritura_mbps || null,
    gpu_chipset: fila.gpu_chipset || null,
    gpu_vram_gb: fila.gpu_vram_gb || null,
    gpu_vram_tipo: fila.gpu_vram_tipo || null,
    gpu_bus_bits: fila.gpu_bus_bits || null,
    gpu_boost_mhz: fila.gpu_boost_mhz || null,
    gpu_tdp_w: fila.gpu_tdp_w || null,
    gpu_longitud_mm: fila.gpu_longitud_mm || null,
    gpu_fuente_recomendada_w: fila.gpu_fuente_recomendada_w || null,
    psu_wattage: fila.psu_wattage || null,
    psu_certificacion: fila.psu_certificacion || null,
    psu_modular: fila.psu_modular || null,
    psu_form_factor: fila.psu_form_factor || null,
    psu_pcie_conectores: fila.psu_pcie_conectores || null,
    psu_sata_conectores: fila.psu_sata_conectores || null,
    case_form_factor: fila.case_form_factor || null,
    case_color: fila.case_color || null,
    case_panel_lateral: fila.case_panel_lateral || null,
    case_max_gpu_mm: fila.case_max_gpu_mm || null,
    case_max_cooler_mm: fila.case_max_cooler_mm || null,
    case_ventiladores_incluidos: fila.case_ventiladores_incluidos || null,
    case_compatibilidad_placa: fila.case_compatibilidad_placa || null,
  };
  const specs = {
    ...specsDetectadas,
    ...specsCatalogoLocal,
    ...Object.fromEntries(Object.entries(specsDesdeCSV).filter(([, v]) => String(v || '').trim() !== '')),
  };

  // §5.2 — Asignar estado_enriquecimiento según si la categoría es principal y si tiene specs completas.
  // Requisitos: 3.1, 3.2, 3.3, 3.4
  let estadoEnriquecimiento = 'no_aplica';
  if (esCategoriaPrincipal(destino.categoria)) {
    estadoEnriquecimiento = tieneSpecsFaltantes(destino.categoria, specs)
      ? 'pendiente'
      : 'csv';
  }

  return {
    categoria: destino.categoria,
    subcategoria: subcategoriaFinal,
    categoria_proveedor: fila.categoria_proveedor || '',
    codigo_proveedor: String(fila.codigo || '').trim().toLowerCase(),
    marca: (fila.marca || '').trim(),
    nombre: nombreLimpio,
    descripcion_general: descripcionGeneral,
    stock: stockInfo.stock,
    disponible_a_pedido: stockInfo.disponible_a_pedido,
    precio_base: Number(precio.toFixed(2)),
    es_componente_principal: esCategoriaPrincipal(destino.categoria),
    estado_enriquecimiento: estadoEnriquecimiento,
    ...specs,
  };
}

/** Devuelve el id de una categoría (creándola si no existe), con cache en memoria para toda la importación. */
async function obtenerIdCategoria(db, nombre, cache) {
  if (cache.has(nombre)) return cache.get(nombre);
  const r = await db('SELECT id FROM categorias WHERE nombre = $1', [nombre]);
  if (r.rows.length > 0) {
    cache.set(nombre, r.rows[0].id);
    return r.rows[0].id;
  }
  const creado = await db('INSERT INTO categorias (nombre, es_componente_principal) VALUES ($1, $2) RETURNING id', [nombre, esCategoriaPrincipal(nombre)]);
  cache.set(nombre, creado.rows[0].id);
  return creado.rows[0].id;
}

/** Devuelve el id de una marca (upsert por nombre único), con cache en memoria. Null si el nombre viene vacío. */
async function obtenerIdMarca(db, nombre, cache) {
  const marca = String(nombre || '').trim();
  if (!marca) return null;
  const clave = marca.toLowerCase();
  if (cache.has(clave)) return cache.get(clave);

  const ins = await db(
    'INSERT INTO marcas (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id',
    [marca]
  );
  const id = ins.rows[0].id;
  cache.set(clave, id);
  return id;
}

/**
 * Inserta o actualiza la fila de specs tipadas del producto en la tabla specs_*
 * que corresponde a su categoría. Usa COALESCE para no pisar con null los valores
 * previamente cargados. El nombre de tabla proviene de un mapa cerrado (nunca del
 * input), evitando inyección SQL.
 * @param {Function} db - Helper de acceso a BD (ejecutarQuery o cliente transaccional).
 */
async function upsertSpecs(db, categoria, idProducto, registro) {
  const specsPorCategoria = {
    procesador: {
      tabla: 'specs_procesador',
      campos: {
        socket: registro.socket,
        arquitectura: registro.arquitectura,
        nucleos: registro.cpu_nucleos,
        hilos: registro.cpu_hilos,
        frecuencia_base_ghz: registro.cpu_frecuencia_base_ghz,
        frecuencia_boost_ghz: registro.cpu_frecuencia_boost_ghz,
        tdp_w: registro.cpu_tdp_w,
        graficos_integrados: registro.cpu_graficos_integrados,
      },
    },
    placa_madre: {
      tabla: 'specs_placa_madre',
      campos: {
        socket: registro.socket,
        chipset: registro.mb_chipset,
        form_factor: registro.mb_form_factor,
        ram_tipo: registro.mb_ram_tipo,
        max_ram_gb: registro.mb_max_ram_gb,
        slots_ram: registro.mb_slots_ram,
        m2_slots: registro.mb_m2_slots,
        pcie_version: registro.mb_pcie_version,
      },
    },
    ram: {
      tabla: 'specs_ram',
      campos: {
        ram_tipo: registro.ram_tipo,
        capacidad_gb: registro.ram_capacidad_gb,
        velocidad_mhz: registro.ram_velocidad_mhz,
        latencia: registro.ram_latencia,
        cantidad_modulos: registro.ram_cantidad_modulos,
      },
    },
    almacenamiento: {
      tabla: 'specs_almacenamiento',
      campos: {
        tipo_almacenamiento: registro.storage_tipo,
        capacidad_gb: registro.storage_capacidad_gb,
        interfaz: registro.storage_interfaz,
        form_factor: registro.storage_form_factor,
        nvme_gen: registro.storage_nvme_gen,
        velocidad_lectura_mbps: registro.storage_velocidad_lectura_mbps,
        velocidad_escritura_mbps: registro.storage_velocidad_escritura_mbps,
      },
    },
    gpu: {
      tabla: 'specs_gpu',
      campos: {
        chipset: registro.gpu_chipset,
        vram_gb: registro.gpu_vram_gb,
        vram_tipo: registro.gpu_vram_tipo,
        bus_bits: registro.gpu_bus_bits,
        boost_mhz: registro.gpu_boost_mhz,
        tdp_w: registro.gpu_tdp_w,
        longitud_mm: registro.gpu_longitud_mm,
        fuente_recomendada_w: registro.gpu_fuente_recomendada_w,
      },
    },
    fuente: {
      tabla: 'specs_fuente',
      campos: {
        wattage: registro.psu_wattage,
        certificacion: registro.psu_certificacion,
        modular: registro.psu_modular,
        form_factor: registro.psu_form_factor,
        pcie_conectores: registro.psu_pcie_conectores,
        sata_conectores: registro.psu_sata_conectores,
      },
    },
    case: {
      tabla: 'specs_case',
      campos: {
        form_factor: registro.case_form_factor,
        color: registro.case_color,
        panel_lateral: registro.case_panel_lateral,
        max_gpu_mm: registro.case_max_gpu_mm,
        max_cooler_mm: registro.case_max_cooler_mm,
        ventiladores_incluidos: registro.case_ventiladores_incluidos,
        compatibilidad_placa: registro.case_compatibilidad_placa,
      },
    },
  };

  const definicion = specsPorCategoria[categoria];
  if (!definicion) return;

  const columnas = Object.keys(definicion.campos);
  const valores = columnas.map((c) => definicion.campos[c] ?? null);
  const placeholders = columnas.map((_, i) => `$${i + 2}`);
  // Conserva el valor ya existente cuando la escritura trae null/undefined.
  // Esto evita que una actualización parcial de IA borre specs válidas detectadas desde CSV.
  const updates = columnas
    .map((c) => `${c} = COALESCE(EXCLUDED.${c}, ${definicion.tabla}.${c})`)
    .join(', ');

  await db(
    `INSERT INTO ${definicion.tabla} (id_producto, ${columnas.join(', ')})
     VALUES ($1, ${placeholders.join(', ')})
     ON CONFLICT (id_producto) DO UPDATE SET ${updates}`,
    [idProducto, ...valores]
  );
}

/**
 * Función principal de importación. Recorre las filas normalizadas y, por cada una,
 * inserta o actualiza el producto, sus specs y su ficha. Clasifica el resultado en
 * insertados / actualizados / omitidos / errores, y arma dos colas de post-proceso:
 * productos que necesitan enriquecimiento IA (specs faltantes) y componentes
 * completos por CSV que solo necesitan complemento de ficha técnica + imagen.
 * @param {Array<object>} filas - Filas crudas provenientes de parsearCSV.
 * @param {Function} db - Helper de acceso a BD.
 * @returns {Promise<object>} Resumen con contadores, detalle de errores y colas de enriquecimiento.
 */
async function importar(filas, db) {
  let insertados = 0;
  let actualizados = 0;
  let omitidos = 0;
  let errores = 0;
  const detalle_errores = [];
  // §5.3 — Acumular productos que necesitan enriquecimiento IA (Req 3.3, 4.1, 4.2)
  const itemsParaIA = [];
  // Componentes principales que llegaron completos del CSV ('csv'): no necesitan
  // enriquecer specs (el CSV es autoritativo), pero sí complementar con ficha
  // técnica + imagen (Icecat/Deltron) para mostrar en el cotizador.
  const itemsComplemento = [];

  const cacheCategorias = new Map();
  const cacheMarcas = new Map();

  for (const fila of filas) {
    // Req 1.11: omitir silenciosamente filas con codigo_proveedor vacío o solo espacios
    const codigoRaw = String(fila.codigo || '').trim();
    if (!codigoRaw) {
      omitidos++;
      continue;
    }

    // Req 1.10: registrar error para filas con precio_usd_raw no parseable como número positivo
    const precioValidacion = parsearPrecio(fila.precio_usd_raw);
    if (!Number.isFinite(precioValidacion) || precioValidacion <= 0) {
      errores++;
      detalle_errores.push({
        fila: fila._fila,
        mensaje: `precio_usd inválido: "${fila.precio_usd_raw}"`,
      });
      continue;
    }

    const registro = construirRegistroNormalizado(fila);
    if (!registro) {
      omitidos++;
      continue;
    }
    if (registro.error) {
      errores++;
      detalle_errores.push({ fila: fila._fila, mensaje: registro.error });
      continue;
    }

    try {
      const idCategoria = await obtenerIdCategoria(db, registro.categoria, cacheCategorias);
      const idMarca = await obtenerIdMarca(db, registro.marca, cacheMarcas);

      const upsertProducto = await db(
        `INSERT INTO productos (
          id_categoria, id_marca, subcategoria, categoria_proveedor, codigo_proveedor,
          nombre, descripcion_general, precio_base, stock, disponible_a_pedido,
          estado_enriquecimiento
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (codigo_proveedor) DO UPDATE SET
          id_categoria = EXCLUDED.id_categoria,
          id_marca = EXCLUDED.id_marca,
          subcategoria = EXCLUDED.subcategoria,
          categoria_proveedor = EXCLUDED.categoria_proveedor,
          nombre = EXCLUDED.nombre,
          descripcion_general = EXCLUDED.descripcion_general,
          precio_base = EXCLUDED.precio_base,
          stock = EXCLUDED.stock,
          disponible_a_pedido = EXCLUDED.disponible_a_pedido,
          estado_enriquecimiento = EXCLUDED.estado_enriquecimiento
        RETURNING id, (xmax = 0) AS es_insercion`,
        [
          idCategoria,
          idMarca,
          registro.subcategoria || null,
          registro.categoria_proveedor,
          registro.codigo_proveedor,
          registro.nombre,
          registro.descripcion_general || null,
          registro.precio_base,
          registro.stock,
          registro.disponible_a_pedido,
          registro.estado_enriquecimiento,
        ]
      );

      const idProducto = upsertProducto.rows[0].id;
      if (registro.es_componente_principal) {
        await upsertSpecs(db, registro.categoria, idProducto, registro);
      }

      // §5.3 — Si el producto quedó pendiente de enriquecimiento IA, acumularlo para encolar (Req 3.3, 4.2)
      if (registro.estado_enriquecimiento === 'pendiente') {
        itemsParaIA.push({
          id_producto: idProducto,
          categoria: registro.categoria,
          codigo_proveedor: registro.codigo_proveedor,
          marca: registro.marca,
          nombre: registro.nombre,
          descripcion_general: registro.descripcion_general,
          specs_faltantes: calcularSpecsFaltantes(registro.categoria, registro),
        });
      } else if (registro.estado_enriquecimiento === 'csv' && registro.es_componente_principal) {
        // Componente principal completo: complementar con ficha técnica + imagen
        // (Icecat/Deltron) sin tocar las columnas tipadas del CSV.
        itemsComplemento.push({
          id_producto: idProducto,
          categoria: registro.categoria,
          codigo_proveedor: registro.codigo_proveedor,
          marca: registro.marca,
          complemento: true,
        });
      }

      if (upsertProducto.rows[0].es_insercion) insertados++;
      else actualizados++;
    } catch (err) {
      errores++;
      detalle_errores.push({ fila: fila._fila, mensaje: err.message });
    }
  }

  // Encolar productos para enriquecimiento Icecat/Deltron al finalizar el loop
  // (sin bloquear la respuesta HTTP). Reemplaza el enriquecimiento por IA.
  // Los 'csv' principales se encolan en modo complemento (ficha + imagen, sin
  // tocar las columnas tipadas).
  if (itemsParaIA.length > 0 || itemsComplemento.length > 0) {
    try {
      const servicioEnriquecimiento = require('./servicioEnriquecimiento');
      if (itemsParaIA.length > 0) servicioEnriquecimiento.encolarProductos(itemsParaIA);
      if (itemsComplemento.length > 0) servicioEnriquecimiento.encolarProductos(itemsComplemento);
    } catch (err) {
      console.warn('[ImportacionCSV] servicioEnriquecimiento no disponible:', err.message);
    }
  }

  return {
    insertados,
    actualizados,
    omitidos,
    errores,
    detalle_errores,
    pendientes_enriquecimiento: itemsParaIA.length,
    pendientes_complemento: itemsComplemento.length,
  };
}

/**
 * Normaliza las filas crudas (sin escribir en BD) y las ordena por categoría,
 * subcategoría, marca y nombre. Se usa para la vista previa y la exportación del
 * CSV estructurado a partir de un CSV Deltron raw.
 */
function normalizarFilasParaCSV(filas) {
  const resultado = [];
  for (const fila of filas) {
    const registro = construirRegistroNormalizado(fila);
    if (!registro || registro.error) continue;
    resultado.push(registro);
  }

  return resultado.sort((a, b) => {
    const c = a.categoria.localeCompare(b.categoria, 'es');
    if (c !== 0) return c;
    const s = (a.subcategoria || '').localeCompare(b.subcategoria || '', 'es');
    if (s !== 0) return s;
    const m = (a.marca || '').localeCompare(b.marca || '', 'es');
    if (m !== 0) return m;
    return a.nombre.localeCompare(b.nombre, 'es');
  });
}

module.exports = {
  MAPA_CATEGORIAS,
  CAMPOS_REQUERIDOS,
  mapearCategoria,
  limpiarNombre,
  limpiarDescripcionGeneral,
  generarNombreComercial,
  parsearStock,
  parsearLineaCSV,
  parsearCSV,
  importar,
  normalizarFilasParaCSV,
  tieneSpecsFaltantes,
  calcularSpecsFaltantes,
  upsertSpecs,
  extraerSpecs,
  // §13.1 — exportadas para pruebas unitarias (tarea 2.4)
  esFilaSeparador,
  esFilaEncabezado,
  esFilaMetadata,
  // exportada para pruebas unitarias (tarea 4.4) y validación de checkpoint
  construirRegistroNormalizado,
};
