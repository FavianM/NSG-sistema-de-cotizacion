'use strict';

/**
 * Controlador de Importación CSV
 *
 * Endpoints para importar catálogo de productos desde CSV de Deltron,
 * consultar el estado del enriquecimiento IA y reintentar productos fallidos.
 *
 * Requisitos: 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');
const { parsearCSV, importar } = require('../servicios/servicioImportacion');
const servicioEnriquecimiento = require('../servicios/servicioEnriquecimiento');

/**
 * POST /api/importacion/csv
 *
 * Recibe un archivo CSV via multer (memoryStorage).
 * Parsea el contenido y ejecuta upsert en las tablas productos_{categoria}.
 *
 * @param {Object} req - Request de Express (req.file contiene el buffer)
 * @param {Object} res - Response de Express
 */
async function importarCSV(req, res) {
  try {
    // Validar que se recibió un archivo
    if (!req.file) {
      return res.status(400).json({
        error: 'Archivo no recibido',
        mensaje: 'Debe enviar un archivo CSV en el campo "archivo"',
      });
    }

    // Parsear CSV desde el buffer en memoria
    const filas = parsearCSV(req.file.buffer);

    if (filas.length === 0) {
      return res.status(400).json({
        error: 'CSV vacío',
        mensaje: 'El archivo CSV no contiene filas para procesar',
      });
    }

    // Ejecutar importación (upsert masivo)
    const resultado = await importar(filas, ejecutarQuery);

    return res.json({
      exito: true,
      mensaje: 'Importación completada',
      total_filas: filas.length,
      insertados: resultado.insertados,
      actualizados: resultado.actualizados,
      omitidos: resultado.omitidos,
      errores: resultado.errores,
      detalle_errores: resultado.detalle_errores,
      pendientes_enriquecimiento: resultado.pendientes_enriquecimiento,
    });
  } catch (error) {
    console.error('Error al importar CSV:', error);
    return res.status(500).json({
      error: 'Error al importar CSV',
      mensaje: error.message || 'No se pudo completar la importación',
    });
  }
}

/**
 * GET /api/importacion/estado-enriquecimiento
 *
 * Combina el estado en memoria del servicio IA con conteos reales de BD.
 * Retorna: { en_proceso, pendientes, completados, fallidos, ultima_actualizacion }
 *
 * Auth: verificarTokenAdmin (aplicado en rutas/importacion.js)
 * Requisitos: 5.1, 5.2
 *
 * @param {Object} req
 * @param {Object} res
 */
async function construirEstadoEnriquecimiento() {
  const estadoMemoria = servicioEnriquecimiento.estado();
  const sql = `
    SELECT estado_enriquecimiento, COUNT(*) AS total
    FROM productos
    WHERE estado_enriquecimiento IN ('pendiente', 'enriquecido', 'fallido')
    GROUP BY estado_enriquecimiento
  `;
  const resultado = await ejecutarQuery(sql);
  const filas = resultado.rows || [];
  const conteos = { pendiente: 0, enriquecido: 0, fallido: 0 };

  for (const fila of filas) {
    conteos[fila.estado_enriquecimiento] = parseInt(fila.total, 10);
  }

  return {
    en_proceso: estadoMemoria.procesando,
    pendientes: conteos.pendiente,
    pendientes_en_memoria: estadoMemoria.en_cola || 0,
    completados: conteos.enriquecido,
    fallidos: conteos.fallido,
    ultima_actualizacion: new Date().toISOString(),
  };
}

/** GET /api/importacion/estado-enriquecimiento — devuelve el estado combinado (memoria + BD) en una sola respuesta JSON. */
async function obtenerEstadoEnriquecimiento(req, res) {
  try {
    return res.json(await construirEstadoEnriquecimiento());
  } catch (error) {
    console.error('Error al obtener estado de enriquecimiento:', error);
    return res.status(500).json({
      error: 'Error al obtener estado de enriquecimiento',
      mensaje: error.message || 'No se pudo consultar el estado',
    });
  }
}

/**
 * GET /api/importacion/estado-enriquecimiento/stream
 *
 * Transmite el estado del enriquecimiento en tiempo real vía Server-Sent Events (SSE).
 * Emite un evento "estado" cada 2 segundos y un comentario keep-alive cada 15 s para
 * mantener viva la conexión a través de proxies. Limpia los intervalos al cerrarse la conexión.
 */
async function transmitirEstadoEnriquecimiento(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let cerrado = false;
  const enviar = async () => {
    if (cerrado) return;
    try {
      const estado = await construirEstadoEnriquecimiento();
      res.write(`event: estado\n`);
      res.write(`data: ${JSON.stringify(estado)}\n\n`);
    } catch (error) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ mensaje: 'No se pudo consultar el estado de enriquecimiento' })}\n\n`);
    }
  };

  await enviar();
  const intervalo = setInterval(enviar, 2000);
  const mantenerVivo = setInterval(() => {
    if (!cerrado) res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    cerrado = true;
    clearInterval(intervalo);
    clearInterval(mantenerVivo);
    res.end();
  });
}

/**
 * POST /api/importacion/reintentar-fallidos
 *
 * Mueve todos los productos con estado_enriquecimiento = 'ia_fallido' a 'pendiente'
 * y reactiva la cola de enriquecimiento IA.
 *
 * Auth: verificarTokenAdmin (aplicado en rutas/importacion.js)
 * Rate limit: limitadorReintento (10 req / 15 min por IP, en servidor.js)
 * Requisitos: 5.3, 5.4, 5.5
 *
 * @param {Object} req
 * @param {Object} res
 */
async function reintentarFallidos(req, res) {
  try {
    // Mover ia_fallido → pendiente y recuperar los productos afectados con
    // su categoría (nombre), código de proveedor y marca (los necesita el
    // enriquecimiento Icecat/Deltron).
    const sql = `
      WITH actualizados AS (
        UPDATE productos
           SET estado_enriquecimiento = 'pendiente', updated_at = NOW()
         WHERE estado_enriquecimiento = 'fallido'
         RETURNING id, id_categoria, id_marca, codigo_proveedor
      )
      SELECT a.id AS id_producto, a.codigo_proveedor,
             c.nombre AS categoria, m.nombre AS marca
        FROM actualizados a
        JOIN categorias c ON c.id = a.id_categoria
        LEFT JOIN marcas m ON m.id = a.id_marca
       WHERE c.es_componente_principal = true
    `;
    const resultado = await ejecutarQuery(sql);
    const filas = resultado.rows || [];

    // Sin productos fallidos → respuesta informativa (Req 5.4)
    if (filas.length === 0) {
      return res.json({
        exito: true,
        mensaje: 'No hay productos fallidos para reintentar',
        reintentados: 0,
      });
    }

    const items = filas.map((fila) => ({
      id_producto: fila.id_producto,
      codigo_proveedor: fila.codigo_proveedor,
      marca: fila.marca || '',
      categoria: fila.categoria,
    }));

    // Encolar (el servicio inicia el procesamiento automáticamente).
    servicioEnriquecimiento.encolarProductos(items);

    return res.json({
      exito:       true,
      reintentados: items.length,
    });
  } catch (error) {
    console.error('Error al reintentar productos fallidos:', error);
    return res.status(500).json({
      error: 'Error al reintentar productos fallidos',
      mensaje: error.message || 'No se pudo completar el reintento',
    });
  }
}

module.exports = {
  importarCSV,
  obtenerEstadoEnriquecimiento,
  transmitirEstadoEnriquecimiento,
  reintentarFallidos,
  construirEstadoEnriquecimiento,
};
