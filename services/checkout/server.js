const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const crypto = require('crypto');
const client = require('prom-client');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '8080', 10);
const PRICING_URL = process.env.PRICING_URL || 'http://pricing-svc/';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-svc/';
const DEP_TIMEOUT = parseInt(process.env.DEP_TIMEOUT || '1500', 10);
const SKIP_DB = (process.env.SKIP_DB || 'false').toLowerCase() === 'true';
client.collectDefaultMetrics();

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const pool = new Pool({
  host: process.env.PGHOST || 'postgres-svc',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'checkoutdb',
  user: process.env.PGUSER || 'appuser',
  password: process.env.PGPASSWORD || 'apppass'
});

async function initDb() {
  if (SKIP_DB) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      request_id TEXT,
      sku TEXT,
      quantity INTEGER,
      subtotal NUMERIC,
      total NUMERIC,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function insertAudit(requestId, sku, quantity, subtotal, total, status) {
  if (SKIP_DB) return;

  await pool.query(
    `
    INSERT INTO audit_log (request_id, sku, quantity, subtotal, total, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [requestId, String(sku), quantity, subtotal, total, status]
  );
}

app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = Array.isArray(req.route?.path) ? req.route.path.join('|') : req.route?.path || req.path;
    httpRequestCounter.inc({
      method: req.method,
      route,
      status_code: String(res.statusCode)
    });
    console.log(
      `req_id=${requestId} method=${req.method} path=${req.originalUrl} status=${res.statusCode} duration_ms=${duration}`
    );
  });

  next();
});

app.get('/health', (_req, res) => {
  res.json({
    service: 'checkout',
    status: 'ok'
  });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/', (req, res) => {
  res.json({
    service: 'checkout',
    status: 'ok',
    request_id: req.requestId
  });
});

app.post(['/api', '/api/checkout'], async (req, res) => {
  const requestId = req.requestId;
  const data = req.body || {};

  const sku = data.sku;
  const subtotal = data.subtotal;
  const quantity = parseInt(data.quantity ?? 1, 10);

  if (sku == null || subtotal == null) {
    return res.status(400).json({
      error: 'sku and subtotal are required',
      request_id: requestId
    });
  }

  const headers = { 'X-Request-Id': requestId };

  let pricing;
  try {
    const pricingResp = await axios.get(PRICING_URL, {
      headers,
      timeout: DEP_TIMEOUT
    });
    pricing = pricingResp.data;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: 'pricing timeout',
        request_id: requestId
      });
    }
    return res.status(503).json({
      error: 'pricing unavailable',
      detail: err.message,
      request_id: requestId
    });
  }

  let inventory;
  try {
    const inventoryResp = await axios.get(INVENTORY_URL, {
      headers,
      timeout: DEP_TIMEOUT
    });
    inventory = inventoryResp.data;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: 'inventory timeout',
        request_id: requestId
      });
    }
    return res.status(503).json({
      error: 'inventory unavailable',
      detail: err.message,
      request_id: requestId
    });
  }

  const stock = parseInt(inventory.stock || 0, 10);
  if (stock < quantity) {
    return res.status(409).json({
      error: 'out of stock',
      available_stock: stock,
      requested_quantity: quantity,
      request_id: requestId
    });
  }

  const discountPercent = parseFloat(pricing.discount_percent || 0);
  const subtotalNum = parseFloat(subtotal);
  const total = Math.round(subtotalNum * (1 - discountPercent / 100) * 100) / 100;

  try {
    await insertAudit(requestId, sku, quantity, subtotalNum, total, 'SUCCESS');
  } catch (dbErr) {
    console.error(`req_id=${requestId} db_error=${dbErr.message}`);
  }

  console.log(
    `req_id=${requestId} method=POST path=/api/checkout pricing_ok=true inventory_ok=true total=${total}`
  );

  return res.status(200).json({
    service: 'checkout',
    request_id: requestId,
    received: data,
    pricing,
    inventory,
    total
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'not found',
    request_id: req.requestId
  });
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`checkout listening on ${PORT}`);
      console.log(`PRICING_URL=${PRICING_URL}`);
      console.log(`INVENTORY_URL=${INVENTORY_URL}`);
      console.log(`DEP_TIMEOUT=${DEP_TIMEOUT}`);
      console.log(`SKIP_DB=${SKIP_DB}`);
    });
  } catch (err) {
    console.error(`startup_error=${err.message}`);
    process.exit(1);
  }
}

start();
