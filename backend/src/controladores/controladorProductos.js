/**
 * Controlador de Productos - Modelo hibrido normalizado.
 * Tabla maestra: productos
 * Diccionarios: categorias, marcas
 * Especificaciones 1:1: specs_*
 */

const { ejecutarQuery, ejecutarTransaccion } = require('../configuracion/baseDatos');
const { validarId } = require('../utilidades/validacion');
const { sanitizarObjeto } = require('../utilidades/sanitizacion');
const {
  CATEGORIAS_PUBLICAS_VALIDAS,
  resolverCategoria,
  resolverTablaPorCategoria,
  requiereSubcategoria,
  subcategoriaValida,
  esCategoriaPrincipal,
} = require('../configuracion/catalogoProductos');

const TABLAS_VALIDAS = CATEGORIAS_PUBLICAS_VALIDAS;

// SELECT canónico que reconstruye el producto "aplanado": une la tabla maestra
// `productos` con categorías, marcas, etiquetas y las siete tablas specs_* (LEFT JOIN),
// exponiendo columnas unificadas por COALESCE. Reutilizado por todos los endpoints de lectura.
const SELECT_PRODUCTO_NORMALIZADO = `
  SELECT
    p.id,
    p.nombre,
    c.nombre AS categoria,
    COALESCE(p.subcategoria, '') AS subcategoria,
    p.categoria_proveedor,
    p.codigo_proveedor,
    COALESCE(m.nombre, '') AS marca,
    p.precio_base,
    p.stock,
    p.disponible_a_pedido,
    NULL::INTEGER AS tiempo_entrega_dias,
    p.descripcion_general AS descripcion_tecnica,
    p.imagen_url,
    p.created_at,
    p.updated_at,
    -- specs_procesador
    COALESCE(sp.socket, sm.socket) AS socket,
    sp.arquitectura,
    sp.nucleos,
    sp.hilos,
    sp.frecuencia_base_ghz,
    sp.frecuencia_boost_ghz,
    COALESCE(sp.tdp_w, sg.tdp_w) AS tdp,
    sp.graficos_integrados,
    -- specs_placa_madre
    sm.chipset,
    sg.chipset AS chipset_gpu,
    COALESCE(sm.ram_tipo, sr.ram_tipo) AS ram_type,
    COALESCE(sm.form_factor, sc.form_factor, sf.form_factor, sa.form_factor) AS form_factor,
    sm.form_factor AS mb_form_factor,
    sf.form_factor AS psu_form_factor,
    sc.form_factor AS case_form_factor,
    sa.form_factor AS storage_form_factor,
    sm.max_ram_gb,
    sm.slots_ram,
    sm.pcie_version,
    sm.m2_slots,
    -- specs_ram
    COALESCE(sr.capacidad_gb, sa.capacidad_gb) AS capacidad_gb,
    sr.velocidad_mhz,
    sr.latencia,
    sr.modulos,
    sr.cantidad_modulos,
    sr.rgb,
    -- specs_almacenamiento
    sa.tipo_almacenamiento,
    sa.capacidad_gb AS storage_capacidad_gb,
    sa.interfaz,
    sa.velocidad_lectura_mbps,
    sa.velocidad_escritura_mbps,
    sa.nvme_gen,
    -- specs_gpu
    sg.vram_gb,
    sg.vram_tipo,
    sg.bus_bits,
    sg.boost_mhz,
    sg.longitud_mm,
    sg.fuente_recomendada_w,
    -- specs_fuente
    sf.wattage,
    sf.certificacion,
    sf.modular,
    sf.pcie_conectores,
    sf.sata_conectores,
    -- specs_case
    sc.compatibilidad_placa,
    sc.max_gpu_mm,
    sc.max_cooler_mm,
    sc.ventiladores_incluidos,
    sc.color,
    sc.panel_lateral,
    -- estado de enriquecimiento (Icecat/Deltron)
    p.estado_enriquecimiento,
    -- etiqueta de perfil gestionada por admin (Basico/Medio/Avanzado/Gamer Full)
    p.id_etiqueta,
    e.nombre AS etiqueta,
    -- ficha tecnica curada (Icecat/Deltron) de la categoria del producto
    COALESCE(sp.ficha_tecnica, sm.ficha_tecnica, sr.ficha_tecnica, sa.ficha_tecnica,
             sg.ficha_tecnica, sf.ficha_tecnica, sc.ficha_tecnica) AS ficha_tecnica,
    -- indicador de historial de precios (Req. 3.9)
    COALESCE(hp.cnt, 0)::INTEGER > 0 AS tiene_historial
  FROM productos p
  INNER JOIN categorias c ON c.id = p.id_categoria
  LEFT JOIN marcas m ON m.id = p.id_marca
  LEFT JOIN etiquetas e ON e.id = p.id_etiqueta
  LEFT JOIN specs_procesador sp ON sp.id_producto = p.id
  LEFT JOIN specs_placa_madre sm ON sm.id_producto = p.id
  LEFT JOIN specs_ram sr ON sr.id_producto = p.id
  LEFT JOIN specs_almacenamiento sa ON sa.id_producto = p.id
  LEFT JOIN specs_gpu sg ON sg.id_producto = p.id
  LEFT JOIN specs_fuente sf ON sf.id_producto = p.id
  LEFT JOIN specs_case sc ON sc.id_producto = p.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt FROM historial_precios_producto WHERE id_producto = p.id
  ) hp ON true
`;

