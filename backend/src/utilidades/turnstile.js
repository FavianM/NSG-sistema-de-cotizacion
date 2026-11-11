'use strict';

/**
 * Verificación de Cloudflare Turnstile (captcha anti-bots).
 *
 * Si TURNSTILE_SECRET_KEY no está configurada, la verificación se OMITE
 * (modo desarrollo) para no bloquear login/registro hasta tener las keys.
 * Usa fetch nativo (Node 18+).
 */

const URL_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * @param {string} token - token del widget (cf-turnstile-response)
 * @param {string} [ip] - IP remota del cliente (opcional)
 * @returns {Promise<{ok: boolean, omitido?: boolean, error?: string}>}
 */
async function verificarTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, omitido: true }; // modo dev: sin secret no se exige captcha

  if (!token) return { ok: false, error: 'captcha_faltante' };

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);

    const resp = await fetch(URL_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: Boolean(data.success), error: data.success ? undefined : 'captcha_invalido' };
  } catch (err) {
    return { ok: false, error: err.message || 'captcha_error' };
  }
}

/**
 * Middleware Express: exige captcha válido. Lee el token de
 * req.body.captcha_token (o turnstile_token). Omite si no hay secret.
 */
async function middlewareTurnstile(req, res, next) {
  if (!process.env.TURNSTILE_SECRET_KEY) return next(); // dev bypass
  const token = req.body?.captcha_token || req.body?.turnstile_token;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const r = await verificarTurnstile(token, ip);
  if (!r.ok) {
    return res.status(403).json({ exito: false, error: 'Verificación anti-bots fallida. Recargá e intentá de nuevo.', codigo: 'CAPTCHA_INVALIDO' });
  }
  next();
}

module.exports = { verificarTurnstile, middlewareTurnstile };
