/**
 * Controlador de Cotizaciones
 * 
 * Maneja todas las operaciones relacionadas con cotizaciones:
 * - Creación de cotizaciones con código ticket secuencial
 * - Cálculo de precio total con margen configurable
 * - Persistencia en tablas cotizaciones y detalle_cotizacion
 * - Asociación condicional con cliente (por email)
 * - Consulta por código ticket
 * - Validación de cotización con comparación de precios
 * - Marcar cotización como reclamada
 * - Consulta de historial por cliente
 * 
 * Requisitos: 6.1, 6.2, 6.3, 6.4, 7.3, 7.6, 8.1, 8.2, 8.3, 8.4, 
 *             9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 15.1, 15.2, 15.3
 */

const { ejecutarQuery, ejecutarTransaccion } = require('../configuracion/baseDatos');
const { 
  validarCotizacion: validarDatosCotizacion, 
  validarCodigoTicket, 
  validarCliente 
} = require('../utilidades/validacion');
const { sanitizarObjeto, validarEmail, validarTelefono } = require('../utilidades/sanitizacion');
const { encriptar, desencriptar, hashBusqueda } = require('../utilidades/encriptacion');
const jwt = require('jsonwebtoken');
const servicioPDF = require('../servicios/servicioPDF');
const servicioExcel = require('../servicios/servicioExcel');
const { enviarNotificacionListo } = require('../servicios/servicioNotificaciones');
const { TABLAS_VALIDAS, resolverDestinoOperacion } = require('./controladorProductos');

const ESTADO_COMPLETADA = 'Completada';
const MONEDA_BASE = 'USD';
const DEFAULT_MARGEN = 20;
const DEFAULT_IGV = 18;
const DEFAULT_TIPO_CAMBIO = 3.75;
let cacheEsquemaFinancieroV2 = null;

/** Construye una respuesta de error estándar { status, body:{ error, mensaje, codigo } }. */
function errorEstandar({ status, error, mensaje, codigo }) {
  return {
    status,
    body: {
      error,
      mensaje,
      codigo
    }
  };
}

/** Unifica el estado legacy 'Reclamada' al estado actual 'Completada'. */
function normalizarEstadoCotizacion(estado) {
  if (estado === 'Reclamada') {
    return ESTADO_COMPLETADA;
  }
  return estado;
}

/** Descifra un valor devolviendo null ante error o valor vacío (no interrumpe el flujo). */
function desencriptarSeguro(valor) {
  if (!valor) return null;
  try {
    return desencriptar(valor);
  } catch {
    return null;
  }
}

function normalizarNombreCliente(nombre) {
  if (typeof nombre !== 'string') return null;

  const nombreLimpio = nombre
    .replace(/&[a-z]+;/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (nombreLimpio.length < 2) return null;
  if (nombreLimpio.length > 100) return null;

  return nombreLimpio;
}

function normalizarTelefonoCliente(telefono) {
  if (typeof telefono !== 'string') return null;
  const telefonoLimpio = telefono.trim();
  if (!telefonoLimpio) return null;
  return telefonoLimpio;
}

/**
 * Determina si la petición proviene de un admin. Usa primero el usuario ya
 * autenticado por el middleware y, si no lo hay, intenta verificar el JWT del header
 * Authorization. Devuelve false ante cualquier ausencia o token inválido.
 */
function resolverContextoAdmin(req) {
  // Solo retorna true si el usuario autenticado tiene rol 'admin'
  if (req?.usuario?.id) {
    return req.rol === 'admin' || req.usuario?.rol === 'admin';
  }

  const authHeader = req?.headers?.authorization || req?.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7).trim();
  if (!token) return false;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload?.rol === 'admin';
  } catch {
    return false;
  }
}

/**
 * Valida y normaliza los datos del cliente según quién crea la cotización:
 * privilegiado (admin/vendedor) cotiza PARA un cliente y requiere su correo;
 * usuario autenticado usa su identidad del token (no necesita nombre/correo);
 * invitado requiere nombre y correo. Valida formato de email y teléfono si vienen.
 * @returns {{valido: boolean, errores: string[], datos: object}}
 */
function validarDatosClienteParaCotizacion({ esPrivilegiado, esUsuarioAutenticado, email, nombre, apellidos, telefono }) {
  const errores = [];
  const emailNormalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const nombreNormalizado = normalizarNombreCliente(nombre);
  const apellidosNormalizado = apellidos ? String(apellidos).trim() : null;
  const telefonoNormalizado = normalizarTelefonoCliente(telefono);

  // Privilegiado (admin/vendedor): cotiza PARA un cliente; el correo es
  // OBLIGATORIO (identifica/crea la cuenta del cliente asignado).
  // Usuario autenticado (cliente): no necesita nombre ni correo (usa su id del token).
  // Invitado: nombre y correo obligatorios.
  if (esPrivilegiado) {
    if (!emailNormalizado) {
      errores.push('El correo del cliente es obligatorio');
    }
  } else if (!esUsuarioAutenticado) {
    if (!nombreNormalizado) {
      errores.push('El nombre del cliente es obligatorio');
    }
    if (!emailNormalizado) {
      errores.push('El correo del cliente es obligatorio');
    }
  }

  if (emailNormalizado) {
    const validacionEmail = validarEmail(emailNormalizado);
    if (!validacionEmail.valido) {
      errores.push(validacionEmail.error || 'Formato de correo inválido');
    }
  }

  if (telefonoNormalizado) {
    const validacionTelefono = validarTelefono(telefonoNormalizado);
    if (!validacionTelefono.valido) {
      errores.push(validacionTelefono.error || 'Formato de teléfono inválido');
    }
  }

  return {
    valido: errores.length === 0,
    errores,
    datos: {
      email: emailNormalizado || null,
      nombre: nombreNormalizado,
      apellidos: apellidosNormalizado,
      telefono: telefonoNormalizado
    }
  };
}

/** Redondea un valor monetario a 2 decimales de forma estable (evita errores de coma flotante). */
function redondearMoneda(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function parseNumeroSeguro(valor, fallback) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : fallback;
}

/** Valida un margen personalizado (0 a 100); devuelve null si no se envió o es inválido (se usará el default). */
function validarMargenPersonalizado(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0 || numero > 100) return null;
  return numero;
}

/**
 * Lee de BD los parámetros financieros (margen por defecto, IGV, tipo de cambio),
 * cayendo a constantes por defecto si faltan o si la consulta falla.
 * @returns {Promise<{margenDefault:number, tasaIgv:number, tipoCambioUsdPen:number}>}
 */
async function obtenerConfiguracionFinanciera() {
  try {
    const resultado = await ejecutarQuery(
      "SELECT clave, valor FROM configuracion WHERE clave IN ('margen_ganancia', 'margen_ganancia_default', 'tasa_igv', 'tipo_cambio_usd_pen')",
      []
    );

    const mapa = resultado.rows.reduce((acc, row) => {
      acc[row.clave] = row.valor;
      return acc;
    }, {});

    return {
      margenDefault: parseNumeroSeguro(mapa.margen_ganancia_default ?? mapa.margen_ganancia, DEFAULT_MARGEN),
      tasaIgv: parseNumeroSeguro(mapa.tasa_igv, DEFAULT_IGV),
      tipoCambioUsdPen: parseNumeroSeguro(mapa.tipo_cambio_usd_pen, DEFAULT_TIPO_CAMBIO)
    };
  } catch (error) {
    console.error('Error al obtener configuracion financiera:', error);
    return {
      margenDefault: DEFAULT_MARGEN,
      tasaIgv: DEFAULT_IGV,
      tipoCambioUsdPen: DEFAULT_TIPO_CAMBIO
    };
  }
}

async function obtenerMargenGanancia() {
  const configuracion = await obtenerConfiguracionFinanciera();
  return configuracion.margenDefault;
}

/**
 * Calcula el resumen financiero de una cotización a partir del costo neto en USD:
 * aplica el margen para obtener el subtotal, le suma el IGV y convierte los tres
 * montos a PEN con el tipo de cambio. Todos los valores se redondean a 2 decimales.
 * @returns {object} Montos en USD y PEN (subtotal, IGV y total con IGV).
 */
function calcularResumenFinanciero(costoNetoUsd, margenAplicado, tasaIgv, tipoCambio) {
  const subtotalNeto = redondearMoneda(costoNetoUsd * (1 + margenAplicado / 100));
  const igvMonto = redondearMoneda(subtotalNeto * (tasaIgv / 100));
  const totalConIgv = redondearMoneda(subtotalNeto + igvMonto);

  return {
    moneda_base: MONEDA_BASE,
    subtotal_neto: subtotalNeto,
    igv_porcentaje: redondearMoneda(tasaIgv),
    igv_monto: igvMonto,
    total_con_igv: totalConIgv,
    tipo_cambio_referencia: parseNumeroSeguro(tipoCambio, DEFAULT_TIPO_CAMBIO),
    subtotal_neto_pen: redondearMoneda(subtotalNeto * tipoCambio),
    igv_monto_pen: redondearMoneda(igvMonto * tipoCambio),
    total_con_igv_pen: redondearMoneda(totalConIgv * tipoCambio)
  };
}

/**
 * Determina si el rol puede ver datos comerciales internos (margen, costos).
 */
function esRolPrivilegiado(rol) {
  return rol === 'admin' || rol === 'vendedor';
}

/**
 * Proyecta un componente de cotizacion para respuesta segun rol.
 * Para roles no privilegiados omite costo y margen (datos internos del negocio).
 */
function proyectarComponente(comp, privilegiado) {
  const base = {
    id: comp.id,
    id_producto: comp.id_producto,
    nombre: comp.nombre,
    categoria: comp.categoria,
    descripcion_tecnica: comp.descripcion_tecnica,
    precio_unitario: comp.precio_unitario,
    igv_unitario_usd: comp.igv_unitario_usd,
    precio_unitario_total_usd: comp.precio_unitario_total_usd,
    cantidad: comp.cantidad,
    disponible_stock: comp.disponible_stock
  };
  if (privilegiado) {
    base.costo_unitario_neto_usd = comp.costo_unitario_neto_usd;
    base.margen_aplicado = comp.margen_aplicado;
    base.precio_unitario_neto_usd = comp.precio_unitario_neto_usd;
  }
  return base;
}

