/**
 * Servicio de Exportación a Excel
 *
 * Genera archivos .xlsx a partir de los datos de una cotización.
 * Usa la librería `xlsx` (SheetJS) para construir el workbook.
 *
 * Estructura del archivo generado:
 *   Hoja 1 "Componentes" — nombre, categoría, precio unitario, cantidad, subtotal
 *   Hoja 2 "Metadatos"   — empresa, fecha de generación, estado
 *
 * Requisitos: 6.1–6.8
 */

const XLSX = require('xlsx');

/**
 * Formatea un valor de fecha a string legible (DD/MM/YYYY HH:MM).
 * @param {string|Date|null} fecha
 * @returns {string}
 */
function formatearFecha(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha);
  if (isNaN(d.getTime())) return String(fecha);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Formatea categoría de componente a texto legible.
 * @param {string} categoria
 * @returns {string}
 */
function formatearCategoria(categoria) {
  const mapa = {
    procesador: 'Procesador',
    placa_madre: 'Placa Madre',
    ram: 'RAM',
    almacenamiento: 'Almacenamiento',
    gpu: 'GPU',
    fuente: 'Fuente',
    case: 'Case',
    mouse: 'Mouse',
    teclado: 'Teclado',
    webcam: 'Webcam',
    auricular: 'Auricular',
    parlante: 'Parlante',
    software_windows: 'Windows',
    software_office: 'Office',
    software_antivirus: 'Antivirus',
    almacenamiento_externo: 'Almac. Externo',
    ups: 'UPS',
    estabilizador: 'Estabilizador',
    monitor: 'Monitor',
    cooler_aire: 'Cooler Aire',
    cooler_liquido: 'Cooler Líquido',
    conectividad: 'Conectividad',
    mousepad: 'Mousepad',
  };
  return mapa[categoria] || String(categoria || '');
}

/**
 * Aplica estilo de encabezado a una celda (fondo #0F172A, texto blanco, negrita, 11pt).
 * @param {Object} celda - Objeto de celda SheetJS
 * @returns {Object} Celda con estilo aplicado
 */
function aplicarEstiloEncabezado(celda) {
  celda.s = {
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    fill: { patternType: 'solid', fgColor: { rgb: '0F172A' } },
    border: {
      top:    { style: 'thin', color: { rgb: '0F172A' } },
      bottom: { style: 'thin', color: { rgb: '0F172A' } },
      left:   { style: 'thin', color: { rgb: '0F172A' } },
      right:  { style: 'thin', color: { rgb: '0F172A' } },
    },
    alignment: { vertical: 'center', horizontal: 'center', wrapText: false },
  };
  return celda;
}

/**
 * Aplica estilo de fila de datos a una celda.
 * @param {Object} celda - Objeto de celda SheetJS
 * @param {boolean} [esNumero=false] - Si la celda contiene un número de precio
 * @returns {Object} Celda con estilo aplicado
 */
function aplicarEstiloDatos(celda, esNumero = false) {
  celda.s = {
    border: {
      top:    { style: 'thin', color: { rgb: 'E2E8F0' } },
      bottom: { style: 'thin', color: { rgb: 'E2E8F0' } },
      left:   { style: 'thin', color: { rgb: 'E2E8F0' } },
      right:  { style: 'thin', color: { rgb: 'E2E8F0' } },
    },
    alignment: { vertical: 'center', wrapText: false },
  };
  if (esNumero) {
    celda.z = '"$"#,##0.00';
  }
  return celda;
}

/**
 * Aplica estilo de fila de totales a una celda.
 * @param {Object} celda - Objeto de celda SheetJS
 * @param {boolean} [esNumero=false] - Si la celda contiene un número de precio
 * @returns {Object} Celda con estilo aplicado
 */
function aplicarEstiloTotal(celda, esNumero = false) {
  celda.s = {
    font: { bold: true },
    fill: { patternType: 'solid', fgColor: { rgb: 'F1F5F9' } },
    border: {
      top:    { style: 'medium', color: { rgb: '94A3B8' } },
      bottom: { style: 'medium', color: { rgb: '94A3B8' } },
      left:   { style: 'thin',   color: { rgb: '94A3B8' } },
      right:  { style: 'thin',   color: { rgb: '94A3B8' } },
    },
    alignment: { vertical: 'center', wrapText: false },
  };
  if (esNumero) {
    celda.z = '"$"#,##0.00';
  }
  return celda;
}

/**
 * Convierte una dirección de celda (ej. "A1") a objeto de celda en la hoja.
 * Si no existe, la crea con valor vacío.
 * @param {Object} hoja - Hoja SheetJS
 * @param {string} addr - Dirección de celda (ej. "A1")
 * @returns {Object} Objeto de celda
 */
function obtenerOCrearCelda(hoja, addr) {
  if (!hoja[addr]) {
    hoja[addr] = { t: 's', v: '' };
  }
  return hoja[addr];
}

/**
 * Genera un archivo Excel (.xlsx) con los datos de una cotización.
 * Aplica estilos profesionales: cabeceras destacadas, anchos de columna,
 * formato de moneda, fila de totales y hoja de metadatos.
 *
 * @param {Object} cotizacion - Objeto de cotización con la siguiente forma:
 *   {
 *     codigo_ticket: string,
 *     fecha_emision: string|Date,
 *     fecha_validez: string|Date,
 *     precio_total: number,          // total con IGV en USD
 *     estado: string,
 *     componentes: Array<{
 *       nombre: string,
 *       categoria: string,
 *       precio_unitario: number,     // precio unitario total USD
 *       cantidad: number
 *     }>
 *   }
 * @returns {Buffer} Buffer con el contenido del archivo .xlsx
 */
