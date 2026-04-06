# CA1 - Enterprise Architecture Microservices Project

A distributed microservices architecture demonstrating enterprise application design patterns, built with containerization and Kubernetes orchestration.

## 📋 Project Overview

This repository implements a small e-commerce checkout system using Node.js microservices deployed on Kubernetes.

Key features:
- **Node.js/Express microservices** for gateway, checkout, pricing, and inventory
- **Kubernetes orchestration** with Deployments, Services, Ingress, Secrets, and PVC
- **KEDA HTTP scale-to-zero** for the checkout service
- **Traefik ingress routing** with a proxy path for `/api/checkout`
- **PostgreSQL persistence** for checkout audit logs
- **Distributed tracing** via `X-Request-Id`

## 🏗️ Architecture

```
                           ┌──────────────────────┐
                           │      Client/User     │
                           └──────────┬───────────┘
                                      │
                                      │ HTTP (Host: ca1.local)
                                      ▼
                           ┌──────────────────────┐
                           │   Traefik Ingress    │
                           │    (K3s Cluster)     │
                           └───────┬───────┬──────┘
                                   │       │
                    ┌──────────────┘       └──────────────┐
                    │                                     │
                    ▼                                     ▼
        ┌──────────────────────┐           ┌──────────────────────────────┐
        │     gateway-svc      │           │  KEDA HTTP Interceptor       │
        │   (ClusterIP svc)    │           │ (http-interceptor-proxy)     │
        └──────────┬───────────┘           └──────────────┬───────────────┘
                   │                                      │
                   ▼                                      ▼
        ┌──────────────────────┐              ┌──────────────────────────┐
        │     Gateway Pod      │              │      checkout-svc        │
        │                      │              │   (scale-to-zero svc)    │
        │ Routes:              │              └──────────────┬───────────┘
        │  /                   │                             │
        │  /api/ping           │                             ▼
        │  /api/arch           │                 ┌──────────────────────────┐
        └──────────────────────┘                 │       Checkout Pod       │
                                                 │   (KEDA scaled)         │
                                                 └──────────────┬──────────┘
                                                                │
                            ┌───────────────────────────────────┼───────────────────────────────────┐
                            │                                   │                                   │
                            ▼                                   ▼                                   ▼
                ┌──────────────────────┐           ┌──────────────────────┐           ┌──────────────────────────────┐
                │     pricing-svc      │           │   inventory-svc      │           │    postgres-svc              │
                │  (always running)    │           │  (always running)    │           │   (stateful DB)              │
                └──────────┬───────────┘           └──────────┬───────────┘           └──────────┬──────────────────┘
                           ▼                                  ▼                                  ▼
                ┌──────────────────────┐           ┌──────────────────────┐           ┌──────────────────────┐
                │     Pricing Pod      │           │    Inventory Pod     │           │     Postgres Pod     │
                └──────────────────────┘           └──────────────────────┘           └──────────┬───────────┘
                                                                                               ▼
                                                                                  ┌──────────────────────┐
                                                                                  │   Persistent Volume  │
                                                                                  │        (PVC)         │
                                                                                  └──────────────────────┘
```

## 📐 Sequence Diagram

```
Client          Traefik        KEDA Interceptor      Checkout        Pricing        Inventory        Postgres
  |                |                 |                  |               |               |                |
  | POST /api/checkout               |                  |               |               |                |
  | X-Request-Id=req-123             |                  |               |               |                |
  |--------------->|                 |                  |               |               |                |
  |                | route request   |                  |               |               |                |
  |                |--------------->|                   |               |               |                |
  |                |                 | forward request  |               |               |                |
  |                |                 |----------------->|               |               |                |
  |                |                 |                  | GET /           |               |                |
  |                |                 |                  |---------------|                |                |
  |                |                 |                  |               |               |                |
  |                |                 |                  | GET /           |               |                |
  |                |                 |                  |------------------------------>|                |
  |                |                 |                  |               |               |                |
  |                |                 |                  | <--- pricing response --------|                |
  |                |                 |                  | <--- inventory response ------|                |
  |                |                 |                  |                               |                |
  |                |                 |                  | INSERT audit_log (req-123)    |                |
  |                |                 |                  |------------------------------>|                |
  |                |                 |                  |                               |                |
  |                |                 |                  | response (req-123)            |                |
  |                |                 |<-----------------|               |               |                |
  |                |<---------------|                   |               |               |                |
  |<---------------| response (req-123)                 |               |               |                |
```

