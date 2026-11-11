/**
 * Pruebas Unitarias — servicioLLM
 * Parser JSON robusto, timeouts, fallbacks y reintentos.
 */

const { extraerJSON, ErrorLLM } = require('../../src/asistente/servicioLLM');

// Mock de las APIs externas
jest.mock('../../src/asistente/servicioLLM', () => {
  const original = jest.requireActual('../../src/asistente/servicioLLM');
  return original;
});

describe('servicioLLM', () => {
  describe('extraerJSON', () => {
    test('parsea JSON válido directamente', () => {
      const result = extraerJSON('{"respuesta":"hola","quick_replies":[]}');
      expect(result).toEqual({ respuesta: 'hola', quick_replies: [] });
    });

    test('parsea JSON con markdown fences ```json ... ```', () => {
      const texto = '```json\n{"respuesta":"hola"}\n```';
      const result = extraerJSON(texto);
      expect(result).toEqual({ respuesta: 'hola' });
    });

    test('parsea JSON con fences ``` sin json', () => {
      const texto = '```\n{"respuesta":"hola"}\n```';
      const result = extraerJSON(texto);
      expect(result).toEqual({ respuesta: 'hola' });
    });

    test('extrae JSON embebido en texto', () => {
      const texto = 'Aquí está tu respuesta: {"respuesta":"hola","quick_replies":[]} y más texto';
      const result = extraerJSON(texto);
      expect(result).toEqual({ respuesta: 'hola', quick_replies: [] });
    });

    test('retorna null para texto sin JSON', () => {
      expect(extraerJSON('Hola mundo')).toBeNull();
    });

    test('retorna null para input vacío', () => {
      expect(extraerJSON('')).toBeNull();
    });

    test('retorna null para input null', () => {
      expect(extraerJSON(null)).toBeNull();
    });

    test('retorna null para input undefined', () => {
      expect(extraerJSON(undefined)).toBeNull();
    });

    test('retorna null para input no-string', () => {
      expect(extraerJSON(123)).toBeNull();
    });

    test('parsea JSON UTF-8 con caracteres españoles', () => {
      const texto = '{"respuesta":"Configuración para edición de video"}';
      const result = extraerJSON(texto);
      expect(result.respuesta).toBe('Configuración para edición de video');
    });
  });

  describe('ErrorLLM', () => {
    test('crea error con tipo rate_limit', () => {
      const err = new ErrorLLM('Rate limited', 'rate_limit');
      expect(err.tipo).toBe('rate_limit');
      expect(err.message).toBe('Rate limited');
      expect(err.name).toBe('ErrorLLM');
    });

    test('crea error con tipo no_provider', () => {
      const err = new ErrorLLM('No API key', 'no_provider');
      expect(err.tipo).toBe('no_provider');
    });

    test('crea error con tipo invalid_json', () => {
      const err = new ErrorLLM('Bad JSON', 'invalid_json');
      expect(err.tipo).toBe('invalid_json');
    });
  });
});