function generarExcelCotizacion(cotizacion) {
  if (!cotizacion || typeof cotizacion !== 'object') {
    throw new Error('Se requiere un objeto de cotización válido');
  }

  const {
    codigo_ticket = '',
    fecha_emision = null,
    fecha_validez = null,
    precio_total = 0,
    estado = '',
    componentes = []
  } = cotizacion;

  // ── Hoja 1: Componentes ────────────────────────────────────────────────────

  // Encabezados
  const encabezados = ['Componente', 'Categoría', 'Precio Unitario', 'Cantidad', 'Subtotal'];

  // Filas de datos
  const filasComponentes = Array.isArray(componentes)
    ? componentes.map((comp) => {
        const precioUnitario = Number(comp.precio_unitario || comp.precio_unitario_total_usd || 0);
        const cantidad = Number(comp.cantidad || 1);
        const subtotal = precioUnitario * cantidad;
        return [
          String(comp.nombre || ''),
          formatearCategoria(comp.categoria),
          precioUnitario,
          cantidad,
          subtotal,
        ];
      })
    : [];

  // Fila de totales
  const totalGeneral = filasComponentes.reduce((acc, fila) => acc + (fila[4] || 0), 0);
  const filaTotal = ['TOTAL', '', '', '', totalGeneral];

  const datosComponentes = [encabezados, ...filasComponentes, filaTotal];

  const hojaComponentes = XLSX.utils.aoa_to_sheet(datosComponentes);

  // Anchos de columna (Req. 6.2)
  hojaComponentes['!cols'] = [
    { wch: 40 }, // Componente
    { wch: 20 }, // Categoría
    { wch: 18 }, // Precio Unitario
    { wch: 10 }, // Cantidad
    { wch: 18 }, // Subtotal
  ];

  // Aplicar estilos a encabezados (fila 1)
  ['A1', 'B1', 'C1', 'D1', 'E1'].forEach((addr) => {
    aplicarEstiloEncabezado(obtenerOCrearCelda(hojaComponentes, addr));
  });

  // Aplicar estilos a filas de datos
  const totalFilasDatos = filasComponentes.length;
  for (let i = 0; i < totalFilasDatos; i++) {
    const fila = i + 2; // fila 2 en adelante (1-indexed)
    aplicarEstiloDatos(obtenerOCrearCelda(hojaComponentes, `A${fila}`));
    aplicarEstiloDatos(obtenerOCrearCelda(hojaComponentes, `B${fila}`));
    aplicarEstiloDatos(obtenerOCrearCelda(hojaComponentes, `C${fila}`), true); // precio
    aplicarEstiloDatos(obtenerOCrearCelda(hojaComponentes, `D${fila}`));
    aplicarEstiloDatos(obtenerOCrearCelda(hojaComponentes, `E${fila}`), true); // subtotal
  }

  // Aplicar estilos a fila de totales
  const filaTotal1Indexed = totalFilasDatos + 2;
  aplicarEstiloTotal(obtenerOCrearCelda(hojaComponentes, `A${filaTotal1Indexed}`));
  aplicarEstiloTotal(obtenerOCrearCelda(hojaComponentes, `B${filaTotal1Indexed}`));
  aplicarEstiloTotal(obtenerOCrearCelda(hojaComponentes, `C${filaTotal1Indexed}`));
  aplicarEstiloTotal(obtenerOCrearCelda(hojaComponentes, `D${filaTotal1Indexed}`));
  aplicarEstiloTotal(obtenerOCrearCelda(hojaComponentes, `E${filaTotal1Indexed}`), true); // total con formato moneda

  // ── Hoja 2: Metadatos ──────────────────────────────────────────────────────
  const fechaGeneracion = new Date().toLocaleDateString('es-PE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const datosMetadatos = [
    ['Campo', 'Valor'],
    ['Empresa', 'NSG Cotizador'],
    ['Código Ticket', codigo_ticket],
    ['Fecha de Emisión', formatearFecha(fecha_emision)],
    ['Fecha de Validez', formatearFecha(fecha_validez)],
    ['Estado', estado],
    ['Fecha de Generación', fechaGeneracion],
    ['Precio Total (USD)', Number(precio_total)],
  ];

  const hojaMetadatos = XLSX.utils.aoa_to_sheet(datosMetadatos);

  // Anchos de columna para metadatos
  hojaMetadatos['!cols'] = [{ wch: 22 }, { wch: 35 }];

  // Aplicar estilos a encabezados de metadatos
  ['A1', 'B1'].forEach((addr) => {
    aplicarEstiloEncabezado(obtenerOCrearCelda(hojaMetadatos, addr));
  });

  // Aplicar bordes a filas de datos de metadatos
  for (let i = 2; i <= datosMetadatos.length; i++) {
    aplicarEstiloDatos(obtenerOCrearCelda(hojaMetadatos, `A${i}`));
    const celdaValor = obtenerOCrearCelda(hojaMetadatos, `B${i}`);
    // Precio total en metadatos también con formato moneda
    const esFilaPrecio = i === datosMetadatos.length;
    aplicarEstiloDatos(celdaValor, esFilaPrecio);
  }

  // ── Workbook ───────────────────────────────────────────────────────────────
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, hojaComponentes, 'Componentes');
  XLSX.utils.book_append_sheet(workbook, hojaMetadatos, 'Metadatos');

  // Generar buffer en formato .xlsx con soporte de estilos de celda
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

  return buffer;
}

module.exports = { generarExcelCotizacion };
