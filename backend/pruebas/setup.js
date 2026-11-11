/**
 * Configuración global de Jest para el backend.
 *
 * Este archivo se ejecuta después de que el entorno de test está configurado
 * (setupFilesAfterEnv). Aquí se definen mocks globales, variables de entorno
 * de test y limpieza post-suite.
 */

// Variables de entorno mínimas para tests unitarios (sin BD real)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'clave-secreta-test-jest-2024';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef'; // 32 bytes hex
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';

// Silenciar console.error en tests para mantener output limpio
// (los tests que necesiten verificar logs pueden restaurarlo localmente)
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    // Permitir errores explícitos de test (prefijados con [TEST])
    if (args[0] && String(args[0]).startsWith('[TEST]')) {
      originalConsoleError(...args);
    }
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  console.error.mockRestore?.();
  console.warn.mockRestore?.();
});

// Timeout global para tests de integración
jest.setTimeout(30000);
