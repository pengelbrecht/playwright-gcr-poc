# Playwright on Google Cloud Run - Proof of Concept

A minimal production-like prototype demonstrating how to deploy **Playwright with Chromium** on **Google Cloud Run** for web scraping and browser automation tasks.

## Overview

This project showcases a complete deployment pipeline for running headless Playwright browser automation in a serverless Cloud Run environment. It extracts page titles from websites using Chromium in a containerized, scalable service.

## Architecture

- **Runtime**: Node.js 18+ with Playwright 1.55.0
- **Browser**: Chromium (headless) with Cloud Run-safe launch flags
- **Base Image**: `mcr.microsoft.com/playwright:v1.55.0-noble`
- **Platform**: Google Cloud Run (fully managed)
- **Memory**: 2GB, Concurrency: 1, Request timeout: 60s

## API Endpoints

### `GET /title?url=<URL>`
Extract the page title from any HTTP(S) website.

**Example Request:**
```bash
curl "https://playwright-title-368152909186.europe-west1.run.app/title?url=https://example.com"
```

**Response:**
```json
{
  "ok": true,
  "title": "Example Domain",
  "url": "https://example.com", 
  "status": 200,
  "timing_ms": 1234
}
```

### `GET /status`
Service health check with version information.

**Response:**
```json
{
  "ok": true,
  "service": "playwright-title-service",
  "version": "1.0.0",
  "timestamp": "2025-09-03T09:25:41.235Z"
}
```

## Quick Start

### Prerequisites
- Google Cloud CLI (`gcloud`) installed and authenticated
- Docker (for local testing)
- Node.js 18+ (for local development)

### Deploy to Cloud Run

1. **Clone and setup:**
   ```bash
   git clone <this-repo>
   cd playwright-gcr
   npm install
   ```

2. **Deploy using npm script:**
   ```bash
   npm run deploy
   ```

3. **Test the service:**
   ```bash
   npm run health                                    # Check service status
   npm run test-title                               # Test with example.com
   URL=https://www.google.com npm run test-title    # Test with custom URL
   ```

### Manual Deployment

```bash
# Set environment variables
export PROJECT_ID=your-project-id
export REGION=europe-west1
export SERVICE=playwright-title

# Enable APIs
gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com

# Build and deploy
export IMG_TAG=$(date +%Y%m%d-%H%M%S)
export IMAGE=gcr.io/$PROJECT_ID/$SERVICE:$IMG_TAG

gcloud builds submit --tag $IMAGE
gcloud run deploy $SERVICE \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --concurrency 1 \
  --timeout 60
```

## Key Implementation Details

### Chromium Launch Configuration
```javascript
browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',           // Required for Cloud Run
    '--disable-dev-shm-usage', // Prevents memory issues
    '--disable-gpu',
    '--disable-extensions'
  ]
});
```

### Error Handling & Timeouts
- **Navigation timeout**: 15 seconds (configurable via `NAV_TIMEOUT_MS`)
- **Request timeout**: 30 seconds (configurable via `REQ_TIMEOUT_MS`)
- **Proper browser cleanup** in finally blocks
- **Structured error logging** with timing metrics

