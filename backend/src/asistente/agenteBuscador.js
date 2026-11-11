/**
 * Buscador determinístico de candidatos del catálogo.
 * Agrupa por categoría y selecciona candidatos según cercanía al presupuesto.
 * Sin IA: arquitectura single-AI (solo el conversador usa modelo).
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');

// ── Búsqueda de candidatos (determinística) ──

async function buscarProductos(clasificacion, productos, ejecutarQueryFn) {
  return buscarProductosFallback(clasificacion, productos, ejecutarQueryFn);
}

// ── Selección SQL por filtros de presupuesto ──

async function buscarProductosFallback(clasificacion, productos, ejecutarQueryFn) {
  const presupuestoUsd = clasificacion.presupuesto_pen
    ? clasificacion.presupuesto_pen / 3.7 // tipo de cambio aproximado
    : null;

  // Agrupar productos por categoría
  const agrupados = new Map();
  for (const p of productos) {
    const cat = normalizarCategoria(p.nombre_categoria);
    if (!cat) continue;
    if (!agrupados.has(cat)) agrupados.set(cat, []);
    agrupados.get(cat).push(p);
  }

  const porCategoria = new Map();

  for (const [cat, items] of agrupados) {
    let seleccionados = items;

    // Si hay presupuesto y es una categoría principal, ordenar por precio
    // y seleccionar los que mejor se ajusten
    if (presupuestoUsd) {
      const pctPorCategoria = {
        procesador: 0.25, placa_madre: 0.14, ram: 0.16,
        almacenamiento: 0.12, gpu: 0.30, fuente: 0.06, case: 0.06
      };
      const pct = pctPorCategoria[cat] || 0.10;
      const presupuestoCat = presupuestoUsd * pct;

      // Ordenar por cercanía al presupuesto de la categoría
      seleccionados = [...items].sort((a, b) => {
        const diffA = Math.abs((a.precio_usd || 0) - presupuestoCat);
        const diffB = Math.abs((b.precio_usd || 0) - presupuestoCat);
        return diffA - diffB;
      });
    } else {
      // Sin presupuesto, ordenar por precio descendente (mejores primero)
      seleccionados = [...items].sort((a, b) => (b.precio_usd || 0) - (a.precio_usd || 0));
    }

    porCategoria.set(cat, seleccionados.slice(0, 8).map((p, i) => ({
      id: p.id,
      score: presupuestoUsd ? Math.max(0.3, 1 - i * 0.1) : 0.5,
      producto: p,
      texto: p.nombre,
    })));
  }

  return porCategoria;
}

// ── Búsqueda por texto (para productos mencionados) ──

async function buscarProductoPorNombre(nombre, productos, ejecutarQueryFn) {
  if (!nombre) return null;

  const nombreLower = nombre.toLowerCase();

  // Primero buscar coincidencia exacta en la lista
  const exacto = productos.find(
    (p) => p.nombre.toLowerCase().includes(nombreLower)
  );
  if (exacto) return exacto;

  // Si no, buscar por ILIKE en BD
  try {
    const resultado = await ejecutarQueryFn(
      `SELECT p.id, p.nombre, c.nombre AS nombre_categoria, p.precio_base, p.stock, p.disponible_a_pedido
       FROM productos p
       INNER JOIN categorias c ON c.id = p.id_categoria
       WHERE (p.stock > 0 OR p.disponible_a_pedido = TRUE)
         AND LOWER(p.nombre) LIKE $1
       LIMIT 3`,
      [`%${nombreLower}%`]
    );
    if (resultado.rows.length > 0) {
      return resultado.rows.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        nombre_categoria: r.nombre_categoria,
        precio_usd: r.precio_base ? Number(r.precio_base) : 0,
        stock: r.stock || 0,
        disponible_a_pedido: r.disponible_a_pedido || false,
      }))[0];
    }
  } catch (error) {
    console.warn('[Buscador] Fallback SQL por nombre falló:', error.message);
  }

  return null;
}

// ── Utilidades ──

function normalizarCategoria(nombreCategoria) {
  const mapa = {
    procesador: 'procesador',
    placa_madre: 'placa_madre',
    ram: 'ram',
    almacenamiento: 'almacenamiento',
    gpu: 'gpu',
    fuente: 'fuente',
    case: 'case',
    gabinete: 'case',
  };
  return mapa[nombreCategoria] || null;
}

module.exports = {
  buscarProductos,
  buscarProductosFallback,
  buscarProductoPorNombre,
  normalizarCategoria,
};