// Mapa categoría -> { tabla specs_*, campos }. `campos` traduce el nombre de columna
// de la tabla specs al nombre que llega en el body sanitizado. Guía el upsert de specs.
const MAPA_SPECS_POR_CATEGORIA = {
  procesador: {
    tabla: 'specs_procesador',
    campos: {
      socket: 'socket',
      arquitectura: 'arquitectura',
      nucleos: 'nucleos',
      hilos: 'hilos',
      frecuencia_base_ghz: 'frecuencia_base_ghz',
      frecuencia_boost_ghz: 'frecuencia_boost_ghz',
      tdp_w: 'tdp',
      graficos_integrados: 'graficos_integrados',
    },
  },
  placa_madre: {
    tabla: 'specs_placa_madre',
    campos: {
      socket: 'socket',
      chipset: 'chipset',
      form_factor: 'form_factor',
      ram_tipo: 'ram_type',
      max_ram_gb: 'max_ram_gb',
      slots_ram: 'slots_ram',
      pcie_version: 'pcie_version',
      m2_slots: 'm2_slots',
    },
  },
  ram: {
    tabla: 'specs_ram',
    campos: {
      ram_tipo: 'ram_type',
      capacidad_gb: 'capacidad_gb',
      velocidad_mhz: 'velocidad_mhz',
      latencia: 'latencia',
      modulos: 'modulos',
      cantidad_modulos: 'cantidad_modulos',
      rgb: 'rgb',
    },
  },
  almacenamiento: {
    tabla: 'specs_almacenamiento',
    campos: {
      tipo_almacenamiento: 'tipo_almacenamiento',
      capacidad_gb: 'capacidad_gb',
      interfaz: 'interfaz',
      form_factor: 'form_factor',
      velocidad_lectura_mbps: 'velocidad_lectura_mbps',
      velocidad_escritura_mbps: 'velocidad_escritura_mbps',
      nvme_gen: 'nvme_gen',
    },
  },
  gpu: {
    tabla: 'specs_gpu',
    campos: {
      chipset: 'chipset',
      vram_gb: 'vram_gb',
      vram_tipo: 'vram_tipo',
      bus_bits: 'bus_bits',
      boost_mhz: 'boost_mhz',
      tdp_w: 'tdp',
      longitud_mm: 'longitud_mm',
      fuente_recomendada_w: 'fuente_recomendada_w',
    },
  },
  fuente: {
    tabla: 'specs_fuente',
    campos: {
      wattage: 'wattage',
      certificacion: 'certificacion',
      modular: 'modular',
      form_factor: 'form_factor',
      pcie_conectores: 'pcie_conectores',
      sata_conectores: 'sata_conectores',
    },
  },
  case: {
    tabla: 'specs_case',
    campos: {
      form_factor: 'form_factor',
      compatibilidad_placa: 'compatibilidad_placa',
      max_gpu_mm: 'max_gpu_mm',
      max_cooler_mm: 'max_cooler_mm',
      ventiladores_incluidos: 'ventiladores_incluidos',
      color: 'color',
      panel_lateral: 'panel_lateral',
    },
  },
};

/** Resuelve la tabla de specs correspondiente a una categoría; lanza si la categoría es inválida. */
function resolverTabla(categoriaEntrada) {
  const tabla = resolverTablaPorCategoria(categoriaEntrada);
  if (!tabla) throw new Error(`Categoria invalida: "${categoriaEntrada}"`);
  return tabla;
}

/**
 * Resuelve la categoría (y subcategoría) de entrada a su forma canónica, validando
 * que la subcategoría sea coherente cuando la categoría la requiere.
 * @returns {{categoriaCanonica: string, subcategoria: string|null, tabla: 'productos'}}
 * @throws {Error} Si la categoría o la subcategoría no son válidas.
 */
