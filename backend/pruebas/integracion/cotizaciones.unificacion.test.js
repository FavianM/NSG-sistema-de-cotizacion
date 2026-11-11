/**
 * Tests de integración — Cotizaciones: Unificación de usuarios en tabla cuentas
 *
 * Usa mocks de ejecutarQuery / ejecutarTransaccion para simular BD sin conexión real.
 * Requisitos: 10.1, 10.2, 10.3
 */

'use strict';

// ─── Mocks (deben declararse antes de require de la app) ─────────────────────

jest.mock('../../src/configuracion/baseDatos', () => ({
  ejecutarQuery: jest.fn(),
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  ejecutarTransaccion: jest.fn(),
}));

// Mock de encriptación para evitar dependencia de ENCRYPTION_KEY válida en tests
jest.mock('../../src/utilidades/encriptacion', () => {
  const crypto = require('crypto');
  const CLAVE_TEST = Buffer.alloc(32, 0x42); // 32 bytes fijos para tests

  return {
    encriptar: jest.fn((texto) => {
      const iv = Buffer.alloc(16, 0x01);
      const cipher = crypto.createCipheriv('aes-256-cbc', CLAVE_TEST, iv);
      let enc = cipher.update(texto, 'utf8', 'hex');
      enc += cipher.final('hex');
      return iv.toString('hex') + ':' + enc;
    }),
    desencriptar: jest.fn((textoEnc) => {
      if (!textoEnc || !textoEnc.includes(':')) return null;
      const [ivHex, contenido] = textoEnc.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', CLAVE_TEST, iv);
      let dec = decipher.update(contenido, 'hex', 'utf8');
      dec += decipher.final('utf8');
      return dec;
    }),
    hashBusqueda: jest.fn((texto) => {
      return crypto.createHmac('sha256', CLAVE_TEST)
        .update(texto.toLowerCase().trim())
        .digest('hex');
    }),
    generarClaveEncriptacion: jest.fn(() => CLAVE_TEST.toString('hex')),
  };
});

// ─── Imports ─────────────────────────────────────────────────────────────────

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/servidor');
const { ejecutarQuery, ejecutarTransaccion } = require('../../src/configuracion/baseDatos');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'clave-secreta-test-jest-2024';

