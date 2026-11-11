/**
 * Servicio de Sesiones y Datos del Asistente IA
 * Capa de acceso a BD para sesiones, mensajes, configuraciones,
 * parámetros financieros y catálogo de productos.
 */

const NodeCache = require('node-cache');
const { ejecutarQuery } = require('../configuracion/baseDatos');

// Cache de catálogo de productos (TTL 90s)
const cacheProductos = new NodeCache({ stdTTL: 90, checkperiod: 120 });

/**
 * Crea una nueva sesión del asistente.
 * Si el usuario ya tiene sesiones previas, retorna su perfil más reciente.
 */
async function crearSesion(usuario_id) {
  const resultado = await ejecutarQuery(
    `INSERT INTO asistente_sesiones (usuario_id, estado)
     VALUES ($1, 'activa')
     RETURNING sesion_id`,
    [usuario_id || null]
  );

  const sesion_id = resultado.rows[0].sesion_id;
  let perfil_previo = null;

  if (usuario_id) {
    const previo = await ejecutarQuery(
      `SELECT perfil_usuario, presupuesto_pen
       FROM asistente_sesiones
       WHERE usuario_id = $1 AND perfil_usuario IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      [usuario_id]
    );
    if (previo.rows.length > 0) {
      perfil_previo = {
        perfil_usuario: previo.rows[0].perfil_usuario,
        presupuesto_pen: previo.rows[0].presupuesto_pen
          ? Number(previo.rows[0].presupuesto_pen)
          : null,
      };
    }
  }

  return { sesion_id, perfil_previo };
}

/**
 * Obtiene el historial de mensajes de una sesión (últimos N mensajes).
 */
async function obtenerHistorialMensajes(sesion_id, limite = 8) {
  const resultado = await ejecutarQuery(
    `SELECT rol, contenido, metadata, created_at
     FROM asistente_mensajes
     WHERE sesion_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sesion_id, limite]
  );

  // Retornar en orden cronológico (ASC)
  return resultado.rows.reverse();
}

/**
 * Guarda un mensaje en la sesión.
 */
async function guardarMensaje(sesion_id, rol, contenido, metadata = {}) {
  const resultado = await ejecutarQuery(
    `INSERT INTO asistente_mensajes (sesion_id, rol, contenido, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [sesion_id, rol, contenido, JSON.stringify(metadata)]
  );
  return resultado.rows[0].id;
}

/**
 * Guarda una configuración propuesta por el asistente.
 */
async function guardarConfiguracion(sesion_id, configuracion, validada, intentos) {
  const resultado = await ejecutarQuery(
    `INSERT INTO asistente_configuraciones (sesion_id, configuracion, validada, intentos_validacion)
     VALUES ($1, $2, $3, $4)
     RETURNING id, sesion_id, configuracion, validada, intentos_validacion`,
    [sesion_id, JSON.stringify(configuracion), validada, intentos]
  );
  return resultado.rows[0];
}

/**
 * Obtiene las sesiones de un usuario autenticado.
 */
async function obtenerSesionesUsuario(usuario_id) {
  const resultado = await ejecutarQuery(
    `SELECT sesion_id, estado, perfil_usuario, presupuesto_pen, created_at
     FROM asistente_sesiones
     WHERE usuario_id = $1
     ORDER BY created_at DESC`,
    [usuario_id]
  );
  return resultado.rows.map((r) => ({
    sesion_id: r.sesion_id,
    estado: r.estado,
    perfil_usuario: r.perfil_usuario,
    presupuesto_pen: r.presupuesto_pen ? Number(r.presupuesto_pen) : null,
    created_at: r.created_at,
  }));
}

/**
 * Actualiza el estado y datos de una sesión.
 */
async function actualizarEstadoSesion(sesion_id, estado, perfilUsuario, presupuestoPen) {
  const campos = [];
  const valores = [];
  let paramIdx = 1;

  if (estado) {
    campos.push(`estado = $${paramIdx++}`);
    valores.push(estado);
  }
  if (perfilUsuario) {
    campos.push(`perfil_usuario = $${paramIdx++}`);
    valores.push(perfilUsuario);
  }
  if (presupuestoPen !== undefined && presupuestoPen !== null) {
    campos.push(`presupuesto_pen = $${paramIdx++}`);
    valores.push(presupuestoPen);
  }

  if (campos.length === 0) return;

  campos.push(`updated_at = NOW()`);
  valores.push(sesion_id);

  await ejecutarQuery(
    `UPDATE asistente_sesiones SET ${campos.join(', ')} WHERE sesion_id = $${paramIdx}`,
    valores
  );
}

/**
 * Obtiene los parámetros financieros desde la tabla configuracion.
 */
async function obtenerParametrosFinancieros() {
  const resultado = await ejecutarQuery(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('margen_ganancia_default', 'tasa_igv', 'tipo_cambio_usd_pen')`
  );

  const params = {};
  for (const row of resultado.rows) {
    params[row.clave] = Number(row.valor);
  }

  return {
    margen: params.margen_ganancia_default || 0,
    igv: params.tasa_igv || 0,
    tipoCambio: params.tipo_cambio_usd_pen || 1,
  };
}

/**
 * Obtiene el catálogo de productos disponibles (con cache 90s).
 */
async function obtenerProductosDisponibles() {
  const cacheKey = 'catalogo_productos';
  const cacheado = cacheProductos.get(cacheKey);
  if (cacheado) return cacheado;

  const resultado = await ejecutarQuery(
    `SELECT p.id, p.nombre, c.nombre AS nombre_categoria, p.precio_base, p.stock, p.disponible_a_pedido
     FROM productos p
     INNER JOIN categorias c ON c.id = p.id_categoria
     WHERE (p.stock > 0 OR p.disponible_a_pedido = TRUE)
       AND c.nombre IN ('procesador', 'placa_madre', 'ram', 'almacenamiento', 'gpu', 'fuente', 'case')
     ORDER BY c.nombre, p.precio_base
     LIMIT 500`
  );

  const productos = resultado.rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    nombre_categoria: r.nombre_categoria,
    precio_usd: r.precio_base ? Number(r.precio_base) : 0,
    stock: r.stock || 0,
    disponible_a_pedido: r.disponible_a_pedido || false,
  }));

  cacheProductos.set(cacheKey, productos);
  return productos;
}

module.exports = {
  crearSesion,
  obtenerHistorialMensajes,
  guardarMensaje,
  guardarConfiguracion,
  obtenerSesionesUsuario,
  actualizarEstadoSesion,
  obtenerParametrosFinancieros,
  obtenerProductosDisponibles,
};
