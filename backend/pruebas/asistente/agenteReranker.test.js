/**
 * Pruebas Unitarias — agenteReranker
 * Selección de productos, compatibilidad socket, distribución de presupuesto.
 */

const {
  rerank,
  rerankFallback,
  obtenerDistribucion,
  inferirPerfil,
} = require('../../src/asistente/agenteReranker');

const CANDIDATOS_EJEMPLO = new Map([
  ['procesador', [
    { id: 1, score: 0.9, producto: { id: 1, nombre: 'Ryzen 7 7800X3D', precio_usd: 350, socket: 'AM5' } },
    { id: 2, score: 0.7, producto: { id: 2, nombre: 'Ryzen 5 7600X', precio_usd: 200, socket: 'AM5' } },
  ]],
  ['placa_madre', [
    { id: 10, score: 0.8, producto: { id: 10, nombre: 'B650 Tomahawk', precio_usd: 180, socket: 'AM5' } },
    { id: 11, score: 0.6, producto: { id: 11, nombre: 'Z790 Tomahawk', precio_usd: 220, socket: 'LGA1700' } },
  ]],
  ['ram', [
    { id: 20, score: 0.85, producto: { id: 20, nombre: 'DDR5 32GB 5600', precio_usd: 90 } },
  ]],
  ['almacenamiento', [
    { id: 30, score: 0.8, producto: { id: 30, nombre: 'NVMe 1TB', precio_usd: 80 } },
  ]],
  ['gpu', [
    { id: 40, score: 0.9, producto: { id: 40, nombre: 'RTX 4070 Super', precio_usd: 600, vram_gb: 12 } },
  ]],
  ['fuente', [
    { id: 50, score: 0.75, producto: { id: 50, nombre: '750W 80+ Gold', precio_usd: 100, wattage: 750 } },
  ]],
  ['case', [
    { id: 60, score: 0.7, producto: { id: 60, nombre: 'Meshify 2', precio_usd: 90 } },
  ]],
]);

const CLASIFICACION_GAMING = {
  uso_principal: 'gaming',
  presupuesto_pen: 5000,
  resolucion: '1440p',
  multitarea_stream: false,
  preferencia_ruido: 'indiferente',
  perfil: 'avanzado',
};