function generarTokenAdmin(overrides = {}) {
  return jwt.sign(
    { id: 1, username: 'admin_test', nombre: 'Admin Test', rol: 'admin', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * Datos de cotización mínimos válidos para POST /api/cotizaciones.
 * 'procesador' es una categoría válida en CATEGORIAS_ALIAS.
 */
const componenteValido = [
  { id_producto: 10, tabla_producto: 'procesador', cantidad: 1 },
];

const productoMock = {
  id: 10,
  nombre: 'Procesador Test',
  subcategoria: null,
  precio_base: '100.00',
  stock: 5,
  disponible_a_pedido: false,
  descripcion_tecnica: 'Descripción técnica',
};

function cotizacionInsertadaMock(overrides = {}) {
  return {
    id: 1,
    codigo_unico: 'abc-001',
    codigo_ticket: 'NSG-2024-0001',
    fecha_emision: new Date().toISOString(),
    fecha_validez: new Date(Date.now() + 3 * 86400000).toISOString(),
    precio_total: '120.00',
    margen_aplicado: '20',
    estado: 'Pendiente',
    ...overrides,
  };
}

const detalleMock = {
  id: 1,
  nombre_producto: 'Procesador Test',
  categoria: 'procesador',
  tabla_producto: 'productos',
  precio_unitario: '120.00',
  cantidad: 1,
  disponible_stock: true,
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Cotizaciones — Unificación de usuarios en tabla cuentas', () => {
  beforeEach(() => {
    // mockReset limpia tanto el historial como los valores encolados (mockResolvedValueOnce)
    ejecutarQuery.mockReset();
    ejecutarTransaccion.mockReset();
  });

  // ── 1. POST /api/cotizaciones con correo nuevo → crea Cuenta_Pendiente ──────
  describe('POST /api/cotizaciones — correo nuevo', () => {
    it('crea una Cuenta_Pendiente en cuentas cuando el correo no existe (Requisito 4.2)', async () => {
      const token = generarTokenAdmin();

      // Dentro de ejecutarTransaccion, el callback usa:
      //   - cliente.query para SELECT productos, INSERT cotizacion, INSERT detalle
      //   - ejecutarQuery para generarCodigoTicket y buscarOCrearCliente
      //
      // Secuencia de ejecutarQuery:
      //   1. verificarTokenUsuario → SELECT estado FROM cuentas WHERE id = $1
      //   2. obtenerConfiguracionFinanciera → SELECT clave, valor FROM configuracion
      //   3. generarCodigoTicket → SELECT generar_codigo_ticket()
      //   4. buscarOCrearCliente → SELECT id FROM cuentas WHERE correo_hash = $1 (vacío)
      //   5. buscarOCrearCliente → INSERT INTO cuentas ... RETURNING id

      const mockClienteQuery = jest.fn();

      ejecutarQuery
        .mockResolvedValueOnce({ rows: [{ estado: 'activa' }] })          // 1. auth check
        .mockResolvedValueOnce({ rows: [] })                               // 2. configuracion
        .mockResolvedValueOnce({ rows: [{ codigo: 'NSG-2024-0001' }] })   // 3. ticket
        .mockResolvedValueOnce({ rows: [] })                               // 4. buscar cliente (vacío)
        .mockResolvedValueOnce({ rows: [{ id: 99 }] });                   // 5. insertar cliente

      ejecutarTransaccion.mockImplementation(async (callback) => {
        mockClienteQuery
          .mockResolvedValueOnce({ rows: [productoMock] })                 // SELECT productos
          .mockResolvedValueOnce({ rows: [cotizacionInsertadaMock()] })    // INSERT cotizacion
          .mockResolvedValueOnce({ rows: [detalleMock] });                 // INSERT detalle
        return callback({ query: mockClienteQuery });
      });

      const res = await request(app)
        .post('/api/cotizaciones')
        .set('Authorization', `Bearer ${token}`)
        .send({
          componentes: componenteValido,
          email_cliente: 'nuevo@ejemplo.com',
          nombre_cliente: 'Cliente Nuevo',
        });

      expect(res.status).toBe(201);
      expect(res.body.exito).toBe(true);

      // Verificar que se llamó a INSERT en cuentas con estado = 'pendiente_activacion'
      const insertCuentas = ejecutarQuery.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('INSERT INTO cuentas') &&
          sql.includes('pendiente_activacion')
      );
      expect(insertCuentas).toBeDefined();
    });
  });

  // ── 2. POST /api/cotizaciones con correo existente → reutiliza cuenta ───────
  describe('POST /api/cotizaciones — correo existente', () => {
    it('reutiliza la cuenta existente y NO inserta en cuentas (Requisito 4.3)', async () => {
      const token = generarTokenAdmin();

      // Secuencia de ejecutarQuery:
      //   1. verificarTokenUsuario
      //   2. obtenerConfiguracionFinanciera
      //   3. generarCodigoTicket
      //   4. buscarOCrearCliente → SELECT retorna cliente existente (no hay INSERT)

      const mockClienteQuery = jest.fn();

      ejecutarQuery
        .mockResolvedValueOnce({ rows: [{ estado: 'activa' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ codigo: 'NSG-2024-0002' }] })
        .mockResolvedValueOnce({ rows: [{ id: 55, nombre: 'Cliente Existente', telefono: null }] });

      ejecutarTransaccion.mockImplementation(async (callback) => {
        mockClienteQuery
          .mockResolvedValueOnce({ rows: [productoMock] })
          .mockResolvedValueOnce({ rows: [cotizacionInsertadaMock({ id: 2, codigo_ticket: 'NSG-2024-0002' })] })
          .mockResolvedValueOnce({ rows: [detalleMock] });
        return callback({ query: mockClienteQuery });
      });

      const res = await request(app)
        .post('/api/cotizaciones')
        .set('Authorization', `Bearer ${token}`)
        .send({
          componentes: componenteValido,
          email_cliente: 'existente@ejemplo.com',
          nombre_cliente: 'Cliente Existente',
        });

      expect(res.status).toBe(201);
      expect(res.body.exito).toBe(true);

      // Verificar que NO se llamó a INSERT en cuentas
      const insertCuentas = ejecutarQuery.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO cuentas')
      );
      expect(insertCuentas).toBeUndefined();
    });
  });

  // ── 3. POST /api/cotizaciones sin email → id_cliente = NULL ─────────────────
  describe('POST /api/cotizaciones — sin email', () => {
    it('crea la cotización con id_cliente = NULL cuando no se proporciona email (Requisito 4.5)', async () => {
      const token = generarTokenAdmin();

      // Sin email → buscarOCrearCliente retorna null sin llamar a BD
      // Secuencia de ejecutarQuery:
      //   1. verificarTokenUsuario
      //   2. obtenerConfiguracionFinanciera
      //   3. generarCodigoTicket

      let paramsInsertCotizacion = null;
      const mockClienteQuery = jest.fn();

      ejecutarQuery
        .mockResolvedValueOnce({ rows: [{ estado: 'activa' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ codigo: 'NSG-2024-0003' }] });

      ejecutarTransaccion.mockImplementation(async (callback) => {
        mockClienteQuery
          .mockResolvedValueOnce({ rows: [productoMock] })
          .mockImplementationOnce(async (sql, params) => {
            paramsInsertCotizacion = params;
            return { rows: [cotizacionInsertadaMock({ id: 3, codigo_ticket: 'NSG-2024-0003' })] };
          })
          .mockResolvedValueOnce({ rows: [detalleMock] });
        return callback({ query: mockClienteQuery });
      });

      const res = await request(app)
        .post('/api/cotizaciones')
        .set('Authorization', `Bearer ${token}`)
        .send({
          componentes: componenteValido,
          // Sin email_cliente ni nombre_cliente (admin puede omitirlos)
        });

      expect(res.status).toBe(201);
      expect(res.body.exito).toBe(true);

      // El segundo parámetro del INSERT cotizaciones es id_cliente
      // INSERT INTO cotizaciones (codigo_ticket, id_cliente, ...) VALUES ($1, $2, ...)
      expect(paramsInsertCotizacion).not.toBeNull();
      expect(paramsInsertCotizacion[1]).toBeNull();

      // Verificar que NO se llamó a INSERT en cuentas
      const insertCuentas = ejecutarQuery.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO cuentas')
      );
      expect(insertCuentas).toBeUndefined();
    });
  });

  // ── 4. GET /api/cotizaciones/:ticket → JOIN con cuentas retorna datos cliente
  describe('GET /api/cotizaciones/:ticket', () => {
    it('retorna HTTP 200 con datos de cotización del JOIN con cuentas (Requisito 10.2)', async () => {
      // obtenerCotizacionConDetallesPorTicket llama a ejecutarQuery dos veces:
      // 1. SELECT cotizacion con LEFT JOIN cuentas
      // 2. SELECT detalle_cotizacion

      ejecutarQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 10,
              codigo_unico: 'abc-001',
              codigo_ticket: 'NSG-2024-0010',
              id_cliente: 55,
              fecha_emision: new Date(Date.now() - 86400000).toISOString(),
              fecha_validez: new Date(Date.now() + 2 * 86400000).toISOString(),
              precio_total: '500.00',
              margen_aplicado: '20',
              estado: 'Pendiente',
              fecha_reclamacion: null,
              // Datos del JOIN con cuentas:
              cliente_nombre: 'Juan Pérez',
              cliente_correo: null, // null → desencriptarSeguro retorna null sin error
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              id_producto: 10,
              nombre_producto: 'Procesador Test',
              categoria: 'procesador',
              descripcion_tecnica: 'Descripción',
              precio_unitario: '500.00',
              cantidad: 1,
              disponible_stock: true,
            },
          ],
        });

      const res = await request(app).get('/api/cotizaciones/NSG-2024-0010');

      expect(res.status).toBe(200);
      expect(res.body.exito).toBe(true);
      expect(res.body.cotizacion).toBeDefined();
      expect(res.body.cotizacion.codigo_ticket).toBe('NSG-2024-0010');
      expect(res.body.cotizacion.estado).toBe('Pendiente');
      expect(res.body.cotizacion.componentes).toHaveLength(1);

      // Verificar que la query usó LEFT JOIN cuentas (no usuarios_clientes)
      const primeraQuery = ejecutarQuery.mock.calls[0][0];
      expect(primeraQuery).toContain('cuentas');
      expect(primeraQuery).not.toContain('usuarios_clientes');
    });

    it('retorna 404 cuando la cotización no existe', async () => {
      ejecutarQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/cotizaciones/NSG-2024-9999');

      expect(res.status).toBe(404);
      expect(res.body.codigo).toBe('COTIZACION_NO_ENCONTRADA');
    });
  });

  // ── 5. GET /api/cotizaciones/cliente/:email → historial del usuario ──────────
  describe('GET /api/cotizaciones/cliente/:email', () => {
    it('retorna las cotizaciones del usuario identificado por email (Requisito 10.3)', async () => {
      const emailCliente = 'historial@ejemplo.com';

      // consultarHistorialCliente (la ruta ahora exige autenticación):
      // 1. SELECT estado FROM cuentas (middleware verificarTokenUsuario)
      // 2. SELECT id, nombre_completo FROM cuentas WHERE correo_hash = $1
      // 3. SELECT cotizaciones (esquema v1 — NODE_ENV=test → usaEsquemaFinancieroV2 = false)

      ejecutarQuery
        .mockResolvedValueOnce({ rows: [{ estado: 'activa' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 42, nombre: 'Cliente Historial' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 100,
              codigo_unico: 'hist-001',
              codigo_ticket: 'NSG-2024-0100',
              fecha_emision: new Date(Date.now() - 86400000).toISOString(),
              fecha_validez: new Date(Date.now() + 2 * 86400000).toISOString(),
              precio_total: '350.00',
              margen_aplicado: '20',
              estado: 'Pendiente',
              fecha_reclamacion: null,
              cantidad_componentes: '2',
              estado_notificacion: null,
              fecha_notificacion: null,
            },
            {
              id: 101,
              codigo_unico: 'hist-002',
              codigo_ticket: 'NSG-2024-0101',
              fecha_emision: new Date(Date.now() - 2 * 86400000).toISOString(),
              fecha_validez: new Date(Date.now() + 86400000).toISOString(),
              precio_total: '150.00',
              margen_aplicado: '20',
              estado: 'Completada',
              fecha_reclamacion: new Date().toISOString(),
              cantidad_componentes: '1',
              estado_notificacion: 'enviada',
              fecha_notificacion: new Date().toISOString(),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/cotizaciones/cliente/${encodeURIComponent(emailCliente)}`)
        .set('Authorization', `Bearer ${generarTokenAdmin()}`);

      expect(res.status).toBe(200);
      expect(res.body.exito).toBe(true);
      expect(res.body.cotizaciones).toHaveLength(2);
      expect(res.body.cantidad).toBe(2);
      expect(res.body.cliente.nombre).toBe('Cliente Historial');
      expect(res.body.cliente.email).toBe(emailCliente);

      // Verificar que la primera query buscó en cuentas (no en usuarios_clientes)
      const primeraQuery = ejecutarQuery.mock.calls[0][0];
      expect(primeraQuery).toContain('cuentas');
      expect(primeraQuery).not.toContain('usuarios_clientes');
    });

    it('retorna lista vacía cuando el email no tiene cuenta asociada (Requisito 6.3)', async () => {
      ejecutarQuery
        .mockResolvedValueOnce({ rows: [{ estado: 'activa' }] }) // middleware auth
        .mockResolvedValueOnce({ rows: [] }); // SELECT cuentas → no encontrado

      const res = await request(app)
        .get('/api/cotizaciones/cliente/sinhistorial@ejemplo.com')
        .set('Authorization', `Bearer ${generarTokenAdmin()}`);

      expect(res.status).toBe(200);
      expect(res.body.exito).toBe(true);
      expect(res.body.cotizaciones).toEqual([]);
      expect(res.body.cantidad).toBe(0);
    });

    it('retorna 400 cuando el email tiene formato inválido', async () => {
      ejecutarQuery.mockResolvedValueOnce({ rows: [{ estado: 'activa' }] }); // middleware auth

      const res = await request(app)
        .get('/api/cotizaciones/cliente/no-es-un-email')
        .set('Authorization', `Bearer ${generarTokenAdmin()}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('retorna 401 cuando no hay token de autenticación (endpoint protegido)', async () => {
      const res = await request(app).get('/api/cotizaciones/cliente/cualquiera@ejemplo.com');

      expect(res.status).toBe(401);
    });
  });
});