function resolverDestinoOperacion(categoriaEntrada, subcategoriaEntrada = null) {
  const destino = resolverCategoria(categoriaEntrada);
  if (!destino) throw new Error(`Categoria invalida: "${categoriaEntrada}"`);

  let subcategoriaFinal = destino.subcategoria;
  if (requiereSubcategoria(destino.categoria) && !subcategoriaFinal) {
    subcategoriaFinal = String(subcategoriaEntrada || '').trim().toLowerCase() || null;
  }

  // Si la categoría requiere subcategoría pero no se especificó, permitir null
  // La validación se hace contra la DB en la query
  const esValida = subcategoriaFinal === null
    ? true // Permitir null cuando no se especificó (se usará la del producto)
    : subcategoriaValida(destino.categoria, subcategoriaFinal);

  if (!esValida) {
    throw new Error(`Subcategoria invalida para categoria "${destino.categoria}"`);
  }

  return {
    categoriaCanonica: destino.categoria,
    subcategoria: subcategoriaFinal,
    tabla: 'productos',
  };
}

/** Devuelve el id de una categoría por nombre, creándola si no existe. */
async function obtenerIdCategoriaPorNombre(nombreCategoria) {
  const r = await ejecutarQuery('SELECT id FROM categorias WHERE nombre = $1', [nombreCategoria]);
  if (r.rows.length > 0) return r.rows[0].id;
  const creado = await ejecutarQuery(
    'INSERT INTO categorias (nombre, es_componente_principal) VALUES ($1, $2) RETURNING id',
    [nombreCategoria, esCategoriaPrincipal(nombreCategoria)]
  );
  return creado.rows[0].id;
}

/** Devuelve el id de una marca (upsert por nombre único), o null si el nombre viene vacío. */
async function obtenerIdMarcaSiExiste(marca) {
  const nombre = String(marca || '').trim();
  if (!nombre) return null;
  const r = await ejecutarQuery(
    'INSERT INTO marcas (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id',
    [nombre]
  );
  return r.rows[0].id;
}

/** Genera un código de proveedor temporal (slug del nombre + timestamp) para productos creados a mano sin código. */
function generarCodigoProveedorTemporal(nombre, categoria) {
  const base = String(nombre || categoria || 'producto')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'producto';

  return `${base}-${Date.now()}`;
}

/**
 * Inserta o actualiza la fila de especificaciones (specs_*) del producto según su
 * categoría, tomando solo los campos presentes en el body sanitizado. Si no hay
 * specs para escribir, garantiza al menos la fila vacía con el id_producto.
 * El nombre de tabla proviene del mapa cerrado MAPA_SPECS_POR_CATEGORIA (no del input).
 */
async function upsertSpecsProducto(idProducto, categoria, datosSanitizados) {
  const def = MAPA_SPECS_POR_CATEGORIA[categoria];
  if (!def) return;

  const columnas = Object.keys(def.campos);
  if (columnas.length === 0) {
    await ejecutarQuery(
      `INSERT INTO ${def.tabla} (id_producto) VALUES ($1)
       ON CONFLICT (id_producto) DO NOTHING`,
      [idProducto]
    );
    return;
  }

  const columnasConValor = columnas.filter((col) => Object.prototype.hasOwnProperty.call(datosSanitizados, def.campos[col]));
  if (columnasConValor.length === 0) {
    await ejecutarQuery(
      `INSERT INTO ${def.tabla} (id_producto) VALUES ($1)
       ON CONFLICT (id_producto) DO NOTHING`,
      [idProducto]
    );
    return;
  }

  const valores = columnasConValor.map((col) => datosSanitizados[def.campos[col]] ?? null);
  const placeholders = columnasConValor.map((_, i) => `$${i + 2}`).join(', ');
  const updates = columnasConValor.map((col) => `${col} = EXCLUDED.${col}`).join(', ');

  await ejecutarQuery(
    `INSERT INTO ${def.tabla} (id_producto, ${columnasConValor.join(', ')})
     VALUES ($1, ${placeholders})
     ON CONFLICT (id_producto) DO UPDATE SET ${updates}`,
    [idProducto, ...valores]
  );
}

/**
 * Construye el fragmento WHERE por categoría (y subcategoría si aplica), agregando
 * los valores a `params` y devolviendo el próximo índice de placeholder disponible.
 */
function construirWhereDestino(destino, params, indiceInicial = 1) {
  let i = indiceInicial;
  let where = ' WHERE c.nombre = $' + i++;
  params.push(destino.categoriaCanonica);

  if (requiereSubcategoria(destino.categoriaCanonica)) {
    if (destino.subcategoria) {
      where += ` AND p.subcategoria = $${i++}`;
      params.push(destino.subcategoria);
    }
  }

  return { where, nextIndex: i };
}

