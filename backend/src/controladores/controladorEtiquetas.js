'use strict';

/**
 * Controlador de Etiquetas de perfil (Básico/Medio/Avanzado/Gamer Full).
 * Las etiquetas son catálogo fijo gestionado por el administrador de productos;
 * acá solo se listan para poblar selectores y filtros (front y back).
 */

const { ejecutarQuery } = require('../configuracion/baseDatos');

/**
 * GET /api/etiquetas
 * Lista todas las etiquetas de perfil ordenadas por su campo `orden` y luego por nombre.
 */
async function listarEtiquetas(req, res) {
  try {
    const { rows } = await ejecutarQuery(
      'SELECT id, nombre, orden FROM etiquetas ORDER BY orden, nombre'
    );
    return res.json({ exito: true, etiquetas: rows });
  } catch (error) {
    console.error('Error al listar etiquetas:', error);
    return res.status(500).json({ error: 'Error al listar etiquetas', mensaje: 'No se pudieron recuperar las etiquetas' });
  }
}

module.exports = { listarEtiquetas };
