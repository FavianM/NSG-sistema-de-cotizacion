/**
 * Tests de integración — Unificación de usuarios en tabla cuentas
 *
 * Usa mocks de ejecutarQuery para simular BD sin conexión real.
 * Requisitos: 10.4, 10.5
 */

'use strict';

// ─── Mocks (deben declararse antes de require de la app) ─────────────────────

jest.mock('../../src/configuracion/baseDatos', () => ({
  ejecutarQuery: jest.fn(),
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

const request = require('supertest');
const app = require('../../src/servidor');
const { ejecutarQuery } = require('../../src/configuracion/baseDatos');
const bcrypt = require('bcryptjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Configura ejecutarQuery para retornar distintos valores en llamadas sucesivas.
 * @param {...{rows: Array}} respuestas
 */
function mockQuerySecuencia(...respuestas) {
  respuestas.forEach((resp, i) => {
    ejecutarQuery.mockResolvedValueOnce(resp);
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Auth — Unificación de usuarios en tabla cuentas', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. Login con Cuenta_Pendiente → HTTP 403 ────────────────────────────────
  describe('POST /api/auth/login', () => {
    it('retorna 403 con codigo CUENTA_PENDIENTE cuando la cuenta está pendiente de activación', async () => {
      // Mock: la query de búsqueda por username retorna cuenta pendiente
      ejecutarQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            username: 'guest_abc123',
            password_hash: null,
            nombre_completo: 'Cliente Presencial',
            rol: 'usuario',
            estado: 'pendiente_activacion',
            intentos_fallidos: 0,
            bloqueado_hasta: null,
          },
        ],
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'guest_abc123', password: 'cualquierCosa' });

      expect(res.status).toBe(403);
      expect(res.body.codigo).toBe('CUENTA_PENDIENTE');
    });

    // ── 2. Login con Cuenta_Activa válida → HTTP 200 + token ──────────────────
    it('retorna 200 con token cuando la cuenta está activa y las credenciales son válidas', async () => {
      const passwordHashFalso = '$2b$12$hasheado';

      // Primera llamada: buscar cuenta por username
      ejecutarQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 2,
            username: 'usuario_activo',
            password_hash: passwordHashFalso,
            nombre_completo: 'Usuario Activo',
            rol: 'usuario',
            estado: 'activa',
            intentos_fallidos: 0,
            bloqueado_hasta: null,
          },
        ],
      });

      // Segunda llamada: UPDATE intentos_fallidos = 0 (login exitoso)
      ejecutarQuery.mockResolvedValueOnce({ rows: [] });

      // bcrypt.compare retorna true (contraseña correcta)
      bcrypt.compare.mockResolvedValueOnce(true);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usuario_activo', password: 'Password123!' });

      expect(res.status).toBe(200);
      expect(res.body.exito).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(typeof res.body.token).toBe('string');
    });
  });

  // ── 3. Registro con correo pendiente → HTTP 409 + CUENTA_PENDIENTE_ACTIVACION
  describe('POST /api/auth/registro', () => {
    it('retorna 409 con codigo CUENTA_PENDIENTE_ACTIVACION cuando el correo tiene cuenta pendiente', async () => {
      // Primera llamada: verificar unicidad de username → no existe
      ejecutarQuery.mockResolvedValueOnce({ rows: [] });

      // Segunda llamada: verificar correo_hash → existe con estado pendiente
      ejecutarQuery.mockResolvedValueOnce({
        rows: [{ id: 5, estado: 'pendiente_activacion' }],
      });

      const res = await request(app)
        .post('/api/auth/registro')
        .send({
          username: 'nuevo_usuario',
          password: 'Password123!',
          confirmarPassword: 'Password123!',
          correo: 'cliente@ejemplo.com',
          nombre_completo: 'Cliente Ejemplo',
        });

      expect(res.status).toBe(409);
      expect(res.body.codigo).toBe('CUENTA_PENDIENTE_ACTIVACION');
    });

    // ── 4. Registro con correo activo → HTTP 409 ──────────────────────────────
    it('retorna 409 con mensaje de correo ya registrado cuando la cuenta está activa', async () => {
      // Primera llamada: verificar unicidad de username → no existe
      ejecutarQuery.mockResolvedValueOnce({ rows: [] });

      // Segunda llamada: verificar correo_hash → existe con estado activa
      ejecutarQuery.mockResolvedValueOnce({
        rows: [{ id: 6, estado: 'activa' }],
      });

      const res = await request(app)
        .post('/api/auth/registro')
        .send({
          username: 'otro_usuario',
          password: 'Password123!',
          confirmarPassword: 'Password123!',
          correo: 'activo@ejemplo.com',
          nombre_completo: 'Usuario Activo',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('El correo electrónico ya está registrado');
    });
  });

  // ── 5. Activar cuenta con datos válidos → HTTP 200 + token + estado activa ──
  describe('POST /api/auth/activar', () => {
    it('retorna 200 con token cuando los datos son válidos y la cuenta está pendiente', async () => {
      // Primera llamada: buscar cuenta por correo_hash con estado pendiente
      ejecutarQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            nombre_completo: 'Cliente Presencial',
            rol: 'usuario',
          },
        ],
      });

      // Segunda llamada: verificar unicidad de username → no existe
      ejecutarQuery.mockResolvedValueOnce({ rows: [] });

      // bcrypt.hash retorna un hash simulado
      bcrypt.hash.mockResolvedValueOnce('$2b$12$hashActivacion');

      // Tercera llamada: UPDATE para activar la cuenta
      ejecutarQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/activar')
        .send({
          correo: 'cliente@ejemplo.com',
          username: 'cliente_nuevo',
          password: 'Password123!',
          confirmarPassword: 'Password123!',
        });

      expect(res.status).toBe(200);
      expect(res.body.exito).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(typeof res.body.token).toBe('string');
    });

    // ── 6. Activar con password < 8 chars → HTTP 400 ─────────────────────────
    it('retorna 400 con codigo PASSWORD_INVALIDO cuando la contraseña tiene menos de 8 caracteres', async () => {
      const res = await request(app)
        .post('/api/auth/activar')
        .send({
          correo: 'cliente@ejemplo.com',
          username: 'cliente_nuevo',
          password: 'corta', // 5 caracteres
          confirmarPassword: 'corta',
        });

      expect(res.status).toBe(400);
      expect(res.body.codigo).toBe('PASSWORD_INVALIDO');
    });
  });
});
