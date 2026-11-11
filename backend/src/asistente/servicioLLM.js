/**
 * Servicio LLM del Asistente IA
 * Proveedor primario: Google Gemini (@google/generative-ai)
 * Fallback: NVIDIA via OpenAI-compatible endpoint
 * Incluye reintentos con backoff exponencial y parser robusto de JSON.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

const MAX_REINTENTOS = 3;
const BACKOFF_BASE = 1000;
const NVIDIA_FETCH_TIMEOUT_MS = parseInt(process.env.NVIDIA_FETCH_TIMEOUT_MS || '25000', 10);
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '25000', 10);

class ErrorLLM extends Error {
  constructor(mensaje, tipo) {
    super(mensaje);
    this.name = 'ErrorLLM';
    this.tipo = tipo;
  }
}

function clasificarError(error) {
  const status = error?.status || error?.statusCode || 0;
  const mensaje = String(error?.message || '').toLowerCase();
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 504) return 'server_error';
  if (error?.name === 'AbortError' || mensaje.includes('aborted') || mensaje.includes('timeout')) return 'timeout';
  return 'unknown';
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extraerJSON(texto) {
  if (!texto || typeof texto !== 'string') return null;

  try {
    return JSON.parse(texto);
  } catch (_) {}

  const limpio = texto
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(limpio);
  } catch (_) {}

  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio !== -1 && fin > inicio) {
    try {
      return JSON.parse(limpio.substring(inicio, fin + 1));
    } catch (_) {}
  }

  return null;
}

async function llamarConReintentos(fn, nombreProveedor) {
  for (let intento = 0; intento < MAX_REINTENTOS; intento++) {
    try {
      return await fn();
    } catch (error) {
      const tipo = clasificarError(error);
      const esReintentable = tipo === 'rate_limit' || tipo === 'server_error' || tipo === 'timeout';

      if (!esReintentable || intento === MAX_REINTENTOS - 1) {
        console.error(`[${nombreProveedor}] Error final (intento ${intento + 1}):`, error.message);
        throw error;
      }

      const espera = BACKOFF_BASE * Math.pow(2, intento);
      console.warn(`[${nombreProveedor}] Reintento ${intento + 1}/${MAX_REINTENTOS} en ${espera}ms — ${error.message}`);
      await esperar(espera);
    }
  }
}

async function llamarGemini(systemPrompt, historial, mensajeActual, configIA) {
  const geminiKey = configIA?.gemini_api_key || GEMINI_API_KEY;

  if (!geminiKey) {
    throw new ErrorLLM('GEMINI_API_KEY no configurada', 'no_provider');
  }

  const modeloGemini = configIA?.gemini_model || GEMINI_MODEL;

  const genAI = new GoogleGenerativeAI(geminiKey);
  const modelo = genAI.getGenerativeModel({
    model: modeloGemini,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 900,
      topP: 0.9,
      responseMimeType: 'application/json',
    },
  });

  return await llamarConReintentos(async () => {
    const contenido = construirContenidoGemini(historial, mensajeActual);

    const resultado = await Promise.race([
      modelo.generateContent({
        contents: contenido,
        systemInstruction: systemPrompt,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Gemini excedió timeout de ${GEMINI_TIMEOUT_MS}ms`)), GEMINI_TIMEOUT_MS)
      ),
    ]);

    const texto = resultado.response?.text?.() || '';
    const json = extraerJSON(texto);
    if (!json) {
      throw new ErrorLLM('Respuesta de Gemini no es JSON válido', 'invalid_json');
    }
    return json;
  }, 'Gemini');
}

function construirContenidoGemini(historial, mensajeActual) {
  const partes = [];

  for (const msg of historial) {
    const rol = msg.rol === 'assistant' ? 'model' : 'user';
    partes.push({ role: rol, parts: [{ text: msg.contenido }] });
  }

  partes.push({ role: 'user', parts: [{ text: mensajeActual }] });

  return partes;
}

async function llamarNVIDIA(systemPrompt, historial, mensajeActual, configIA) {
  const nvidiaKey = configIA?.nvidia_api_key || NVIDIA_API_KEY;

  if (!nvidiaKey) {
    throw new ErrorLLM('NVIDIA_API_KEY no configurada', 'no_provider');
  }

  const modeloNVIDIA = configIA?.nvidia_model || NVIDIA_MODEL;

  return await llamarConReintentos(async () => {
    const mensajes = construirMensajesNVIDIA(systemPrompt, historial, mensajeActual);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NVIDIA_FETCH_TIMEOUT_MS);

    let respuesta;
    try {
      respuesta = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nvidiaKey}`,
        },
        body: JSON.stringify({
          model: modeloNVIDIA,
          messages: mensajes,
          temperature: 0.1,
          max_tokens: 900,
          top_p: 0.1,
          response_format: {
            type: 'json_object',
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new ErrorLLM(`NVIDIA excedió timeout de ${NVIDIA_FETCH_TIMEOUT_MS}ms`, 'timeout');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!respuesta.ok) {
      const errorBody = await respuesta.text().catch(() => '');
      const err = new Error(`NVIDIA ${respuesta.status}: ${errorBody}`);
      err.status = respuesta.status;
      throw err;
    }

    const data = await respuesta.json();
    const texto = data?.choices?.[0]?.message?.content || '';
    const json = extraerJSON(texto);
    if (!json) {
      throw new ErrorLLM('Respuesta de NVIDIA no es JSON válido', 'invalid_json');
    }
    return json;
  }, 'NVIDIA');
}

function construirMensajesNVIDIA(systemPrompt, historial, mensajeActual) {
  const mensajes = [{ role: 'system', content: systemPrompt }];

  for (const msg of historial) {
    mensajes.push({ role: msg.rol, content: msg.contenido });
  }

  mensajes.push({ role: 'user', content: mensajeActual });
  return mensajes;
}

async function generarRespuesta({ systemPrompt, historial, mensajeActual, configIA }) {
  try {
    return await llamarGemini(systemPrompt, historial, mensajeActual, configIA);
  } catch (errorGemini) {
    console.warn('[LLM] Gemini falló, intentando NVIDIA fallback:', errorGemini.message);

    if (errorGemini.tipo === 'no_provider') {
      const nvidiaKey = configIA?.nvidia_api_key || NVIDIA_API_KEY;
      if (!nvidiaKey) {
        throw new ErrorLLM('No hay proveedor LLM configurado (GEMINI_API_KEY y NVIDIA_API_KEY ausentes)', 'no_provider');
      }
    }
  }

  try {
    return await llamarNVIDIA(systemPrompt, historial, mensajeActual, configIA);
  } catch (errorNVIDIA) {
    console.error('[LLM] NVIDIA también falló:', errorNVIDIA.message);
    throw new ErrorLLM(
      'El servicio de IA no está disponible temporalmente. Intenta en un momento.',
      errorNVIDIA.tipo || 'server_error'
    );
  }
}

async function generarRespuestaConPrioridad({ systemPrompt, historial, mensajeActual, configIA, prioridadProveedores }) {
  const prioridad = Array.isArray(prioridadProveedores) && prioridadProveedores.length > 0
    ? prioridadProveedores
    : ['gemini', 'nvidia'];

  const errores = [];

  for (const proveedor of prioridad) {
    try {
      if (proveedor === 'nvidia') {
        return await llamarNVIDIA(systemPrompt, historial, mensajeActual, configIA);
      }

      if (proveedor === 'gemini') {
        return await llamarGemini(systemPrompt, historial, mensajeActual, configIA);
      }
    } catch (error) {
      errores.push({ proveedor, error });
      console.warn(`[LLM] ${proveedor} falló, intentando siguiente proveedor:`, error.message);
    }
  }

  const ultimoError = errores[errores.length - 1]?.error;
  if (!ultimoError) {
    throw new ErrorLLM('No hay proveedores de IA configurados para la prioridad solicitada', 'no_provider');
  }

  if (errores.every(({ error }) => error?.tipo === 'no_provider')) {
    throw new ErrorLLM('No hay proveedor LLM configurado para el enriquecimiento', 'no_provider');
  }

  throw new ErrorLLM(
    'El servicio de IA no está disponible temporalmente. Intenta en un momento.',
    ultimoError.tipo || clasificarError(ultimoError) || 'server_error'
  );
}

// ── Generación en TEXTO PLANO (sin JSON) ──
// El conversador devuelve solo el mensaje; los quick_replies/perfil se derivan
// determinísticamente en el controlador. Elimina los errores "no es JSON válido".

async function llamarGeminiTexto(systemPrompt, historial, mensajeActual, configIA) {
  const geminiKey = configIA?.gemini_api_key || GEMINI_API_KEY;
  if (!geminiKey) throw new ErrorLLM('GEMINI_API_KEY no configurada', 'no_provider');

  const modeloGemini = configIA?.gemini_model || GEMINI_MODEL;
  const genAI = new GoogleGenerativeAI(geminiKey);
  const modelo = genAI.getGenerativeModel({
    model: modeloGemini,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1200, topP: 0.9 },
  });

  return await llamarConReintentos(async () => {
    const contenido = construirContenidoGemini(historial, mensajeActual);
    const resultado = await Promise.race([
      modelo.generateContent({ contents: contenido, systemInstruction: systemPrompt }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Gemini excedió timeout de ${GEMINI_TIMEOUT_MS}ms`)), GEMINI_TIMEOUT_MS)
      ),
    ]);
    const texto = (resultado.response?.text?.() || '').trim();
    if (!texto) throw new ErrorLLM('Respuesta de Gemini vacía', 'server_error');
    return texto;
  }, 'Gemini');
}

async function llamarNVIDIATexto(systemPrompt, historial, mensajeActual, configIA) {
  const nvidiaKey = configIA?.nvidia_api_key || NVIDIA_API_KEY;
  if (!nvidiaKey) throw new ErrorLLM('NVIDIA_API_KEY no configurada', 'no_provider');

  const modeloNVIDIA = configIA?.nvidia_model || NVIDIA_MODEL;

  return await llamarConReintentos(async () => {
    const mensajes = construirMensajesNVIDIA(systemPrompt, historial, mensajeActual);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NVIDIA_FETCH_TIMEOUT_MS);

    let respuesta;
    try {
      respuesta = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nvidiaKey}` },
        body: JSON.stringify({ model: modeloNVIDIA, messages: mensajes, temperature: 0.5, max_tokens: 1200, top_p: 0.9 }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new ErrorLLM(`NVIDIA excedió timeout de ${NVIDIA_FETCH_TIMEOUT_MS}ms`, 'timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!respuesta.ok) {
      const errorBody = await respuesta.text().catch(() => '');
      const err = new Error(`NVIDIA ${respuesta.status}: ${errorBody}`);
      err.status = respuesta.status;
      throw err;
    }

    const data = await respuesta.json();
    const texto = (data?.choices?.[0]?.message?.content || '').trim();
    if (!texto) throw new ErrorLLM('Respuesta de NVIDIA vacía', 'server_error');
    return texto;
  }, 'NVIDIA');
}

async function generarTextoConPrioridad({ systemPrompt, historial, mensajeActual, configIA, prioridadProveedores }) {
  const prioridad = Array.isArray(prioridadProveedores) && prioridadProveedores.length > 0
    ? prioridadProveedores
    : ['gemini', 'nvidia'];

  const errores = [];
  for (const proveedor of prioridad) {
    try {
      if (proveedor === 'nvidia') {
        return { texto: await llamarNVIDIATexto(systemPrompt, historial, mensajeActual, configIA) };
      }
      if (proveedor === 'gemini') {
        return { texto: await llamarGeminiTexto(systemPrompt, historial, mensajeActual, configIA) };
      }
    } catch (error) {
      errores.push({ proveedor, error });
      console.warn(`[LLM] ${proveedor} (texto) falló, intentando siguiente proveedor:`, error.message);
    }
  }

  const ultimoError = errores[errores.length - 1]?.error;
  if (!ultimoError) throw new ErrorLLM('No hay proveedores de IA configurados', 'no_provider');
  if (errores.every(({ error }) => error?.tipo === 'no_provider')) {
    throw new ErrorLLM('No hay proveedor LLM configurado', 'no_provider');
  }
  throw new ErrorLLM(
    'El servicio de IA no está disponible temporalmente. Intenta en un momento.',
    ultimoError.tipo || clasificarError(ultimoError) || 'server_error'
  );
}

module.exports = {
  generarRespuesta,
  generarRespuestaConPrioridad,
  generarTextoConPrioridad,
  llamarGemini,
  llamarNVIDIA,
  llamarGeminiTexto,
  llamarNVIDIATexto,
  extraerJSON,
  ErrorLLM,
};
