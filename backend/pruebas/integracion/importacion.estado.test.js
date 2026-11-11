jest.mock('../../src/configuracion/baseDatos', () => ({
  ejecutarQuery: jest.fn(),
}));

jest.mock('../../src/servicios/servicioEnriquecimiento', () => ({
  estado: jest.fn(),
}));

const { ejecutarQuery } = require('../../src/configuracion/baseDatos');
const servicioEnriquecimiento = require('../../src/servicios/servicioEnriquecimiento');
const {
  construirEstadoEnriquecimiento,
  transmitirEstadoEnriquecimiento,
} = require('../../src/controladores/controladorImportacion');

describe('controladorImportacion estado enriquecimiento', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    servicioEnriquecimiento.estado.mockReturnValue({
      procesando: true,
      en_cola: 2,
    });
    ejecutarQuery.mockResolvedValue({
      rows: [
        { estado_enriquecimiento: 'pendiente', total: '7' },
        { estado_enriquecimiento: 'enriquecido', total: '11' },
        { estado_enriquecimiento: 'fallido', total: '3' },
      ],
    });
  });

  test('construye estado combinando memoria y conteos BD', async () => {
    const estado = await construirEstadoEnriquecimiento();

    expect(estado).toMatchObject({
      en_proceso: true,
      pendientes: 7,
      pendientes_en_memoria: 2,
      completados: 11,
      fallidos: 3,
    });
    expect(typeof estado.ultima_actualizacion).toBe('string');
  });

  test('stream SSE envía evento inicial y limpia intervalos al cerrar', async () => {
    jest.useFakeTimers();
    const listeners = {};
    const req = {
      on: jest.fn((evento, cb) => {
        listeners[evento] = cb;
      }),
    };
    const res = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };

    await transmitirEstadoEnriquecimiento(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(res.write).toHaveBeenCalledWith('event: estado\n');
    expect(res.write.mock.calls.some(([texto]) => String(texto).includes('"pendientes":7'))).toBe(true);

    listeners.close();
    jest.runOnlyPendingTimers();

    expect(res.end).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
