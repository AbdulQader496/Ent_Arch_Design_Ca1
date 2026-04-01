const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CHECKOUT_URL = process.env.CHECKOUT_URL || 'http://checkout-svc/api';
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

function postJsonWithTimeout(url, payload, timeoutMs, requestId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const target = new URL(url);

    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Request-Id': requestId
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 200,
          contentType: res.headers['content-type'] || 'application/json',
          body: data
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`backend timeout after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>CA1 Gateway</h1>
    <p>System entry point is running.</p>
    <ul>
      <li><a href="/api/arch">/api/arch</a></li>
      <li><a href="/api/ping">/api/ping</a></li>
    </ul>
  `);
});

app.get('/api/arch', maybeValidateToken, (_req, res) => {
  res.json({
    architecture: 'gateway -> checkout -> pricing + inventory -> postgres',
    ingress: 'traefik',
    scaling: 'keda scale-to-zero on checkout'
  });
});

app.get('/api/ping', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    service: 'gateway'
  });
});

app.post('/api/checkout', (_req, res) => {
  res.status(500).json({
    error: 'checkout should be routed by ingress to the HTTP interceptor, not handled by gateway'
  });
});

app.listen(PORT, () => {
  console.log(`CA1 gateway listening on ${PORT}`);
  console.log(`REQUIRE_AUTH=${REQUIRE_AUTH}`);
  console.log(`BACKEND_TIMEOUT_MS=${BACKEND_TIMEOUT_MS}`);
});