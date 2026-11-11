/**
 * controladorClientes.js
 *
 * Controlador para gestión de clientes.
 * Proporciona endpoint de búsqueda para autocompletado de datos.
 */

const { pool } = require('../configuracion/baseDatos');
const { desencriptar, hashBusqueda } = require('../utilidades/encriptacion');

/**
 * GET /api/clientes/buscar?q={email|telefono}
 * Busca un cliente (usuario con rol 'usuario') por email o teléfono para autocompletado.
 *
 * @param {object} req - Request con query param 'q'
 * @param {object} res - Response
 */
async function buscarCliente(req, res) {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 3) {
      return res.status(400).json({
        error: 'Parámetro de búsqueda debe tener al menos 3 caracteres',
      });
    }

    const busqueda = q.trim();
    const busquedaHash = hashBusqueda(busqueda);

    // Buscar por email o teléfono en tabla cuentas (solo usuarios)
    const query = `
      SELECT nombre, apellidos, nombre_completo, correo_encrypted, telefono_encrypted
      FROM cuentas
      WHERE rol = 'usuario'
        AND estado = 'activa'
        AND (correo_hash = $1 OR telefono_hash = $2)
      LIMIT 1
    `;

    const resultado = await pool.query(query, [busquedaHash, busquedaHash]);

    if (resultado.rows.length === 0) {
      return res.json({
        encontrado: false,
        cliente: null,
      });
    }

    const cuenta = resultado.rows[0];

    // Desencriptar email y teléfono
    let email = null;
    let telefono = null;

    try {
      if (cuenta.correo_encrypted) {
        email = desencriptar(cuenta.correo_encrypted);
      }
    } catch (error) {
      console.error('Error al desencriptar email:', error);
    }

    try {
      if (cuenta.telefono_encrypted) {
        telefono = desencriptar(cuenta.telefono_encrypted);
      }
    } catch (error) {
      console.error('Error al desencriptar teléfono:', error);
    }

    return res.json({
      encontrado: true,
      cliente: {
        nombre: cuenta.nombre || null,
        apellidos: cuenta.apellidos || null,
        nombre_completo: cuenta.nombre_completo,
        email: email,
        telefono: telefono,
      },
    });
  } catch (error) {
    console.error('Error al buscar cliente:', error);
    return res.status(500).json({
      error: 'Error al buscar cliente',
    });
  }
}

/**
 * GET /api/clientes/emails
 * Obtiene lista de emails registrados de usuarios para combobox de autocompletado.
 *
 * @param {object} req - Request
 * @param {object} res - Response
 */
async function obtenerEmails(req, res) {
  try {
    const query = `
      SELECT correo_encrypted
      FROM cuentas
      WHERE rol = 'usuario'
        AND estado = 'activa'
        AND correo_encrypted IS NOT NULL
        AND correo_encrypted != ''
      ORDER BY nombre_completo ASC
      LIMIT 100
    `;

    const resultado = await pool.query(query);

    // Desencriptar emails
    const emails = [];
    for (const row of resultado.rows) {
      try {
        if (row.correo_encrypted) {
          const emailDesencriptado = desencriptar(row.correo_encrypted);
          emails.push(emailDesencriptado);
        }
      } catch (error) {
        console.error('Error al desencriptar email:', error);
        // Continuar con el siguiente
      }
    }

    return res.json({
      emails: emails,
    });
  } catch (error) {
    console.error('Error al obtener emails:', error);
    return res.status(500).json({
      error: 'Error al obtener emails',
    });
  }
}

module.exports = { buscarCliente, obtenerEmails };