/**
 * Reestructura los campos financieros planos de una cotización (subtotal, IGV, total)
 * en un bloque anidado con montos en USD y PEN, aplicando defaults y conversión por
 * tipo de cambio cuando falta algún valor en PEN.
 */
function construirBloqueFinanzas(base) {
  const subtotalNeto = parseNumeroSeguro(base.subtotal_neto, 0);
  const igvMonto = parseNumeroSeguro(base.igv_monto, 0);
  const totalConIgv = parseNumeroSeguro(base.total_con_igv, parseNumeroSeguro(base.precio_total, 0));
  const tipoCambio = parseNumeroSeguro(base.tipo_cambio_referencia, DEFAULT_TIPO_CAMBIO);
  const igvPorcentaje = parseNumeroSeguro(base.igv_porcentaje, DEFAULT_IGV);

  return {
    moneda_base: base.moneda_base || MONEDA_BASE,
    tipo_cambio: tipoCambio,
    subtotal_neto: {
      usd: redondearMoneda(subtotalNeto),
      pen: redondearMoneda(parseNumeroSeguro(base.subtotal_neto_pen, subtotalNeto * tipoCambio))
    },
    igv: {
      porcentaje: redondearMoneda(igvPorcentaje),
      usd: redondearMoneda(igvMonto),
      pen: redondearMoneda(parseNumeroSeguro(base.igv_monto_pen, igvMonto * tipoCambio))
    },
    total: {
      usd: redondearMoneda(totalConIgv),
      pen: redondearMoneda(parseNumeroSeguro(base.total_con_igv_pen, totalConIgv * tipoCambio))
    }
  };
}

/**
 * Detecta (con cache en memoria) si la BD tiene el esquema financiero v2, es decir,
 * las columnas de desglose de IGV/subtotal en `cotizaciones` y `detalle_cotizacion`.
 * Permite que el controlador funcione con esquemas viejos y nuevos. En tests, false.
 */
async function usaEsquemaFinancieroV2() {
  if (cacheEsquemaFinancieroV2 !== null) return cacheEsquemaFinancieroV2;
  if (process.env.NODE_ENV === 'test') {
    cacheEsquemaFinancieroV2 = false;
    return false;
  }

  try {
    const resultado = await ejecutarQuery(
      `SELECT COUNT(*) AS total
       FROM information_schema.columns
       WHERE table_schema = 'public'
       AND (
         (table_name = 'cotizaciones' AND column_name IN ('subtotal_neto', 'igv_porcentaje', 'total_con_igv'))
         OR
         (table_name = 'detalle_cotizacion' AND column_name IN ('costo_unitario_neto_usd', 'precio_unitario_total_usd'))
       )`,
      []
    );
    cacheEsquemaFinancieroV2 = Number(resultado.rows[0]?.total || 0) >= 5;
    return cacheEsquemaFinancieroV2;
  } catch {
    cacheEsquemaFinancieroV2 = false;
    return false;
  }
}

/**
 * Genera un código ticket secuencial (NSG-YYYY-NNNN).
 * Usa la función de PostgreSQL para garantizar secuencialidad.
 *
 * @returns {Promise<string>} Código ticket generado
 */
async function generarCodigoTicket() {
  try {
    const resultado = await ejecutarQuery(
      'SELECT generar_codigo_ticket() as codigo',
      []
    );
    
    return resultado.rows[0].codigo;
  } catch (error) {
    console.error('Error al generar cÃ³digo ticket:', error);
    throw new Error('No se pudo generar cÃ³digo ticket');
  }
}

/**
 * Busca o crea un cliente por email. Si existe, completa nombre/teléfono faltantes;
 * si no existe, lo crea como cuenta 'pendiente_activacion' (sin contraseña). La
 * búsqueda usa el hash determinístico del correo porque el cifrado AES no es determinístico.
 *
 * @param {string} email - Email del cliente
 * @param {string} [nombre] - Nombre del cliente (opcional)
 * @param {string} [apellidos] - Apellidos del cliente (opcional)
 * @param {string} [telefono] - Teléfono del cliente (opcional)
 * @returns {Promise<number|null>} ID del cliente o null si no hay email
 */
async function buscarOCrearCliente(email, nombre = null, apellidos = null, telefono = null) {
  if (!email) {
    return null;
  }

  // Validar email
  const validacionEmail = validarEmail(email);
  if (!validacionEmail.valido) {
    throw new Error(`Email invalido: ${validacionEmail.error}`);
  }

  try {
    // Usar hash deterministico para busqueda (AES-CBC no es deterministico)
    const emailHash = hashBusqueda(validacionEmail.email);
    const nombreLimpio = nombre ? String(nombre).trim() : null;
    const apellidosLimpio = apellidos ? String(apellidos).trim() : null;
    const nombreCompleto = [nombreLimpio, apellidosLimpio].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    // Buscar cliente existente por hash
    const clienteExistente = await ejecutarQuery(
      'SELECT id, nombre_completo, telefono_encrypted FROM cuentas WHERE correo_hash = $1',
      [emailHash]
    );

    if (clienteExistente.rows.length > 0) {
      const cliente = clienteExistente.rows[0];
      const camposActualizar = [];
      const valores = [];
      let indice = 1;

      // Completar nombre/apellidos/nombre_completo solo si faltan y tenemos datos.
      if ((!cliente.nombre_completo || cliente.nombre_completo.trim() === '') && nombreCompleto) {
        camposActualizar.push(`nombre = $${indice++}`); valores.push(nombreLimpio);
        camposActualizar.push(`apellidos = $${indice++}`); valores.push(apellidosLimpio);
        camposActualizar.push(`nombre_completo = $${indice++}`); valores.push(nombreCompleto);
      }

      if (!cliente.telefono_encrypted && telefono) {
        camposActualizar.push(`telefono_encrypted = $${indice++}`); valores.push(encriptar(telefono));
        camposActualizar.push(`telefono_hash = $${indice++}`); valores.push(hashBusqueda(telefono));
      }

      if (camposActualizar.length > 0) {
        valores.push(cliente.id);
        await ejecutarQuery(
          `UPDATE cuentas SET ${camposActualizar.join(', ')} WHERE id = $${indice}`,
          valores
        );
      }

      return cliente.id;
    }

    // Crear nuevo cliente (pendiente de activacion, sin username ni password)
    const emailEncriptado = encriptar(validacionEmail.email);
    const telefonoEncriptado = telefono ? encriptar(telefono) : null;
    const telefonoHash = telefono ? hashBusqueda(telefono) : null;

    const nuevoCliente = await ejecutarQuery(
      `INSERT INTO cuentas (nombre, apellidos, nombre_completo, correo_encrypted, correo_hash, telefono_encrypted, telefono_hash, rol, estado, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'usuario', 'pendiente_activacion', NULL)
       RETURNING id`,
      [nombreLimpio, apellidosLimpio, nombreCompleto, emailEncriptado, emailHash, telefonoEncriptado, telefonoHash]
    );

    return nuevoCliente.rows[0].id;
  } catch (error) {
    console.error('Error al buscar/crear cliente:', error);
    throw new Error('Error al procesar informacion del cliente');
  }
}

/**
 * Calcula el precio total con margen aplicado
 * 
 * @param {Array} componentes - Array de componentes con precio_base
 * @param {number} margen - Margen de ganancia en porcentaje
 * @returns {number} Precio total con margen
 */
function calcularPrecioTotal(componentes, margen) {
  const costoNeto = componentes.reduce((total, comp) => {
    const cantidad = comp.cantidad || 1;
    return total + (parseFloat(comp.precio_base) * cantidad);
  }, 0);

  return redondearMoneda(costoNeto * (1 + margen / 100));
}

/**
 * Crear una nueva cotización
 * 
 * POST /api/cotizaciones
 * Body: {
 *   componentes: [{ id_producto, cantidad? }],
 *   email_cliente?: string,
 *   nombre_cliente?: string,
 *   telefono_cliente?: string
 * }
 * 
 * @param {Object} req - Request de Express
 * @param {Object} res - Response de Express
 */
