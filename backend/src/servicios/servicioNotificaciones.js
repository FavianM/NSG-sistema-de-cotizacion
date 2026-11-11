/**
 * Servicio de notificaciones por email.
 *
 * Envía correos transaccionales de estado de cotización usando nodemailer
 * con la misma lógica de fallback DNS que servicioCorreo.js.
 *
 * Requisitos: 9.1–9.6, 9.9
 */

const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const path = require('path');
const { desencriptar } = require('../utilidades/encriptacion');

// ── Utilidades ────────────────────────────────────────────────────────────────

function obtenerConfiguracionSMTP() {
  const host = process.env.SMTP_HOST_IP || process.env.SMTP_HOST;
  const servername = process.env.SMTP_HOST || host;
  return {
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    family: 4,
    tls: { servername },
  };
}

function formatearFechaLegible(fecha) {
  if (!fecha) return '-';
  return new Date(fecha).toLocaleDateString('es-PE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Resuelve la ruta del logo para adjuntar en el correo.
 * Usa las mismas rutas candidatas que servicioPDF.js.
 * @returns {string|null}
 */
function resolverRutaLogoCorreo() {
  const fs = require('fs');
  const candidatos = [
    path.resolve(__dirname, '../../../resources/logo vector-1.png'),
    path.resolve(__dirname, '../../assets/logo-nsg.png'),
    path.resolve(__dirname, '../../../frontend/dist/favicon.png'),
  ];
  return candidatos.find((ruta) => fs.existsSync(ruta)) || null;
}

/**
 * Construye la plantilla HTML del correo "equipo listo para recoger".
 * Reutiliza la estructura visual de servicioCorreo.js.
 */
function construirPlantillaEquipoListo({ nombre, codigoTicket, estado, fechaEmision, fechaValidez }) {
  const nombreMostrar = nombre || 'Cliente';
  const estadoMostrar = estado === 'Caducada' ? 'Vencida' : (estado || 'Pendiente');
  // Una cotización confirmada ya no caduca: se omite la fecha de validez.
  const estaConfirmada = String(estado).toLowerCase() === 'confirmada';

  return `
    <div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:24px 24px 10px 24px;text-align:center;">
            <img src="cid:nsg-logo" alt="NSG Cotizador" width="64" height="64" style="display:block;margin:0 auto 12px auto;" />
            <h1 style="margin:0;font-size:20px;line-height:1.3;color:#0f172a;">¡Tu equipo está listo!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 24px 0 24px;">
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:#334155;">
              Hola <strong>${nombreMostrar}</strong>,
            </p>
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:#334155;">
              Tu equipo ya está listo para recoger en nuestra tienda. Puedes acercarte cuando gustes.
            </p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 18px 0;">
              <tr>
                <td style="padding:14px 16px;">
                  <p style="margin:0 0 8px 0;font-size:13px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Detalle del ticket</p>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                      <td style="padding:4px 0;font-size:13px;color:#64748b;width:45%;">Código de ticket</td>
                      <td style="padding:4px 0;font-size:13px;color:#0f172a;font-weight:600;">${codigoTicket}</td>
                    </tr>
                    <tr>
                      <td style="padding:4px 0;font-size:13px;color:#64748b;">Estado</td>
                      <td style="padding:4px 0;font-size:13px;color:#0f172a;font-weight:600;">${estadoMostrar}</td>
                    </tr>
                    <tr>
                      <td style="padding:4px 0;font-size:13px;color:#64748b;">Fecha de emisión</td>
                      <td style="padding:4px 0;font-size:13px;color:#0f172a;">${formatearFechaLegible(fechaEmision)}</td>
                    </tr>
                    ${estaConfirmada ? '' : `
                    <tr>
                      <td style="padding:4px 0;font-size:13px;color:#64748b;">Válida hasta</td>
                      <td style="padding:4px 0;font-size:13px;color:#b91c1c;font-weight:600;">${formatearFechaLegible(fechaValidez)}</td>
                    </tr>
                    `}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.6;color:#334155;">
              Recuerda traer tu código de ticket al momento de recoger tu equipo.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 24px 24px;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
              Gracias por confiar en <strong>NSG Latinoamérica</strong>.
            </p>
          </td>
        </tr>
      </table>
    </div>
  `;
}

/**
 * Envía correo al cliente notificando que su equipo está listo para recoger.
 * Usa nodemailer con fallback DNS (misma lógica que servicioCorreo.js).
 *
 * @param {Object} cotizacion - Objeto con datos de la cotización y cliente
 * @param {string} cotizacion.codigo_ticket
 * @param {string} cotizacion.cliente_nombre
 * @param {string|null} cotizacion.cliente_correo_encrypted - Correo encriptado con AES
 * @param {string|null} cotizacion.cliente_email - Correo ya desencriptado (alternativa)
 * @param {string} cotizacion.estado
 * @param {string|Date} cotizacion.fecha_emision
 * @param {string|Date} cotizacion.fecha_validez
 * @throws {{ status: 422, codigo: string, mensaje: string }} Si no hay correo disponible
 * @throws {Error} Si falla el envío SMTP
 */
async function notificarEquipoListo(cotizacion) {
  const {
    codigo_ticket,
    cliente_nombre,
    cliente_correo_encrypted,
    cliente_email,
    estado,
    fecha_emision,
    fecha_validez,
  } = cotizacion;

  // 1. Resolver correo del cliente
  let correoCliente = cliente_email || null;

  if (!correoCliente && cliente_correo_encrypted) {
    try {
      correoCliente = desencriptar(cliente_correo_encrypted);
    } catch (errorDesencriptar) {
      console.error('[ServicioNotificaciones] Error al desencriptar correo:', errorDesencriptar.message);
    }
  }

  if (!correoCliente) {
    throw {
      status: 422,
      codigo: 'CORREO_NO_DISPONIBLE',
      mensaje: 'El cliente no tiene correo registrado para notificar',
    };
  }

  // 2. Construir mensaje
  const html = construirPlantillaEquipoListo({
    nombre: cliente_nombre,
    codigoTicket: codigo_ticket,
    estado,
    fechaEmision: fecha_emision,
    fechaValidez: fecha_validez,
  });

  const rutaLogo = resolverRutaLogoCorreo();

  const mensaje = {
    from: process.env.EMAIL_FROM || `"NSG Cotizador" <no-reply@nsg.local>`,
    to: correoCliente,
    subject: `NSG - Tu equipo está listo para recoger (${codigo_ticket})`,
    html,
    attachments: rutaLogo
      ? [{ filename: 'nsg-logo.png', path: rutaLogo, cid: 'nsg-logo' }]
      : [],
  };

  // 3. Enviar con fallback DNS (misma lógica que servicioCorreo.js)
  const configBase = obtenerConfiguracionSMTP();

  try {
    const transporter = nodemailer.createTransport(configBase);
    await transporter.sendMail(mensaje);
    return;
  } catch (error) {
    const esErrorDNS = error && (error.code === 'EDNS' || error.code === 'ETIMEOUT');
    if (!esErrorDNS) {
      console.error('[ServicioNotificaciones] Error SMTP:', error.message);
      throw error;
    }
  }

  // Fallback: resolver IPv4 y reintentar
  if (process.env.SMTP_HOST_IP) {
    const err = new Error('No se pudo conectar al SMTP usando SMTP_HOST_IP');
    console.error('[ServicioNotificaciones] Error SMTP:', err.message);
    throw err;
  }

  let ips;
  try {
    ips = await dns.resolve4(configBase.host);
  } catch (dnsError) {
    console.error('[ServicioNotificaciones] Error DNS:', dnsError.message);
    throw dnsError;
  }

  if (!ips || ips.length === 0) {
    const err = new Error(`No se pudo resolver IPv4 para ${configBase.host}`);
    console.error('[ServicioNotificaciones] Error DNS:', err.message);
    throw err;
  }

  let ultimoError = null;
  for (const ip of ips.slice(0, 2)) {
    try {
      const transporterFallback = nodemailer.createTransport({
        ...configBase,
        host: ip,
        tls: { servername: process.env.SMTP_HOST },
      });
      await transporterFallback.sendMail(mensaje);
      return;
    } catch (error) {
      ultimoError = error;
    }
  }

  console.error('[ServicioNotificaciones] Error SMTP (fallback):', ultimoError?.message);
  throw ultimoError || new Error('No se pudo enviar el correo de notificación');
}

// ── Compatibilidad con código existente ───────────────────────────────────────

/**
 * @deprecated Usar notificarEquipoListo en su lugar.
 * Mantenido para compatibilidad con controladorCotizaciones.js existente.
 */
async function enviarNotificacionListo({ para, codigoTicket, estado, fechaEmision, fechaValidez }) {
  await notificarEquipoListo({
    codigo_ticket: codigoTicket,
    cliente_nombre: null,
    cliente_email: para,
    estado,
    fecha_emision: fechaEmision,
    fecha_validez: fechaValidez,
  });

  return {
    enviado: true,
    modo: 'smtp',
    para,
    asunto: `NSG - Tu equipo está listo para recoger (${codigoTicket})`,
  };
}

module.exports = {
  notificarEquipoListo,
  enviarNotificacionListo,
};
