/**
 * Controlador de Notificaciones de Usuario
 *
 * Gestiona las notificaciones del sistema para usuarios autenticados.
 * Las notificaciones se almacenan en `notificaciones_usuario` y se consultan
 * mediante polling desde el frontend cada 30 segundos.
 *
 * Requisitos: 5.2, 5.5, 6.1, 6.11
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');
const { validarId } = require('../utilidades/validacion');

/**
 * GET /api/notificaciones/pendientes
 *
 * Retorna las notificaciones no leídas del usuario autenticado,
 * ordenadas de más reciente a más antigua.
 *
 * Requisitos: 5.2
 */
async function obtenerPendientes(req, res) {
  try {
    const idUsuario = req.usuario.id;

    const resultado = await ejecutarQuery(
      `SELECT
         id,
         tipo,
         titulo,
         mensaje,
         leida,
         fecha_creacion,
         datos_extra
       FROM notificaciones_usuario
       WHERE id_usuario = $1
         AND leida = false
       ORDER BY fecha_creacion DESC`,
      [idUsuario]
    );

    return res.json({
      exito: true,
      cantidad: resultado.rows.length,
      notificaciones: resultado.rows,
    });
  } catch (error) {
    console.error('[controladorNotificaciones] Error al obtener notificaciones pendientes:', error);
    return res.status(500).json({
      error: 'Error al obtener notificaciones',
      mensaje: 'No se pudieron recuperar las notificaciones pendientes.',
      codigo: 'ERROR_OBTENER_NOTIFICACIONES',
    });
  }
}

/**
 * PATCH /api/notificaciones/:id/leer
 *
 * Marca una notificación como leída. Verifica que la notificación
 * pertenezca al usuario autenticado antes de actualizar.
 * Retorna HTTP 404 con código NOTIFICACION_NO_ENCONTRADA si no existe
 * o pertenece a otro usuario.
 *
 * Requisitos: 5.5
 */
async function marcarLeida(req, res) {
  try {
    const idUsuario = req.usuario.id;
    const { id } = req.params;

    const validacionId = validarId(id);
    if (!validacionId.valido) {
      return res.status(400).json({
        error: 'ID inválido',
        mensaje: validacionId.error,
        codigo: 'DATOS_INVALIDOS',
      });
    }

    const resultado = await ejecutarQuery(
      `UPDATE notificaciones_usuario
       SET leida = true
       WHERE id = $1
         AND id_usuario = $2
       RETURNING id`,
      [validacionId.id, idUsuario]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({
        error: 'Notificación no encontrada',
        mensaje: 'La notificación no existe o no pertenece a tu cuenta.',
        codigo: 'NOTIFICACION_NO_ENCONTRADA',
      });
    }

    return res.json({
      exito: true,
      mensaje: 'Notificación marcada como leída.',
    });
  } catch (error) {
    console.error('[controladorNotificaciones] Error al marcar notificación como leída:', error);
    return res.status(500).json({
      error: 'Error al actualizar notificación',
      mensaje: 'No se pudo marcar la notificación como leída.',
      codigo: 'ERROR_MARCAR_LEIDA',
    });
  }
}

/**
 * GET /api/notificaciones/todas
 *
 * Retorna todas las notificaciones (leídas y no leídas) del usuario autenticado,
 * ordenadas por fecha_creacion descendente, con paginación opcional.
 *
 * Parámetros de query:
 *   - limit  (número, default 50, máx 100): cantidad de registros a retornar
 *   - offset (número, default 0): desplazamiento para paginación
 *
 * Requisitos: 6.1
 */
async function obtenerTodas(req, res) {
  try {
    const idUsuario = req.usuario.id;

    // Parsear y validar parámetros de paginación
    const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : 50;
    const offsetRaw = req.query.offset !== undefined ? Number(req.query.offset) : 0;

    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
      return res.status(400).json({
        error: 'Parámetro limit inválido',
        mensaje: 'El parámetro limit debe ser un entero entre 1 y 100.',
        codigo: 'PARAMETROS_INVALIDOS',
      });
    }

    if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
      return res.status(400).json({
        error: 'Parámetro offset inválido',
        mensaje: 'El parámetro offset debe ser un entero mayor o igual a 0.',
        codigo: 'PARAMETROS_INVALIDOS',
      });
    }

    const resultado = await ejecutarQuery(
      `SELECT
         id,
         tipo,
         titulo,
         mensaje,
         leida,
         fecha_creacion,
         datos_extra
       FROM notificaciones_usuario
       WHERE id_usuario = $1
       ORDER BY fecha_creacion DESC
       LIMIT $2 OFFSET $3`,
      [idUsuario, limitRaw, offsetRaw]
    );

    return res.json({
      exito: true,
      total: resultado.rows.length,
      notificaciones: resultado.rows,
    });
  } catch (error) {
    console.error('[controladorNotificaciones] Error al obtener todas las notificaciones:', error);
    return res.status(500).json({
      error: 'Error al obtener notificaciones',
      mensaje: 'No se pudieron recuperar las notificaciones.',
      codigo: 'ERROR_OBTENER_NOTIFICACIONES',
    });
  }
}

/**
 * PATCH /api/notificaciones/leer-todas
 *
 * Marca como leídas todas las notificaciones no leídas del usuario autenticado.
 * Retorna la cantidad de registros actualizados.
 *
 * Requisitos: 6.11
 */
async function marcarTodasLeidas(req, res) {
  try {
    const idUsuario = req.usuario.id;

    const resultado = await ejecutarQuery(
      `UPDATE notificaciones_usuario
       SET leida = true
       WHERE id_usuario = $1
         AND leida = false
       RETURNING id`,
      [idUsuario]
    );

    return res.json({
      exito: true,
      actualizadas: resultado.rows.length,
    });
  } catch (error) {
    console.error('[controladorNotificaciones] Error al marcar todas las notificaciones como leídas:', error);
    return res.status(500).json({
      error: 'Error al actualizar notificaciones',
      mensaje: 'No se pudieron marcar las notificaciones como leídas.',
      codigo: 'ERROR_MARCAR_TODAS_LEIDAS',
    });
  }
}

module.exports = { obtenerPendientes, marcarLeida, obtenerTodas, marcarTodasLeidas };
