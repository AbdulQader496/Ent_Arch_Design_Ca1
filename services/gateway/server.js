const express = require('express');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const app = express();
app.use(express.json());

const PORT = 3000;
const ISSUER = process.env.ISSUER || '';
const JWKS_URL = process.env.JWKS_URL || '';
const REQUIRE_AUTH = (process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';

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
    return res.status(500).json({
      error: 'gateway auth misconfigured',
      request_id: req.requestId
    });
  }

  try {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({
        error: 'missing bearer token',
        request_id: req.requestId
      });
    }

    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
    req.token = payload;
    next();
  } catch (err) {
    return res.status(401).json({
      error: 'invalid token',
      detail: err.message,
      request_id: req.requestId
    });
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

app.get('/health', (req, res) => {
  res.json({
    service: 'gateway',
    status: 'ok',
    request_id: req.requestId
  });
});

app.get('/api/arch', maybeValidateToken, (req, res) => {
  res.json({
    arch: 'nanoservices-kubernetes',
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

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nanoservices (Kubernetes)</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</head>
<body class="bg-light">
  <div class="container py-5" x-data="app()" x-init="init()">
    <h1 class="mb-3">Nanoservices (Kubernetes)</h1>

    <div class="card mb-4">
      <div class="card-body">

        <div class="d-flex justify-content-between align-items-start">
          <div>
            <h5 class="card-title mb-1">Architecture</h5>
            <div class="small text-muted">What this UI is talking to right now</div>
            <div class="mt-2">
              <span class="badge text-bg-secondary" x-text="archLabel || 'unknown'"></span>
            </div>
          </div>

          <div class="text-end">
            <h5 class="card-title mb-1">Last request</h5>
            <div class="small text-muted" x-text="lastReq.label || '—'"></div>
            <div class="fw-semibold" x-text="lastReq.ms != null ? \`\${lastReq.ms.toFixed(1)} ms\` : '—'"></div>
          </div>
        </div>

        <hr />

        <div class="d-flex flex-wrap gap-2">
          <button class="btn btn-primary" @click="ping()">Ping</button>

          <button class="btn btn-outline-primary" @click="checkout(1, 100)">
            Checkout sku=1 subtotal=100
          </button>

          <button class="btn btn-outline-primary" @click="checkout(3, 100)">
            Checkout sku=3 subtotal=100
          </button>

          <button class="btn btn-outline-secondary" @click="clearTimings()">Clear</button>
        </div>

        <div class="table-responsive mt-3">
          <table class="table table-sm mb-0">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
                <th class="text-end">Time (ms)</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="r in timings" :key="r.id">
                <tr>
                  <td x-text="r.method"></td>
                  <td x-text="r.path"></td>
                  <td>
                    <span :class="r.ok ? 'badge text-bg-success' : 'badge text-bg-danger'" x-text="r.status"></span>
                  </td>
                  <td class="text-end" x-text="r.ms.toFixed(1)"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

      </div>
    </div>

    <div class="alert alert-info" x-show="result" style="white-space: pre-wrap;" x-text="result"></div>
  </div>

  <script>
    function app() {
      return {
        archLabel: "",
        timings: [],
        lastReq: {},
        result: "",

        clearTimings() {
          this.timings = [];
          this.lastReq = {};
          this.result = "";
        },

        record(method, path, res, ms, ok) {
          const id = \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
          const entry = {
            id,
            method,
            path,
            ok,
            status: res ? res.status : "ERR",
            ms
          };

          this.lastReq = { label: \`\${method} \${path}\`, ms };
          this.timings.unshift(entry);
          this.timings = this.timings.slice(0, 10);
        },

        async timedJson(method, path, options = {}) {
          const start = performance.now();
          let res = null;

          try {
            res = await fetch(path, { method, ...options });
            const data = await res.json().catch(() => ({}));
            const ms = performance.now() - start;

            this.record(method, path, res, ms, res.ok);

            if (!res.ok) throw new Error(data.error || \`HTTP \${res.status}\`);

            return data;
          } catch (err) {
            const ms = performance.now() - start;
            this.record(method, path, res, ms, false);
            throw err;
          }
        },

        async init() {
          try {
            const info = await this.timedJson("GET", "/api/arch");
            this.archLabel = info.arch || "nanoservices-kubernetes";
          } catch (e) {
            this.archLabel = "unknown";
          }
        },

        async ping() {
          try {
            const data = await this.timedJson("GET", "/api/ping");
            this.result = JSON.stringify(data, null, 2);
          } catch (e) {
            this.result = e.message;
          }
        },

        async checkout(sku, subtotal) {
          try {
            const data = await this.timedJson("POST", "/api/checkout", {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sku, subtotal, quantity: 1 }),
            });

            this.result = JSON.stringify(data, null, 2);
          } catch (e) {
            this.result = e.message;
          }
        },
      };
    }
  </script>
</body>
</html>`);
});

app.use((req, res) => {
  res.status(404).json({
    error: 'not found',
    request_id: req.requestId
  });
});

app.listen(PORT, () => {
  console.log(`gateway listening on ${PORT}`);
  console.log(`REQUIRE_AUTH=${REQUIRE_AUTH}`);
});