'use strict';

/**
 * Servicio Deltron — descarga la ficha de un producto de Deltron y extrae:
 *  - el MPN (código de fabricante), para consultar Icecat,
 *  - las "Especificaciones" (fallback cuando Icecat no tiene el producto),
 *  - la imagen del producto.
 *
 * Una sola petición HTTP por producto. Promovido desde el POC validado
 * (scripts/poc-icecat/scraper-deltron.js + scraper-deltron-specs.js).
 */

// Usa fetch nativo (Node 18+). No requiere dependencias externas.
const URL_BASE = 'https://www.deltron.com.pe/modulos/productos/items/producto.php?item_number=';
const TIMEOUT_MS = Number(process.env.DELTRON_TIMEOUT_MS || 12000);

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'es-PE,es;q=0.9',
  Referer: 'https://www.deltron.com.pe/',
};

/** Arma la URL de la ficha de Deltron para un código de proveedor dado. */
function urlProducto(codigo) {
  return URL_BASE + encodeURIComponent(codigo);
}

/** Descarga el HTML de la ficha (una sola petición). No lanza excepción. */
async function descargarHtmlDeltron(codigo) {
  const url = urlProducto(codigo);
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controlador.signal });
    const html = resp.status >= 400 ? null : await resp.text();
    return { html, status: resp.status, url };
  } catch (err) {
    return { html: null, status: null, url, error: err.name === 'AbortError' ? 'timeout' : (err.message || 'error_desconocido') };
  } finally {
    clearTimeout(timer);
  }
}

/** Convierte un fragmento HTML a texto plano: quita etiquetas, decodifica entidades y colapsa espacios. */
function decodificar(texto) {
  return String(texto || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/&deg;/gi, '°').replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrae el MPN (código de fabricante) y datos básicos del HTML. */
function extraerMpnDeHtml(html, codigo) {
  const m1 = html.match(/<span class="product-price part-number"><b>([^<]+)<\/b>/);
  const m2 = html.match(/C[oó]digo de Fabricante:<\/b>\s*([A-Z0-9][^<]+?)</i);
  const m3 = html.match(/title-name-product[^>]*itemprop="name">([^<]+)</);
  const skuMatch = html.match(/itemprop="sku"[^>]*>([^<]+)</);
  const mpn = (m1 && m1[1]) || (m2 && m2[1] && m2[1].trim()) || null;
  return {
    codigo_consultado: codigo,
    sku_encontrado: skuMatch ? skuMatch[1].trim() : null,
    mpn,
    mpn_metodo: m1 ? 'part-number' : m2 ? 'codigo-fabricante' : null,
    titulo: m3 ? decodificar(m3[1]) : null,
  };
}

/**
 * Extrae la URL de la imagen REAL del producto.
 *
 * Solo acepta imágenes bajo la ruta `/productos/` del host de imágenes de Deltron.
 * Esto evita capturar el logo/encabezado del sitio (`/temp_imgs/deltron_logo...`),
 * que es lo único que tiene la página "PRODUCTO NO ENCONTRADO" cuando el item ya
 * no existe en Deltron. Si no hay imagen de producto, devuelve null (no se pone nada).
 *
 * Se prioriza el carrusel (lightSlider) porque el `og:image` de Deltron suele
 * apuntar a una ruta equivocada; og:image queda como último recurso.
 */
function extraerImagenDeHtml(html) {
  const IMG_PRODUCTO = '(?:https?:)?\\/\\/imagenes\\.deltron\\.com\\.pe\\/[^"\']*\\/productos\\/[^"\']+';

  // 1) Carrusel: <li data-thumb="URL" data-src="URL" class="lslide ..."><img src="URL"></li>
  const dataSrc = html.match(new RegExp(`data-src=["'](${IMG_PRODUCTO})["']`, 'i'));
  if (dataSrc && dataSrc[1]) return normalizarUrl(dataSrc[1]);
  const dataThumb = html.match(new RegExp(`data-thumb=["'](${IMG_PRODUCTO})["']`, 'i'));
  if (dataThumb && dataThumb[1]) return normalizarUrl(dataThumb[1]);

  // 2) <img> de producto (bajo /productos/), nunca logos del sitio.
  const imgHost = html.match(new RegExp(`<img[^>]+src=["'](${IMG_PRODUCTO})["']`, 'i'));
  if (imgHost && imgHost[1]) return normalizarUrl(imgHost[1]);

  // 3) Último recurso: og:image, solo si es una imagen de producto.
  const og = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (og && og[1] && /\/productos\//.test(og[1])) return normalizarUrl(og[1]);

  // Producto inexistente / sin imagen de producto -> no devolver nada.
  return null;
}

/** Normaliza una URL de imagen a absoluta con https (resuelve rutas relativas y protocol-relative). */
function normalizarUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return 'https://www.deltron.com.pe' + s;
  return s;
}

/**
 * Extrae las celdas (<td>) de una fila de tabla, conservando los atributos
 * relevantes de Deltron: `firCol` (marca la celda de etiqueta/grupo) y `rowspan`
 * (cuántas subfilas abarca), además del texto decodificado.
 */
function celdasDeFila(trHtml) {
  const celdas = [];
  const re = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(trHtml)) !== null) {
    const attrs = m[1] || '';
    const rowspanMatch = attrs.match(/rowspan\s*=\s*"?(\d+)"?/i);
    celdas.push({
      esFirCol: /firCol\s*=\s*"?y"?/i.test(attrs),
      rowspan: rowspanMatch ? parseInt(rowspanMatch[1], 10) : 1,
      texto: decodificar(m[2]),
    });
  }
  return celdas;
}

