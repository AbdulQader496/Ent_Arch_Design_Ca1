const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = 8080;

app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
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
    service: 'inventory',
    status: 'ok',
    request_id: req.requestId
  });
});

app.get('*', (req, res) => {
  res.status(200).json({
    service: 'inventory',
    stock: 42,
    warehouse: 'ca1-main',
    request_id: req.requestId
  });
});

app.listen(PORT, () => {
  console.log(`inventory listening on ${PORT}`);
});