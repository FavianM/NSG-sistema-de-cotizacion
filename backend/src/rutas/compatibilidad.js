/**
 * Rutas de Compatibilidad
 * 
 * Define los endpoints para validación de compatibilidad de componentes
 * 
 * Requisitos: 3.3
 */

const express = require('express');
const router = express.Router();
const servicioCompatibilidad = require('../servicios/servicioCompatibilidad');
const { ejecutarQuery } = require('../configuracion/baseDatos');
const { verificarTokenUsuario } = require('../middleware/auth');

/**
 * POST /api/compatibilidad/validar
 * Valida la compatibilidad entre componentes seleccionados (requiere login)
 *
 * Body: { componentes: Object }
 * Response: { compatible: boolean, errores: string[], advertencias: string[] }
 */
router.post('/validar', verificarTokenUsuario, async (req, res) => {
  try {
    const { componentes } = req.body;

    if (!componentes || typeof componentes !== 'object') {
      return res.status(400).json({
        error: 'Se requiere un objeto "componentes" en el body'
      });
    }

    const resultado = await servicioCompatibilidad.validarConfiguracionConBD(componentes, ejecutarQuery);

    res.json(resultado);
  } catch (error) {
    console.error('Error en /validar:', error);
    res.status(500).json({
      error: 'Error interno del servidor',
      mensaje: 'No se pudo validar la compatibilidad'
    });
  }
});

module.exports = router;
