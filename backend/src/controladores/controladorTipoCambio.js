/**
 * Controlador: Proxy de tipo de cambio automático
 *
 * Actúa como intermediario hacia api.decolecta.com para obtener el tipo de
 * cambio USD/PEN publicado por SUNAT. El token de autenticación se lee
 * exclusivamente desde la variable de entorno APIS_NET_TOKEN y nunca se
 * expone en ninguna respuesta al cliente.
 *
 * Requisitos: 2.2, 2.3, 2.4, 2.5, 10.1, 10.2
 */

const URL_API_EXTERNA = 'https://api.decolecta.com/v1/tipo-cambio/sunat';

/**
 * GET /api/tipo-cambio/automatico
 *
 * Obtiene el tipo de cambio vigente desde la API externa de decolecta.com.
 * Requiere autenticación JWT (aplicada por el middleware verificarToken en la ruta).
 *
 * Respuesta exitosa (200):
 *   { exito: true, tipo_cambio: number, fuente: "automatico", fecha: string }
 *
 * Errores posibles:
 *   503 — APIS_NET_TOKEN no configurado en el servidor
 *   502 — API externa no responde o retorna error HTTP
 *   422 — Valor de tipo de cambio inválido (≤ 0 o no numérico)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
async function obtenerTipoCambioAutomatico(req, res) {
  // 1. Verificar que el token de la API externa esté configurado
  const token = process.env.APIS_NET_TOKEN;

  if (!token) {
    console.warn('[ADVERTENCIA] APIS_NET_TOKEN no está definido. El modo automático de tipo de cambio no estará disponible.');
    return res.status(503).json({
      error: 'Servicio no disponible',
      mensaje: 'El modo automático no está configurado en el servidor'
    });
  }

  // 2. Llamar a la API externa — token como query param según documentación de decolecta.com
  const urlConToken = `${URL_API_EXTERNA}?token=${token}`;
  let respuestaExterna;
  try {
    respuestaExterna = await fetch(urlConToken, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000) // 10 segundos de timeout
    });
  } catch (errorRed) {
    console.error('[TipoCambio] Error de red al contactar API externa:', errorRed.message);
    return res.status(502).json({
      error: 'Error de gateway',
      mensaje: 'No se pudo obtener el tipo de cambio de la API externa'
    });
  }

  // 3. Verificar que la API externa respondió con éxito
  if (!respuestaExterna.ok) {
    console.error(`[TipoCambio] API externa retornó error HTTP ${respuestaExterna.status}`);
    return res.status(502).json({
      error: 'Error de gateway',
      mensaje: `La API externa retornó un error: ${respuestaExterna.status}`
    });
  }

  // 4. Parsear la respuesta
  let datos;
  try {
    datos = await respuestaExterna.json();
  } catch (errorParseo) {
    console.error('[TipoCambio] Error al parsear respuesta de API externa:', errorParseo.message);
    return res.status(502).json({
      error: 'Error de gateway',
      mensaje: 'No se pudo obtener el tipo de cambio de la API externa'
    });
  }

  // 5. La API retorna un objeto único { buy_price, sell_price, base_currency, quote_currency, date }
  //    o un array; manejar ambos casos
  const registro = Array.isArray(datos) ? datos[datos.length - 1] : datos;

  if (!registro || typeof registro !== 'object') {
    console.error('[TipoCambio] La API externa retornó una respuesta vacía o con formato inesperado:', datos);
    return res.status(502).json({
      error: 'Error de gateway',
      mensaje: 'No se pudo obtener el tipo de cambio de la API externa'
    });
  }

  // 6. El campo de venta es "sell_price" según la documentación de decolecta.com
  const valorVenta = Number(registro?.sell_price ?? registro?.venta);
  if (!Number.isFinite(valorVenta) || valorVenta <= 0) {
    console.error('[TipoCambio] Valor de tipo de cambio inválido recibido de la API externa:', registro);
    return res.status(422).json({
      error: 'Valor inválido',
      mensaje: 'El tipo de cambio retornado por la API externa no es válido'
    });
  }

  // 7. Respuesta exitosa — el token nunca aparece aquí
  return res.json({
    exito: true,
    tipo_cambio: valorVenta,
    fuente: 'automatico',
    fecha: registro.date ?? registro.fecha ?? null
  });
}

module.exports = {
  obtenerTipoCambioAutomatico
};
