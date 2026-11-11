# NSG Cotizador — Backend API

Backend del **Sistema de Cotización Automatizada para NSG Latinoamerica E.I.R.L.**
(Node.js + Express). Este repositorio contiene **únicamente el backend**, que es el
componente desplegado en Render.

---

## Qué vive en cada parte

| Componente | Dónde vive | Configuración |
|---|---|---|
| Backend API (este repo) | **Render** (web service) | `render.yaml` (Blueprint) |
| Frontend React | **Ninja Hosting** (build estático de Vite) | `frontend/.env.production` |
| Base de datos | **Neon** (PostgreSQL gestionado) | Variables `DB_*` del backend |

El frontend se compila y se publica por separado; este repo no lo incluye porque no
participa del despliegue en Render.

---

## Despliegue en Render

`render.yaml` es la fuente de verdad del servicio: runtime, comandos, plan, región y
health check. En el dashboard de Render: **New → Blueprint** → conectar el repo →
rama `main` → Blueprint Path `render.yaml` → **Apply**.

| Parámetro | Valor |
|---|---|
| Runtime | Node 24 (`NODE_VERSION` en el Blueprint) |
| Root Directory | `backend` |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Puertos | `PORT` lo define Render; no declararlo |

El servicio expone **todas las rutas bajo `/api/`** ([`backend/src/servidor.js`](backend/src/servidor.js)),
por lo que el subdominio público no lleva prefijo `/api`:

```
https://<host>.onrender.com/api/auth/...
https://<host>.onrender.com/api/cotizaciones/...
```

Health check:

```bash
curl -i https://<host>.onrender.com/health
# 200  {"estado":"ok","baseDatos":"conectada"}
```

### Dominio

`api.nsglatinoamerica.pe` es un **CNAME** en el DNS de Ninja Hosting que apunta al
hostname `onrender.com` del servicio. El frontend consume la API por ese dominio
público, por lo que **cambiar de instancia de Render no obliga a recompilar el
frontend**.

---

## Variables de entorno

[`backend/.env.example`](backend/.env.example) documenta todas las variables. En
producción son **obligatorias**: el servidor se niega a arrancar si falta alguna
([`backend/src/servidor.js`](backend/src/servidor.js)).

| Variable | Nota |
|---|---|
| `NODE_ENV=production` | Activa el driver `@neondatabase/serverless` (HTTPS/443) y las validaciones estrictas |
| `JWT_SECRET` | Mínimo 32 caracteres |
| `ENCRYPTION_KEY` | 64 caracteres hexadecimales. **Debe ser idéntica en todos los entornos**: las API keys guardadas en la base de datos están cifradas con ella |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Conexión a Neon |
| `TURNSTILE_SECRET_KEY` | Captcha de Cloudflare del login/registro |
| `FRONTEND_URL` | Origen permitido por CORS |

Las variables opcionales (`APIS_NET_TOKEN`, `DECOLECTA_API_TOKEN`, `NVIDIA_*`,
`GEMINI_*`, `SMTP_*`, `ICECAT_*`, `WHATSAPP_NUMERO_ASESOR`) habilitan la funcionalidad
correspondiente; sin ellas el sistema arranca igual y solo se desactiva esa feature.

---

## Desarrollo local

```bash
cd backend
cp .env.example .env      # completar con credenciales locales
npm install
npm run dev               # nodemon en http://localhost:3000
npm test                  # suite con Jest
```

En local el driver es `pg` sobre TCP al PostgreSQL local; en producción es
`@neondatabase/serverless` sobre HTTPS/443. La selección es automática según
`NODE_ENV` ([`backend/src/configuracion/baseDatos.js`](backend/src/configuracion/baseDatos.js)).

---

## Configuracion de proxy y health check

Dos puntos que afectan al comportamiento del backend en produccion, ya resueltos en
[`backend/src/servidor.js`](backend/src/servidor.js).

### 1. `trust proxy` — IP real del cliente

Render sirve el servicio detras de Cloudflare y de su propio load balancer, y encadena
la cabecera `X-Forwarded-For` asi:

```
<lo que escribio el cliente>, <cliente real>, <cloudflare>, <render>
```

Sin `app.set('trust proxy', ...)`, Express usa la IP del proxy y `express-rate-limit`
mete a **todos los usuarios en un mismo bucket** (10 req / 15 min en `/api/auth`), lo
que bloquea el login de usuarios legitimos y escribe un
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` en cada request.

El codigo ahora configura los saltos desde el entorno:

```js
const SALTOS_PROXY = Number(process.env.TRUST_PROXY_HOPS ?? 3);
if (SALTOS_PROXY > 0) {
  app.set('trust proxy', SALTOS_PROXY);
}
```

`3` es el valor medido contra un servicio real en Render. Con `2` se resuelve la IP de
Cloudflare (compartida) y con `true` el cliente elige su propia IP, con lo que el
rate limit se puede evadir. Si se antepone otro proxy, hay que sumar sus saltos.

### 2. `/health` sin dependencia de la base de datos

Render envia health checks cada pocos segundos y los corta a los **5 segundos**. La
implementacion anterior hacia `SELECT 1` en cada request: como Neon escala a cero a
los 5 minutos, el primer `SELECT` tras el reposo podia exceder el timeout, devolver
500 y provocar reinicios ciclicos de la instancia.

Ahora:

| Ruta | Consulta la BD | Uso |
|---|---|---|
| `/health` | No (estado cacheado, refrescado cada 30 s) | `healthCheckPath` de Render (liveness) |
| `/health/ready` | Si | Monitoreo externo; devuelve 503 si la base no responde |

La respuesta de `/health` conserva las mismas claves (`estado`, `baseDatos`) para no
romper el monitoreo existente.

> Nota: el health check no pasa por el rate limiter porque la ruta no esta bajo
> `/api/`. Si alguna vez se cambiara, hay que excluirla de forma explicita.

---

## Estructura

```
NSG-sistema-de-cotizacion/
├── backend/
│   ├── src/
│   │   ├── asistente/         # Asistente IA conversacional
│   │   ├── configuracion/     # Conexion a base de datos
│   │   ├── controladores/     # Logica de endpoints
│   │   ├── middleware/        # Multer, validaciones
│   │   ├── modelos/           # Modelos de datos
│   │   ├── rutas/             # Definicion de rutas (/api/*)
│   │   ├── servicios/         # Logica de negocio
│   │   └── servidor.js        # Arranque de Express
│   ├── assets/                # Logo para PDF y correos
│   ├── pruebas/               # Tests unitarios e integracion
│   ├── scripts/               # Utilidades (claves, pgpass, CSV)
│   └── package.json
├── render.yaml                # Blueprint de Render
└── .gitignore
```
