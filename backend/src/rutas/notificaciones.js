/**
 * Rutas de Notificaciones de Usuario
 *
 * Todas las rutas requieren autenticación de usuario (admin o usuario registrado).
 *
 * GET   /api/notificaciones/pendientes  → obtenerPendientes
 * GET   /api/notificaciones/todas       → obtenerTodas
 * PATCH /api/notificaciones/leer-todas  → marcarTodasLeidas
 * PATCH /api/notificaciones/:id/leer    → marcarLeida
 *
 * Requisitos: 5.2, 5.5, 6.1, 6.11
 */

const express = require('express');
const router = express.Router();
const { verificarTokenUsuario } = require('../middleware/auth');
const { obtenerPendientes, marcarLeida, obtenerTodas, marcarTodasLeidas } = require('../controladores/controladorNotificaciones');

// Obtener notificaciones no leídas del usuario autenticado
router.get('/pendientes', verificarTokenUsuario, obtenerPendientes);

// Obtener todas las notificaciones (leídas y no leídas) con paginación opcional
router.get('/todas', verificarTokenUsuario, obtenerTodas);

// Marcar todas las notificaciones no leídas como leídas
// IMPORTANTE: esta ruta debe ir ANTES de /:id/leer para evitar que "leer-todas"
// sea interpretado como un :id
router.patch('/leer-todas', verificarTokenUsuario, marcarTodasLeidas);

// Marcar una notificación como leída
router.patch('/:id/leer', verificarTokenUsuario, marcarLeida);

module.exports = router;