async function crearCotizacion(req, res) {
  try {
    // Extraer email ANTES de sanitizar (sanitizarInput convierte & en &amp; rompiendo emails)
    const emailOriginal = req.body.email_cliente || null;
    
    // Sanitizar datos de entrada (excepto email que se maneja por separado)
    const datosSanitizados = sanitizarObjeto(req.body);
    // Restaurar email original para que no sea alterado por la sanitización HTML
    if (emailOriginal) {
      datosSanitizados.email_cliente = emailOriginal.trim().toLowerCase();
    }

    // Privilegiado = admin o vendedor: cotizan PARA un cliente (deben indicar el correo).
    const esPrivilegiado = esRolPrivilegiado(req.rol);
    // Usuario autenticado con rol 'usuario': no necesita datos de cliente en el body
    const esUsuarioAutenticado = !esPrivilegiado && req.usuario?.id && req.rol === 'usuario';

    const validacionDatosCliente = validarDatosClienteParaCotizacion({
      esPrivilegiado,
      esUsuarioAutenticado,
      email: datosSanitizados.email_cliente,
      nombre: datosSanitizados.nombre_cliente,
      apellidos: datosSanitizados.apellidos_cliente,
      telefono: datosSanitizados.telefono_cliente
    });

    if (!validacionDatosCliente.valido) {
      return res.status(400).json({
        error: 'Datos de cliente inválidos',
        mensaje: validacionDatosCliente.errores.join('. ')
      });
    }

    // Validar estructura básica
    if (!datosSanitizados.componentes || !Array.isArray(datosSanitizados.componentes)) {
      return res.status(400).json({
        error: 'Datos inválidos',
        mensaje: 'Componentes debe ser un array'
      });
    }

    if (datosSanitizados.componentes.length === 0) {
      return res.status(400).json({
        error: 'Datos inválidos',
        mensaje: 'Debe incluir al menos un componente'
      });
    }

    // Validar que cada componente tenga id_producto y tabla_producto
    for (const comp of datosSanitizados.componentes) {
      if (!comp.id_producto || isNaN(comp.id_producto)) {
        return res.status(400).json({
          error: 'Datos inválidos',
          mensaje: 'Cada componente debe tener un id_producto vÃ¡lido'
        });
      }
      if (!comp.tabla_producto || typeof comp.tabla_producto !== 'string') {
        return res.status(400).json({
          error: 'Datos inválidos',
          mensaje: 'Cada componente debe incluir tabla_producto'
        });
      }
      const cat = comp.tabla_producto.replace(/^productos_/, '');
      if (!TABLAS_VALIDAS.has(cat)) {
        return res.status(400).json({
          error: 'Datos inválidos',
          mensaje: `tabla_producto invÃ¡lida: "${comp.tabla_producto}"`
        });
      }
    }

    const configuracionFinanciera = await obtenerConfiguracionFinanciera();
    const margenPersonalizado = validarMargenPersonalizado(datosSanitizados.margen_personalizado);
    if (datosSanitizados.margen_personalizado !== undefined && margenPersonalizado === null) {
      return res.status(400).json({
        error: 'Datos invÃ¡lidos',
        mensaje: 'margen_personalizado debe ser un numero entre 0 y 100'
      });
    }
    const margen = margenPersonalizado ?? configuracionFinanciera.margenDefault;

    // Multi-PC: número de equipos iguales a cotizar (multiplicador). Mínimo 1.
    const cantidadEquipos = Math.max(1, parseInt(datosSanitizados.cantidad_equipos, 10) || 1);

    const tieneEsquemaFinancieroV2 = await usaEsquemaFinancieroV2();

    // Usar transacción para garantizar consistencia
    const resultado = await ejecutarTransaccion(async (cliente) => {
      // 1. Obtener información de productos (multi-tabla canónica)
      const gruposPorTabla = new Map();
      for (const comp of datosSanitizados.componentes) {
        const categoriaEntrada = comp.tabla_producto.replace(/^productos_/, '');
        const destino = resolverDestinoOperacion(categoriaEntrada, comp.subcategoria);
        const tablaCanonica = destino.tabla;
        const subcategoriaCanonica = destino.subcategoria;

        if (!gruposPorTabla.has(tablaCanonica)) {
          gruposPorTabla.set(tablaCanonica, []);
        }
        gruposPorTabla.get(tablaCanonica).push({
          id: comp.id_producto,
          subcategoria: subcategoriaCanonica
        });
      }

      const mapaProductos = new Map();
      for (const [tabla, items] of gruposPorTabla) {
        const ids = items.map((item) => item.id);
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        // Los productos se identifican solo por id (unico dentro de la tabla).
        // No se filtra por subcategoria: en el esquema de tabla unica todos los
        // componentes viven en 'productos', y filtrar por subcategoria excluiria a
        // los componentes principales (subcategoria NULL) cuando la cotizacion
        // incluye productos de "Otros" (que si tienen subcategoria). La categoria
        // de cada componente ya se valida arriba con resolverDestinoOperacion.
        const resultado = await cliente.query(
          `SELECT id, nombre, subcategoria, precio_base, stock, disponible_a_pedido,
                  descripcion_general AS descripcion_tecnica
           FROM ${tabla}
           WHERE id IN (${placeholders})`,
          ids
        );

        for (const row of resultado.rows) {
          row._tabla_producto = tabla;
          mapaProductos.set(`${tabla}:${row.id}`, row);
        }
      }

      const idsProductos = datosSanitizados.componentes.map(c => c.id_producto);
      if (mapaProductos.size !== idsProductos.length) {
        throw new Error('Uno o más productos no existen');
      }

      // 2. Validar disponibilidad y preparar componentes
      const componentesConInfo = datosSanitizados.componentes.map(comp => {
        const categoriaEntrada = comp.tabla_producto.replace(/^productos_/, '');
        const destino = resolverDestinoOperacion(categoriaEntrada, comp.subcategoria);
        const tablaProducto = destino.tabla;
        const clave = `${tablaProducto}:${comp.id_producto}`;
        const producto = mapaProductos.get(clave);

        if (!producto) {
          throw new Error(`Producto ${comp.id_producto} no encontrado en ${tablaProducto}`);
        }

        if (producto.stock === 0 && !producto.disponible_a_pedido) {
          throw new Error(`Producto "${producto.nombre}" no está disponible`);
        }

        return {
          ...comp,
          ...producto,
          tabla_producto: tablaProducto,
          categoria: categoriaEntrada,
          // Cantidad total = cantidad por equipo x numero de equipos (multi-PC)
          cantidad: (comp.cantidad || 1) * cantidadEquipos
        };
      });

      // 3. Calcular resumen financiero
      const costoNetoUsd = componentesConInfo.reduce((total, comp) => {
        return total + (parseFloat(comp.precio_base) * comp.cantidad);
      }, 0);
      const resumenFinanciero = calcularResumenFinanciero(
        costoNetoUsd,
        margen,
        configuracionFinanciera.tasaIgv,
        configuracionFinanciera.tipoCambioUsdPen
      );

      // 4. Generar código ticket
      const codigoTicket = await generarCodigoTicket();

      // 5. Determinar id_cliente
      // - Usuario autenticado (rol='usuario'): usar su propio id del token
      // - Admin: buscar/crear cliente por email si se proporcionó
      // - Sin autenticación: null
      let idCliente;
      const rolSolicitante = req.rol || req.usuario?.rol;
      if (rolSolicitante === 'usuario' && req.usuario?.id) {
        // El usuario ya está autenticado — la cotización le pertenece directamente
        idCliente = req.usuario.id;
      } else {
        idCliente = await buscarOCrearCliente(
          validacionDatosCliente.datos.email,
          validacionDatosCliente.datos.nombre,
          validacionDatosCliente.datos.apellidos,
          validacionDatosCliente.datos.telefono
        );
      }

      // 6. Calcular fecha de validez (15 dias desde emision)
      const fechaValidez = new Date();
      fechaValidez.setDate(fechaValidez.getDate() + 15);

      // 6.b Estado inicial segun quien crea la cotizacion.
      // Admin y vendedor confirman ellos mismos la operacion, por lo que la
      // cotizacion nace 'Confirmada' (no caduca y no requiere paso de ventas).
      // El cliente ('usuario') u origen sin rol privilegiado nace 'Pendiente'.
      const esSolicitantePrivilegiado = rolSolicitante === 'admin' || rolSolicitante === 'vendedor';
      const estadoInicial = esSolicitantePrivilegiado ? 'Confirmada' : 'Pendiente';
      const fechaConfirmacionInicial = esSolicitantePrivilegiado ? new Date() : null;
      const idConfirmadorInicial = esSolicitantePrivilegiado ? (req.usuario?.id || null) : null;

      // 7. Insertar cotización
      const cotizacion = tieneEsquemaFinancieroV2
        ? await cliente.query(
            `INSERT INTO cotizaciones (
              codigo_ticket, id_cliente, fecha_validez, moneda_base,
              subtotal_neto, igv_porcentaje, igv_monto, total_con_igv,
              tipo_cambio_referencia, subtotal_neto_pen, igv_monto_pen, total_con_igv_pen,
              precio_total, margen_aplicado, estado, cantidad_equipos,
              fecha_confirmacion, id_confirmador
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            RETURNING id, codigo_unico, codigo_ticket, fecha_emision,
                      fecha_validez, moneda_base, subtotal_neto, igv_porcentaje, igv_monto,
                      total_con_igv, tipo_cambio_referencia, subtotal_neto_pen, igv_monto_pen,
                      total_con_igv_pen, precio_total, margen_aplicado, estado, cantidad_equipos`,
            [
              codigoTicket,
              idCliente,
              fechaValidez,
              resumenFinanciero.moneda_base,
              resumenFinanciero.subtotal_neto,
              resumenFinanciero.igv_porcentaje,
              resumenFinanciero.igv_monto,
              resumenFinanciero.total_con_igv,
              resumenFinanciero.tipo_cambio_referencia,
              resumenFinanciero.subtotal_neto_pen,
              resumenFinanciero.igv_monto_pen,
              resumenFinanciero.total_con_igv_pen,
              resumenFinanciero.total_con_igv,
              margen,
              estadoInicial,
              cantidadEquipos,
              fechaConfirmacionInicial,
              idConfirmadorInicial
            ]
          )
        : await cliente.query(
            `INSERT INTO cotizaciones (
              codigo_ticket, id_cliente, fecha_validez, precio_total, margen_aplicado, estado, cantidad_equipos,
              fecha_confirmacion, id_confirmador
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, codigo_unico, codigo_ticket, fecha_emision,
                      fecha_validez, precio_total, margen_aplicado, estado, cantidad_equipos`,
            [
              codigoTicket,
              idCliente,
              fechaValidez,
              resumenFinanciero.subtotal_neto,
              margen,
              estadoInicial,
              cantidadEquipos,
              fechaConfirmacionInicial,
              idConfirmadorInicial
            ]
          );

      const cotizacionCreada = cotizacion.rows[0];

      // 8. Insertar detalles de cotización
      const detalles = [];
      for (const comp of componentesConInfo) {
        const costoUnitarioNetoUsd = redondearMoneda(parseFloat(comp.precio_base));
        const precioUnitarioNetoUsd = redondearMoneda(costoUnitarioNetoUsd * (1 + margen / 100));
        const igvUnitarioUsd = redondearMoneda(precioUnitarioNetoUsd * (configuracionFinanciera.tasaIgv / 100));
        const precioUnitarioTotalUsd = redondearMoneda(precioUnitarioNetoUsd + igvUnitarioUsd);

        const detalle = tieneEsquemaFinancieroV2
          ? await cliente.query(
              `INSERT INTO detalle_cotizacion (
                id_cotizacion, id_producto, tabla_producto, nombre_producto, categoria,
                descripcion_tecnica, costo_unitario_neto_usd, margen_aplicado,
                precio_unitario_neto_usd, igv_unitario_usd, precio_unitario_total_usd,
                precio_unitario, cantidad, disponible_stock
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
              RETURNING id, nombre_producto, categoria, tabla_producto, precio_unitario,
                        costo_unitario_neto_usd, margen_aplicado, precio_unitario_neto_usd,
                        igv_unitario_usd, precio_unitario_total_usd, cantidad, disponible_stock`,
              [
                cotizacionCreada.id,
                comp.id,
                comp.tabla_producto,
                comp.nombre,
                comp.categoria,
                comp.descripcion_tecnica,
                costoUnitarioNetoUsd,
                margen,
                precioUnitarioNetoUsd,
                igvUnitarioUsd,
                precioUnitarioTotalUsd,
                precioUnitarioTotalUsd,
                comp.cantidad,
                comp.stock > 0
              ]
            )
          : await cliente.query(
              `INSERT INTO detalle_cotizacion (
                id_cotizacion, id_producto, tabla_producto, nombre_producto, categoria,
                descripcion_tecnica, precio_unitario, cantidad, disponible_stock
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              RETURNING id, nombre_producto, categoria, tabla_producto, precio_unitario,
                        cantidad, disponible_stock`,
              [
                cotizacionCreada.id,
                comp.id,
                comp.tabla_producto,
                comp.nombre,
                comp.categoria,
                comp.descripcion_tecnica,
                costoUnitarioNetoUsd,
                comp.cantidad,
                comp.stock > 0
              ]
            );

        detalles.push(detalle.rows[0]);
      }

      // 9. Insertar notificación si el usuario autenticado tiene rol 'usuario'
      // La inserción ocurre dentro de la misma transacción para garantizar atomicidad.
      // Requisito: 5.3
      if (req.rol === 'usuario' && req.usuario?.id) {
        try {
          await cliente.query(
            `INSERT INTO notificaciones_usuario
               (id_usuario, tipo, titulo, mensaje, datos_extra)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              req.usuario.id,
              'cotizacion_creada',
              'Cotización creada',
              `Tu cotización ${codigoTicket} fue generada exitosamente y es válida por 15 días.`,
              JSON.stringify({ codigoTicket })
            ]
          );
        } catch (errorNotificacion) {
          // No interrumpir la transacción si la tabla aún no existe (entorno sin migración)
          console.error('[crearCotizacion] Error al insertar notificación:', errorNotificacion);
        }
      }

      return {
        cotizacion: cotizacionCreada,
        finanzas: resumenFinanciero,
        detalles
      };
    });

    const finanzas = construirBloqueFinanzas({
      ...resultado.finanzas,
      ...resultado.cotizacion
    });

    res.status(201).json({
      exito: true,
      mensaje: 'CotizaciÃ³n creada exitosamente',
      cotizacion: {
        id: resultado.cotizacion.id,
        codigo_unico: resultado.cotizacion.codigo_unico,
        codigo_ticket: resultado.cotizacion.codigo_ticket,
        fecha_emision: resultado.cotizacion.fecha_emision,
        fecha_validez: resultado.cotizacion.fecha_validez,
        precio_total: parseFloat(resultado.cotizacion.total_con_igv ?? resultado.cotizacion.precio_total),
        ...(esRolPrivilegiado(req.rol) ? { margen_aplicado: parseFloat(resultado.cotizacion.margen_aplicado) } : {}),
        finanzas,
        estado: resultado.cotizacion.estado,
        componentes: resultado.detalles
      }
    });
  } catch (error) {
    console.error('Error al crear cotizaciÃ³n:', error);

    res.status(500).json({
      error: 'Error al crear cotizacion',
      // SEGURIDAD: sin detalles internos en producción
      mensaje: process.env.NODE_ENV === 'production'
        ? 'No se pudo crear la cotizacion'
        : (error.message || 'No se pudo crear la cotizacion')
    });
  }
}


/**
 * Helper de lectura: recupera una cotización y sus detalles por código de ticket,
 * adaptando las columnas consultadas según el esquema financiero (v1 o v2) presente
 * en la BD. Devuelve el objeto ya proyectado, o null si no existe la cotización.
 * (Lo consumen consultarCotizacion, los PDF y la validación.)
 */
async function obtenerCotizacionConDetallesPorTicket(codigoTicket) {
  const tieneEsquemaFinancieroV2 = await usaEsquemaFinancieroV2();
  const cotizacion = await ejecutarQuery(
    tieneEsquemaFinancieroV2
      ? `SELECT 
          c.id, c.codigo_unico, c.codigo_ticket, c.id_cliente,
          c.fecha_emision, c.fecha_validez, c.moneda_base,
          c.subtotal_neto, c.igv_porcentaje, c.igv_monto, c.total_con_igv,
          c.tipo_cambio_referencia, c.subtotal_neto_pen, c.igv_monto_pen, c.total_con_igv_pen,
          c.precio_total, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion,
          uc.nombre_completo AS cliente_nombre, uc.correo_encrypted AS cliente_correo
        FROM cotizaciones c
        LEFT JOIN cuentas uc ON uc.id = c.id_cliente
        WHERE c.codigo_ticket = $1`
      : `SELECT 
          c.id, c.codigo_unico, c.codigo_ticket, c.id_cliente,
          c.fecha_emision, c.fecha_validez,
          c.precio_total, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion,
          uc.nombre_completo AS cliente_nombre, uc.correo_encrypted AS cliente_correo
        FROM cotizaciones c
        LEFT JOIN cuentas uc ON uc.id = c.id_cliente
        WHERE c.codigo_ticket = $1`,
    [codigoTicket]
  );

  if (cotizacion.rows.length === 0) {
    return null;
  }

  const detalles = await ejecutarQuery(
    tieneEsquemaFinancieroV2
      ? `SELECT 
          id, id_producto, nombre_producto, categoria,
          descripcion_tecnica, precio_unitario, cantidad, disponible_stock,
          costo_unitario_neto_usd, margen_aplicado, precio_unitario_neto_usd,
          igv_unitario_usd, precio_unitario_total_usd
        FROM detalle_cotizacion
        WHERE id_cotizacion = $1
        ORDER BY id`
      : `SELECT 
          id, id_producto, nombre_producto, categoria,
          descripcion_tecnica, precio_unitario, cantidad, disponible_stock
        FROM detalle_cotizacion
        WHERE id_cotizacion = $1
        ORDER BY id`,
    [cotizacion.rows[0].id]
  );

  const base = cotizacion.rows[0];
  const estadoNormalizado = normalizarEstadoCotizacion(base.estado);
  const ahora = new Date();
  const fechaValidez = new Date(base.fecha_validez);
  const caducada = ahora > fechaValidez && estadoNormalizado === 'Pendiente';

  return {
    ...base,
    estado: caducada ? 'Caducada' : estadoNormalizado,
    caducada,
    cliente_email: desencriptarSeguro(base.cliente_correo),
    finanzas: construirBloqueFinanzas(base),
    componentes: detalles.rows.map((d) => ({
      id: d.id,
      id_producto: d.id_producto,
      nombre: d.nombre_producto,
      categoria: d.categoria,
      descripcion_tecnica: d.descripcion_tecnica,
      precio_unitario: parseFloat(d.precio_unitario),
      costo_unitario_neto_usd: parseFloat(d.costo_unitario_neto_usd ?? 0),
      margen_aplicado: parseFloat(d.margen_aplicado ?? base.margen_aplicado ?? 0),
      precio_unitario_neto_usd: parseFloat(d.precio_unitario_neto_usd ?? 0),
      igv_unitario_usd: parseFloat(d.igv_unitario_usd ?? 0),
      precio_unitario_total_usd: parseFloat(d.precio_unitario_total_usd ?? d.precio_unitario ?? 0),
      cantidad: d.cantidad,
      disponible_stock: d.disponible_stock
    }))
  };
}

async function consultarCotizacion(req, res) {
  try {
    const { codigoTicket } = req.params;
    const validacion = validarCodigoTicket(codigoTicket);

    if (!validacion.valido) {
      return res.status(400).json({
        error: 'Codigo invalido',
        mensaje: validacion.error,
        codigo: 'CODIGO_INVALIDO'
      });
    }

    const cotizacionData = await obtenerCotizacionConDetallesPorTicket(codigoTicket);

    if (!cotizacionData) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    if (cotizacionData.caducada) {
      return res.status(410).json({
        error: 'Cotizacion caducada',
        mensaje: 'La cotizacion supero su fecha de validez',
        codigo: 'COTIZACION_CADUCADA'
      });
    }

    const privilegiado = esRolPrivilegiado(req.rol);

    const respuesta = {
      id: cotizacionData.id,
      codigo_unico: cotizacionData.codigo_unico,
      codigo_ticket: cotizacionData.codigo_ticket,
      fecha_emision: cotizacionData.fecha_emision,
      fecha_validez: cotizacionData.fecha_validez,
      precio_total: parseFloat(cotizacionData.total_con_igv ?? cotizacionData.precio_total),
      finanzas: cotizacionData.finanzas,
      estado: cotizacionData.estado,
      fecha_reclamacion: cotizacionData.fecha_reclamacion,
      fecha_solicitud_confirmacion: cotizacionData.fecha_solicitud_confirmacion || null,
      fecha_confirmacion: cotizacionData.fecha_confirmacion || null,
      caducada: false,
      componentes: cotizacionData.componentes.map((c) => proyectarComponente(c, privilegiado))
    };
    if (privilegiado) {
      respuesta.margen_aplicado = parseFloat(cotizacionData.margen_aplicado);
    }

    return res.json({ exito: true, cotizacion: respuesta });
  } catch (error) {
    console.error('Error al consultar cotizacion:', error);
    return res.status(500).json({
      error: 'Error al consultar cotizacion',
      mensaje: 'No se pudo recuperar la cotizacion',
      codigo: 'ERROR_CONSULTAR_COTIZACION'
    });
  }
}


/**
 * Validar cotización con comparación de precios
 * 
 * GET /api/cotizaciones/:codigoTicket/validar
 * 
 * @param {Object} req - Request de Express
 * @param {Object} res - Response de Express
 */
async function validarCotizacion(req, res) {
  try {
    const { codigoTicket } = req.params;
    const validacion = validarCodigoTicket(codigoTicket);

    if (!validacion.valido) {
      return res.status(400).json({
        error: 'Codigo invalido',
        mensaje: validacion.error,
        codigo: 'CODIGO_INVALIDO'
      });
    }

    const tieneEsquemaFinancieroV2 = await usaEsquemaFinancieroV2();
    const cotizacion = await ejecutarQuery(
      tieneEsquemaFinancieroV2
        ? `SELECT 
            c.id, c.codigo_ticket, c.fecha_emision, c.fecha_validez,
            c.moneda_base, c.subtotal_neto, c.igv_porcentaje, c.igv_monto, c.total_con_igv,
            c.tipo_cambio_referencia, c.subtotal_neto_pen, c.igv_monto_pen, c.total_con_igv_pen,
            c.precio_total, c.margen_aplicado, c.estado
          FROM cotizaciones c
          WHERE c.codigo_ticket = $1`
        : `SELECT 
            c.id, c.codigo_ticket, c.fecha_emision, c.fecha_validez,
            c.precio_total, c.margen_aplicado, c.estado
          FROM cotizaciones c
          WHERE c.codigo_ticket = $1`,
      [codigoTicket]
    );

    if (cotizacion.rows.length === 0) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        valida: false,
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    const cotizacionData = cotizacion.rows[0];
    const estadoNormalizado = normalizarEstadoCotizacion(cotizacionData.estado);

    const ahora = new Date();
    const fechaValidez = new Date(cotizacionData.fecha_validez);
    const caducada = ahora > fechaValidez && estadoNormalizado === 'Pendiente';

    if (caducada) {
      return res.status(410).json({
        exito: true,
        valida: false,
        mensaje: 'Cotizacion caducada',
        codigo: 'COTIZACION_CADUCADA',
        cotizacion: {
          codigo_ticket: cotizacionData.codigo_ticket,
          fecha_emision: cotizacionData.fecha_emision,
          fecha_validez: cotizacionData.fecha_validez,
          estado: 'Caducada'
        }
      });
    }

    const detalles = await ejecutarQuery(
      tieneEsquemaFinancieroV2
        ? 'SELECT dc.id, dc.id_producto, dc.nombre_producto, dc.categoria, dc.costo_unitario_neto_usd as costo_historico, dc.precio_unitario_total_usd as precio_historico_total, dc.cantidad, dc.disponible_stock as stock_historico, p.precio_base as precio_actual, p.stock as stock_actual, p.disponible_a_pedido FROM detalle_cotizacion dc LEFT JOIN productos p ON dc.id_producto = p.id WHERE dc.id_cotizacion = $1 ORDER BY dc.id'
        : 'SELECT dc.id, dc.id_producto, dc.nombre_producto, dc.categoria, dc.precio_unitario as precio_historico_total, dc.cantidad, dc.disponible_stock as stock_historico, p.precio_base as precio_actual, p.stock as stock_actual, p.disponible_a_pedido FROM detalle_cotizacion dc LEFT JOIN productos p ON dc.id_producto = p.id WHERE dc.id_cotizacion = $1 ORDER BY dc.id',
      [cotizacionData.id]
    );

    const margen = parseFloat(cotizacionData.margen_aplicado);
    const tasaIgv = tieneEsquemaFinancieroV2
      ? parseNumeroSeguro(cotizacionData.igv_porcentaje, DEFAULT_IGV)
      : 0;
    const tipoCambio = parseNumeroSeguro(cotizacionData.tipo_cambio_referencia, DEFAULT_TIPO_CAMBIO);

    let costoNetoActual = 0;

    const componentesComparacion = detalles.rows.map((d) => {
      const costoHistoricoUnitario = parseNumeroSeguro(d.costo_historico, d.precio_historico_total);
      const costoActualUnitario = parseNumeroSeguro(d.precio_actual, costoHistoricoUnitario);
      const cantidad = parseNumeroSeguro(d.cantidad, 1);

      const precioHistoricoUnitarioTotal = tieneEsquemaFinancieroV2
        ? parseNumeroSeguro(
            d.precio_historico_total,
            redondearMoneda(costoHistoricoUnitario * (1 + margen / 100) * (1 + tasaIgv / 100))
          )
        : redondearMoneda(costoHistoricoUnitario * (1 + margen / 100) * (1 + tasaIgv / 100));
      const precioActualUnitarioTotal = redondearMoneda(costoActualUnitario * (1 + margen / 100) * (1 + tasaIgv / 100));

      const subtotalHistorico = redondearMoneda(precioHistoricoUnitarioTotal * cantidad);
      const subtotalActual = redondearMoneda(precioActualUnitarioTotal * cantidad);
      const diferencia = redondearMoneda(subtotalActual - subtotalHistorico);

      costoNetoActual += costoActualUnitario * cantidad;

      return {
        id_producto: d.id_producto,
        nombre: d.nombre_producto,
        categoria: d.categoria,
        cantidad,
        precio_historico: precioHistoricoUnitarioTotal,
        precio_actual: precioActualUnitarioTotal,
        diferencia_unitaria: redondearMoneda(precioActualUnitarioTotal - precioHistoricoUnitarioTotal),
        subtotal_historico: subtotalHistorico,
        subtotal_actual: subtotalActual,
        diferencia_subtotal: diferencia,
        stock_historico: d.stock_historico,
        stock_actual: d.stock_actual || 0,
        disponible_a_pedido: d.disponible_a_pedido || false,
        disponible: (d.stock_actual > 0) || d.disponible_a_pedido
      };
    });

    const resumenActual = calcularResumenFinanciero(costoNetoActual, margen, tasaIgv, tipoCambio);
    const precioTotalActual = tieneEsquemaFinancieroV2
      ? resumenActual.total_con_igv
      : resumenActual.subtotal_neto;

    const precioTotalHistorico = parseNumeroSeguro(cotizacionData.total_con_igv, cotizacionData.precio_total);
    const diferenciaTotalPrecio = redondearMoneda(precioTotalActual - precioTotalHistorico);
    const finanzasHistoricas = construirBloqueFinanzas(cotizacionData);
    const finanzasActuales = construirBloqueFinanzas(resumenActual);

    return res.json({
      exito: true,
      valida: true,
      cotizacion: {
        codigo_ticket: cotizacionData.codigo_ticket,
        fecha_emision: cotizacionData.fecha_emision,
        fecha_validez: cotizacionData.fecha_validez,
        estado: estadoNormalizado,
        ...(esRolPrivilegiado(req.rol) ? { margen_aplicado: margen } : {}),
        precio_total_historico: precioTotalHistorico,
        precio_total_actual: precioTotalActual,
        diferencia_total: diferenciaTotalPrecio,
        finanzas: {
          historico: finanzasHistoricas,
          actual: finanzasActuales
        },
        hay_cambios_precio: Math.abs(diferenciaTotalPrecio) > 0.01,
        componentes: componentesComparacion
      }
    });
  } catch (error) {
    console.error('Error al validar cotizacion:', error);
    return res.status(500).json({
      error: 'Error al validar cotizacion',
      mensaje: 'No se pudo validar la cotizacion',
      codigo: 'ERROR_VALIDAR_COTIZACION'
    });
  }
}


/**
 * Adapta los datos de una cotización al formato que espera servicioPDF: mapea los
 * componentes (precio USD/PEN, stock/a pedido) y arma el total en ambas monedas.
 */
function construirDatosPdf(cotizacionData) {
  const tipoCambio = parseNumeroSeguro(cotizacionData.tipo_cambio_referencia, DEFAULT_TIPO_CAMBIO);
  const componentes = (cotizacionData.componentes || []).map((comp) => ({
    categoria: comp.categoria,
    nombre: comp.nombre,
    precioBaseUsd: Number(comp.precio_unitario_total_usd || comp.precio_unitario_neto_usd || comp.costo_unitario_neto_usd || comp.precio_unitario || 0),
    stock: comp.disponible_stock ? 1 : 0,
    disponibleAPedido: !comp.disponible_stock,
    tiempoEntregaDias: comp.disponible_stock ? 0 : 3
  })).map((comp) => ({
    ...comp,
    precioBasePen: redondearMoneda(comp.precioBaseUsd * tipoCambio)
  }));

  const totalUsd = Number(cotizacionData.total_con_igv || cotizacionData.precio_total || 0);
  const totalPen = parseNumeroSeguro(cotizacionData.total_con_igv_pen, totalUsd * tipoCambio);

  return {
    codigoTicket: cotizacionData.codigo_ticket,
    codigoUnico: cotizacionData.codigo_unico,
    fechaEmision: cotizacionData.fecha_emision,
    fechaValidez: cotizacionData.fecha_validez,
    estado: cotizacionData.estado,
    tipoCambioUsdPen: tipoCambio,
    componentes,
    precioTotal: {
      usd: totalUsd,
      pen: totalPen
    }
  };
}

/** Normaliza la moneda solicitada para el PDF a 'PEN' o 'USD' (por defecto 'USD'). */
function resolverMonedaPdf(valor) {
  const moneda = String(valor || 'USD').toUpperCase();
  return moneda === 'PEN' ? 'PEN' : 'USD';
}

/**
 * Verifica que el solicitante pueda acceder a la cotizacion:
 * admin/vendedor siempre; rol usuario solo si es el dueno.
 */
function puedeAccederCotizacion(req, cotizacionData) {
  if (esRolPrivilegiado(req.rol)) return true;
  return cotizacionData.id_cliente != null && cotizacionData.id_cliente === req.usuario?.id;
}

/**
 * GET /api/cotizaciones/:codigoTicket/pdf
 * Genera y descarga el PDF comercial de la cotización (con precios). Valida el ticket,
 * el acceso del solicitante (dueño o rol privilegiado) y que la cotización no esté caducada.
 */
async function obtenerPdfCotizacion(req, res) {
  try {
    const { codigoTicket } = req.params;
    const moneda = resolverMonedaPdf(req.query?.moneda);
    const validacion = validarCodigoTicket(codigoTicket);

    if (!validacion.valido) {
      return res.status(400).json({ error: 'Codigo invalido', mensaje: validacion.error, codigo: 'CODIGO_INVALIDO' });
    }

    const cotizacionData = await obtenerCotizacionConDetallesPorTicket(codigoTicket);
    if (!cotizacionData) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    if (!puedeAccederCotizacion(req, cotizacionData)) {
      return res.status(403).json({
        error: 'Acceso restringido',
        mensaje: 'Solo puedes descargar tus propias cotizaciones',
        codigo: 'COTIZACION_NO_PROPIA'
      });
    }

    if (cotizacionData.caducada) {
      return res.status(410).json({
        error: 'Cotizacion caducada',
        mensaje: 'La cotizacion supero su fecha de validez',
        codigo: 'COTIZACION_CADUCADA'
      });
    }

    const buffer = await servicioPDF.generarPDFCotizacion(construirDatosPdf(cotizacionData), { moneda });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=\"cotizacion-${codigoTicket}.pdf\"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error al generar PDF de cotizacion:', error);
    res.status(500).json({
      error: 'Error al generar PDF',
      mensaje: 'No se pudo generar el PDF comercial',
      codigo: 'ERROR_PDF_COTIZACION'
    });
  }
}

/**
 * GET /api/cotizaciones/:codigoTicket/pdf-tecnico
 * Genera y descarga el PDF de listado técnico (sin precios). Mismas validaciones de
 * ticket y acceso que el PDF comercial.
 */
async function obtenerPdfTecnico(req, res) {
  try {
    const { codigoTicket } = req.params;
    const moneda = resolverMonedaPdf(req.query?.moneda);
    const validacion = validarCodigoTicket(codigoTicket);

    if (!validacion.valido) {
      return res.status(400).json({ error: 'Codigo invalido', mensaje: validacion.error, codigo: 'CODIGO_INVALIDO' });
    }

    const cotizacionData = await obtenerCotizacionConDetallesPorTicket(codigoTicket);
    if (!cotizacionData) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    if (!puedeAccederCotizacion(req, cotizacionData)) {
      return res.status(403).json({
        error: 'Acceso restringido',
        mensaje: 'Solo puedes descargar tus propias cotizaciones',
        codigo: 'COTIZACION_NO_PROPIA'
      });
    }

    const dataPdf = construirDatosPdf(cotizacionData);
    const buffer = await servicioPDF.generarPDFListado(dataPdf.codigoTicket, dataPdf.componentes, { moneda });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=\"listado-tecnico-${codigoTicket}.pdf\"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error al generar PDF tecnico:', error);
    res.status(500).json({
      error: 'Error al generar PDF',
      mensaje: 'No se pudo generar el PDF tecnico',
      codigo: 'ERROR_PDF_TECNICO'
    });
  }
}

/** Registra en `notificaciones_cotizacion` un intento de aviso 'listo_recojo' en estado pendiente; devuelve su id o null. */
async function registrarIntentoNotificacion(idCotizacion, emailDestino, payload) {
  try {
    const r = await ejecutarQuery(
      `INSERT INTO notificaciones_cotizacion (
        id_cotizacion, tipo, email_destino, estado, payload, fecha_intento
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING id`,
      [idCotizacion, 'listo_recojo', emailDestino, 'pendiente', JSON.stringify(payload || {})]
    );
    return r.rows[0]?.id || null;
  } catch (error) {
    return null;
  }
}

/** Actualiza el estado de un intento de notificación (enviada/fallida) y sella la fecha de envío si corresponde. */
async function actualizarIntentoNotificacion(idNotificacion, estado, detalle) {
  if (!idNotificacion) return;
  try {
    await ejecutarQuery(
      `UPDATE notificaciones_cotizacion
       SET estado = $1,
           mensaje_error = $2,
           respuesta = $3,
           fecha_envio = CASE WHEN $1 = 'enviada' THEN CURRENT_TIMESTAMP ELSE fecha_envio END
       WHERE id = $4`,
      [
        estado,
        detalle?.mensaje_error || null,
        JSON.stringify(detalle || {}),
        idNotificacion
      ]
    );
  } catch (error) {
    // no-op
  }
}

/**
 * POST /api/cotizaciones/:codigoTicket/notificar-listo
 * Envía al cliente el correo de "equipo listo para recoger", registrando el intento y
 * su resultado en `notificaciones_cotizacion`. Solo admin/vendedor. (Requisitos 9.x)
 */
async function notificarCotizacionLista(req, res) {
  try {
    const { codigoTicket } = req.params;
    const validacion = validarCodigoTicket(codigoTicket);

    if (!validacion.valido) {
      return res.status(400).json({ error: 'Codigo invalido', mensaje: validacion.error, codigo: 'CODIGO_INVALIDO' });
    }

    const cotizacionData = await obtenerCotizacionConDetallesPorTicket(codigoTicket);
    if (!cotizacionData) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    if (!cotizacionData.cliente_email) {
      return res.status(400).json({
        error: 'Sin email de cliente',
        mensaje: 'La cotizacion no tiene email asociado para notificar',
        codigo: 'EMAIL_CLIENTE_NO_DISPONIBLE'
      });
    }

    const intentoId = await registrarIntentoNotificacion(cotizacionData.id, cotizacionData.cliente_email, {
      codigo_ticket: cotizacionData.codigo_ticket,
      estado: cotizacionData.estado
    });

    try {
      const resultado = await enviarNotificacionListo({
        para: cotizacionData.cliente_email,
        codigoTicket: cotizacionData.codigo_ticket,
        estado: cotizacionData.estado,
        fechaEmision: cotizacionData.fecha_emision,
        fechaValidez: cotizacionData.fecha_validez
      });

      await actualizarIntentoNotificacion(intentoId, 'enviada', resultado);

      return res.json({
        exito: true,
        mensaje: 'Correo enviado al cliente.',
        notificacion: {
          estado: 'enviada',
          destino: cotizacionData.cliente_email,
          modo: resultado.modo
        }
      });
    } catch (errorEnvio) {
      await actualizarIntentoNotificacion(intentoId, 'fallida', {
        mensaje_error: errorEnvio.message
      });

      return res.status(500).json({
        error: 'Error al enviar notificacion',
        mensaje: 'No se pudo enviar la notificacion al cliente',
        codigo: 'ERROR_NOTIFICACION_EMAIL'
      });
    }
  } catch (error) {
    console.error('Error al notificar cotizacion lista:', error);
    return res.status(500).json({
      error: 'Error interno',
      mensaje: 'No se pudo procesar la notificacion',
      codigo: 'ERROR_INTERNO_NOTIFICACION'
    });
  }
}

/**
 * PUT /api/cotizaciones/:codigoTicket/reclamar
 * Marca una cotización como reclamada/completada (estado 'Completada'). Solo admin/vendedor.
 * Body opcional: { id_vendedor }.
 */
async function marcarComoReclamada(req, res) {
  try {
    const { codigoTicket } = req.params;
    const datosSanitizados = sanitizarObjeto(req.body);

    const validacion = validarCodigoTicket(codigoTicket);
    if (!validacion.valido) {
      return res.status(400).json({
        error: 'Codigo invalido',
        mensaje: validacion.error,
        codigo: 'CODIGO_INVALIDO'
      });
    }

    const cotizacion = await ejecutarQuery(
      'SELECT id, estado, fecha_validez FROM cotizaciones WHERE codigo_ticket = $1',
      [codigoTicket]
    );

    if (cotizacion.rows.length === 0) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    const cotizacionData = cotizacion.rows[0];
    const estadoActual = normalizarEstadoCotizacion(cotizacionData.estado);

    // Se puede completar la venta desde 'Pendiente' (sin confirmar) o 'Confirmada'.
    if (estadoActual !== 'Pendiente' && estadoActual !== 'Confirmada') {
      return res.status(400).json({
        error: 'Estado invalido',
        mensaje: `La cotizacion ya esta en estado: ${estadoActual}`,
        codigo: 'ESTADO_NO_PERMITE_RECLAMO'
      });
    }

    // Al completar la venta: marcar Completada y DESCONTAR stock de cada producto
    // (cantidad del detalle ya incluye el multiplicador de equipos). Atomico.
    const resultado = await ejecutarTransaccion(async (clienteTx) => {
      const upd = await clienteTx.query(
        'UPDATE cotizaciones SET estado = $1, fecha_reclamacion = CURRENT_TIMESTAMP, id_vendedor = $2 WHERE id = $3 RETURNING id, codigo_ticket, estado, fecha_reclamacion',
        [ESTADO_COMPLETADA, datosSanitizados.id_vendedor || null, cotizacionData.id]
      );

      // Descontar stock por producto (solo los que aún existen). No baja de 0.
      await clienteTx.query(
        `UPDATE productos p
            SET stock = GREATEST(p.stock - d.total, 0), updated_at = CURRENT_TIMESTAMP
           FROM (
             SELECT id_producto, SUM(cantidad)::int AS total
               FROM detalle_cotizacion
              WHERE id_cotizacion = $1 AND id_producto IS NOT NULL
              GROUP BY id_producto
           ) d
          WHERE p.id = d.id_producto`,
        [cotizacionData.id]
      );

      return upd;
    });

    return res.json({
      exito: true,
      mensaje: 'Cotizacion marcada como completada',
      cotizacion: {
        id: resultado.rows[0].id,
        codigo_ticket: resultado.rows[0].codigo_ticket,
        estado: normalizarEstadoCotizacion(resultado.rows[0].estado),
        fecha_reclamacion: resultado.rows[0].fecha_reclamacion
      }
    });
  } catch (error) {
    console.error('Error al marcar cotizacion como completada:', error);
    return res.status(500).json({
      error: 'Error al actualizar cotizacion',
      mensaje: 'No se pudo marcar la cotizacion como completada',
      codigo: 'ERROR_ACTUALIZAR_ESTADO'
    });
  }
}


/**
 * Consultar historial de cotizaciones por cliente
 * 
 * GET /api/cotizaciones/cliente/:email
 * 
 * @param {Object} req - Request de Express
 * @param {Object} res - Response de Express
 */
async function consultarHistorialCliente(req, res) {
  try {
    const { email } = req.params;

    const validacionEmail = validarEmail(email);
    if (!validacionEmail.valido) {
      return res.status(400).json({
        error: 'Email invalido',
        mensaje: validacionEmail.error
      });
    }

    const emailHash = hashBusqueda(validacionEmail.email);

    const cliente = await ejecutarQuery('SELECT id, nombre_completo AS nombre FROM cuentas WHERE correo_hash = $1', [emailHash]);

    // SEGURIDAD: un usuario regular solo puede consultar su propio historial;
    // admin y vendedor pueden consultar cualquier cliente.
    if (!esRolPrivilegiado(req.rol)) {
      const esPropio = cliente.rows.length > 0 && cliente.rows[0].id === req.usuario?.id;
      if (!esPropio) {
        return res.status(403).json({
          error: 'Acceso restringido',
          mensaje: 'Solo puedes consultar tu propio historial de cotizaciones'
        });
      }
    }

    if (cliente.rows.length === 0) {
      return res.json({
        exito: true,
        mensaje: 'No se encontraron cotizaciones para este email',
        cantidad: 0,
        cotizaciones: []
      });
    }

    const clienteData = cliente.rows[0];
    const tieneEsquemaFinancieroV2 = await usaEsquemaFinancieroV2();

    let cotizaciones;
    try {
      cotizaciones = await ejecutarQuery(
        tieneEsquemaFinancieroV2
          ? 'SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez, c.precio_total, c.total_con_igv, c.subtotal_neto, c.igv_porcentaje, c.igv_monto, c.tipo_cambio_referencia, c.subtotal_neto_pen, c.igv_monto_pen, c.total_con_igv_pen, c.moneda_base, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion, COUNT(dc.id) as cantidad_componentes, n.estado as estado_notificacion, n.fecha_envio as fecha_notificacion FROM cotizaciones c LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion LEFT JOIN LATERAL (SELECT nc.estado, nc.fecha_envio FROM notificaciones_cotizacion nc WHERE nc.id_cotizacion = c.id ORDER BY nc.fecha_intento DESC LIMIT 1) n ON TRUE WHERE c.id_cliente = $1 GROUP BY c.id, n.estado, n.fecha_envio ORDER BY c.fecha_emision DESC'
          : 'SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez, c.precio_total, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion, COUNT(dc.id) as cantidad_componentes, n.estado as estado_notificacion, n.fecha_envio as fecha_notificacion FROM cotizaciones c LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion LEFT JOIN LATERAL (SELECT nc.estado, nc.fecha_envio FROM notificaciones_cotizacion nc WHERE nc.id_cotizacion = c.id ORDER BY nc.fecha_intento DESC LIMIT 1) n ON TRUE WHERE c.id_cliente = $1 GROUP BY c.id, n.estado, n.fecha_envio ORDER BY c.fecha_emision DESC',
        [clienteData.id]
      );
    } catch (errorNotificaciones) {
      cotizaciones = await ejecutarQuery(
        tieneEsquemaFinancieroV2
          ? 'SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez, c.precio_total, c.total_con_igv, c.subtotal_neto, c.igv_porcentaje, c.igv_monto, c.tipo_cambio_referencia, c.subtotal_neto_pen, c.igv_monto_pen, c.total_con_igv_pen, c.moneda_base, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion, COUNT(dc.id) as cantidad_componentes FROM cotizaciones c LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion WHERE c.id_cliente = $1 GROUP BY c.id ORDER BY c.fecha_emision DESC'
          : 'SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez, c.precio_total, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion, COUNT(dc.id) as cantidad_componentes FROM cotizaciones c LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion WHERE c.id_cliente = $1 GROUP BY c.id ORDER BY c.fecha_emision DESC',
        [clienteData.id]
      );
    }

    return res.json({
      exito: true,
      cliente: {
        nombre: clienteData.nombre,
        email: validacionEmail.email
      },
      cantidad: cotizaciones.rows.length,
      cotizaciones: cotizaciones.rows.map((c) => ({
        id: c.id,
        codigo_unico: c.codigo_unico,
        codigo_ticket: c.codigo_ticket,
        fecha_emision: c.fecha_emision,
        fecha_validez: c.fecha_validez,
        precio_total: parseFloat(c.total_con_igv ?? c.precio_total),
        ...(esRolPrivilegiado(req.rol) ? { margen_aplicado: parseFloat(c.margen_aplicado) } : {}),
        finanzas: construirBloqueFinanzas(c),
        estado: normalizarEstadoCotizacion(c.estado),
        fecha_reclamacion: c.fecha_reclamacion,
        fecha_solicitud_confirmacion: c.fecha_solicitud_confirmacion || null,
        fecha_confirmacion: c.fecha_confirmacion || null,
        cantidad_componentes: parseInt(c.cantidad_componentes, 10),
        notificacion: c.estado_notificacion
          ? { estado: c.estado_notificacion, fecha_envio: c.fecha_notificacion || null }
          : null
      }))
    });
  } catch (error) {
    console.error('Error al consultar historial:', error);
    return res.status(500).json({
      error: 'Error al consultar historial',
      mensaje: 'No se pudo recuperar el historial de cotizaciones'
    });
  }
}


/**
 * Obtener cotizaciones propias del usuario autenticado
 *
 * GET /api/cotizaciones/propias
 * Requiere autenticación (verificarTokenUsuario).
 *
 * El id del usuario se obtiene exclusivamente del token JWT (req.usuario.id).
 * No acepta parámetros de identificación en query string ni body.
 *
 * Retorna la misma estructura que GET /api/cotizaciones/cliente/:email
 * para mantener compatibilidad con el frontend existente.
 *
 * Requisitos: 5.1, 5.8, 5.9
 */
async function obtenerPropias(req, res) {
  try {
    // El id del usuario proviene exclusivamente del token JWT
    const idUsuario = req.usuario?.id;

    if (!idUsuario) {
      return res.status(401).json({
        error: 'No autorizado',
        mensaje: 'Se requiere autenticación para acceder a este recurso.',
        codigo: 'NO_AUTORIZADO'
      });
    }

    // Obtener datos del usuario autenticado
    const cuentaResult = await ejecutarQuery(
      'SELECT id, nombre_completo AS nombre, correo_encrypted AS correo_encriptado FROM cuentas WHERE id = $1',
      [idUsuario]
    );

    if (cuentaResult.rows.length === 0) {
      return res.status(401).json({
        error: 'No autorizado',
        mensaje: 'No se encontró la cuenta del usuario autenticado.',
        codigo: 'NO_AUTORIZADO'
      });
    }

    const cuenta = cuentaResult.rows[0];
    const emailDesencriptado = desencriptarSeguro(cuenta.correo_encriptado);

    const tieneEsquemaFinancieroV2 = await usaEsquemaFinancieroV2();

    let cotizaciones;
    try {
      cotizaciones = await ejecutarQuery(
        tieneEsquemaFinancieroV2
          ? `SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez,
                    c.precio_total, c.total_con_igv, c.subtotal_neto, c.igv_porcentaje, c.igv_monto,
                    c.tipo_cambio_referencia, c.subtotal_neto_pen, c.igv_monto_pen, c.total_con_igv_pen,
                    c.moneda_base, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion,
                    COUNT(dc.id) AS cantidad_componentes,
                    n.estado AS estado_notificacion,
                    n.fecha_envio AS fecha_notificacion
             FROM cotizaciones c
             LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion
             LEFT JOIN LATERAL (
               SELECT nc.estado, nc.fecha_envio
               FROM notificaciones_cotizacion nc
               WHERE nc.id_cotizacion = c.id
               ORDER BY nc.fecha_intento DESC
               LIMIT 1
             ) n ON TRUE
             WHERE c.id_cliente = $1
             GROUP BY c.id, n.estado, n.fecha_envio
             ORDER BY c.fecha_emision DESC`
          : `SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez,
                    c.precio_total, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion,
                    COUNT(dc.id) AS cantidad_componentes,
                    n.estado AS estado_notificacion,
                    n.fecha_envio AS fecha_notificacion
             FROM cotizaciones c
             LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion
             LEFT JOIN LATERAL (
               SELECT nc.estado, nc.fecha_envio
               FROM notificaciones_cotizacion nc
               WHERE nc.id_cotizacion = c.id
               ORDER BY nc.fecha_intento DESC
               LIMIT 1
             ) n ON TRUE
             WHERE c.id_cliente = $1
             GROUP BY c.id, n.estado, n.fecha_envio
             ORDER BY c.fecha_emision DESC`,
        [idUsuario]
      );
    } catch (_errorNotificaciones) {
      // Fallback sin JOIN a notificaciones_cotizacion (tabla puede no existir en entornos sin migración)
      cotizaciones = await ejecutarQuery(
        tieneEsquemaFinancieroV2
          ? `SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez,
                    c.precio_total, c.total_con_igv, c.subtotal_neto, c.igv_porcentaje, c.igv_monto,
                    c.tipo_cambio_referencia, c.subtotal_neto_pen, c.igv_monto_pen, c.total_con_igv_pen,
                    c.moneda_base, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion,
                    COUNT(dc.id) AS cantidad_componentes
             FROM cotizaciones c
             LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion
             WHERE c.id_cliente = $1
             GROUP BY c.id
             ORDER BY c.fecha_emision DESC`
          : `SELECT c.id, c.codigo_unico, c.codigo_ticket, c.fecha_emision, c.fecha_validez,
                    c.precio_total, c.margen_aplicado, c.estado, c.fecha_reclamacion, c.fecha_solicitud_confirmacion, c.fecha_confirmacion,
                    COUNT(dc.id) AS cantidad_componentes
             FROM cotizaciones c
             LEFT JOIN detalle_cotizacion dc ON c.id = dc.id_cotizacion
             WHERE c.id_cliente = $1
             GROUP BY c.id
             ORDER BY c.fecha_emision DESC`,
        [idUsuario]
      );
    }

    return res.json({
      exito: true,
      cliente: {
        nombre: cuenta.nombre,
        email: emailDesencriptado
      },
      cantidad: cotizaciones.rows.length,
      cotizaciones: cotizaciones.rows.map((c) => ({
        id: c.id,
        codigo_unico: c.codigo_unico,
        codigo_ticket: c.codigo_ticket,
        fecha_emision: c.fecha_emision,
        fecha_validez: c.fecha_validez,
        precio_total: parseFloat(c.total_con_igv ?? c.precio_total),
        ...(esRolPrivilegiado(req.rol) ? { margen_aplicado: parseFloat(c.margen_aplicado) } : {}),
        finanzas: construirBloqueFinanzas(c),
        estado: normalizarEstadoCotizacion(c.estado),
        fecha_reclamacion: c.fecha_reclamacion,
        fecha_solicitud_confirmacion: c.fecha_solicitud_confirmacion || null,
        fecha_confirmacion: c.fecha_confirmacion || null,
        cantidad_componentes: parseInt(c.cantidad_componentes, 10),
        notificacion: c.estado_notificacion
          ? { estado: c.estado_notificacion, fecha_envio: c.fecha_notificacion || null }
          : null
      }))
    });
  } catch (error) {
    console.error('[obtenerPropias] Error al consultar cotizaciones propias:', error);
    return res.status(500).json({
      error: 'Error al consultar cotizaciones',
      mensaje: 'No se pudo recuperar el historial de cotizaciones propias.',
      codigo: 'ERROR_INTERNO'
    });
  }
}

/**
 * Listar todos los clientes registrados con al menos una cotización
 * 
 * GET /api/cotizaciones/clientes
 * Requiere autenticación (solo admin)
 */
async function listarClientesRegistrados(req, res) {
  try {
    const resultado = await ejecutarQuery(
      `SELECT uc.id, uc.nombre_completo AS nombre, uc.correo_encrypted AS correo_encriptado, COUNT(c.id) AS total_cotizaciones,
              MAX(c.fecha_emision) AS ultima_cotizacion
       FROM cuentas uc
       LEFT JOIN cotizaciones c ON c.id_cliente = uc.id
       WHERE uc.rol = 'usuario'
       GROUP BY uc.id, uc.nombre_completo, uc.correo_encrypted
       ORDER BY ultima_cotizacion DESC NULLS LAST`
    );

    const clientes = resultado.rows.map((row) => {
      let email = null;
      try {
        email = row.correo_encriptado ? desencriptar(row.correo_encriptado) : null;
      } catch (_) {
        email = null;
      }
      return {
        id: row.id,
        nombre: row.nombre,
        email,
        total_cotizaciones: parseInt(row.total_cotizaciones, 10),
        ultima_cotizacion: row.ultima_cotizacion
      };
    });

    return res.json({ exito: true, clientes });
  } catch (error) {
    console.error('Error al listar clientes:', error);
    return res.status(500).json({
      error: 'Error al listar clientes',
      mensaje: 'No se pudo recuperar la lista de clientes registrados'
    });
  }
}

/**
 * Exportar cotización a Excel
 *
 * GET /api/cotizaciones/:codigoTicket/excel
 * Requiere autenticación (verificarTokenUsuario).
 *
 * Responde con un archivo .xlsx descargable.
 * HTTP 400 si el formato del ticket es inválido.
 * HTTP 404 si la cotización no existe.
 *
 * Requisitos: 2.1, 2.3, 2.4, 2.5
 */
async function exportarExcel(req, res) {
  try {
    const { codigoTicket } = req.params;

    // Validar formato del ticket (NSG-YYYY-NNNN)
    const validacion = validarCodigoTicket(codigoTicket);
    if (!validacion.valido) {
      return res.status(400).json({
        error: 'Codigo invalido',
        mensaje: validacion.error,
        codigo: 'CODIGO_INVALIDO'
      });
    }

    // Consultar cotización con detalles
    const cotizacionData = await obtenerCotizacionConDetallesPorTicket(codigoTicket);
    if (!cotizacionData) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    // Generar buffer Excel
    const buffer = servicioExcel.generarExcelCotizacion({
      codigo_ticket: cotizacionData.codigo_ticket,
      fecha_emision: cotizacionData.fecha_emision,
      fecha_validez: cotizacionData.fecha_validez,
      precio_total: parseFloat(cotizacionData.total_con_igv ?? cotizacionData.precio_total ?? 0),
      componentes: cotizacionData.componentes
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cotizacion-${codigoTicket}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error al exportar Excel de cotizacion:', error);
    res.status(500).json({
      error: 'Error al generar Excel',
      mensaje: 'No se pudo generar el archivo Excel de la cotizacion',
      codigo: 'ERROR_EXCEL_COTIZACION'
    });
  }
}

/**
 * Confirmar (verificar) una cotización — solo admin/vendedor.
 *
 * PUT /api/cotizaciones/:codigoTicket/confirmar
 *
 * Transición 'Pendiente' (sin confirmar) → 'Confirmada'. Una vez confirmada,
 * la cotización ya no caduca y queda fijada. NO mueve stock (negocio a pedido).
 */
async function confirmarCotizacion(req, res) {
  try {
    const { codigoTicket } = req.params;

    const validacion = validarCodigoTicket(codigoTicket);
    if (!validacion.valido) {
      return res.status(400).json({
        error: 'Codigo invalido',
        mensaje: validacion.error,
        codigo: 'CODIGO_INVALIDO'
      });
    }

    const cotizacion = await ejecutarQuery(
      'SELECT id, estado FROM cotizaciones WHERE codigo_ticket = $1',
      [codigoTicket]
    );

    if (cotizacion.rows.length === 0) {
      return res.status(404).json({
        error: 'Cotizacion no encontrada',
        mensaje: 'No existe una cotizacion con ese codigo',
        codigo: 'COTIZACION_NO_ENCONTRADA'
      });
    }

    const estadoActual = normalizarEstadoCotizacion(cotizacion.rows[0].estado);
    if (estadoActual !== 'Pendiente') {
      return res.status(400).json({
        error: 'Estado invalido',
        mensaje: `Solo se puede confirmar una cotizacion sin confirmar. Estado actual: ${estadoActual}`,
        codigo: 'ESTADO_NO_PERMITE_CONFIRMAR'
      });
    }

    const resultado = await ejecutarQuery(
      `UPDATE cotizaciones
          SET estado = 'Confirmada', fecha_confirmacion = CURRENT_TIMESTAMP, id_confirmador = $2
        WHERE id = $1
        RETURNING id, codigo_ticket, estado, fecha_confirmacion`,
      [cotizacion.rows[0].id, req.usuario?.id || null]
    );

    return res.json({
      exito: true,
      mensaje: 'Cotizacion confirmada',
      cotizacion: {
        id: resultado.rows[0].id,
        codigo_ticket: resultado.rows[0].codigo_ticket,
        estado: resultado.rows[0].estado,
        fecha_confirmacion: resultado.rows[0].fecha_confirmacion
      }
    });
  } catch (error) {
    console.error('Error al confirmar cotizacion:', error);
    return res.status(500).json({
      error: 'Error al confirmar cotizacion',
      mensaje: 'No se pudo confirmar la cotizacion',
      codigo: 'ERROR_CONFIRMAR_COTIZACION'
    });
  }
}

/**
 * Registrar que el cliente solicitó confirmar su cotización (contacto a
 * ventas por WhatsApp).
 *
 * POST /api/cotizaciones/:codigoTicket/solicitar-confirmacion
 *
 * Idempotente: solo marca la primera vez y solo sobre cotizaciones 'Pendiente'.
 * No requiere rol privilegiado: identifica por código de ticket.
 */
async function solicitarConfirmacion(req, res) {
  try {
    const { codigoTicket } = req.params;

    const validacion = validarCodigoTicket(codigoTicket);
    if (!validacion.valido) {
      return res.status(400).json({
        error: 'Codigo invalido',
        mensaje: validacion.error,
        codigo: 'CODIGO_INVALIDO'
      });
    }

    const resultado = await ejecutarQuery(
      `UPDATE cotizaciones
          SET fecha_solicitud_confirmacion = COALESCE(fecha_solicitud_confirmacion, CURRENT_TIMESTAMP)
        WHERE codigo_ticket = $1 AND estado = 'Pendiente'
        RETURNING codigo_ticket, fecha_solicitud_confirmacion`,
      [codigoTicket]
    );

    // Respuesta uniforme aunque ya estuviera marcada o no aplique (no filtra estado).
    return res.json({
      exito: true,
      mensaje: 'Solicitud de confirmacion registrada',
      registrada: resultado.rows.length > 0,
      fecha_solicitud_confirmacion: resultado.rows[0]?.fecha_solicitud_confirmacion || null
    });
  } catch (error) {
    console.error('Error al registrar solicitud de confirmacion:', error);
    return res.status(500).json({
      error: 'Error al registrar solicitud',
      mensaje: 'No se pudo registrar la solicitud de confirmacion',
      codigo: 'ERROR_SOLICITAR_CONFIRMACION'
    });
  }
}

module.exports = {
  crearCotizacion,
  consultarCotizacion,
  validarCotizacion,
  obtenerPdfCotizacion,
  obtenerPdfTecnico,
  notificarCotizacionLista,
  marcarComoReclamada,
  confirmarCotizacion,
  solicitarConfirmacion,
  consultarHistorialCliente,
  obtenerPropias,
  listarClientesRegistrados,
  exportarExcel,
  // Exportar funciones auxiliares para testing
  obtenerMargenGanancia,
  generarCodigoTicket,
  buscarOCrearCliente,
  calcularPrecioTotal
};