/**
 * GET /api/productos
 * Lista productos con filtros opcionales (categoría, socket, marca, búsqueda, etiqueta)
 * y paginación. Solo devuelve productos con stock o disponibles a pedido. A los
 * invitados (no autenticados) se les oculta `precio_base`.
 */
async function obtenerProductos(req, res) {
  try {
    const { categoria, socket, marca, busqueda, subcategoria, etiqueta, page, limit } = req.query;
    const params = [];
    let i = 1;
    let where = ' WHERE (p.stock > 0 OR p.disponible_a_pedido = true)';

    if (categoria) {
      const destino = resolverDestinoOperacion(categoria, subcategoria);
      const base = construirWhereDestino(destino, params, i);
      where += base.where.replace(' WHERE', ' AND');
      i = base.nextIndex;
    }

    if (socket) {
      where += ` AND COALESCE(sp.socket, sm.socket) = $${i++}`;
      params.push(socket);
    }
    if (marca) {
      where += ` AND LOWER(COALESCE(m.nombre, '')) = LOWER($${i++})`;
      params.push(marca);
    }
    if (busqueda) {
      where += ` AND (p.nombre ILIKE $${i} OR COALESCE(p.descripcion_general, '') ILIKE $${i})`;
      params.push(`%${busqueda}%`);
      i++;
    }
    if (etiqueta) {
      // Filtro por etiqueta de perfil: acepta id numerico o nombre.
      if (/^\d+$/.test(String(etiqueta))) {
        where += ` AND p.id_etiqueta = $${i++}`;
        params.push(Number(etiqueta));
      } else {
        where += ` AND e.nombre = $${i++}`;
        params.push(etiqueta);
      }
    }

    // Paginación
    const paginaActual = parseInt(page) || 1;
    const limite = parseInt(limit) || 50;
    const offset = (paginaActual - 1) * limite;

    // Contar total de productos (sin paginación)
    const countQuery = `
      SELECT COUNT(*) as total
      FROM productos p
      LEFT JOIN categorias c ON p.id_categoria = c.id
      LEFT JOIN marcas m ON p.id_marca = m.id
      LEFT JOIN etiquetas e ON e.id = p.id_etiqueta
      LEFT JOIN specs_procesador sp ON p.id = sp.id_producto
      LEFT JOIN specs_placa_madre sm ON p.id = sm.id_producto
      ${where}
    `;
    const countResult = await ejecutarQuery(countQuery, params);
    const total = parseInt(countResult.rows[0].total);
    const totalPaginas = Math.ceil(total / limite);

    // Obtener productos con paginación
    const resultado = await ejecutarQuery(
      `${SELECT_PRODUCTO_NORMALIZADO}
       ${where}
       ORDER BY c.nombre, p.subcategoria, p.nombre
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limite, offset]
    );

    // Strip de precio_base para invitados (no autenticados)
    const productosFinales = !req.rol
      ? resultado.rows.map(({ precio_base, ...rest }) => rest)
      : resultado.rows;

    return res.json({
      exito: true,
      productos: productosFinales,
      total,
      pagina: paginaActual,
      totalPaginas,
      limite
    });
  } catch (error) {
    if (error.message.includes('Categoria') || error.message.includes('Subcategoria')) {
      return res.status(400).json({ error: 'Categoria invalida', mensaje: error.message });
    }
    console.error('Error al obtener productos:', error);
    return res.status(500).json({ error: 'Error al obtener productos', mensaje: 'No se pudieron recuperar los productos' });
  }
}

/**
 * GET /api/productos/:categoria/:id
 * Devuelve un producto por id dentro de su categoría (con todas sus specs aplanadas).
 * Oculta `precio_base` a invitados. 404 si no existe en esa categoría.
 */
async function obtenerProductoPorId(req, res) {
  try {
    const destino = resolverDestinoOperacion(req.params.categoria, req.query.subcategoria);
    const validacionId = validarId(req.params.id);
    if (!validacionId.valido) return res.status(400).json({ error: 'ID invalido', mensaje: validacionId.error });

    const params = [validacionId.id];
    const whereDestino = construirWhereDestino(destino, params, 2);

    const resultado = await ejecutarQuery(
      `${SELECT_PRODUCTO_NORMALIZADO}
       WHERE p.id = $1 ${whereDestino.where.replace(' WHERE', ' AND')}
       LIMIT 1`,
      params
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado', mensaje: `No existe un producto con ID ${validacionId.id}` });
    }

    // Strip de precio_base para invitados
    const producto = !req.rol
      ? (() => { const { precio_base, ...rest } = resultado.rows[0]; return rest; })()
      : resultado.rows[0];

    return res.json({ exito: true, producto });
  } catch (error) {
    if (error.message.includes('Categoria') || error.message.includes('Subcategoria')) {
      return res.status(400).json({ error: 'Categoria invalida', mensaje: error.message });
    }
    console.error('Error al obtener producto:', error);
    return res.status(500).json({ error: 'Error al obtener producto', mensaje: 'No se pudo recuperar el producto' });
  }
}

/**
 * POST /api/productos
 * Crea un producto: valida nombre/precio/stock, resuelve categoría y marca (creándolas
 * si hace falta), genera un código de proveedor temporal si no vino, inserta en
 * `productos` y, si es componente principal, escribe sus specs. Devuelve el producto creado.
 */
async function crearProducto(req, res) {
  try {
    const datosSanitizados = sanitizarObjeto(req.body);
    const destino = resolverDestinoOperacion(datosSanitizados.categoria, datosSanitizados.subcategoria);

    if (!datosSanitizados.nombre) {
      return res.status(400).json({ error: 'Datos invalidos', mensaje: 'nombre es obligatorio' });
    }

    if (!datosSanitizados.codigo_proveedor) {
      datosSanitizados.codigo_proveedor = generarCodigoProveedorTemporal(datosSanitizados.nombre, destino.categoriaCanonica);
    }

    const precio = Number(datosSanitizados.precio_base);
    const stock = Number(datosSanitizados.stock);
    if (!Number.isFinite(precio) || precio <= 0 || precio > 100000) {
      return res.status(400).json({ error: 'Datos invalidos', mensaje: 'precio_base invalido' });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'Datos invalidos', mensaje: 'stock invalido' });
    }

    const idCategoria = await obtenerIdCategoriaPorNombre(destino.categoriaCanonica);
    const idMarca = await obtenerIdMarcaSiExiste(datosSanitizados.marca);

    const idEtiqueta = Number.isInteger(Number(datosSanitizados.id_etiqueta))
      ? Number(datosSanitizados.id_etiqueta)
      : null;

    const insert = await ejecutarQuery(
      `INSERT INTO productos (
         id_categoria, id_marca, subcategoria, categoria_proveedor, codigo_proveedor,
         nombre, descripcion_general, precio_base, stock, disponible_a_pedido, imagen_url,
         id_etiqueta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        idCategoria,
        idMarca,
        destino.subcategoria || null,
        datosSanitizados.categoria_proveedor || null,
        datosSanitizados.codigo_proveedor,
        datosSanitizados.nombre,
        datosSanitizados.descripcion_tecnica || null,
        precio,
        stock,
        Boolean(datosSanitizados.disponible_a_pedido),
        datosSanitizados.imagen_url || null,
        idEtiqueta,
      ]
    );

    const id = insert.rows[0].id;
    if (esCategoriaPrincipal(destino.categoriaCanonica)) {
      await upsertSpecsProducto(id, destino.categoriaCanonica, datosSanitizados);
    }

    req.params.id = String(id);
    req.params.categoria = destino.categoriaCanonica;
    req.query.subcategoria = destino.subcategoria || '';
    return obtenerProductoPorId(req, res);
  } catch (error) {
    if (error.message.includes('Categoria') || error.message.includes('Subcategoria')) {
      return res.status(400).json({ error: 'Categoria invalida', mensaje: error.message });
    }
    if (error.code === '23505') return res.status(409).json({ error: 'Producto duplicado', mensaje: 'Ya existe un producto con ese codigo' });
    if (error.code === '23514') return res.status(400).json({ error: 'Constraint violado', mensaje: 'Los datos no cumplen las restricciones de base de datos' });
    console.error('Error al crear producto:', error);
    return res.status(500).json({ error: 'Error al crear producto', mensaje: 'No se pudo crear el producto' });
  }
}