## 📦 Services

### Gateway (Node.js/Express)
- **Location**: `services/gateway/`
- **Entrypoint**: `services/gateway/server.js`
- **Container port**: 3000
- **Responsibilities**:
  - Routes external HTTP traffic to internal services
  - Validates JWT tokens when enabled via `REQUIRE_AUTH`
  - Sets `X-Request-Id` for distributed tracing
  - Logs request metadata and timing
- **Environment Variables**:
  - `PORT` (default: 3000)
  - `REQUIRE_AUTH` (`true`/`false`)
  - `ISSUER` and `JWKS_URL` for JWT validation
  - `BACKEND_TIMEOUT_MS` for downstream requests
- **Dependencies**: `express`, `jose`

### Checkout Service (Node.js/Express)
- **Location**: `services/checkout/`
- **Entrypoint**: `services/checkout/server.js`
- **Container port**: 8080
- **Responsibilities**:
  - Handles checkout requests at `/api` and `/api/checkout`
  - Calls Pricing and Inventory services
  - Applies discounts and computes totals
  - Persists audit logs to PostgreSQL
  - Manages timeout and service availability errors
- **Environment Variables**:
  - `PRICING_URL`
  - `INVENTORY_URL`
  - `DEP_TIMEOUT`
  - `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- **Dependencies**: `express`, `axios`, `pg`

### Pricing Service (Node.js/Express)
- **Location**: `services/pricing/`
- **Entrypoint**: `services/pricing/server.js`
- **Container port**: 8080
- **Responsibilities**:
  - Returns discount information and pricing metadata
  - Stateless service used by Checkout
- **Endpoint**: `GET /`

### Inventory Service (Node.js/Express)
- **Location**: `services/inventory/`
- **Entrypoint**: `services/inventory/server.js`
- **Container port**: 8080
- **Responsibilities**:
  - Returns stock availability
  - Stateless service used by Checkout
- **Endpoint**: `GET /`

### PostgreSQL Database
- **Container port**: 5432
- **Configuration**: persistent storage via PVC
- **Purpose**: stores checkout audit logs and transaction metadata

## 🚀 Deployment

### Prerequisites
- Kubernetes cluster (v1.24+)
- `kubectl` configured to the cluster
- Traefik ingress controller installed
- Access to the container images referenced in manifests

### Kubernetes manifests
The deployment manifests are stored in `manifests/`:

```
manifests/
├── 00-namespace.yaml
├── 10-pricing.yaml
├── 11-inventory.yaml
├── 12-checkout.yaml
├── 13-postgres-secret.yaml
├── 14-postgres-pvc.yaml
├── 15-postgres.yaml
├── 20-gateway.yaml
├── 30-ingress.yaml
├── 41-http-scaledobject-checkout.yaml
├── 42-http-interceptor-externalname.yaml
└── checkout-ingress.yaml
```

### Deploy to Kubernetes
1. Apply all manifests:
   ```bash
   kubectl apply -f manifests/
   ```
2. Verify resources:
   ```bash
   kubectl get pods,svc,ingress -n ca1
   ```
3. Access the application:
   - `http://ca1.local/`
   - `http://ca1.local/api/ping`
   - `http://ca1.local/api/arch`
   - `http://ca1.local/api/checkout`
```

## 🌐 Routing and scaling

- `ca1.local` is routed through Traefik.
- `/api/checkout` is routed through the HTTP interceptor proxy and KEDA to scale the checkout service from zero.
- `/api/ping` and `/api/arch` are handled directly by the gateway service.
