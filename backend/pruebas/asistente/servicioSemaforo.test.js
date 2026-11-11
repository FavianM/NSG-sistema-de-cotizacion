/**
 * Pruebas Unitarias — servicioSemaforo
 * Puntuaciones del semáforo de capacidades.
 */

const {
  calcularSemaforo,
  scoreGaming,
  scoreEdicionVideo,
  scoreProductividad,
  scoreStreaming,
  scoreRenderizado3d,
} = require('../../src/asistente/servicioSemaforo');

const COMPONENTES_GAMING_HIGH = {
  procesador: { nucleos: 16, hilos: 24, frecuencia_boost_ghz: 5.5, tdp_w: 125 },
  gpu: { vram_gb: 16, tdp_w: 350 },
  ram: [{ capacidad_gb: 32 }, { capacidad_gb: 32 }],
};

const COMPONENTES_OFICINA = {
  procesador: { nucleos: 6, hilos: 12, frecuencia_boost_ghz: 4.3, tdp_w: 65 },
  gpu: { vram_gb: 0, tdp_w: 0 },
  ram: [{ capacidad_gb: 8 }],
};

describe('servicioSemaforo', () => {
  describe('calcularSemaforo', () => {
    test('todas las categorías retornan número entre 1 y 10', () => {
      const semaforo = calcularSemaforo(COMPONENTES_GAMING_HIGH);
      for (const [cat, val] of Object.entries(semaforo)) {
        expect(val).toBeGreaterThanOrEqual(1);
        expect(val).toBeLessThanOrEqual(10);
      }
    });

    test('PC gaming high-end tiene gaming > 7', () => {
      const semaforo = calcularSemaforo(COMPONENTES_GAMING_HIGH);
      expect(semaforo.gaming).toBeGreaterThan(7);
    });

    test('PC oficina tiene productividad razonable', () => {
      const semaforo = calcularSemaforo(COMPONENTES_OFICINA);
      expect(semaforo.productividad).toBeGreaterThanOrEqual(3);
    });
  });

  describe('scoreGaming', () => {
    test('GPU potente puntúa alto', () => {
      const gpu = { vram_gb: 24, tdp_w: 450 };
      const cpu = { frecuencia_boost_ghz: 5.8 };
      const score = scoreGaming(gpu, cpu);
      expect(score).toBeGreaterThan(7);
    });

    test('sin GPU puntúa bajo', () => {
      const gpu = { vram_gb: 0, tdp_w: 0 };
      const cpu = { frecuencia_boost_ghz: 3.0 };
      const score = scoreGaming(gpu, cpu);
      expect(score).toBeLessThanOrEqual(4);
    });
  });

  describe('scoreEdicionVideo', () => {
    test('muchos núcleos + RAM = puntaje alto', () => {
      const cpu = { nucleos: 24, hilos: 32 };
      const ram = [{ capacidad_gb: 64 }];
      const score = scoreEdicionVideo(cpu, ram);
      expect(score).toBeGreaterThan(7);
    });
  });

  describe('scoreProductividad', () => {
    test('single-core alto = productividad alta', () => {
      const cpu = { frecuencia_boost_ghz: 5.8, nucleos: 8 };
      const score = scoreProductividad(cpu);
      expect(score).toBeGreaterThan(6);
    });
  });

  describe('scoreStreaming', () => {
    test('GPU + CPU balanceados', () => {
      const gpu = { vram_gb: 12, tdp_w: 250 };
      const cpu = { nucleos: 12 };
      const score = scoreStreaming(gpu, cpu);
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(10);
    });
  });

  describe('scoreRenderizado3d', () => {
    test('VRAM alta = puntaje alto', () => {
      const gpu = { vram_gb: 24, tdp_w: 450 };
      const score = scoreRenderizado3d(gpu);
      expect(score).toBeGreaterThan(7);
    });

    test('sin GPU = puntaje bajo', () => {
      const gpu = { vram_gb: 0, tdp_w: 0 };
      const score = scoreRenderizado3d(gpu);
      expect(score).toBeLessThanOrEqual(5);
    });
  });
});
