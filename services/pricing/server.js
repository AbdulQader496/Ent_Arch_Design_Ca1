const express = require('express');
const crypto = require('crypto');
const client = require('prom-client');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '8080', 10);
client.collectDefaultMetrics();

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
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
    service: 'pricing',
    status: 'ok',
    request_id: req.requestId
  });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/', (req, res) => {
  res.status(200).json({
    service: 'pricing',
    discount_percent: 10,
    currency: 'EUR',
    request_id: req.requestId
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'not found',
    request_id: req.requestId
  });
});

app.listen(PORT, () => {
  console.log(`pricing listening on ${PORT}`);
});
