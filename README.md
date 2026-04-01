# CA1 - Enterprise Architecture Microservices Project

A distributed microservices architecture demonstrating enterprise application design patterns, built with containerization and Kubernetes orchestration.

## 📋 Project Overview

This is a complete e-commerce checkout system deployed on Kubernetes, showcasing:
- **Microservices Architecture**: Decoupled services for pricing, inventory, and checkout
- **API Gateway**: Request routing and JWT authentication
- **Service Orchestration**: Kubernetes-based deployment and scaling
- **Distributed Systems**: Service-to-service communication with timeouts and error handling
- **Database Integration**: PostgreSQL for persistent data storage

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Ingress (API Gateway)                │
└────────────────────────────┬────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │    Gateway      │
                    │  (Node.js)      │
                    │  :3000          │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼─────┐      ┌──────▼──────┐      ┌─────▼────┐
   │  Pricing  │      │   Checkout  │      │ Inventory│
   │ (Python)  │      │  (Python)   │      │ (Python) │
   │  :8000    │      │   :8001     │      │   :8002  │
   └──────────┘      └──────┬──────┘      └──────────┘
                             │
                    ┌────────▼────────┐
                    │   PostgreSQL    │
                    │   (Database)    │
                    │   :5432         │
                    └─────────────────┘
```

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
                ┌──────────────────────┐           ┌──────────────────────┐           ┌──────────────────────┐
                │     pricing-svc      │           │   inventory-svc      │           │    postgres-svc      │
                │  (always running)    │           │  (always running)    │           │   (stateful DB)      │
                └──────────┬───────────┘           └──────────┬───────────┘           └──────────┬───────────┘
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

## 📦 Services

### Gateway (Node.js/Express)
- **Location**: `gateway/`
- **Entrypoint**: `gateway/server.js`
- **Port**: 3000
- **Responsibilities**:
  - Routes incoming requests to microservices
  - Validates JWT tokens (optional, configurable)
  - Adds request IDs for distributed tracing
  - Implements request timeout handling
  - Logs request metrics (duration, status, path)
- **Environment Variables**:
  - `PORT`: Server port (default: 3000)
  - `CHECKOUT_URL`: Checkout service URL
  - `ISSUER`: JWT issuer (for token validation)
  - `JWKS_URL`: JWKS endpoint for public keys
  - `REQUIRE_AUTH`: Enable/disable JWT validation
  - `BACKEND_TIMEOUT_MS`: Timeout for backend requests (default: 2000ms)
- **Dependencies**: express, jose (JWT)

### Checkout Service (Python)
- **Location**: `checkout/` (configured in K8s manifests)
- **Port**: 8001
- **Responsibilities**:
  - Orchestrates the checkout process
  - Calls Pricing service to get discounts
  - Calls Inventory service to check stock
  - Stores transactions in PostgreSQL
  - Handles distributed timeouts
- **Environment Variables**:
  - `PRICING_URL`: Pricing service URL
  - `INVENTORY_URL`: Inventory service URL
  - `DEP_TIMEOUT`: Dependency call timeout (seconds)
  - `PGHOST`: PostgreSQL hostname
  - `PGPORT`: PostgreSQL port
  - `PGDATABASE`: Database name
  - `PGUSER`: Database user
  - `PGPASSWORD`: Database password (from secret)

### Pricing Service (Python)
- **Location**: `pricing/` (configured in K8s manifests)
- **Port**: 8000
- **Responsibilities**:
  - Returns pricing and discount information
  - Simple stateless service
- **Endpoint**: GET `/` returns JSON with pricing data

### Inventory Service (Python)
- **Location**: `inventory/` (configured in K8s manifests)
- **Port**: 8002
- **Responsibilities**:
  - Returns stock/inventory information
  - Simple stateless service
- **Endpoint**: GET `/` returns JSON with stock data

### PostgreSQL Database
- **Port**: 5432
- **Configuration**: Persistent storage with PVC
- **Purpose**: Stores checkout transactions and application data

## 🚀 Deployment

### Prerequisites
- Kubernetes cluster (v1.24+)
- `kubectl` CLI configured
- Container runtime (Docker/containerd)

### Kubernetes Manifests Structure

All deployment configurations are in the `manifests/` directory:

```
manifests/
├── 00-namespace.yaml           # Creates 'ca1' namespace
├── 10-pricing.yaml            # Pricing service deployment
├── 11-inventory.yaml          # Inventory service deployment
├── 12-checkout.yaml           # Checkout service deployment
├── 13-postgres-secret.yaml    # PostgreSQL credentials
├── 14-postgres-pvc.yaml       # Database persistent volume
├── 15-postgres.yaml           # PostgreSQL deployment
├── 20-gateway.yaml            # Gateway deployment
├── 30-ingress.yaml            # Ingress routing rules
├── 41-http-scaledobject-checkout.yaml  # Auto-scaling config
├── 42-http-interceptor-externalname.yaml
└── checkout-ingress.yaml      # Additional ingress config
```

### Deploy to Kubernetes

1. **Create the namespace and deploy all components**:
   ```bash
   kubectl apply -f manifests/
   ```

2. **Verify deployments**:
   ```bash
   kubectl get pods -n ca1
   ```

3. **Check services**:
   ```bash
   kubectl get svc -n ca1
   ```

4. **View logs**:
   ```bash
   kubectl logs -n ca1 -l app=gateway -f
   kubectl logs -n ca1 -l app=checkout -f
   ```

## 📡 API Usage

### Making Requests to the Gateway

**Example Checkout Request**:
```bash
curl -X POST http://10.0.2.15/api/checkout \
  -H "Host: ca1.local" \
  -H "X-Request-Id: trace-123" \
  -H "Content-Type: application/json" \
  -d '{
    "sku": 1,
    "subtotal": 100,
    "quantity": 1
  }'
