const express = require('express');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const client = require('prom-client');

const app = express();
app.use(express.json());

const PORT = 3000;
const ISSUER = process.env.ISSUER || '';
const JWKS_URL = process.env.JWKS_URL || '';
const REQUIRE_AUTH = (process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
const CHECKOUT_URL = process.env.CHECKOUT_URL || '';
const BACKEND_TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || '5000', 10);
client.collectDefaultMetrics();

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

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
    httpRequestCounter.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: String(res.statusCode)
    });
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

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
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

app.post('/api/checkout', maybeValidateToken, async (req, res) => {
  if (!CHECKOUT_URL) {
    return res.status(404).json({
      error: 'checkout route is handled by ingress; set CHECKOUT_URL for local gateway proxying',
      request_id: req.requestId
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const upstream = await fetch(new URL('/api/checkout', CHECKOUT_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': req.requestId
      },
      body: JSON.stringify(req.body || {}),
      signal: controller.signal
    });
    const text = await upstream.text();

    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(err.name === 'AbortError' ? 504 : 503).json({
      error: err.name === 'AbortError' ? 'checkout timeout' : 'checkout unavailable',
      detail: err.message,
      request_id: req.requestId
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CA1 Checkout Console</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
  <script defer src="https://unpkg.com/lucide@latest"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    :root {
      color-scheme: light;
      --page-bg: #f5f7fb;
      --surface: #ffffff;
      --ink: #162033;
      --muted: #657085;
      --line: #dce3ee;
      --blue: #2563eb;
      --teal: #0f766e;
      --amber: #b45309;
      --red: #b91c1c;
      --green: #15803d;
    }

    body {
      background: var(--page-bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    .app-shell {
      min-height: 100vh;
    }

    .topbar {
      background: #121826;
      color: #fff;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    .brand-mark {
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: #2dd4bf;
      color: #102026;
      font-weight: 800;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 12px 28px rgba(22, 32, 51, 0.07);
    }

    .metric-card {
      min-height: 118px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }

    .muted {
      color: var(--muted);
    }

    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: #94a3b8;
      display: inline-block;
    }

    .status-ok { background: var(--green); }
    .status-warn { background: var(--amber); }
    .status-bad { background: var(--red); }

    .icon-box {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: #edf5ff;
      color: var(--blue);
    }

    .flow {
      display: grid;
      grid-template-columns: repeat(6, minmax(112px, 1fr));
      gap: 10px;
      align-items: stretch;
    }

    .flow-node {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfdff;
      min-height: 92px;
    }

    .flow-node.active {
      border-color: rgba(37, 99, 235, 0.55);
      background: #eff6ff;
    }

    .json-box {
      min-height: 362px;
      max-height: 520px;
      overflow: auto;
      margin: 0;
      border-radius: 8px;
      background: #111827;
      color: #d1fae5;
      padding: 16px;
      font-size: 0.875rem;
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .btn {
      border-radius: 8px;
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      white-space: nowrap;
    }

    .btn-icon {
      width: 38px;
      padding: 0;
    }

    .form-control, .form-select {
      border-radius: 8px;
      min-height: 40px;
    }

    .table-fixed {
      table-layout: fixed;
    }

    .truncate-cell {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    [x-cloak] {
      display: none !important;
    }

    @media (max-width: 1199px) {
      .flow {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }

    @media (max-width: 767px) {
      .flow {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .json-box {
        min-height: 260px;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell" x-data="app()" x-init="init()" x-cloak>
    <header class="topbar">
      <div class="container-fluid px-3 px-lg-4 py-3">
        <div class="d-flex flex-wrap gap-3 align-items-center justify-content-between">
          <div class="d-flex align-items-center gap-3">
            <div class="brand-mark">CA1</div>
            <div>
              <h1 class="h4 mb-0">Checkout Operations Console</h1>
              <div class="small text-white-50" x-text="archLabel || 'nanoservices-kubernetes'"></div>
            </div>
          </div>
          <div class="d-flex flex-wrap align-items-center gap-2">
            <span class="badge text-bg-light" x-text="lastReq.requestId ? 'req ' + lastReq.requestId : 'no request yet'"></span>
            <button class="btn btn-outline-light btn-icon" type="button" title="Refresh" @click="refresh()">
              <i data-lucide="refresh-cw" width="18" height="18"></i>
            </button>
          </div>
        </div>
      </div>
    </header>

    <main class="container-fluid px-3 px-lg-4 py-4">
      <section class="row g-3 mb-4">
        <template x-for="service in services" :key="service.name">
          <div class="col-12 col-sm-6 col-xl">
            <div class="metric-card h-100">
              <div class="d-flex align-items-start justify-content-between gap-3">
                <div>
                  <div class="small text-uppercase fw-semibold muted" x-text="service.role"></div>
                  <div class="h5 mb-1" x-text="service.name"></div>
                </div>
                <span class="status-dot mt-2" :class="statusClass(service.status)"></span>
              </div>
              <div class="small muted mt-3" x-text="service.detail"></div>
              <div class="fw-semibold mt-2" x-text="service.status"></div>
            </div>
          </div>
        </template>
      </section>

      <section class="row g-4 align-items-start">
        <div class="col-12 col-xl-5">
          <div class="panel p-3 p-lg-4 mb-4">
            <div class="d-flex align-items-start justify-content-between gap-3 mb-3">
              <div>
                <h2 class="h5 mb-1">Checkout Request</h2>
                <div class="small muted">Submit a real request through the deployed ingress route.</div>
              </div>
              <div class="icon-box">
                <i data-lucide="shopping-cart" width="18" height="18"></i>
              </div>
            </div>

            <form class="row g-3" @submit.prevent="submitCheckout()">
              <div class="col-12 col-md-4">
                <label class="form-label small fw-semibold" for="sku">SKU</label>
                <input id="sku" class="form-control" type="text" x-model.trim="form.sku" />
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small fw-semibold" for="subtotal">Subtotal</label>
                <input id="subtotal" class="form-control" type="number" min="0" step="0.01" x-model.number="form.subtotal" />
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small fw-semibold" for="quantity">Quantity</label>
                <input id="quantity" class="form-control" type="number" min="1" step="1" x-model.number="form.quantity" />
              </div>
              <div class="col-12 d-flex flex-wrap gap-2">
                <button class="btn btn-primary" type="submit" :disabled="busy">
                  <i data-lucide="send" width="18" height="18"></i>
                  <span x-text="busy ? 'Sending' : 'Send Checkout'"></span>
                </button>
                <button class="btn btn-outline-secondary" type="button" @click="loadExample('success')">
                  <i data-lucide="check-circle-2" width="18" height="18"></i>
                  Success case
                </button>
                <button class="btn btn-outline-secondary" type="button" @click="loadExample('stock')">
                  <i data-lucide="alert-triangle" width="18" height="18"></i>
                  Stock error
                </button>
              </div>
            </form>
          </div>

          <div class="panel p-3 p-lg-4 mb-4">
            <div class="d-flex align-items-center justify-content-between gap-3 mb-3">
              <div>
                <h2 class="h5 mb-1">Quick Actions</h2>
                <div class="small muted">Gateway checks and local console state.</div>
              </div>
              <div class="icon-box">
                <i data-lucide="activity" width="18" height="18"></i>
              </div>
            </div>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-outline-primary" type="button" @click="ping()">
                <i data-lucide="radio" width="18" height="18"></i>
                Ping
              </button>
              <button class="btn btn-outline-primary" type="button" @click="loadArchitecture()">
                <i data-lucide="network" width="18" height="18"></i>
                Architecture
              </button>
              <button class="btn btn-outline-secondary" type="button" @click="clearTimings()">
                <i data-lucide="eraser" width="18" height="18"></i>
                Clear
              </button>
            </div>
          </div>

          <div class="panel p-3 p-lg-4">
            <div class="d-flex align-items-start justify-content-between gap-3 mb-3">
              <div>
                <h2 class="h5 mb-1">Request Path</h2>
                <div class="small muted">The active route highlights after checkout traffic.</div>
              </div>
              <div class="icon-box">
                <i data-lucide="route" width="18" height="18"></i>
              </div>
            </div>
            <div class="flow">
              <template x-for="node in flow" :key="node.name">
                <div class="flow-node" :class="node.active ? 'active' : ''">
                  <div class="small text-uppercase fw-semibold muted" x-text="node.type"></div>
                  <div class="fw-semibold" x-text="node.name"></div>
                  <div class="small muted mt-2" x-text="node.detail"></div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <div class="col-12 col-xl-7">
          <div class="panel p-3 p-lg-4 mb-4">
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
              <div>
                <h2 class="h5 mb-1">Response</h2>
                <div class="small muted" x-text="lastReq.label || 'Waiting for a request'"></div>
              </div>
              <span class="badge" :class="resultOk ? 'text-bg-success' : 'text-bg-secondary'" x-text="lastReq.status || 'idle'"></span>
            </div>
            <pre class="json-box" x-text="result || 'Run a checkout or ping request to see the response payload.'"></pre>
          </div>

          <div class="panel p-3 p-lg-4">
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
              <div>
                <h2 class="h5 mb-1">Recent Requests</h2>
                <div class="small muted">Latest browser requests from this console session.</div>
              </div>
              <div class="fw-semibold" x-text="lastReq.ms != null ? lastReq.ms.toFixed(1) + ' ms' : '-' "></div>
            </div>
            <div class="table-responsive">
              <table class="table table-sm align-middle table-fixed mb-0">
                <thead>
                  <tr>
                    <th style="width: 90px;">Method</th>
                    <th>Path</th>
                    <th style="width: 90px;">Status</th>
                    <th style="width: 110px;" class="text-end">Time</th>
                  </tr>
                </thead>
                <tbody>
                  <template x-if="timings.length === 0">
                    <tr>
                      <td colspan="4" class="text-center muted py-4">No requests recorded.</td>
                    </tr>
                  </template>
                  <template x-for="r in timings" :key="r.id">
                    <tr>
                      <td class="fw-semibold" x-text="r.method"></td>
                      <td class="truncate-cell" x-text="r.path" :title="r.path"></td>
                      <td>
                        <span class="badge" :class="r.ok ? 'text-bg-success' : 'text-bg-danger'" x-text="r.status"></span>
                      </td>
                      <td class="text-end" x-text="r.ms.toFixed(1) + ' ms'"></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <script>
    function app() {
      return {
        archLabel: '',
        busy: false,
        checkoutIdleTimer: null,
        timings: [],
        lastReq: {},
        result: '',
        resultOk: false,
        form: {
          sku: '1',
          subtotal: 100,
          quantity: 1
        },
        services: [
          { name: 'Gateway', role: 'edge', status: 'waiting', detail: 'Handles UI, ping, and architecture endpoints.' },
          { name: 'Checkout', role: 'workflow', status: 'waiting', detail: 'Activated by KEDA for checkout requests.' },
          { name: 'Pricing', role: 'dependency', status: 'waiting', detail: 'Returns discount and currency data.' },
          { name: 'Inventory', role: 'dependency', status: 'waiting', detail: 'Returns stock availability.' },
          { name: 'Postgres', role: 'storage', status: 'waiting', detail: 'Stores successful checkout audit records.' }
        ],
        flow: [
          { name: 'Client', type: 'browser', detail: 'This console', active: false },
          { name: 'Traefik', type: 'ingress', detail: 'ca1.local', active: false },
          { name: 'KEDA HTTP', type: 'scaler', detail: '/api/checkout', active: false },
          { name: 'Checkout', type: 'service', detail: 'workflow', active: false },
          { name: 'Pricing + Inventory', type: 'services', detail: 'dependencies', active: false },
          { name: 'Postgres', type: 'database', detail: 'audit log', active: false }
        ],

        statusClass(status) {
          if (status === 'online' || status === 'observed') return 'status-ok';
          if (status === 'error') return 'status-bad';
          return 'status-warn';
        },

        setService(name, status, detail) {
          const service = this.services.find((item) => item.name === name);
          if (!service) return;
          service.status = status;
          if (detail) service.detail = detail;
        },

        scheduleCheckoutIdle() {
          if (this.checkoutIdleTimer) clearTimeout(this.checkoutIdleTimer);
          this.checkoutIdleTimer = setTimeout(() => {
            this.setService('Checkout', 'idle', 'Scaled to zero after the KEDA cool-down window.');
            this.resetFlow();
          }, 35000);
        },

        activateFlow() {
          this.flow = this.flow.map((node) => ({ ...node, active: true }));
        },

        resetFlow() {
          this.flow = this.flow.map((node) => ({ ...node, active: false }));
        },

        clearTimings() {
          if (this.checkoutIdleTimer) clearTimeout(this.checkoutIdleTimer);
          this.checkoutIdleTimer = null;
          this.timings = [];
          this.lastReq = {};
          this.result = '';
          this.resultOk = false;
          this.resetFlow();
        },

        loadExample(type) {
          if (type === 'stock') {
            this.form = { sku: '1', subtotal: 100, quantity: 100 };
            return;
          }
          this.form = { sku: '1', subtotal: 100, quantity: 1 };
        },

        record(method, path, res, ms, ok) {
          const id = Date.now() + '-' + Math.random().toString(16).slice(2);
          const requestId = res ? res.headers.get('x-request-id') : '';
          const status = res ? String(res.status) : 'ERR';
          const entry = { id, method, path, ok, status, ms, requestId };

          this.lastReq = {
            label: method + ' ' + path,
            status,
            ms,
            requestId
          };
          this.timings.unshift(entry);
          this.timings = this.timings.slice(0, 12);
        },

        async timedJson(method, path, options = {}) {
          const start = performance.now();
          let res = null;

          try {
            res = await fetch(path, { method, ...options });
            const data = await res.json().catch(() => ({}));
            const ms = performance.now() - start;

            this.record(method, path, res, ms, res.ok);

            if (!res.ok) {
              const err = new Error(data.error || 'HTTP ' + res.status);
              err.payload = data;
              throw err;
            }

            return data;
          } catch (err) {
            const ms = performance.now() - start;
            if (!res) this.record(method, path, res, ms, false);
            throw err;
          }
        },

        showPayload(data, ok) {
          this.resultOk = ok;
          this.result = JSON.stringify(data, null, 2);
          this.$nextTick(() => {
            if (window.lucide) window.lucide.createIcons();
          });
        },

        async init() {
          this.$nextTick(() => {
            if (window.lucide) window.lucide.createIcons();
          });
          await this.loadArchitecture(false);
        },

        async refresh() {
          await this.loadArchitecture(true);
        },

        async loadArchitecture(showResult = true) {
          try {
            const info = await this.timedJson('GET', '/api/arch');
            this.archLabel = info.arch || 'nanoservices-kubernetes';
            this.setService('Gateway', 'online', 'Serving architecture and browser console traffic.');
            if (showResult) this.showPayload(info, true);
          } catch (err) {
            this.archLabel = 'unknown';
            this.setService('Gateway', 'error', err.message);
            if (showResult) this.showPayload(err.payload || { error: err.message }, false);
          }
        },

        async ping() {
          this.resetFlow();
          try {
            const data = await this.timedJson('GET', '/api/ping');
            this.setService('Gateway', 'online', 'Ping responded at ' + (data.time || 'unknown time') + '.');
            this.showPayload(data, true);
          } catch (err) {
            this.setService('Gateway', 'error', err.message);
            this.showPayload(err.payload || { error: err.message }, false);
          }
        },

        async submitCheckout() {
          this.busy = true;
          this.activateFlow();
          try {
            const payload = {
              sku: this.form.sku,
              subtotal: Number(this.form.subtotal),
              quantity: Number(this.form.quantity)
            };
            const data = await this.timedJson('POST', '/api/checkout', {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            this.setService('Checkout', 'online', 'Returned total ' + data.total + '.');
            this.setService('Pricing', 'observed', 'Discount ' + (data.pricing?.discount_percent ?? 0) + ' percent.');
            this.setService('Inventory', 'observed', 'Stock ' + (data.inventory?.stock ?? 'unknown') + '.');
            this.setService('Postgres', 'observed', 'Checkout completed and audit insert was attempted.');
            this.scheduleCheckoutIdle();
            this.showPayload(data, true);
          } catch (err) {
            this.setService('Checkout', 'error', err.message);
            this.showPayload(err.payload || { error: err.message }, false);
          } finally {
            this.busy = false;
          }
        }
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
  console.log(`CHECKOUT_URL=${CHECKOUT_URL || '(ingress-managed)'}`);
});
