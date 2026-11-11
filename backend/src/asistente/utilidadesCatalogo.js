function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function categoriaProducto(producto) {
  return producto?.categoria || producto?.subcategoria || producto?.nombre_categoria || null;
}

function precioProducto(producto) {
  return Number(producto?.precio_base ?? producto?.precio_usd ?? producto?.precio ?? 0) || 0;
}

function buscarProductosMencionados(pregunta, productos = [], limite = 4) {
  const texto = normalizarTexto(pregunta);
  if (!texto || !Array.isArray(productos)) return [];

  return productos
    .map((producto) => {
      const nombre = normalizarTexto(producto.nombre);
      if (!nombre) return null;
      const palabras = nombre.split(/\s+/).filter((p) => p.length >= 3);
      const coincidencias = palabras.filter((palabra) => texto.includes(palabra)).length;
      const score = texto.includes(nombre) ? coincidencias + 5 : coincidencias;
      return score > 0 ? { producto, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || precioProducto(b.producto) - precioProducto(a.producto))
    .slice(0, limite)
    .map((item) => item.producto);
}

function describirProducto(producto) {
  if (!producto) return 'Producto no identificado';
  const partes = [producto.nombre];
  const categoria = categoriaProducto(producto);
  if (categoria) partes.push(`categoría ${categoria}`);
  const precio = precioProducto(producto);
  if (precio > 0) partes.push(`precio ${precio}`);
  if (producto.socket) partes.push(`socket ${producto.socket}`);
  if (producto.ram_type || producto.ram_tipo) partes.push(`RAM ${producto.ram_type || producto.ram_tipo}`);
  if (producto.form_factor) partes.push(`form factor ${producto.form_factor}`);
  if (producto.wattage) partes.push(`${producto.wattage}W`);
  return partes.join(', ');
}

function productosPorCategoria(productos = [], categoria, limite = 5) {
  return productos
    .filter((producto) => categoriaProducto(producto) === categoria)
    .sort((a, b) => precioProducto(b) - precioProducto(a))
    .slice(0, limite);
}

module.exports = {
  normalizarTexto,
  categoriaProducto,
  precioProducto,
  buscarProductosMencionados,
  describirProducto,
  productosPorCategoria,
};