/**
 * PUT /api/productos/:categoria/:id
 * Actualiza dinámicamente solo los campos enviados. Si cambia el precio, ejecuta el
 * UPDATE y el INSERT en `historial_precios_producto` dentro de una transacción atómica.
 * Actualiza también las specs si es componente principal.
 */
async function actualizarProducto(req, res) {
  try {
    const destino = resolverDestinoOperacion(req.params.categoria, req.body?.subcategoria || req.query.subcategoria);
    const validacionId = validarId(req.params.id);
    if (!validacionId.valido) return res.status(400).json({ error: 'ID invalido', mensaje: validacionId.error });

    const datosSanitizados = sanitizarObjeto(req.body);

    // Leer precio_base actual para detectar cambio y registrar historial (Req. 3.3)
    const check = await ejecutarQuery(
      `SELECT p.id, p.precio_base
       FROM productos p
       INNER JOIN categorias c ON c.id = p.id_categoria
       WHERE p.id = $1 AND c.nombre = $2
       ${destino.subcategoria ? 'AND p.subcategoria = $3' : ''}`,
      destino.subcategoria ? [validacionId.id, destino.categoriaCanonica, destino.subcategoria] : [validacionId.id, destino.categoriaCanonica]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado', mensaje: `No existe un producto con ID ${validacionId.id}` });
    }

    const precioAnterior = Number(check.rows[0].precio_base);
    const cambiaPrecio = Object.prototype.hasOwnProperty.call(datosSanitizados, 'precio_base')
      && Number(datosSanitizados.precio_base) !== precioAnterior;

    const actualizaciones = [];
    const valores = [];
    let i = 1;

    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'nombre')) {
      actualizaciones.push(`nombre = $${i++}`);
      valores.push(datosSanitizados.nombre);
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'categoria_proveedor')) {
      actualizaciones.push(`categoria_proveedor = $${i++}`);
      valores.push(datosSanitizados.categoria_proveedor || null);
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'codigo_proveedor')) {
      actualizaciones.push(`codigo_proveedor = $${i++}`);
      valores.push(datosSanitizados.codigo_proveedor);
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'descripcion_tecnica')) {
      actualizaciones.push(`descripcion_general = $${i++}`);
      valores.push(datosSanitizados.descripcion_tecnica || null);
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'precio_base')) {
      actualizaciones.push(`precio_base = $${i++}`);
      valores.push(Number(datosSanitizados.precio_base));
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'stock')) {
      actualizaciones.push(`stock = $${i++}`);
      valores.push(Number(datosSanitizados.stock));
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'disponible_a_pedido')) {
      actualizaciones.push(`disponible_a_pedido = $${i++}`);
      valores.push(Boolean(datosSanitizados.disponible_a_pedido));
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'imagen_url')) {
      actualizaciones.push(`imagen_url = $${i++}`);
      valores.push(datosSanitizados.imagen_url || null);
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'marca')) {
      const idMarca = await obtenerIdMarcaSiExiste(datosSanitizados.marca);
      actualizaciones.push(`id_marca = $${i++}`);
      valores.push(idMarca);
    }
    if (Object.prototype.hasOwnProperty.call(datosSanitizados, 'id_etiqueta')) {
      // Etiqueta de perfil (gestion manual del admin); null la quita.
      const idEtiqueta = Number.isInteger(Number(datosSanitizados.id_etiqueta))
        ? Number(datosSanitizados.id_etiqueta)
        : null;
      actualizaciones.push(`id_etiqueta = $${i++}`);
      valores.push(idEtiqueta);
    }

    if (cambiaPrecio) {
      // Ejecutar UPDATE + INSERT historial en una sola transaccion atomica (Req. 3.3)
      const precioNuevo = Number(datosSanitizados.precio_base);
      const idUsuarioAdmin = req.usuario?.id || null;
      const idProducto = validacionId.id;
      const tablaProducto = destino.categoriaCanonica;

      await ejecutarTransaccion(async (cliente) => {
        if (actualizaciones.length > 0) {
          await cliente.query(
            `UPDATE productos SET ${actualizaciones.join(', ')} WHERE id = $${i}`,
            [...valores, idProducto]
          );
        }
        await cliente.query(
          `INSERT INTO historial_precios_producto
             (id_producto, tabla_producto, precio_anterior, precio_nuevo, id_usuario_admin)
           VALUES ($1, $2, $3, $4, $5)`,
          [idProducto, tablaProducto, precioAnterior, precioNuevo, idUsuarioAdmin]
        );
      });
    } else if (actualizaciones.length > 0) {
      valores.push(validacionId.id);
      await ejecutarQuery(`UPDATE productos SET ${actualizaciones.join(', ')} WHERE id = $${i}`, valores);
    }

    if (esCategoriaPrincipal(destino.categoriaCanonica)) {
      await upsertSpecsProducto(validacionId.id, destino.categoriaCanonica, datosSanitizados);
    }

    req.params.id = String(validacionId.id);
    req.params.categoria = destino.categoriaCanonica;
    req.query.subcategoria = destino.subcategoria || '';
    return obtenerProductoPorId(req, res);
  } catch (error) {
    if (error.message.includes('Categoria') || error.message.includes('Subcategoria')) {
      return res.status(400).json({ error: 'Categoria invalida', mensaje: error.message });
    }
    console.error('Error al actualizar producto:', error);
    return res.status(500).json({ error: 'Error al actualizar producto', mensaje: 'No se pudo actualizar el producto' });
  }
}
/**
 * DELETE /api/productos/:categoria/:id
 * Elimina un producto, salvo que esté referenciado en cotizaciones existentes
 * (responde 409 en ese caso para no romper el historial de cotizaciones).
 */
