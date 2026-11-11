/**
 * Pruebas Unitarias — servicioCuestionario
 * Lógica pura (sin DB, sin LLM) para detectar campos del cuestionario.
 */

const {
  detectarUsoPrincipal,
  extraerPresupuestoPen,
  detectarResolucion,
  detectarMultitarea,
  construirEstadoCuestionario,
  construirSiguientePregunta,
} = require('../../src/asistente/servicioCuestionario');

describe('servicioCuestionario', () => {
  describe('detectarUsoPrincipal', () => {
    test('detecta gaming', () => {
      const h = [{ rol: 'user', contenido: 'Quiero una PC para gaming' }];
      expect(detectarUsoPrincipal(h)).toBe('gaming');
    });

    test('detecta edición de video', () => {
      const h = [{ rol: 'user', contenido: 'Voy a editar video con Premiere' }];
      expect(detectarUsoPrincipal(h)).toBe('edicion_video');
    });

    test('detecta diseño 3D', () => {
      const h = [{ rol: 'user', contenido: 'Uso Blender para diseño 3D' }];
      expect(detectarUsoPrincipal(h)).toBe('diseno_3d');
    });

    test('detecta oficina', () => {
      const h = [{ rol: 'user', contenido: 'Para la oficina y Excel' }];
      expect(detectarUsoPrincipal(h)).toBe('oficina');
    });

    test('retorna null si no detecta uso', () => {
      const h = [{ rol: 'user', contenido: 'Hola buenas tardes' }];
      expect(detectarUsoPrincipal(h)).toBeNull();
    });

    test('ignora mensajes del asistente', () => {
      const h = [{ rol: 'assistant', contenido: '¿Para qué usarás tu PC? Para gaming quizás?' }];
      expect(detectarUsoPrincipal(h)).toBeNull();
    });
  });

  describe('extraerPresupuestoPen', () => {
    test('detecta presupuesto en soles', () => {
      const h = [{ rol: 'user', contenido: 'Tengo S/4000' }];
      expect(extraerPresupuestoPen(h)).toBe(4000);
    });

    test('detecta presupuesto numérico solo', () => {
      const h = [{ rol: 'user', contenido: 'Mi presupuesto es 3000 soles' }];
      expect(extraerPresupuestoPen(h)).toBe(3000);
    });

    test('detecta presupuesto de 5 dígitos', () => {
      const h = [{ rol: 'user', contenido: 'Tengo 15000 soles' }];
      expect(extraerPresupuestoPen(h)).toBe(15000);
    });

    test('rechaza montos menores a 500', () => {
      const h = [{ rol: 'user', contenido: 'Tengo 100 soles' }];
      expect(extraerPresupuestoPen(h)).toBeNull();
    });

    test('rechaza montos mayores a 50000', () => {
      const h = [{ rol: 'user', contenido: 'Tengo 100000 soles' }];
      expect(extraerPresupuestoPen(h)).toBeNull();
    });

    test('retorna null si no hay monto', () => {
      const h = [{ rol: 'user', contenido: 'No sé mi presupuesto' }];
      expect(extraerPresupuestoPen(h)).toBeNull();
    });
  });

  describe('detectarResolucion', () => {
    test('detecta 4K', () => {
      const h = [{ rol: 'user', contenido: 'Quiero jugar en 4K' }];
      expect(detectarResolucion(h)).toBe('4k');
    });

    test('detecta 1440p', () => {
      const h = [{ rol: 'user', contenido: 'En 1440p o 2K' }];
      expect(detectarResolucion(h)).toBe('1440p');
    });

    test('detecta 1080p', () => {
      const h = [{ rol: 'user', contenido: 'Full HD 1080p' }];
      expect(detectarResolucion(h)).toBe('1080p');
    });

    test('retorna null si no menciona resolución', () => {
      const h = [{ rol: 'user', contenido: 'No sé' }];
      expect(detectarResolucion(h)).toBeNull();
    });
  });

  describe('detectarMultitarea', () => {
    test('detecta streaming sí', () => {
      const h = [{ rol: 'user', contenido: 'Sí, voy a hacer stream' }];
      expect(detectarMultitarea(h)).toBe(true);
    });

    test('detecta streaming no', () => {
      const h = [{ rol: 'user', contenido: 'No necesito streaming' }];
      expect(detectarMultitarea(h)).toBe(false);
    });

    test('retorna null si no menciona', () => {
      const h = [{ rol: 'user', contenido: 'Gaming' }];
      expect(detectarMultitarea(h)).toBeNull();
    });
  });

  describe('construirEstadoCuestionario', () => {
    test('cuestionario completo con todos los campos', () => {
      const h = [
        { rol: 'user', contenido: 'Gaming' },
        { rol: 'user', contenido: 'S/5000' },
        { rol: 'user', contenido: '1440p' },
        { rol: 'user', contenido: 'Sí stream' },
        { rol: 'user', contenido: 'Silenciosa' },
      ];
      const estado = construirEstadoCuestionario(h);
      expect(estado.completo).toBe(true);
      expect(estado.faltantes).toEqual([]);
    });

    test('cuestionario incompleto — falta presupuesto', () => {
      const h = [{ rol: 'user', contenido: 'Gaming' }];
      const estado = construirEstadoCuestionario(h);
      expect(estado.completo).toBe(false);
      expect(estado.faltantes).toContain('presupuesto');
    });

    test('campos irrelevantes para oficina — no pide resolución ni multitarea', () => {
      const h = [
        { rol: 'user', contenido: 'Oficina' },
        { rol: 'user', contenido: 'S/2500' },
        { rol: 'user', contenido: 'Indiferente ruido' },
      ];
      const estado = construirEstadoCuestionario(h);
      expect(estado.completo).toBe(true);
    });
  });

  describe('construirSiguientePregunta', () => {
    test('primera pregunta es uso', () => {
      const estado = { faltantes: ['uso', 'presupuesto'], completo: false };
      const pregunta = construirSiguientePregunta(estado);
      expect(pregunta.respuesta).toContain('usar principalmente');
    });

    test('retorna null si cuestionario completo', () => {
      const estado = { faltantes: [], completo: true };
      expect(construirSiguientePregunta(estado)).toBeNull();
    });
  });
});