### Security Features
- URL validation (HTTP/HTTPS only, max length 2048)
- Protocol filtering (blocks file://, data:// etc.)
- Optional hostname allowlist via `ALLOWED_HOSTS` environment variable
- Input sanitization and error boundaries

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port (set by Cloud Run) |
| `DEBUG` | `""` | Playwright debug logging (`pw:browser*`) |
| `WAIT_UNTIL` | `"load"` | Page load strategy |
| `NAV_TIMEOUT_MS` | `15000` | Navigation timeout |
| `REQ_TIMEOUT_MS` | `30000` | Total request timeout |
| `ALLOWED_HOSTS` | `""` | Comma-separated hostname allowlist |

## Lessons Learned

1. **Base Image Choice**: Use official Playwright Docker images (`mcr.microsoft.com/playwright`) to avoid Alpine/musl compatibility issues
2. **Memory Requirements**: Start with 2GB memory; Chromium is resource-intensive
3. **Launch Flags**: `--no-sandbox` and `--disable-dev-shm-usage` are essential for containerized environments
4. **Concurrency**: Set to 1 initially to prevent browser launch contention
5. **Health Checks**: Avoid `/healthz` path - it's intercepted by Google Cloud infrastructure
6. **Version Pinning**: Pin Playwright version in package.json to match Docker image tag

## Common Pitfalls & Solutions

During implementation, we encountered and solved several critical issues:

### 1. Docker Base Image Compatibility 🔧
**Problem**: Started with `mcr.microsoft.com/playwright:v1.40.0-jammy` but faced package version conflicts and browser launch failures.

**Solution**: Evolved through multiple versions:
- ❌ `v1.40.0-jammy` → Package conflicts
- ⚠️ `v1.48.2-noble` → Better but still issues  
- ✅ `v1.55.0-noble` → Final stable version

**Key Lesson**: Always pin Playwright version in `package.json` to exactly match the Docker image tag.

### 2. Container Networking Mystery 🌐
**Problem**: Service deployed successfully but was unreachable. Cloud Run health checks failed with connection errors.

**Root Cause**: Server was only listening on `localhost` (127.0.0.1), but Cloud Run needs to connect from external load balancers.

**Solution**: 
```javascript
// ❌ This fails on Cloud Run
server.listen(PORT, () => { ... });

// ✅ This works - must bind to 0.0.0.0  
server.listen(PORT, '0.0.0.0', () => { ... });
```

### 3. The `/healthz` Endpoint Mystery 👻
**Problem**: `/healthz` endpoint returned Google's 404 page instead of our application response, even though other endpoints worked perfectly.

**Investigation**: Created a test `/status` endpoint which worked fine on the same URLs, revealing the issue wasn't with our code.

**Root Cause**: Google Cloud Run infrastructure reserves certain paths (like `/healthz`) for load balancer and infrastructure-level health checking. Requests to these paths never reach the application container.

**Solution**: Use alternative paths like `/status` for application health checks.

### 4. Package Lock Synchronization Issues 🔒
**Problem**: When upgrading Playwright versions, encountered dependency resolution errors and version mismatches.

**Solution**: After changing Playwright version in `package.json`:
```bash
rm package-lock.json
npm install  # Regenerates lock file with correct versions
```

**Key Lesson**: Always regenerate lock files when upgrading major dependencies.

### 5. Browser Launch Race Conditions 🏃‍♂️
**Problem**: Multiple concurrent requests caused browser launch failures and memory issues.

**Solution**: Set Cloud Run concurrency to 1:
```bash
gcloud run deploy --concurrency 1
```

**Why**: Chromium launches are resource-intensive and can conflict when starting simultaneously in containers.

## Troubleshooting

### Common Issues
- **Container startup failures**: Usually memory or launch flag issues
- **Navigation timeouts**: Increase `NAV_TIMEOUT_MS` or check network connectivity
- **Resource exhaustion**: Increase memory allocation or reduce concurrency
- **Cold starts**: Expected; consider min instances for production

### Debug Mode
Enable verbose Playwright logging:
```bash
gcloud run deploy playwright-title --set-env-vars DEBUG=pw:browser*,pw:protocol
```

## Performance Characteristics

- **Cold start**: 5-15 seconds (includes browser launch)
- **Warm requests**: 1-3 seconds for simple pages
- **Memory usage**: 300-800MB per request
- **Concurrent capacity**: 1 request per instance (configurable)

## Production Considerations

- **Monitoring**: Add Cloud Logging and Error Reporting
- **Scaling**: Configure min/max instances based on load patterns  
- **Security**: Implement authentication and rate limiting
- **Cost optimization**: Use Cloud Scheduler for periodic cleanup
- **Content policy**: Add content filtering and size limits

## License

MIT License - see LICENSE file for details.

---

**Note**: This is a proof of concept for educational and testing purposes. For production use, implement proper authentication, monitoring, and error handling according to your specific requirements.