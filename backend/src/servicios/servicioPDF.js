const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const qrcode = require('qrcode');

const EMPRESA_NOMBRE = 'NSG Latinoamerica E.I.R.L.';
const EMPRESA_SUBTITULO = 'Soluciones en Tecnologia';

// Rutas candidatas en orden de prioridad (Req. 4)
const RUTAS_LOGO_CANDIDATAS = [
  path.resolve(__dirname, '../../../resources/logo vector-1.png'),
  path.resolve(__dirname, '../../assets/logo-nsg.png'),
  path.resolve(__dirname, '../../../frontend/public/favicon.png'),
  path.resolve(__dirname, '../../../frontend/dist/favicon.png'),
];

/**
 * Resuelve la ruta del logo iterando sobre las rutas candidatas.
 * Retorna la primera ruta que exista en el sistema de archivos.
 * Si ninguna existe, registra un warning y retorna null.
 * @returns {string|null}
 */
function resolverRutaLogo() {
  for (const ruta of RUTAS_LOGO_CANDIDATAS) {
    if (fs.existsSync(ruta)) {
      return ruta;
    }
  }
  console.warn('[ServicioPDF] Logo no encontrado en ninguna ruta candidata');
  return null;
}

/** Normaliza la moneda del documento a 'PEN' o 'USD' (por defecto 'USD'). */
function resolverMoneda(valor) {
  return String(valor || 'USD').toUpperCase() === 'PEN' ? 'PEN' : 'USD';
}

/** Selecciona el monto correspondiente a la moneda del documento (PEN o USD). */
function resolverMontoPorMoneda({ moneda, usd, pen }) {
  return moneda === 'PEN' ? Number(pen || 0) : Number(usd || 0);
}

/**
 * Obtiene el total en ambas monedas soportando dos formas de entrada:
 * `precioTotal` como número (USD, convertido a PEN con `tipoCambioUsdPen`)
 * o como objeto ya desglosado `{ usd, pen }`.
 * @returns {{usd: number, pen: number}}
 */
function normalizarMontoTotal(datos) {
  if (typeof datos?.precioTotal === 'number') {
    const totalUsd = Number(datos.precioTotal || 0);
    const tipoCambio = Number(datos?.tipoCambioUsdPen || 1);
    return {
      usd: totalUsd,
      pen: totalUsd * (Number.isFinite(tipoCambio) && tipoCambio > 0 ? tipoCambio : 1)
    };
  }

  return {
    usd: Number(datos?.precioTotal?.usd || 0),
    pen: Number(datos?.precioTotal?.pen || 0)
  };
}

function simboloMoneda(moneda) {
  return moneda === 'PEN' ? 'S/' : '$';
}

function formatearMoneda(valor, moneda) {
  return `${simboloMoneda(moneda)} ${Number(valor || 0).toFixed(2)}`;
}

