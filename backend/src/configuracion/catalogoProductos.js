'use strict';

const CATEGORIAS_PRINCIPALES = new Set([
  'procesador',
  'placa_madre',
  'ram',
  'almacenamiento',
  'gpu',
  'fuente',
  'case',
]);

const CATEGORIAS_CATALOGO = new Set([
  ...CATEGORIAS_PRINCIPALES,
  'perifericos',
  'audio',
  'software',
  'almacenamiento_externo',
  'energia',
  'monitor',
  'refrigeracion',
  'conectividad',
]);

const SUBCATEGORIAS_POR_CATEGORIA = {
  perifericos: new Set(['mouse', 'teclado', 'mousepad', 'webcam']),
  audio: new Set(['auricular', 'parlante']),
  software: new Set(['windows', 'office', 'antivirus']),
  almacenamiento_externo: new Set(['almac_externo']),
  energia: new Set(['ups', 'estabilizador']),
  monitor: new Set(['monitor']),
  refrigeracion: new Set(['cooler_aire', 'cooler_liquido']),
  conectividad: new Set(['conectividad']),
};

const CATEGORIAS_ALIAS = {
  procesador: { categoria: 'procesador', subcategoria: null },
  placa_madre: { categoria: 'placa_madre', subcategoria: null },
  ram: { categoria: 'ram', subcategoria: null },
  almacenamiento: { categoria: 'almacenamiento', subcategoria: null },
  gpu: { categoria: 'gpu', subcategoria: null },
  fuente: { categoria: 'fuente', subcategoria: null },
  case: { categoria: 'case', subcategoria: null },
  perifericos: { categoria: 'perifericos', subcategoria: null },
  mouse: { categoria: 'perifericos', subcategoria: 'mouse' },
  teclado: { categoria: 'perifericos', subcategoria: 'teclado' },
  mousepad: { categoria: 'perifericos', subcategoria: 'mousepad' },
  webcam: { categoria: 'perifericos', subcategoria: 'webcam' },
  audio: { categoria: 'audio', subcategoria: null },
  auricular: { categoria: 'audio', subcategoria: 'auricular' },
  parlante: { categoria: 'audio', subcategoria: 'parlante' },
  software: { categoria: 'software', subcategoria: null },
  windows: { categoria: 'software', subcategoria: 'windows' },
  office: { categoria: 'software', subcategoria: 'office' },
  antivirus: { categoria: 'software', subcategoria: 'antivirus' },
  software_windows: { categoria: 'software', subcategoria: 'windows' },
  software_office: { categoria: 'software', subcategoria: 'office' },
  software_antivirus: { categoria: 'software', subcategoria: 'antivirus' },
  almacenamiento_externo: { categoria: 'almacenamiento_externo', subcategoria: 'almac_externo' },
  almac_externo: { categoria: 'almacenamiento_externo', subcategoria: 'almac_externo' },
  energia: { categoria: 'energia', subcategoria: null },
  ups: { categoria: 'energia', subcategoria: 'ups' },
  estabilizador: { categoria: 'energia', subcategoria: 'estabilizador' },
  monitor: { categoria: 'monitor', subcategoria: 'monitor' },
  refrigeracion: { categoria: 'refrigeracion', subcategoria: null },
  cooler_aire: { categoria: 'refrigeracion', subcategoria: 'cooler_aire' },
  cooler_liquido: { categoria: 'refrigeracion', subcategoria: 'cooler_liquido' },
  conectividad: { categoria: 'conectividad', subcategoria: 'conectividad' },
};

const CATEGORIAS_PUBLICAS_VALIDAS = new Set(Object.keys(CATEGORIAS_ALIAS));

function resolverCategoria(categoriaEntrada) {
  const clave = String(categoriaEntrada || '').trim().toLowerCase();
  const destino = CATEGORIAS_ALIAS[clave];
  if (!destino) return null;
  return { ...destino };
}

function resolverTablaPorCategoria(categoriaEntrada) {
  const destino = resolverCategoria(categoriaEntrada);
  if (!destino) return null;
  return 'productos';
}

function requiereSubcategoria(categoriaCanonica) {
  return Boolean(SUBCATEGORIAS_POR_CATEGORIA[categoriaCanonica]);
}

function subcategoriaValida(categoriaCanonica, subcategoria) {
  const permitidas = SUBCATEGORIAS_POR_CATEGORIA[categoriaCanonica];
  if (!permitidas) return subcategoria == null || String(subcategoria).trim() === '';
  return permitidas.has(String(subcategoria || '').trim().toLowerCase());
}

function esCategoriaPrincipal(categoriaCanonica) {
  return CATEGORIAS_PRINCIPALES.has(categoriaCanonica);
}

module.exports = {
  CATEGORIAS_PRINCIPALES,
  CATEGORIAS_CATALOGO,
  SUBCATEGORIAS_POR_CATEGORIA,
  CATEGORIAS_ALIAS,
  CATEGORIAS_PUBLICAS_VALIDAS,
  resolverCategoria,
  resolverTablaPorCategoria,
  requiereSubcategoria,
  subcategoriaValida,
  esCategoriaPrincipal,
};