```

**With JWT Authentication**:
```bash
curl -X POST http://10.0.2.15/api/checkout \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "X-Request-Id: trace-123" \
  -H "Content-Type: application/json" \
  -d '{"sku": 1, "subtotal": 100, "quantity": 1}'
```

### Request Headers
- `Host`: Host header for routing
- `X-Request-Id`: Unique request identifier (auto-generated if not provided)
- `Authorization`: Bearer token for JWT-based auth (optional)
- `Content-Type`: application/json

### Response Headers
- `X-Request-Id`: Echo back of request ID for tracing

## 🔐 Security

### JWT Authentication
- Gateway supports optional JWT validation
- Tokens are validated against JWKS endpoint
- Enable with `REQUIRE_AUTH=true`
- Requires `ISSUER` and `JWKS_URL` configuration

### Secret Management
- PostgreSQL credentials stored in Kubernetes secrets
- Injected into pods via environment variables
- Reference: `manifests/13-postgres-secret.yaml`

## 📊 Monitoring & Observability

### Request Logging
All services log requests with:
- `req_id`: Unique request ID for distributed tracing
- `method`: HTTP method
- `path`: Request path
- `status`: HTTP status code
- `duration_ms`: Request processing time

Example log:
```
req_id=f47ac10b-58cc-4372-a567-0e02b2c3d479 method=POST path=/api/checkout status=200 duration_ms=150
```

### Tracing
- Use `X-Request-Id` header to trace requests across services
- Passed through all service-to-service calls
- Help correlate logs across microservices

## 🛠️ Scaling & Auto-scaling

### Manual Scaling
```bash
kubectl scale deployment checkout -n ca1 --replicas=3
kubectl scale deployment gateway -n ca1 --replicas=2
```

### Auto-scaling Configuration
- See `manifests/41-http-scaledobject-checkout.yaml`
- Configured for KEDA (Kubernetes Event-driven Autoscaling)
- Automatically scales based on HTTP traffic

## 📁 Project Structure

```
ca1/
├── README.md                          # This file
├── gateway/
│   ├── package.json                   # Node.js dependencies
│   └── server.js                      # Gateway implementation
├── checkout/                          # (configured in K8s)
├── pricing/                           # (configured in K8s)
├── inventory/                         # (configured in K8s)
├── manifests/                         # Kubernetes configurations
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
├── scripts/                           # Deployment/utility scripts
├── docs/                              # Documentation
└── .git/                              # Version control
```

## 🔄 Request Flow

1. **Client Request**: Sends request to Ingress/Gateway
2. **Gateway Processing**: 
   - Generates or extracts request ID
   - Validates JWT token (if REQUIRE_AUTH enabled)
   - Routes to appropriate service
3. **Checkout Service**:
   - Receives request
   - Calls Pricing service (with timeout)
   - Calls Inventory service (with timeout)
   - Stores transaction in PostgreSQL
   - Returns response
4. **Response**: Gateway returns response to client with X-Request-Id header

## 🧪 Testing

### Health Checks
```bash
# Check if services are running
kubectl get pods -n ca1