function formatearFecha(fecha) {
  return new Date(fecha).toLocaleDateString('es-PE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatearCategoria(categoria) {
  const mapa = {
    // Armado PC
    procesador: 'Procesador',
    placa_madre: 'Placa Madre',
    ram: 'RAM',
    almacenamiento: 'Almacenamiento',
    gpu: 'GPU',
    fuente: 'Fuente',
    case: 'Case',
    // Extras
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
  return mapa[categoria] || categoria;
}

/**
 * Genera un código QR como data URL (base64 PNG) para el ticket dado.
 * Retorna null si la generación falla, para permitir degradación elegante.
 * @param {string} codigoTicket
 * @returns {Promise<string|null>}
 */
async function generarQRDataUrl(codigoTicket) {
  try {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const urlValidacion = `${baseUrl}/validar?ticket=${codigoTicket}`;
    return await qrcode.toDataURL(urlValidacion, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 120
    });
  } catch (error) {
    console.error('[ServicioPDF] Error al generar QR:', error);
    return null;
  }
}

/**
 * Servicio de generación de PDFs (cotización y listado técnico).
 *
 * Usa dos motores según el entorno:
 *   - Producción: @react-pdf/renderer (importado dinámicamente y cacheado) para
 *     un layout rico con estilos, tabla de componentes, total y código QR.
 *   - Tests (NODE_ENV=test): pdfkit, mucho más liviano y sin dependencias ESM,
 *     para evitar el costo de cargar react-pdf en la batería de pruebas.
 */
class ServicioPDF {
  constructor() {
    this.react = null;
    this.renderer = null;
    this.estilos = null;
  }

  /**
   * Carga de forma diferida (dynamic import) React y @react-pdf/renderer y
   * construye la hoja de estilos una sola vez. Idempotente: si ya están cargados,
   * retorna de inmediato. Necesario porque @react-pdf es un módulo ESM.
   */
  async cargarRenderer() {
    if (this.react && this.renderer && this.estilos) {
      return;
    }

    const reactModule = await import('react');
    const rendererModule = await import('@react-pdf/renderer');

    this.react = reactModule.default || reactModule;
    this.renderer = rendererModule;
    this.estilos = rendererModule.StyleSheet.create({
      pagina: {
        fontFamily: 'Helvetica',
        fontSize: 9,
        color: '#111827',
        paddingTop: 28,
        paddingHorizontal: 32,
        paddingBottom: 30,
        backgroundColor: '#FFFFFF'
      },
      cabecera: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 10
      },
      logo: {
        width: 96,
        height: 56,
        objectFit: 'contain'
      },
      cabeceraTexto: {
        textAlign: 'right'
      },
      empresa: {
        fontSize: 19,
        fontFamily: 'Helvetica-Bold'
      },
      subtitulo: {
        marginTop: 3,
        color: '#4B5563',
        fontSize: 10
      },
      separador: {
        marginTop: 6,
        marginBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#D1D5DB'
      },
      titulo: {
        fontSize: 15,
        fontFamily: 'Helvetica-Bold',
        textAlign: 'center',
        marginBottom: 8
      },
      metadatosWrap: {
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#E5E7EB',
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 10
      },
      metaFila: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 3,
        gap: 8
      },
      metaLabel: {
        color: '#4B5563',
        width: '38%'
      },
      metaValor: {
        width: '62%',
        textAlign: 'right',
        fontFamily: 'Helvetica-Bold'
      },
      ticketValor: {
        color: '#1D4ED8'
      },
      validezValor: {
        color: '#B91C1C'
      },
      tablaHeader: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: '#D1D5DB',
        borderTopWidth: 1,
        borderTopColor: '#D1D5DB',
        paddingVertical: 5,
        marginTop: 4
      },
      colCategoria: {
        width: '18%',
        fontFamily: 'Helvetica-Bold',
        fontSize: 8.4
      },
      colProducto: {
        width: '43%',
        fontFamily: 'Helvetica-Bold',
        fontSize: 8.4
      },
      colDisponibilidad: {
        width: '19%',
        fontFamily: 'Helvetica-Bold',
        fontSize: 8.4
      },
      colPrecio: {
        width: '20%',
        textAlign: 'right',
        fontFamily: 'Helvetica-Bold',
        fontSize: 8.4
      },
      fila: {
        flexDirection: 'row',
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderBottomColor: '#EEF0F3'
      },
      filaPar: {
        backgroundColor: '#F8FAFC'
      },
      textoProducto: {
        width: '43%',
        paddingRight: 8
      },
      textoCategoria: {
        width: '18%',
        paddingRight: 6
      },
      textoDisponibilidad: {
        width: '19%'
      },
      textoPrecio: {
        width: '20%',
        textAlign: 'right'
      },
      disponibilidadStock: {
        color: '#15803D',
        fontFamily: 'Helvetica-Bold'
      },
      disponibilidadPedido: {
        color: '#C2410C',
        fontFamily: 'Helvetica-Bold'
      },
      totalWrap: {
        marginTop: 12,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#D1D5DB',
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 10
      },
      totalFila: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
      },
      totalLabel: {
        fontFamily: 'Helvetica-Bold',
        fontSize: 11
      },
      totalValor: {
        fontFamily: 'Helvetica-Bold',
        fontSize: 15,
        color: '#047857'
      },
      totalReferencia: {
        marginTop: 4,
        textAlign: 'right',
        color: '#4B5563',
        fontSize: 8
      },
      notaWrap: {
        borderWidth: 1,
        borderColor: '#E5E7EB',
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 10
      },
      notaTitulo: {
        fontFamily: 'Helvetica-Bold',
        marginBottom: 4
      },
      notaItem: {
        marginBottom: 2.5
      },
      pie: {
        marginTop: 10,
        textAlign: 'center',
        color: '#4B5563',
        fontSize: 8
      },
      politicaWrap: {
        marginTop: 8,
        borderWidth: 1,
        borderColor: '#FEF3C7',
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 10,
        backgroundColor: '#FFFBEB'
      },
      politicaTexto: {
        textAlign: 'center',
        color: '#92400E',
        fontSize: 7,
        lineHeight: 1.4
      },
      referenciaMoneda: {
        textAlign: 'center',
        marginTop: 2,
        color: '#4B5563',
        fontSize: 8
      },
      qrWrap: {
        marginTop: 10,
        alignItems: 'center'
      },
      qrImagen: {
        width: 80,
        height: 80
      },
      qrLabel: {
        marginTop: 3,
        textAlign: 'center',
        color: '#4B5563',
        fontSize: 7
      }
    });
  }

  obtenerRutaLogo() {
    return resolverRutaLogo();
  }

  /**
   * Devuelve el logo como objeto { data: Buffer, format } para @react-pdf.
   * Pasar un Buffer (en vez de una ruta) evita que @react-pdf intente
   * "fetchear" la ruta como URL y falle silenciosamente (recuadro vacío).
   * @returns {{data: Buffer, format: string}|null}
   */
  obtenerLogoImagen() {
    const ruta = resolverRutaLogo();
    if (!ruta) return null;
    try {
      const data = fs.readFileSync(ruta);
      const format = ruta.toLowerCase().endsWith('.jpg') || ruta.toLowerCase().endsWith('.jpeg') ? 'jpg' : 'png';
      return { data, format };
    } catch (error) {
      console.warn('[ServicioPDF] No se pudo leer el logo:', error.message);
      return null;
    }
  }

  /**
   * Construye una fila (View) de la tabla de componentes para react-pdf, con
   * categoría, nombre, disponibilidad (stock / a pedido / no disponible) y,
   * opcionalmente, el precio. Aplica fondo alternado en las filas pares.
   */
  renderFilaComponente(comp, index, incluirPrecios, moneda) {
    const h = this.react.createElement;
    const estilos = this.estilos;
    const disponibilidad = comp.stock > 0
      ? 'En stock'
      : comp.disponibleAPedido
        ? `A pedido (${comp.tiempoEntregaDias}d)`
        : 'No disponible';
    const montoUsd = Number(comp.precioBaseUsd ?? comp.precioBase ?? 0);
    const montoPen = Number(comp.precioBasePen ?? comp.precioBase ?? 0);
    const monto = resolverMontoPorMoneda({
      moneda,
      usd: montoUsd,
      pen: montoPen
    });

    return h(
      this.renderer.View,
      {
        key: `${comp.nombre}-${index}`,
        style: [estilos.fila, index % 2 === 0 ? estilos.filaPar : null]
      },
      h(this.renderer.Text, { style: estilos.textoCategoria }, formatearCategoria(comp.categoria)),
      h(this.renderer.Text, { style: estilos.textoProducto }, comp.nombre),
      h(
        this.renderer.Text,
        {
          style: [
            estilos.textoDisponibilidad,
            comp.stock > 0 ? estilos.disponibilidadStock : estilos.disponibilidadPedido
          ]
        },
        disponibilidad
      ),
      incluirPrecios
        ? h(this.renderer.Text, { style: estilos.textoPrecio }, formatearMoneda(monto, moneda))
        : null
    );
  }

  /**
   * Arma el árbol de elementos react-pdf de la cotización completa: cabecera con
   * logo, metadatos (ticket, UUID, emisión/caducidad, moneda y TC), tabla de
   * componentes, total con referencia en la otra moneda, instrucciones de reclamo,
   * política de precios y, si se provee, el código QR de validación.
   */
  construirDocumentoCotizacion(datos, moneda, qrDataUrl = null) {
    const h = this.react.createElement;
    const { Document, Page, Text, View, Image } = this.renderer;
    const estilos = this.estilos;
    const logoImagen = this.obtenerLogoImagen();
    const totalNormalizado = normalizarMontoTotal(datos);
    const total = resolverMontoPorMoneda({
      moneda,
      usd: totalNormalizado.usd,
      pen: totalNormalizado.pen
    });
    // Una cotización confirmada ya no caduca: se omite la fila de caducidad.
    const estaConfirmada = String(datos.estado || '').toLowerCase() === 'confirmada';

    return h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', style: estilos.pagina },
        h(
          View,
          { style: estilos.cabecera },
          logoImagen ? h(Image, { src: logoImagen, style: estilos.logo }) : h(View, { style: estilos.logo }),
          h(
            View,
            { style: estilos.cabeceraTexto },
            h(Text, { style: estilos.empresa }, EMPRESA_NOMBRE),
            h(Text, { style: estilos.subtitulo }, EMPRESA_SUBTITULO)
          )
        ),
        h(View, { style: estilos.separador }),
        h(Text, { style: estilos.titulo }, 'COTIZACION DE COMPUTADORA'),
        h(
          View,
          { style: estilos.metadatosWrap },
          h(View, { style: estilos.metaFila }, h(Text, { style: estilos.metaLabel }, 'Codigo de Ticket'), h(Text, { style: [estilos.metaValor, estilos.ticketValor] }, datos.codigoTicket)),
          h(View, { style: estilos.metaFila }, h(Text, { style: estilos.metaLabel }, 'UUID'), h(Text, { style: estilos.metaValor }, datos.codigoUnico)),
          h(View, { style: estilos.metaFila }, h(Text, { style: estilos.metaLabel }, 'Emision'), h(Text, { style: estilos.metaValor }, formatearFecha(datos.fechaEmision))),
          estaConfirmada ? null : h(View, { style: estilos.metaFila }, h(Text, { style: estilos.metaLabel }, 'Caducidad'), h(Text, { style: [estilos.metaValor, estilos.validezValor] }, formatearFecha(datos.fechaValidez))),
          h(View, { style: estilos.metaFila }, h(Text, { style: estilos.metaLabel }, 'Moneda documento'), h(Text, { style: estilos.metaValor }, `${moneda} (TC ${Number(datos.tipoCambioUsdPen || 1).toFixed(4)})`))
        ),
        h(
          View,
          { style: estilos.tablaHeader },
          h(Text, { style: estilos.colCategoria }, 'Categoria'),
          h(Text, { style: estilos.colProducto }, 'Producto'),
          h(Text, { style: estilos.colDisponibilidad }, 'Disponibilidad'),
          h(Text, { style: estilos.colPrecio }, 'Precio')
        ),
        ...datos.componentes.map((comp, index) => this.renderFilaComponente(comp, index, true, moneda)),
        h(
          View,
          { style: estilos.totalWrap },
          h(View, { style: estilos.totalFila }, h(Text, { style: estilos.totalLabel }, 'PRECIO TOTAL'), h(Text, { style: estilos.totalValor }, formatearMoneda(total, moneda)))
        ),
        h(
          View,
          { style: estilos.notaWrap },
          h(Text, { style: estilos.notaTitulo }, 'COMO RECLAMAR'),
          h(Text, { style: estilos.notaItem }, `1. Visita nuestra tienda con el ticket ${datos.codigoTicket}.`),
          h(Text, { style: estilos.notaItem }, '2. Validaremos disponibilidad y precio vigente.'),
          h(Text, { style: estilos.notaItem }, '3. Los componentes a pedido se confirman al cerrar venta.')
        ),
        h(
          View,
          { style: estilos.politicaWrap },
          h(Text, { style: estilos.politicaTexto }, '* Los precios mostrados no incluyen los impuestos aplicables. Los precios están sujetos a cambios a discreción de NSG Latinoamerica E.I.R.L. según disponibilidad y condiciones del mercado.')
        ),
        h(Text, { style: estilos.pie }, 'Precio sujeto a cambios por disponibilidad.'),
        qrDataUrl
          ? h(
              View,
              { style: estilos.qrWrap },
              h(Image, { src: qrDataUrl, style: estilos.qrImagen }),
              h(Text, { style: estilos.qrLabel }, 'Escanea para validar esta cotizacion')
            )
          : null
      )
    );
  }

  /**
   * Arma el árbol react-pdf del listado técnico: mismo encabezado pero sin precios
   * ni total, pensado como documento de referencia técnica interna.
   */
  construirDocumentoListado(codigoTicket, componentes) {
    const h = this.react.createElement;
    const { Document, Page, Text, View, Image } = this.renderer;
    const estilos = this.estilos;
    const logoImagen = this.obtenerLogoImagen();

    return h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', style: estilos.pagina },
        h(
          View,
          { style: estilos.cabecera },
          logoImagen ? h(Image, { src: logoImagen, style: estilos.logo }) : h(View, { style: estilos.logo }),
          h(
            View,
            { style: estilos.cabeceraTexto },
            h(Text, { style: estilos.empresa }, EMPRESA_NOMBRE),
            h(Text, { style: estilos.subtitulo }, EMPRESA_SUBTITULO)
          )
        ),
        h(View, { style: estilos.separador }),
        h(Text, { style: estilos.titulo }, 'LISTADO TECNICO DE COMPONENTES'),
        h(Text, { style: estilos.referenciaMoneda }, `Ticket de referencia: ${codigoTicket}`),
        h(
          View,
          { style: estilos.tablaHeader },
          h(Text, { style: estilos.colCategoria }, 'Categoria'),
          h(Text, { style: estilos.colProducto }, 'Producto'),
          h(Text, { style: estilos.colDisponibilidad }, 'Disponibilidad')
        ),
        ...componentes.map((comp, index) => this.renderFilaComponente(comp, index, false, 'USD')),
        h(Text, { style: estilos.pie }, 'Documento de referencia tecnica sin valores comerciales.')
      )
    );
  }

  /**
   * Renderiza un documento react-pdf a un Buffer. Soporta tanto la API que
   * devuelve el Buffer directamente como la que devuelve un stream (acumula chunks).
   * @returns {Promise<Buffer>}
   */
  async renderBuffer(documento) {
    const instancia = this.renderer.pdf(documento);
    const salida = await instancia.toBuffer();

    if (Buffer.isBuffer(salida)) {
      return salida;
    }

    const chunks = [];
    return new Promise((resolve, reject) => {
      salida.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      salida.on('end', () => resolve(Buffer.concat(chunks)));
      salida.on('error', reject);
    });
  }

  /**
   * Punto de entrada para generar el PDF de una cotización.
   * En entorno de test usa el motor pdfkit; en el resto, react-pdf con QR.
   * @param {object} datos - Debe incluir codigoTicket y el arreglo componentes.
   * @param {object} [opciones] - { moneda } del documento.
   * @returns {Promise<Buffer>} PDF listo para enviar/descargar.
   * @throws {Error} Si faltan datos obligatorios.
   */
  async generarPDFCotizacion(datos, opciones = {}) {
    if (!datos?.codigoTicket || !Array.isArray(datos.componentes)) {
      throw new Error('Datos de cotizacion incompletos para generar PDF');
    }
    if (process.env.NODE_ENV === 'test') {
      return this.generarPdfKitCotizacion(datos, opciones);
    }

    await this.cargarRenderer();

    const moneda = resolverMoneda(opciones.moneda);
    const qrDataUrl = await generarQRDataUrl(datos.codigoTicket);
    const documento = this.construirDocumentoCotizacion(datos, moneda, qrDataUrl);
    return this.renderBuffer(documento);
  }

  /**
   * Punto de entrada para generar el PDF del listado técnico (sin precios).
   * En test usa pdfkit; en el resto, react-pdf.
   * @returns {Promise<Buffer>}
   * @throws {Error} Si faltan datos obligatorios.
   */
  async generarPDFListado(codigoTicket, componentes, opciones = {}) {
    if (!codigoTicket || !Array.isArray(componentes)) {
      throw new Error('Datos de listado tecnico incompletos para generar PDF');
    }
    if (process.env.NODE_ENV === 'test') {
      return this.generarPdfKitListado(codigoTicket, componentes, opciones);
    }

    await this.cargarRenderer();

    resolverMoneda(opciones.moneda);
    const documento = this.construirDocumentoListado(codigoTicket, componentes);
    return this.renderBuffer(documento);
  }

  /**
   * Motor alternativo (pdfkit) para la cotización, usado en tests.
   * Produce un PDF simplificado equivalente, incluyendo el QR de validación.
   * @returns {Promise<Buffer>}
   */
  async generarPdfKitCotizacion(datos, opciones = {}) {
    const moneda = resolverMoneda(opciones.moneda);
    const totalNormalizado = normalizarMontoTotal(datos);
    const total = resolverMontoPorMoneda({ moneda, usd: totalNormalizado.usd, pen: totalNormalizado.pen });

    // Generar QR con degradación elegante
    const qrDataUrl = await generarQRDataUrl(datos.codigoTicket);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(16).text('COTIZACION DE COMPUTADORA', { align: 'center' });
      doc.moveDown();
      doc.font('Helvetica').fontSize(10).text(`Ticket: ${datos.codigoTicket}`);
      doc.text(`UUID: ${datos.codigoUnico}`);
      doc.text(`Emision: ${formatearFecha(datos.fechaEmision)}`);
      // Una cotización confirmada ya no caduca: se omite la caducidad.
      if (String(datos.estado || '').toLowerCase() !== 'confirmada') {
        doc.text(`Caducidad: ${formatearFecha(datos.fechaValidez)}`);
      }
      doc.text(`Moneda: ${moneda}`);
      doc.moveDown();

      datos.componentes.forEach((comp) => {
        const monto = resolverMontoPorMoneda({
          moneda,
          usd: comp.precioBaseUsd ?? comp.precioBase,
          pen: comp.precioBasePen
        });
        doc.font('Helvetica').fontSize(9).text(`${formatearCategoria(comp.categoria)} | ${comp.nombre} | ${formatearMoneda(monto, moneda)}`);
      });

      doc.moveDown();
      doc.font('Helvetica-Bold').fontSize(12).text(`TOTAL: ${formatearMoneda(total, moneda)}`, { align: 'right' });

      // Insertar QR si está disponible (mínimo 80×80 puntos según Req. 9.4)
      if (qrDataUrl) {
        doc.moveDown();
        const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
        doc.image(qrBuffer, { width: 80, height: 80, align: 'center' });
        doc.font('Helvetica').fontSize(7).text('Escanea para validar esta cotizacion', { align: 'center' });
      }

      doc.end();
    });
  }

  /** Motor alternativo (pdfkit) para el listado técnico, usado en tests. */
  async generarPdfKitListado(codigoTicket, componentes) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(16).text('LISTADO TECNICO DE COMPONENTES', { align: 'center' });
      doc.moveDown();
      doc.font('Helvetica').fontSize(10).text(`Ticket: ${codigoTicket}`);
      doc.moveDown();

      componentes.forEach((comp) => {
        doc.font('Helvetica').fontSize(9).text(`${formatearCategoria(comp.categoria)} | ${comp.nombre}`);
      });

      doc.end();
    });
  }

  formatearFecha(fecha) {
    return formatearFecha(fecha);
  }

  formatearCategoria(categoria) {
    return formatearCategoria(categoria);
  }
}

module.exports = new ServicioPDF();
