/**
 * Rutas del Asistente IA
 * Express router con rate limiting para los 5 endpoints del asistente.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const controlador = require('./controladorAsistente');
const { verificarToken, verificarTokenAdmin, verificarTokenUsuario } = require('../middleware/auth');

const router = express.Router();

// Rate limiter: 20 requests por minuto por IP
const limitadorAsistente = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.ip,
  message: {
    exito: false,
    mensaje: 'Demasiadas solicitudes al asistente. Espera un momento.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/asistente/nueva-sesion (requiere login)
router.post('/nueva-sesion', limitadorAsistente, verificarTokenUsuario, controlador.nuevaSesion);

// POST /api/asistente/mensaje (requiere login)
router.post('/mensaje', limitadorAsistente, verificarTokenUsuario, controlador.procesarMensaje);

// POST /api/asistente/validar-configuracion (requiere login)
router.post('/validar-configuracion', limitadorAsistente, verificarTokenUsuario, controlador.validarConfiguracion);

// GET /api/asistente/historial/:usuario_id (solo admin)
router.get('/historial/:usuario_id', verificarTokenAdmin, controlador.obtenerHistorial);

// GET /api/asistente/sesion/:sesion_id (requiere login)
router.get('/sesion/:sesion_id', verificarTokenUsuario, controlador.obtenerSesion);

module.exports = router;
