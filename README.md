# CA1 - Enterprise Architecture Microservices Project

This repository contains a small e-commerce checkout system built as a set of Node.js microservices and deployed with Kubernetes. It is designed to demonstrate enterprise architecture concepts such as service decomposition, containerization, ingress routing, service discovery, persistence, distributed request tracing, and event-style scaling with KEDA HTTP add-on scale-to-zero.

## Table of Contents

- [Project Summary](#project-summary)
- [Architecture](#architecture)
- [Request Flow](#request-flow)
- [Repository Structure](#repository-structure)
- [Services](#services)
- [API Reference](#api-reference)
- [Kubernetes Resources](#kubernetes-resources)
- [Configuration](#configuration)
- [Deployment Guide](#deployment-guide)
- [Verification Commands](#verification-commands)
- [Local Development](#local-development)
- [Data Persistence](#data-persistence)
- [Observability](#observability)
- [Security Notes](#security-notes)
- [Known Limitations](#known-limitations)

## Project Summary

The system models a checkout workflow. A user accesses the gateway through a Traefik ingress route using the host `ca1.local`. The gateway serves a simple browser UI and lightweight diagnostic endpoints. Checkout traffic is routed through the KEDA HTTP interceptor so the checkout service can scale down to zero pods and wake up when requests arrive.

The checkout service calls two internal services:

- `pricing-svc`, which returns discount and currency information.
- `inventory-svc`, which returns stock availability.

After a successful checkout calculation, the checkout service writes an audit record to PostgreSQL.

Key technologies:

- Node.js 20
- Express.js
- Axios
- PostgreSQL
- Docker
- Kubernetes
- Traefik Ingress
- KEDA HTTP add-on

## Architecture

```text
Client/User
   |
   | HTTP Host: ca1.local
   v
Traefik Ingress
   |
   |-- /, /api/ping, /api/arch --> gateway-svc --> Gateway pod
   |
   |-- /api/checkout -----------> http-interceptor-proxy
                                   |
                                   v
                              checkout-svc
                                   |
                                   v
                              Checkout pod
                              /    |     \
                             /     |      \
                            v      v       v
                    pricing-svc inventory-svc postgres-svc
                         |          |          |
                         v          v          v
                    Pricing pod Inventory pod PostgreSQL pod
```

Important routing detail: the gateway application does not proxy checkout requests in its Node.js code. Instead, Kubernetes ingress sends `/api/checkout` directly to the KEDA HTTP interceptor, which forwards traffic to the checkout service.

## Request Flow

A successful checkout request follows this path:

1. The client sends `POST /api/checkout` to `http://ca1.local`.
2. Traefik matches the `/api/checkout` path.
3. The request is sent to `http-interceptor-proxy`.
4. The KEDA HTTP interceptor activates or forwards to `checkout-svc`.
5. The checkout service reads `sku`, `subtotal`, and optional `quantity` from the request body.
6. Checkout calls `pricing-svc` to retrieve the discount percentage.
7. Checkout calls `inventory-svc` to retrieve stock availability.
8. Checkout checks whether enough stock exists.
9. Checkout calculates the total after discount.
10. Checkout inserts an audit row into PostgreSQL.
11. The response is returned to the client with the same `X-Request-Id`.

## Repository Structure

```text
.
├── README.md
├── project.zip
├── manifests/
│   ├── 00-namespace.yaml
│   ├── 10-pricing.yaml
│   ├── 11-inventory.yaml
│   ├── 12-checkout.yaml
│   ├── 13-postgres-secret.yaml
│   ├── 14-postgres-pvc.yaml
│   ├── 15-postgres.yaml
│   ├── 20-gateway.yaml
│   ├── 30-ingress.yaml
│   ├── 41-http-scaledobject-checkout.yaml
│   ├── 42-http-interceptor-externalname.yaml
│   └── checkout-ingress.yaml
└── services/
    ├── checkout/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── server.js
    ├── gateway/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── server.js
    ├── inventory/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── server.js
    └── pricing/
        ├── Dockerfile
        ├── package.json
        └── server.js
```

## Services

### Gateway

Location: `services/gateway/`

The gateway is the public-facing application component. It exposes diagnostic API endpoints and serves a small HTML interface that can call the ping and checkout routes from a browser.

Responsibilities:

- Serve the root web UI at `/`.
- Provide `/api/ping` for a simple health-style request.
- Provide `/api/arch` to describe the deployed architecture.
- Generate or propagate `X-Request-Id`.
- Log request method, path, status, and duration.
- Optionally validate JWT bearer tokens for protected routes when `REQUIRE_AUTH=true`.

Container port: `3000`

Dependencies:

- `express`
- `jose`

### Checkout

Location: `services/checkout/`

The checkout service contains the main workflow logic. It is the service configured for KEDA HTTP scaling.

Responsibilities:

- Accept checkout requests on `/api` and `/api/checkout`.
- Validate that required fields are present.
- Call pricing and inventory services using internal Kubernetes DNS names.
- Apply the pricing discount.
- Check stock before returning success.
- Insert successful checkout audit records into PostgreSQL.
- Return dependency timeout or unavailable errors when downstream calls fail.
- Generate or propagate `X-Request-Id`.

Container port: `8080`

Dependencies:

- `express`
- `axios`
- `pg`

### Pricing

Location: `services/pricing/`

The pricing service is a small stateless dependency used by checkout.

Current behavior:

- `GET /` returns a fixed discount of `10` percent.
- The response uses `EUR` as the currency.
- `GET /health` returns service health.

Container port: `8080`

Dependencies:

- `express`

### Inventory

Location: `services/inventory/`

The inventory service is a small stateless dependency used by checkout.

Current behavior:

- `GET /` returns fixed stock of `42` from warehouse `ca1-main`.
- `GET /health` returns service health.

Container port: `8080`

Dependencies:

- `express`

### PostgreSQL

PostgreSQL stores checkout audit data. It is deployed inside the Kubernetes cluster using the official `postgres:16-alpine` image and a persistent volume claim.

Database purpose:

- Store checkout request ID.
- Store SKU and quantity.
- Store subtotal and final total.
- Store checkout status.
- Store creation timestamp.

## API Reference

### Gateway Endpoints

#### `GET /`

Returns the browser UI.

The UI can:

- Call `/api/ping`.
- Trigger sample checkout requests.
- Display response JSON.
- Show recent request timings.

#### `GET /health`

Health endpoint for Kubernetes probes.

Example response:

```json
{
  "service": "gateway",
  "status": "ok",
  "request_id": "generated-request-id"
}
```

#### `GET /api/ping`

Simple diagnostic endpoint.

Example response:

```json
{
  "status": "ok",
  "time": "2026-05-20T00:00:00.000Z",
  "service": "gateway",
  "request_id": "generated-request-id"
}
```

#### `GET /api/arch`

Returns high-level architecture metadata.

Example response:

```json
{
  "arch": "nanoservices-kubernetes",
  "architecture": "client -> traefik -> gateway + keda-http-interceptor -> checkout -> pricing + inventory -> postgres",
  "ingress": "traefik",
  "scaling": "keda scale-to-zero on checkout",
  "request_id": "generated-request-id"
}
```

### Checkout Endpoints

#### `GET /health`

Health endpoint for Kubernetes probes.

Example response:

```json
{
  "service": "checkout",
  "status": "ok"
}
```

#### `GET /`

Basic service status endpoint.

Example response:

```json
{
  "service": "checkout",
  "status": "ok",
  "request_id": "generated-request-id"
}
```

#### `POST /api/checkout`

Performs a checkout calculation.

Request body:

```json
{
  "sku": "1",
  "subtotal": 100,
  "quantity": 1
}
```

Required fields:

- `sku`
- `subtotal`

Optional fields:

- `quantity`, default value is `1`

Successful response example:

```json
{
  "service": "checkout",
  "request_id": "generated-request-id",
  "received": {
    "sku": "1",
    "subtotal": 100,
    "quantity": 1
  },
  "pricing": {
    "service": "pricing",
    "discount_percent": 10,
    "currency": "EUR",
    "request_id": "generated-request-id"
  },
  "inventory": {
    "service": "inventory",
    "stock": 42,
    "warehouse": "ca1-main",
    "request_id": "generated-request-id"
  },
  "total": 90
}
```

Possible error responses:

- `400` when `sku` or `subtotal` is missing.
- `409` when requested quantity is greater than available stock.
- `503` when pricing or inventory is unavailable.
- `504` when pricing or inventory times out.

### Pricing Endpoints

#### `GET /health`

Returns pricing service health.

#### `GET /`

Example response:

```json
{
  "service": "pricing",
  "discount_percent": 10,
  "currency": "EUR",
  "request_id": "generated-request-id"
}
```

### Inventory Endpoints

#### `GET /health`

Returns inventory service health.

#### `GET /`

Example response:

```json
{
  "service": "inventory",
  "stock": 42,
  "warehouse": "ca1-main",
  "request_id": "generated-request-id"
}
```

## Kubernetes Resources

The Kubernetes manifests are stored in `manifests/`.

### Namespace

`00-namespace.yaml` creates the `ca1` namespace.

### Pricing

`10-pricing.yaml` creates:

- `Deployment/pricing`
- `Service/pricing-svc`

The service exposes port `80` and forwards to container port `8080`.

### Inventory

`11-inventory.yaml` creates:

- `Deployment/inventory`
- `Service/inventory-svc`

The service exposes port `80` and forwards to container port `8080`.

### Checkout

`12-checkout.yaml` creates:

- `Deployment/checkout`
- `Service/checkout-svc`

The checkout deployment uses environment variables to locate pricing, inventory, and PostgreSQL. The service exposes port `80` and forwards to container port `8080`.

### PostgreSQL Secret

`13-postgres-secret.yaml` creates `Secret/postgres-secret` with base64-encoded values:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

Decoded demo values:

- Database: `checkoutdb`
- User: `appuser`
- Password: `apppass`

### PostgreSQL PVC

`14-postgres-pvc.yaml` creates `PersistentVolumeClaim/postgres-pvc` requesting `1Gi` of storage.

### PostgreSQL Deployment

`15-postgres.yaml` creates:

- `Deployment/postgres`
- `Service/postgres-svc`

PostgreSQL listens on port `5432`.

### Gateway

`20-gateway.yaml` creates:

- `Deployment/gateway`
- `Service/gateway-svc`

The gateway service exposes port `80` and forwards to container port `3000`.

### Ingress

`30-ingress.yaml` creates `Ingress/ca1-gateway` for host `ca1.local`.

Routes:

- `/api/checkout` -> `http-interceptor-proxy:8080`
- `/api/ping` -> `gateway-svc:80`
- `/api/arch` -> `gateway-svc:80`
- `/` -> `gateway-svc:80`

### KEDA HTTP ScaledObject

`41-http-scaledobject-checkout.yaml` creates `HTTPScaledObject/checkout-http`.

Important settings:

- Host: `ca1.local`
- Path prefix: `/api/checkout`
- Target deployment: `checkout`
- Target service: `checkout-svc`
- Minimum replicas: `0`
- Maximum replicas: `5`
- Scaledown period: `30` seconds
- Concurrency target: `5`

### KEDA Interceptor ExternalName Service

`42-http-interceptor-externalname.yaml` creates a local service name for the KEDA HTTP interceptor:

```text
http-interceptor-proxy.ca1.svc.cluster.local
```

It points to:

```text
keda-add-ons-http-interceptor-proxy.keda.svc.cluster.local
```

### Checkout Ingress Placeholder

`checkout-ingress.yaml` contains a commented-out alternative ingress definition for checkout. The active ingress rule currently lives in `30-ingress.yaml`.

## Configuration

### Gateway Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` in code | Port used by the Express app. The current code defines this as a constant. |
| `REQUIRE_AUTH` | `false` | Enables JWT validation when set to `true`. |
| `ISSUER` | empty | Required issuer value for JWT validation. |
| `JWKS_URL` | empty | JWKS endpoint used by `jose` to validate tokens. |
| `BACKEND_TIMEOUT_MS` | set in manifest | Present in the manifest but not currently used by gateway code. |

### Checkout Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` in code | Port used by the Express app. The current code defines this as a constant. |
| `PRICING_URL` | `http://pricing-svc/` | Internal URL for the pricing service. |
| `INVENTORY_URL` | `http://inventory-svc/` | Internal URL for the inventory service. |
| `DEP_TIMEOUT` | `1500` | Timeout in milliseconds for pricing and inventory calls. |
| `PGHOST` | `postgres-svc` | PostgreSQL service host. |
| `PGPORT` | `5432` | PostgreSQL port. |
| `PGDATABASE` | `checkoutdb` | Database name. In Kubernetes this comes from a Secret. |
| `PGUSER` | `appuser` | Database user. In Kubernetes this comes from a Secret. |
| `PGPASSWORD` | `apppass` | Database password. In Kubernetes this comes from a Secret. |

## Deployment Guide

### Prerequisites

You need:

- A Kubernetes cluster, such as K3s, Minikube, Kind, or a managed cluster.
- `kubectl` configured for the target cluster.
- Traefik ingress controller installed and available as ingress class `traefik`.
- KEDA and the KEDA HTTP add-on installed if you want scale-to-zero behavior.
- Access to the container images referenced in the manifests.

The manifests currently reference these images:

- `aq496/gateway:1.3`
- `aq496/checkout:1.1`
- `aq496/pricing:1.1`
- `aq496/inventory:1.1`
- `postgres:16-alpine`

### Apply Manifests

From the repository root:

```bash
kubectl apply -f manifests/
```

Because the files are prefixed numerically, the namespace, services, secrets, PVC, deployments, ingress, and KEDA resources are applied in a predictable order.

### Configure Local Hostname

For local testing, map `ca1.local` to your cluster ingress address.

Example for a local cluster using `127.0.0.1`:

```bash
sudo sh -c 'echo "127.0.0.1 ca1.local" >> /etc/hosts'
```

Use your actual ingress IP if different.

### Access the Application

Open:

```text
http://ca1.local/
```

Useful URLs:

```text
http://ca1.local/api/ping
http://ca1.local/api/arch
http://ca1.local/api/checkout
```

`/api/checkout` expects a `POST` request for the checkout workflow.

## Verification Commands

Check all resources in the namespace:

```bash
kubectl get all -n ca1
```

Check ingress:

```bash
kubectl get ingress -n ca1
```

Check KEDA HTTP scaled object:

```bash
kubectl get httpscaledobject -n ca1
```

Check pods:

```bash
kubectl get pods -n ca1
```

Watch checkout scale from zero when requests arrive:

```bash
kubectl get pods -n ca1 -w
```

View gateway logs:

```bash
kubectl logs -n ca1 deploy/gateway
```

View checkout logs:

```bash
kubectl logs -n ca1 deploy/checkout
```

Send a ping request:

```bash
curl -i http://ca1.local/api/ping
```

Send a checkout request:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H 'X-Request-Id: demo-req-001' \
  -d '{"sku":"1","subtotal":100,"quantity":1}' \
  http://ca1.local/api/checkout
```

Test out-of-stock behavior:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -d '{"sku":"1","subtotal":100,"quantity":100}' \
  http://ca1.local/api/checkout
```

## Local Development

Each service is a separate Node.js application with its own `package.json` and `Dockerfile`.

Install dependencies for a service:

```bash
cd services/gateway
npm install
node server.js
```

Run another service similarly:

```bash
cd services/pricing
npm install
node server.js
```

For checkout local development, PostgreSQL must be available and the dependency service URLs must point to reachable pricing and inventory services.

Example environment variables for checkout:

```bash
export PRICING_URL=http://localhost:8081/
export INVENTORY_URL=http://localhost:8082/
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=checkoutdb
export PGUSER=appuser
export PGPASSWORD=apppass
node server.js
```

Note: the current service code uses fixed port constants, so running pricing, inventory, and checkout on the same machine at the same time requires either code changes, containers, or separate network namespaces because they all listen on `8080` except gateway.

## Container Build Commands

Example image build commands from the repository root:

```bash
docker build -t ca1-gateway:local services/gateway
docker build -t ca1-checkout:local services/checkout
docker build -t ca1-pricing:local services/pricing
docker build -t ca1-inventory:local services/inventory
```

If using a local Kubernetes cluster, load or push these images depending on the cluster type, then update the image names in the manifests.

## Data Persistence

The checkout service creates this table on startup if it does not exist:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  request_id TEXT,
  sku TEXT,
  quantity INTEGER,
  subtotal NUMERIC,
  total NUMERIC,
  status TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Successful checkout requests insert rows with status `SUCCESS`. Failed dependency calls and out-of-stock responses are not currently inserted into the audit table.

To inspect audit records from inside the cluster:

```bash
kubectl exec -it -n ca1 deploy/postgres -- \
  psql -U appuser -d checkoutdb -c 'SELECT * FROM audit_log ORDER BY id DESC LIMIT 10;'
```

## Observability

The project includes lightweight observability through request IDs and structured-ish logs.

### Request ID

Every service checks for an incoming `X-Request-Id` header. If it exists, the service reuses it. If it is missing, the service generates a new UUID.

The request ID is:

- Added to the response as `X-Request-Id`.
- Included in JSON responses where relevant.
- Logged by each service.
- Forwarded by checkout to pricing and inventory.

### Logs

Services log method, path, response status, duration, and request ID.

Example log format:

```text
req_id=demo-req-001 method=POST path=/api/checkout status=200 duration_ms=42
```

Checkout also logs successful dependency calls and final totals.

## Security Notes

This repository is suitable for a demo or coursework environment. For production, several changes would be needed:

- Do not commit real database passwords in Kubernetes Secret manifests.
- Use stronger secret management such as External Secrets, Sealed Secrets, Vault, or a cloud secret manager.
- Enable gateway authentication with `REQUIRE_AUTH=true`, `ISSUER`, and `JWKS_URL` if public routes need protection.
- Add network policies to restrict pod-to-pod communication.
- Add resource requests and limits for each container.
- Add TLS for ingress traffic.
- Validate checkout input more strictly.
- Avoid returning raw dependency error messages to external clients.

## Known Limitations

Current limitations in the implementation:

- Pricing and inventory return fixed demo values.
- Checkout only records successful audit events.
- There are no automated tests in the repository.
- The service ports are hard-coded in code instead of reading `PORT` from the environment.
- The gateway manifest defines `BACKEND_TIMEOUT_MS`, but the gateway code does not currently use it.
- `project.zip` is present as an untracked archive and is not required for the source application.
- The database is deployed as a single PostgreSQL pod using a Deployment; production systems usually use a managed database or a StatefulSet/operator.

## Suggested Future Improvements

Useful next improvements would be:

- Add unit and integration tests for checkout calculations and error handling.
- Add stricter validation for `sku`, `subtotal`, and `quantity`.
- Make service ports configurable through `process.env.PORT`.
- Add request and response schemas.
- Add resource requests and limits in Kubernetes manifests.
- Add readiness checks that verify real dependency health where appropriate.
- Add CI steps for linting, testing, image building, and manifest validation.
- Replace demo secrets with a safer secret-management workflow.
