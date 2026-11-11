'use strict';

/**
 * Rutas de Importación CSV
 *
 * POST /csv                    — Importar catálogo desde CSV de Deltron.
 * GET  /estado-enriquecimiento — Consultar estado del proceso de enriquecimiento IA.
 * GET  /estado/stream          — Stream SSE del estado de enriquecimiento IA.
 * POST /reintentar-fallidos    — Mover productos ia_fallido → pendiente y reactivar cola.
 *
 * Requisitos: 5.1, 5.3, 5.10, 5.12, Restricción Seg 3
 */

const express = require('express');
const router = express.Router();
const { verificarToken, verificarTokenAdmin, verificarTokenStream, emitirTokenStream } = require('../middleware/auth');
const uploadCSV = require('../middleware/multerCSV');
const ctrl = require('../controladores/controladorImportacion');

// limitadorReintento se inyecta desde servidor.js al registrar las rutas.
// Se expone como propiedad del router para que servidor.js pueda asignarlo.
let limitadorReintento = (req, res, next) => next(); // no-op por defecto (sobrescrito en servidor.js)

/**
 * Permite a servidor.js inyectar el rate limiter específico para /reintentar-fallidos.
 * Diseño §7.1 — 10 req / 15 min por IP.
 */
function setLimitadorReintento(limiter) {
  limitadorReintento = limiter;
}

router.post(
  '/csv',
  verificarToken,
  (req, res, next) => {
    uploadCSV.single('archivo')(req, res, (err) => {
      if (err) {
        if (err.codigo === 'TIPO_INVALIDO') {
          return res.status(400).json({ error: err.message });
        }
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Archivo demasiado grande (máx 50 MB)' });
        }
        return next(err);
      }
      next();
    });
  },
  ctrl.importarCSV
);

/**
 * GET /api/importacion/estado-enriquecimiento
 * Auth: verificarTokenAdmin
 * Requisitos: 5.1, 5.2
 */
router.get(
  '/estado-enriquecimiento',
  verificarTokenAdmin,
  ctrl.obtenerEstadoEnriquecimiento
);

/**
 * POST /api/importacion/estado/stream-token
 * Auth: verificarTokenAdmin (por header)
 * Emite un token efímero (60s, scope sse-stream) para abrir el stream SSE
 * sin exponer el JWT de sesión en la URL.
 */
router.post(
  '/estado/stream-token',
  verificarTokenAdmin,
  (req, res) => {
    res.json({ exito: true, token: emitirTokenStream(req.usuario) });
  }
);

/**
 * GET /api/importacion/estado/stream
 * Auth: verificarTokenStream (token efímero por query, scope sse-stream)
 * Requisitos: monitoreo tiempo real de enriquecimiento IA
 */
router.get(
  '/estado/stream',
  verificarTokenStream,
  ctrl.transmitirEstadoEnriquecimiento
);

/**
 * POST /api/importacion/reintentar-fallidos
 * Auth: verificarTokenAdmin
 * Rate limit: limitadorReintento (10 req / 15 min por IP) — Restricción Seg 3
 * Requisitos: 5.3, 5.4, 5.5
 */
router.post(
  '/reintentar-fallidos',
  verificarTokenAdmin,
  (req, res, next) => limitadorReintento(req, res, next),
  ctrl.reintentarFallidos
);

module.exports = router;
module.exports.setLimitadorReintento = setLimitadorReintento;