async function eliminarProducto(req, res) {
  try {
    const destino = resolverDestinoOperacion(req.params.categoria, req.query.subcategoria);
    const validacionId = validarId(req.params.id);
    if (!validacionId.valido) return res.status(400).json({ error: 'ID invalido', mensaje: validacionId.error });

    const existente = await ejecutarQuery(
      `SELECT p.id, p.nombre
       FROM productos p
       INNER JOIN categorias c ON c.id = p.id_categoria
       WHERE p.id = $1 AND c.nombre = $2
       ${destino.subcategoria ? 'AND p.subcategoria = $3' : ''}`,
      destino.subcategoria ? [validacionId.id, destino.categoriaCanonica, destino.subcategoria] : [validacionId.id, destino.categoriaCanonica]
    );

    if (existente.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado', mensaje: `No existe un producto con ID ${validacionId.id}` });
    }

    const enCotizaciones = await ejecutarQuery(
      'SELECT COUNT(*) as cantidad FROM detalle_cotizacion WHERE id_producto = $1',
      [validacionId.id]
    );

    if (parseInt(enCotizaciones.rows[0].cantidad, 10) > 0) {
      return res.status(409).json({
        error: 'Producto en uso',
        mensaje: 'No se puede eliminar el producto porque esta incluido en cotizaciones existentes',
      });
    }

    await ejecutarQuery('DELETE FROM productos WHERE id = $1', [validacionId.id]);
    return res.json({
      exito: true,
      mensaje: 'Producto eliminado exitosamente',
      producto: { id: validacionId.id, nombre: existente.rows[0].nombre },
    });
  } catch (error) {
    if (error.message.includes('Categoria') || error.message.includes('Subcategoria')) {
      return res.status(400).json({ error: 'Categoria invalida', mensaje: error.message });
    }
    console.error('Error al eliminar producto:', error);
    return res.status(500).json({ error: 'Error al eliminar producto', mensaje: 'No se pudo eliminar el producto' });
  }
}

