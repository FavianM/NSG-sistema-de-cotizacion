/**
 * Rutas: Tipo de cambio automático
 *
 * Expone el proxy hacia la API externa de decolecta.com.
 * Todas las rutas requieren autenticación JWT.
 *
 * Requisitos: 2.1, 10.5
 */

const express = require('express');
const router = express.Router();
const { verificarToken } = require('../middleware/auth');
const { obtenerTipoCambioAutomatico } = require('../controladores/controladorTipoCambio');

// GET /api/tipo-cambio/automatico
// Requiere token JWT válido antes de consultar la API externa
router.get('/automatico', verificarToken, obtenerTipoCambioAutomatico);

module.exports = router;
