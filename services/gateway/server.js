const express = require('express');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const app = express();
app.use(express.json());

const PORT = 3000;
const ISSUER = process.env.ISSUER || '';
const JWKS_URL = process.env.JWKS_URL || '';
const REQUIRE_AUTH = (process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
const BACKEND_TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || '2000', 10);

let jwks = null;
if (JWKS_URL) {
  jwks = createRemoteJWKSet(new URL(JWKS_URL));
}

function makeRequestId() {
  return crypto.randomUUID();
}

function extractBearer(req) {
  const header = req.header('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function maybeValidateToken(req, res, next) {
  if (!REQUIRE_AUTH) return next();

  if (!ISSUER || !jwks) {
    return res.status(500).json({ error: 'gateway auth misconfigured' });
  }

  try {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
    req.token = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token', detail: err.message });
  }
}

app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || makeRequestId();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `req_id=${requestId} method=${req.method} path=${req.originalUrl} status=${res.statusCode} duration_ms=${duration}`
    );
  });

  next();
});

app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>CA1 Gateway</h1>
    <p>System entry point is running.</p>
    <ul>
      <li><a href="/api/arch">/api/arch</a></li>
      <li><a href="/api/ping">/api/ping</a></li>
      <li><a href="/api/checkout">/api/checkout</a> (POST)</li>
    </ul>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    service: 'gateway',
    status: 'ok',
    request_id: req.requestId
  });
});

app.get('/api/arch', maybeValidateToken, (req, res) => {
  res.json({
    architecture: 'client -> traefik -> gateway + keda-http-interceptor -> checkout -> pricing + inventory -> postgres',
    ingress: 'traefik',
    scaling: 'keda scale-to-zero on checkout',
    request_id: req.requestId
  });
});

app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    service: 'gateway',
    request_id: req.requestId
  });
});

app.listen(PORT, () => {
  console.log(`gateway listening on ${PORT}`);
  console.log(`REQUIRE_AUTH=${REQUIRE_AUTH}`);
  console.log(`BACKEND_TIMEOUT_MS=${BACKEND_TIMEOUT_MS}`);
});