/**
 * Obtiene el historial de cambios de precio de un producto.
 * Req. 3.4, 3.5, 3.6
 */
async function obtenerHistorialPrecios(req, res) {
  try {
    const validacionId = validarId(req.params.id);
    if (!validacionId.valido) {
      return res.status(400).json({ error: 'ID invalido', mensaje: validacionId.error });
    }

    // Verificar que el producto existe
    const existeProducto = await ejecutarQuery(
      'SELECT id FROM productos WHERE id = $1',
      [validacionId.id]
    );
    if (existeProducto.rows.length === 0) {
      return res.status(404).json({
        error: 'Producto no encontrado',
        mensaje: `No existe un producto con ID ${validacionId.id}`,
        codigo: 'PRODUCTO_NO_ENCONTRADO',
      });
    }

    const resultado = await ejecutarQuery(
      `SELECT
         h.id,
         h.id_producto,
         h.tabla_producto,
         h.precio_anterior,
         h.precio_nuevo,
         h.fecha_cambio,
         h.id_usuario_admin,
         c.username AS usuario_admin
       FROM historial_precios_producto h
       LEFT JOIN cuentas c ON c.id = h.id_usuario_admin
       WHERE h.id_producto = $1
       ORDER BY h.fecha_cambio DESC`,
      [validacionId.id]
    );

    return res.json({
      exito: true,
      id_producto: validacionId.id,
      total: resultado.rows.length,
      historial: resultado.rows,
    });
  } catch (error) {
    console.error('Error al obtener historial de precios:', error);
    return res.status(500).json({
      error: 'Error al obtener historial de precios',
      mensaje: 'No se pudo recuperar el historial de precios del producto',
    });
  }
}
/**
 * Busca productos filtrando por compatibilidad de hardware.
 * Parámetros opcionales de query: procesador, ram_tipo, socket, categoria, busqueda.
 * Los filtros de compatibilidad se aplican con AND lógico.
 * Req. 8.1, 8.2, 8.3, 8.4, 8.7, 8.8
 */
