/**
 * Utilidades de detección de intención (determinísticas, sin IA).
 * - Gate de scope: detecta temas comerciales/negociación fuera del alcance del
 *   asistente (que solo arma/cotiza PCs) para derivar a un asesor humano.
 * - Confirmación de cotizar: detecta cuando el usuario quiere ver la configuración.
 */

function normalizar(mensaje) {
  return String(mensaje || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Temas comerciales que el asistente NO maneja: derivan a asesor humano (WhatsApp).
const KEYWORDS_NEGOCIACION = [
  'descuento', 'descuentos', 'rebaja', 'rebajar', 'oferta', 'promocion', 'cupon',
  'financiamiento', 'financiar', 'cuotas', 'credito', 'a credito', 'pago en cuotas',
  'garantia', 'devolucion', 'reembolso', 'factura', 'boleta', 'ruc',
  'precio especial', 'mejor precio', 'me lo dejas', 'rebajame', 'regateo', 'negociar',
  'delivery', 'envio', 'tiempo de entrega', 'metodo de pago',
];

// Confirmaciones / pedidos explícitos de ver la configuración armada.
const KEYWORDS_COTIZAR = [
  'ver mi configuracion', 'ver configuracion', 'mostrar configuracion', 'mostrar propuesta',
  'ver propuesta', 'armar pc', 'arma la pc', 'arma una pc', 'armame', 'armala', 'arma mi',
  'cotizar', 'cotizacion', 'ver config', 'ver mi pc', 'generar configuracion',
  'pasemos a ver', 'pasar a ver', 'vamos a verla', 'quiero verla', 'muestrame', 'muestramela',
  'ver la configuracion', 'recomiendame', 'que me recomiendas', 'recomendacion',
  'dame la configuracion', 'dame la config', 'dame mi configuracion', 'dame una configuracion',
  'quiero la configuracion', 'la configuracion', 'mi configuracion',
];

// Afirmaciones cortas tras el checkpoint ("¿pasamos a ver la configuración?").
const AFIRMACIONES = [
  'si', 'sip', 'sii', 'dale', 'ok', 'oka', 'okay', 'listo', 'vamos', 'de una',
  'obvio', 'perfecto', 'claro', 'hagamoslo', 'adelante', 'ya', 'va',
];

function contienePalabra(texto, frase) {
  // Coincidencia por límites de palabra para frases de una sola palabra,
  // includes para frases multi-palabra.
  if (frase.includes(' ')) return texto.includes(frase);
  const re = new RegExp(`(^|\\s)${frase}($|\\s|[.,!?])`);
  return re.test(texto);
}

function detectarNegociacion(mensaje) {
  const t = normalizar(mensaje);
  return KEYWORDS_NEGOCIACION.some((kw) => contienePalabra(t, kw));
}

function detectarIntencionCotizar(mensaje) {
  const t = normalizar(mensaje);
  if (KEYWORDS_COTIZAR.some((kw) => contienePalabra(t, kw))) return true;
  // Afirmaciones cortas solo cuentan si el mensaje es breve (respuesta al checkpoint).
  if (t.split(/\s+/).length <= 3 && AFIRMACIONES.some((kw) => contienePalabra(t, kw))) return true;
  return false;
}

module.exports = {
  normalizar,
  detectarNegociacion,
  detectarIntencionCotizar,
  KEYWORDS_NEGOCIACION,
  KEYWORDS_COTIZAR,
};