describe('agenteReranker', () => {
  describe('rerank', () => {
    test('genera propuesta con 7 slots', async () => {
      const result = await rerank(CLASIFICACION_GAMING, CANDIDATOS_EJEMPLO, {
        tipoCambio: 3.7,
        margen: 15,
        igv: 18,
      });
      expect(result.configuracion_propuesta).toBeDefined();
      expect(result.configuracion_propuesta.procesador).toBeDefined();
      expect(result.configuracion_propuesta.placa_madre).toBeDefined();
      expect(result.configuracion_propuesta.ram).toBeDefined();
      expect(result.configuracion_propuesta.gpu).toBeDefined();
      expect(result.configuracion_propuesta.fuente).toBeDefined();
      expect(result.configuracion_propuesta.case).toBeDefined();
    });

    test('detecta incompatibilidad de socket y selecciona compatible', async () => {
      // Clasificación con CPU socket AM5 — debe elegir placa AM5, no LGA1700
      const result = await rerank(CLASIFICACION_GAMING, CANDIDATOS_EJEMPLO, {
        tipoCambio: 3.7,
        margen: 15,
        igv: 18,
      });
      // El procesador seleccionado tiene socket AM5
      const cpuItem = CANDIDATOS_EJEMPLO.get('procesador').find(
        (c) => c.producto.id === result.configuracion_propuesta.procesador.id
      );
      const mbItem = CANDIDATOS_EJEMPLO.get('placa_madre').find(
        (c) => c.producto.id === result.configuracion_propuesta.placa_madre.id
      );
      if (cpuItem && mbItem) {
        expect(cpuItem.producto.socket).toBe(mbItem.producto.socket);
      }
    });

    test('prioriza stock disponible sobre componentes a pedido', async () => {
      const candidatos = new Map([
        ['procesador', [
          // a pedido (stock 0), barato y dentro de presupuesto
          { id: 1, score: 0.9, producto: { id: 1, nombre: 'CPU a pedido', precio_usd: 150, stock: 0, disponible_a_pedido: true, socket: 'AM5' } },
          // en stock, también dentro de presupuesto
          { id: 2, score: 0.8, producto: { id: 2, nombre: 'CPU en stock', precio_usd: 180, stock: 5, disponible_a_pedido: false, socket: 'AM5' } },
        ]],
        ['placa_madre', [
          { id: 10, score: 0.8, producto: { id: 10, nombre: 'B650', precio_usd: 150, stock: 3, socket: 'AM5' } },
        ]],
      ]);
      const result = await rerank(CLASIFICACION_GAMING, candidatos, { tipoCambio: 3.7, margen: 15, igv: 18 });
      // Debe elegir el que tiene stock, no el "a pedido"
      expect(result.configuracion_propuesta.procesador.id).toBe(2);
    });

    test('filtra RAM incompatible con el tipo de la placa', async () => {
      const candidatos = new Map([
        ['procesador', [
          { id: 1, score: 0.9, producto: { id: 1, nombre: 'CPU', precio_usd: 150, stock: 5, socket: 'AM5' } },
        ]],
        ['placa_madre', [
          { id: 10, score: 0.8, producto: { id: 10, nombre: 'Placa DDR5', precio_usd: 150, stock: 5, socket: 'AM5', ram_tipo: 'DDR5' } },
        ]],
        ['ram', [
          { id: 20, score: 0.9, producto: { id: 20, nombre: 'RAM DDR4', precio_usd: 50, stock: 5, ram_type: 'DDR4' } },
          { id: 21, score: 0.7, producto: { id: 21, nombre: 'RAM DDR5', precio_usd: 70, stock: 5, ram_type: 'DDR5' } },
        ]],
      ]);
      const result = await rerank(CLASIFICACION_GAMING, candidatos, { tipoCambio: 3.7, margen: 15, igv: 18 });
      // Debe elegir DDR5 (compatible con la placa), no DDR4 aunque tenga mejor score
      expect(result.configuracion_propuesta.ram[0].id).toBe(21);
    });

    test('incluye perfil inferido si no viene en clasificación', async () => {
      const sinPerfil = { ...CLASIFICACION_GAMING, perfil: null };
      const result = await rerank(sinPerfil, CANDIDATOS_EJEMPLO, {
        tipoCambio: 3.7, margen: 15, igv: 18,
      });
      expect(result.perfil).toBeDefined();
    });
  });

  describe('rerankFallback', () => {
    test('retorna mismo resultado que rerank (misma lógica)', async () => {
      const result = await rerankFallback(CLASIFICACION_GAMING, CANDIDATOS_EJEMPLO, {
        tipoCambio: 3.7, margen: 15, igv: 18,
      });
      expect(result.configuracion_propuesta).toBeDefined();
    });
  });

  describe('obtenerDistribucion', () => {
    test('gaming sin resolución = gaming_1080p', () => {
      const dist = obtenerDistribucion('gaming', null);
      expect(dist.gpu).toBe(0.26);
    });

    test('gaming 1440p', () => {
      const dist = obtenerDistribucion('gaming', '1440p');
      expect(dist.gpu).toBe(0.30);
    });

    test('gaming 4k', () => {
      const dist = obtenerDistribucion('gaming', '4k');
      expect(dist.gpu).toBe(0.34);
    });

    test('oficina = GPU baja', () => {
      const dist = obtenerDistribucion('oficina', null);
      expect(dist.gpu).toBe(0.12);
    });

    test('uso desconocido = default', () => {
      const dist = obtenerDistribucion('otro', null);
      expect(dist.gpu).toBe(0.26);
    });
  });

  describe('inferirPerfil', () => {
    test('presupuesto bajo = basico', () => {
      expect(inferirPerfil({ presupuesto_pen: 2500 })).toBe('basico');
    });

    test('presupuesto medio = intermedio', () => {
      expect(inferirPerfil({ presupuesto_pen: 4000 })).toBe('intermedio');
    });

    test('presupuesto alto = avanzado', () => {
      expect(inferirPerfil({ presupuesto_pen: 7000 })).toBe('avanzado');
    });

    test('presupuesto premium = gamer_full', () => {
      expect(inferirPerfil({ presupuesto_pen: 12000 })).toBe('gamer_full');
    });

    test('sin presupuesto + gaming = avanzado', () => {
      expect(inferirPerfil({ uso_principal: 'gaming' })).toBe('avanzado');
    });

    test('sin presupuesto + oficina = basico', () => {
      expect(inferirPerfil({ uso_principal: 'oficina' })).toBe('basico');
    });
  });
});