async function buscarProductosCompatibles(req, res) {
  try {
    const { procesador, ram_tipo, socket, categoria, busqueda, subcategoria } = req.query;

    // Validar y sanitizar parámetros de compatibilidad (Req. 8.8)
    const LONGITUD_MAX = 100;
    const PATRON_SEGURO = /^[a-zA-Z0-9\s\-_.+/()áéíóúÁÉÍÓÚñÑ]+$/;

    const erroresValidacion = [];

    if (procesador !== undefined) {
      const val = String(procesador).trim();
      if (!val || val.length > LONGITUD_MAX || !PATRON_SEGURO.test(val)) {
        erroresValidacion.push({ campo: 'procesador', mensaje: 'Valor inválido para el filtro procesador' });
      }
    }
    if (ram_tipo !== undefined) {
      const val = String(ram_tipo).trim();
      if (!val || val.length > LONGITUD_MAX || !PATRON_SEGURO.test(val)) {
        erroresValidacion.push({ campo: 'ram_tipo', mensaje: 'Valor inválido para el filtro ram_tipo' });
      }
    }
    if (socket !== undefined) {
      const val = String(socket).trim();
      if (!val || val.length > LONGITUD_MAX || !PATRON_SEGURO.test(val)) {
        erroresValidacion.push({ campo: 'socket', mensaje: 'Valor inválido para el filtro socket' });
      }
    }
    if (busqueda !== undefined) {
      const val = String(busqueda).trim();
      if (val.length > LONGITUD_MAX) {
        erroresValidacion.push({ campo: 'busqueda', mensaje: 'El término de búsqueda es demasiado largo' });
      }
    }

    if (erroresValidacion.length > 0) {
      return res.status(400).json({
        error: 'Parámetros inválidos',
        mensaje: 'Uno o más parámetros de búsqueda son inválidos',
        codigo: 'PARAMETROS_INVALIDOS',
        detalle: erroresValidacion,
      });
    }

    const params = [];
    let i = 1;
    let where = ' WHERE (p.stock > 0 OR p.disponible_a_pedido = true)';

    // Filtro por categoría (opcional)
    if (categoria) {
      try {
        const destino = resolverDestinoOperacion(categoria, subcategoria);
        const base = construirWhereDestino(destino, params, i);
        where += base.where.replace(' WHERE', ' AND');
        i = base.nextIndex;
      } catch (errCat) {
        return res.status(400).json({
          error: 'Categoría inválida',
          mensaje: errCat.message,
          codigo: 'PARAMETROS_INVALIDOS',
        });
      }
    }

    // Filtro por socket: aplica a procesadores (sp.socket) y placas madre (sm.socket) — Req. 8.2
    if (socket) {
      where += ` AND UPPER(COALESCE(sp.socket, sm.socket)) = UPPER($${i++})`;
      params.push(String(socket).trim());
    }

    // Filtro por tipo de RAM: aplica a placas madre (sm.ram_tipo) y módulos RAM (sr.ram_tipo) — Req. 8.3
    if (ram_tipo) {
      where += ` AND UPPER(COALESCE(sm.ram_tipo, sr.ram_tipo)) = UPPER($${i++})`;
      params.push(String(ram_tipo).trim());
    }

    // Filtro por nombre de procesador compatible: busca en nombre del producto — Req. 8.1
    if (procesador) {
      where += ` AND p.nombre ILIKE $${i++}`;
      params.push(`%${String(procesador).trim()}%`);
    }

    // Filtro de búsqueda libre
    if (busqueda) {
      const termino = String(busqueda).trim();
      if (termino) {
        where += ` AND (p.nombre ILIKE $${i} OR COALESCE(p.descripcion_general, '') ILIKE $${i})`;
        params.push(`%${termino}%`);
        i++;
      }
    }

    const resultado = await ejecutarQuery(
      `${SELECT_PRODUCTO_NORMALIZADO}
       ${where}
       ORDER BY c.nombre, p.subcategoria, p.nombre`,
      params
    );

    // Strip de precio_base para invitados (no autenticados)
    const productosFinales = !req.rol
      ? resultado.rows.map(({ precio_base, ...rest }) => rest)
      : resultado.rows;

    const mensajeVacio = productosFinales.length === 0
      ? 'No se encontraron productos compatibles con los filtros especificados'
      : null;

    return res.json({
      exito: true,
      cantidad: productosFinales.length,
      productos: productosFinales,
      ...(mensajeVacio ? { mensaje: mensajeVacio } : {}),
    });
  } catch (error) {
    console.error('Error al buscar productos compatibles:', error);
    return res.status(500).json({
      error: 'Error al buscar productos',
      mensaje: 'No se pudieron recuperar los productos',
    });
  }
}

module.exports = {
  TABLAS_VALIDAS,
  resolverTabla,
  resolverDestinoOperacion,
  obtenerProductos,
  obtenerProductoPorId,
  crearProducto,
  actualizarProducto,
  eliminarProducto,
  obtenerHistorialPrecios,
  buscarProductosCompatibles,
};