/**
 * Parsea la tabla de Especificaciones (div#esp_tecnicas > tabla tbn="3")
 * a grupos tipo Icecat (FeaturesGroups).
 */
function parsearEspecificaciones(html) {
  const inicio = html.indexOf('id="esp_tecnicas"');
  if (inicio === -1) return [];
  const tbn3 = html.indexOf('tbn="3"', inicio);
  if (tbn3 === -1) return [];
  const fin = html.indexOf('</table>', tbn3);
  const tabla = html.slice(tbn3, fin === -1 ? undefined : fin);

  const filas = [];
  const reTr = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = reTr.exec(tabla)) !== null) {
    const celdas = celdasDeFila(m[1]);
    if (celdas.length) filas.push(celdas);
  }

  const generales = [];
  const grupos = [];
  let grupoActual = null;
  let subFilasRestantes = 0;

  for (const celdas of filas) {
    const primera = celdas[0];
    if (primera && primera.esFirCol) {
      const etiqueta = primera.texto;
      const resto = celdas.slice(1).filter((c) => c.texto !== '');
      if (primera.rowspan > 1 || resto.length >= 2) {
        grupoActual = { nombre: etiqueta, features: [] };
        if (resto.length >= 2) grupoActual.features.push({ nombre: resto[0].texto, valor: resto[1].texto });
        grupos.push(grupoActual);
        subFilasRestantes = Math.max(0, primera.rowspan - 1);
      } else {
        if (resto.length >= 1) generales.push({ nombre: etiqueta, valor: resto[0].texto });
        grupoActual = null;
        subFilasRestantes = 0;
      }
    } else if (grupoActual && subFilasRestantes > 0) {
      const noVacias = celdas.filter((c) => c.texto !== '');
      if (noVacias.length >= 2) grupoActual.features.push({ nombre: noVacias[0].texto, valor: noVacias[1].texto });
      subFilasRestantes--;
    }
  }

  const featuresGroups = [];
  if (generales.length) {
    featuresGroups.push({
      FeatureGroup: { Name: { Value: 'General' } },
      Features: generales.map((g) => ({ Feature: { Name: { Value: g.nombre } }, PresentationValue: g.valor })),
    });
  }
  for (const grupo of grupos) {
    featuresGroups.push({
      FeatureGroup: { Name: { Value: grupo.nombre } },
      Features: grupo.features.map((f) => ({ Feature: { Name: { Value: f.nombre } }, PresentationValue: f.valor })),
    });
  }
  return featuresGroups;
}

/** Extrae el título del producto desde el HTML de la ficha. */
function extraerTitulo(html) {
  const m = html.match(/title-name-product[^>]*itemprop="name">([^<]+)</);
  return m ? decodificar(m[1]) : null;
}

/** Extrae una descripción corta (máx. 500 caracteres) desde la sección "home" de la ficha. */
function extraerDescripcion(html) {
  const i = html.indexOf('id="home"');
  if (i === -1) return '';
  const fin = html.indexOf('</div>', html.indexOf('<div', i + 1));
  return decodificar(html.slice(i, fin === -1 ? i + 1500 : fin)).slice(0, 500);
}

/**
 * Construye una ficha tipo Icecat (misma forma: data.data.FeaturesGroups)
 * a partir de un HTML de Deltron ya descargado.
 */
function construirFichaDeHtml(html, codigo, marca) {
  const featuresGroups = parsearEspecificaciones(html);
  const total = featuresGroups.reduce((a, g) => a + g.Features.length, 0);
  return {
    ok: total > 0,
    fuente: 'deltron-scraping',
    status: 200,
    consulta: { codigo, marca },
    imagen: extraerImagenDeHtml(html),
    data: {
      msg: 'OK',
      StatusCode: 0,
      source: 'deltron-scraping',
      data: {
        GeneralInfo: {
          Title: extraerTitulo(html),
          Brand: marca || null,
          BrandPartCode: codigo,
          SummaryDescription: { ShortSummaryDescription: extraerDescripcion(html) },
        },
        FeaturesGroups: featuresGroups,
      },
    },
  };
}

module.exports = {
  urlProducto,
  descargarHtmlDeltron,
  extraerMpnDeHtml,
  extraerImagenDeHtml,
  parsearEspecificaciones,
  construirFichaDeHtml,
};
