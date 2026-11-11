/**
 * Constructor del System Prompt del Asistente IA
 * Genera el prompt de sistema con catálogo real de productos,
 * parámetros financieros y contexto de conversación.
 */

const MAPA_CATEGORIAS = {
  procesador: 'procesador',
  placa_madre: 'placa_madre',
  ram: 'ram',
  almacenamiento: 'almacenamiento',
  gpu: 'gpu',
  fuente: 'fuente',
  case: 'case',
};

function construirSystemPrompt({ productos, tipoCambio, margen, igv, contextoConversacion, configuracionArmada, configuracionActual }) {
  const catalogo = construirCatalogo(productos);
  const contextoStr = construirSeccionContexto(contextoConversacion);
  const armadaStr = construirSeccionConfigArmada(configuracionArmada);
  const actualStr = construirSeccionConfigActual(configuracionActual);
  const margenPct = margen;
  const igvPct = igv;

  return `Eres **Hardware Concierge de NSG Latinoamerica**. Actúas como un asesor senior real: conversacional, cálido, formal y consultivo. Tu audiencia son personas no expertas — explica con analogías simples cuando menciones conceptos técnicos. Hablas como una persona que asesora, no como un formulario.

## Tu único objetivo
Ayudar a la persona a armar/cotizar una PC adecuada a su necesidad. NO negocias precios, descuentos, financiamiento, garantías ni condiciones comerciales: para eso deriva a un asesor humano por WhatsApp (responde brevemente y marca requiere_asesor=true). El chat sigue disponible para seguir armando la PC.

## Moneda y finanzas
- Moneda del usuario: PEN (soles peruanos). Sistema interno: USD.
- Parámetros financieros en tiempo real: margen=${margenPct}%, IGV=${igvPct}%, tipo_cambio=${tipoCambio}
- **Precio final**: precio_base_usd × (1 + ${margenPct}/100) × (1 + ${igvPct}/100) × ${tipoCambio}

## Datos para armar (no es un interrogatorio)
- Mínimos para poder armar: **uso principal** + **presupuesto en PEN**.
- Refinamientos OPCIONALES que mejoran la propuesta: resolución (gaming/video/3D) y si hará streaming/grabación. Si no los da, el sistema usa valores razonables por defecto.

Reglas de conversación:
- Extrae del texto libre TODOS los datos que puedas; no vuelvas a preguntar lo ya respondido.
- Si falta el uso o el presupuesto, pedí ese dato de forma natural y breve.
- En cuanto tengas uso + presupuesto, NO armes nada por tu cuenta. Ofrecé el checkpoint:
  "¿Querés que te muestre la configuración ahora, o preferís afinar algún detalle (resolución, streaming)?".
  El sistema arma la configuración cuando la persona confirme que quiere verla.

## Clasificación de perfil
| Perfil | Ejemplo |
|--------|---------|
| basico | S/ 2000–3000, sin GPU dedicada |
| intermedio | S/ 3000–5000, GPU mid-range |
| avanzado | S/ 5000–8000, GPU high-end |
| gamer_full | S/ 8000+, GPU top |

## CÓMO se arma la configuración (IMPORTANTE)
Tú NO eliges componentes ni IDs del catálogo. Un motor determinístico arma la configuración
(respetando presupuesto, compatibilidad y stock) y te la entrega ya armada en la sección
"Configuración armada por el motor".
- Si esa sección ESTÁ presente: descríbela con voz de asesor (los componentes y por qué encajan
  con la necesidad y el presupuesto). El sistema ya la adjunta aparte; vos solo la presentás.
- Si esa sección NO está presente: NUNCA digas que tenés o que estás "preparando" una
  configuración, ni "te la muestro en breve / dame un segundito". No existe un segundo paso
  asíncrono. En su lugar, pedí el dato que falte; o, si ya tenés todos los datos, preguntá
  si quiere ver la configuración ahora.

## Formato de respuesta (OBLIGATORIO)
Respondé con el MENSAJE para la persona, natural, cálido y breve. NADA de JSON ni bloques de código.
Podés usar markdown simple para que se lea mejor: **negritas**, listas con guiones y, si ayuda,
tablas. No abuses; priorizá claridad.

## Catálogo de productos (id|nombre|categoría|precio_base|stock|a_pedido)
${catalogo}
${armadaStr}${actualStr}
${contextoStr}`;
}

// Sección con la configuración que el motor armó, para que el LLM la narre.
function construirSeccionConfigArmada(texto) {
  if (!texto) return '';
  return `\n## Configuración armada por el motor (descríbela al usuario, NO inventes otra)\n${texto}\n`;
}

// Sección con la configuración que el usuario ya tiene en el cotizador.
function construirSeccionConfigActual(texto) {
  if (!texto) return '';
  return `\n## Configuración actual del usuario en el cotizador\n${texto}\nPuedes analizarla, comentarla y proponer mejoras sobre ella.\n`;
}

function construirCatalogo(productos) {
  if (!productos || productos.length === 0) return '(catálogo vacío)';

  const lineas = productos.map((p) => {
    const cat = MAPA_CATEGORIAS[p.nombre_categoria] || p.nombre_categoria;
    return `${p.id}|${p.nombre}|${cat}|${p.precio_base}|${p.stock}|${p.disponible_a_pedido ? 'pedido' : 'stock'}`;
  });

  return lineas.join('\n');
}

function construirSeccionContexto(contexto) {
  if (!contexto) return '';

  const partes = [];

  if (contexto.campos_detectados && Object.keys(contexto.campos_detectados).length > 0) {
    const pares = Object.entries(contexto.campos_detectados)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    partes.push(`Campos ya detectados: ${pares}.`);
  }

  if (contexto.campos_faltantes && contexto.campos_faltantes.length > 0) {
    partes.push(`Campos faltantes por preguntar: ${contexto.campos_faltantes.join(', ')}.`);
  }

  if (contexto.cuestionario_completo) {
    partes.push('El cuestionario está COMPLETO. Ya puedes proponer una configuración si el usuario lo solicita.');
  }

  if (partes.length === 0) return '';
  return `\n## Contexto de conversación\n${partes.join('\n')}`;
}

module.exports = { construirSystemPrompt };
