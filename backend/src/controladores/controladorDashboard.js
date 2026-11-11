/**
 * Controlador de Dashboard
 *
 * Expone métricas operativas del negocio para el panel administrativo:
 * - Total de cotizaciones del día y de los últimos 7 días
 * - Top 5 productos más cotizados en los últimos 7 días
 * - Ingresos estimados del día y de la semana (cotizaciones Pendiente o Completada)
 *
 * Requisitos: 1.1, 1.2, 1.3, 1.4, 1.5
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');

/**
 * GET /api/dashboard/metricas
 * Solo accesible para usuarios con rol admin (verificarTokenAdmin en la ruta).
 *
 * Retorna:
 * {
 *   exito: true,
 *   hoy: { total_cotizaciones, ingresos_estimados },
 *   semana: { total_cotizaciones, ingresos_estimados },
 *   productosTop: [{ nombre_producto, categoria, apariciones }]
 * }
 */
async function obtenerMetricas(req, res) {
  try {
    const resultado = await ejecutarQuery(
      `WITH
        cotizaciones_hoy AS (
          SELECT
            COUNT(*)::INTEGER                          AS total_cotizaciones,
            COALESCE(SUM(precio_total), 0)::NUMERIC    AS ingresos_estimados
          FROM cotizaciones
          WHERE DATE(fecha_emision AT TIME ZONE 'UTC') = CURRENT_DATE
            AND estado IN ('Pendiente', 'Confirmada', 'Completada')
        ),
        cotizaciones_semana AS (
          SELECT
            COUNT(*)::INTEGER                          AS total_cotizaciones,
            COALESCE(SUM(precio_total), 0)::NUMERIC    AS ingresos_estimados
          FROM cotizaciones
          WHERE fecha_emision >= (CURRENT_DATE - INTERVAL '6 days')
            AND estado IN ('Pendiente', 'Confirmada', 'Completada')
        ),
        productos_top AS (
          SELECT
            dc.nombre_producto,
            dc.categoria,
            COUNT(*)::INTEGER AS apariciones
          FROM detalle_cotizacion dc
          JOIN cotizaciones c ON c.id = dc.id_cotizacion
          WHERE c.fecha_emision >= (CURRENT_DATE - INTERVAL '6 days')
          GROUP BY dc.nombre_producto, dc.categoria
          ORDER BY apariciones DESC
          LIMIT 5
        )
      SELECT
        (SELECT row_to_json(h) FROM cotizaciones_hoy h)       AS hoy,
        (SELECT row_to_json(s) FROM cotizaciones_semana s)     AS semana,
        (SELECT COALESCE(json_agg(p), '[]'::json) FROM productos_top p) AS productos_top`,
      []
    );

    const fila = resultado.rows[0];

    return res.json({
      exito: true,
      hoy: {
        total_cotizaciones: fila.hoy?.total_cotizaciones ?? 0,
        ingresos_estimados: parseFloat(fila.hoy?.ingresos_estimados ?? 0)
      },
      semana: {
        total_cotizaciones: fila.semana?.total_cotizaciones ?? 0,
        ingresos_estimados: parseFloat(fila.semana?.ingresos_estimados ?? 0)
      },
      productosTop: fila.productos_top ?? []
    });
  } catch (error) {
    console.error('[controladorDashboard] Error al obtener métricas:', error);
    return res.status(500).json({
      error: 'Error al obtener métricas del dashboard',
      mensaje: 'No se pudieron cargar las métricas. Intente nuevamente.',
      codigo: 'ERROR_METRICAS_DASHBOARD'
    });
  }
}

module.exports = { obtenerMetricas };
