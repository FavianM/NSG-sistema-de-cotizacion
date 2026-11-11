/**
 * Rutas del Dashboard
 *
 * GET /api/dashboard/metricas — métricas operativas (solo admin)
 *
 * Requisitos: 1.1, 1.5
 */

const express = require('express');
const router = express.Router();
const { verificarTokenAdmin } = require('../middleware/auth');
const { obtenerMetricas } = require('../controladores/controladorDashboard');

// Métricas del dashboard — requiere rol admin
router.get('/metricas', verificarTokenAdmin, obtenerMetricas);

module.exports = router;