# Check service endpoints
kubectl get endpoints -n ca1
```

### Service Discovery
```bash
# Within cluster, services are accessible via DNS:
# http://pricing-svc/
# http://inventory-svc/
# http://checkout-svc/
# postgres-svc:5432
```

### Database Access
```bash
# Port-forward to PostgreSQL
kubectl port-forward -n ca1 svc/postgres-svc 5432:5432

# Connect with psql
psql -h localhost -U ca1user -d ca1db
```

## 🐛 Troubleshooting

### Pods not starting
```bash
kubectl describe pod -n ca1 <pod-name>
kubectl logs -n ca1 <pod-name>
```

### Service not responding
```bash
kubectl get svc -n ca1
kubectl get endpoints -n ca1
kubectl exec -it -n ca1 <pod-name> -- /bin/sh
```

### Connection timeouts
- Check service endpoints: `kubectl get endpoints -n ca1`
- Verify BACKEND_TIMEOUT_MS and DEP_TIMEOUT settings
- Check network policies and firewall rules

### Database issues
```bash
# Connect to postgres pod
kubectl exec -it -n ca1 postgres-0 -- psql -U ca1user -d ca1db
```

## 📚 Technology Stack

- **Runtime**: Node.js 20 (Gateway), Python 3.11 (Services)
- **Web Framework**: Express.js (Gateway), http.server (Services)
- **Authentication**: JWT via Jose library
- **Database**: PostgreSQL 15
- **Container**: Docker (Alpine images)
- **Orchestration**: Kubernetes
- **Auto-scaling**: KEDA (Kubernetes Event-driven Autoscaling)

## 📝 Configuration

### Environment Variables Reference

**Gateway**:
```
PORT=3000
CHECKOUT_URL=http://checkout-svc/api
ISSUER=<optional-jwt-issuer>
JWKS_URL=<optional-jwks-endpoint>
REQUIRE_AUTH=false
BACKEND_TIMEOUT_MS=2000
```

**Checkout**:
```
PRICING_URL=http://pricing-svc/
INVENTORY_URL=http://inventory-svc/
DEP_TIMEOUT=1.5
PGHOST=postgres-svc
PGPORT=5432
PGDATABASE=ca1db
PGUSER=ca1user
PGPASSWORD=<from-secret>
```

## 🚀 Getting Started

1. **Deploy the application**:
   ```bash
   kubectl apply -f manifests/
   ```

2. **Wait for pods to be ready**:
   ```bash
   kubectl wait --for=condition=ready pod -l app=gateway -n ca1 --timeout=300s
   ```

3. **Test the API**:
   ```bash
   curl -X POST http://<ingress-ip>/api/checkout \
     -H "Content-Type: application/json" \
     -d '{"sku": 1, "subtotal": 100, "quantity": 1}'
   ```

4. **Monitor logs**:
   ```bash
   kubectl logs -n ca1 -l app=gateway -f
   ```

## 📖 Additional Resources

- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Express.js Guide](https://expressjs.com/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [KEDA Scaler Documentation](https://keda.sh/)

## 🤝 Contributing

This is an educational project demonstrating enterprise architecture patterns. Contributions and improvements are welcome.

## 📄 License

This project is provided as-is for educational purposes.

---

**Last Updated**: April 2026  
**Repository**: https://github.com/AbdulQader496/Ent_Arch_Design_Ca1
