const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const path = require('path');

/**
 * Servicio de correo transaccional (SMTP vía nodemailer).
 * Actualmente cubre el envío del correo de recuperación de contraseña.
 */

/**
 * Construye la configuración del transporte SMTP a partir de variables de entorno.
 * Permite fijar la IP del host (SMTP_HOST_IP) manteniendo el nombre real en el
 * `servername` TLS, útil cuando la resolución DNS del proveedor es inestable.
 * Fuerza IPv4 (family: 4) y define timeouts de conexión/saludo/socket.
 */
function obtenerConfiguracionSMTP() {
  const host = process.env.SMTP_HOST_IP || process.env.SMTP_HOST;
  const servername = process.env.SMTP_HOST || host;
  return {
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    family: 4,
    tls: {
      servername
    }
  };
}

/**
 * Verifica que estén presentes las variables de entorno necesarias para enviar correo.
 * Acepta indistintamente SMTP_HOST o SMTP_HOST_IP como host.
 * @returns {{valida: boolean, faltantes: string[]}}
 */
function validarConfiguracionCorreo() {
  const requeridas = ['SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
  if (!process.env.SMTP_HOST && !process.env.SMTP_HOST_IP) {
    requeridas.push('SMTP_HOST o SMTP_HOST_IP');
  }
  const faltantes = requeridas.filter((clave) => !process.env[clave]);
  return { valida: faltantes.length === 0, faltantes };
}

/**
 * Envía el correo de recuperación de contraseña con el enlace de restablecimiento
 * (válido por 5 minutos) y el logo embebido como adjunto inline (cid:nsg-logo).
 *
 * Estrategia de resiliencia ante fallos de DNS: primero intenta con la configuración
 * base; si falla por error de resolución/timeout (EDNS/ETIMEOUT) y no se fijó una IP
 * manual, resuelve las IPv4 del host y reintenta contra las dos primeras.
 *
 * @param {string} destinatario - Dirección de correo del usuario.
 * @param {string} enlace - URL de restablecimiento de contraseña.
 * @throws {Error} Si la configuración es incompleta o no se pudo enviar por ninguna vía.
 */
async function enviarCorreoRecuperacion(destinatario, enlace) {
  const validacion = validarConfiguracionCorreo();
  if (!validacion.valida) {
    throw new Error(`Configuración de correo incompleta: ${validacion.faltantes.join(', ')}`);
  }

  const mensaje = {
    from: process.env.EMAIL_FROM,
    to: destinatario,
    subject: 'Recuperación de contraseña - NSG Cotizador',
    text: `Recibimos una solicitud para restablecer tu contraseña.\n\nEl enlace es válido por 5 minutos.\n\nRestablecer contraseña: ${enlace}\n\nSi no solicitaste este cambio, ignora este correo.`,
    html: `
      <div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:24px 24px 10px 24px;text-align:center;">
              <img src="cid:nsg-logo" alt="NSG Cotizador" width="64" height="64" style="display:block;margin:0 auto 12px auto;" />
              <h1 style="margin:0;font-size:20px;line-height:1.3;color:#0f172a;">Restablece tu contraseña</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 0 24px;">
              <p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:#334155;">
                Recibimos una solicitud para restablecer tu contraseña en NSG Cotizador.
              </p>
              <p style="margin:0 0 18px 0;font-size:14px;line-height:1.6;color:#334155;">
                Este enlace es válido por <strong>5 minutos</strong>.
              </p>
              <div style="text-align:center;margin:0 0 18px 0;">
                <a href="${enlace}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:10px;">
                  Restablecer contraseña
                </a>
              </div>
              <p style="margin:0 0 10px 0;font-size:12px;line-height:1.6;color:#64748b;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin:0 0 18px 0;font-size:12px;line-height:1.6;word-break:break-all;color:#2563eb;">
                <a href="${enlace}" style="color:#2563eb;text-decoration:none;">${enlace}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px 24px;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
                Si no solicitaste este cambio, ignora este correo.
              </p>
            </td>
          </tr>
        </table>
      </div>
    `,
    attachments: [
      {
        filename: 'nsg-logo.png',
        path: path.resolve(__dirname, '../../../frontend/dist/favicon.png'),
        cid: 'nsg-logo'
      }
    ]
  };

  const configBase = obtenerConfiguracionSMTP();

  try {
    const transporter = nodemailer.createTransport(configBase);
    await transporter.sendMail(mensaje);
    return;
  } catch (error) {
    const esErrorDNS = error && (error.code === 'EDNS' || error.code === 'ETIMEOUT');
    if (!esErrorDNS) throw error;
  }

  if (process.env.SMTP_HOST_IP) {
    throw new Error('No se pudo conectar al SMTP usando SMTP_HOST_IP');
  }

  const ips = await dns.resolve4(configBase.host);
  if (!ips || ips.length === 0) {
    throw new Error(`No se pudo resolver IPv4 para ${configBase.host}`);
  }

  let ultimoError = null;
  for (const ip of ips.slice(0, 2)) {
    try {
      const transporterFallback = nodemailer.createTransport({
        ...configBase,
        host: ip,
        tls: {
          servername: process.env.SMTP_HOST
        }
      });
      await transporterFallback.sendMail(mensaje);
      return;
    } catch (error) {
      ultimoError = error;
    }
  }

  throw ultimoError || new Error('No se pudo enviar el correo de recuperación');
}

module.exports = {
  enviarCorreoRecuperacion
};
