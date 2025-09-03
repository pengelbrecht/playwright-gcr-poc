# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This is a Playwright on Google Cloud Run prototype that exposes a single HTTP GET endpoint `/title` which uses headless Chromium to extract page titles from URLs.

## API Design
- **Main endpoint**: `GET /title?url=https://example.com`
- **Health endpoint**: `GET /healthz` 
- **Response format**: JSON with `{ ok: boolean, title: string | null, url: string, status: number | null, timing_ms: number }`

## Development Commands

### Local Development
```bash
# Install dependencies
npm install

# Start local server
npm start
# or
node server.js

# Test locally
curl "http://localhost:8080/title?url=https://example.com"
curl "http://localhost:8080/healthz"
```

### Cloud Build & Deploy
```bash
# Set environment variables
export PROJECT_ID=YOUR_PROJECT_ID
export REGION=europe-west1  
export SERVICE=playwright-title

# Build and tag image
export IMG_TAG=$(date +%Y%m%d-%H%M%S)
export IMAGE=gcr.io/$PROJECT_ID/$SERVICE:$IMG_TAG
gcloud builds submit --tag $IMAGE

# Deploy to Cloud Run
gcloud run deploy $SERVICE \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --concurrency 1 \
  --timeout 60 \
  --set-env-vars DEBUG=pw:browser*,NODE_ENV=production

# Test deployed service
export URL="$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')"
curl -i "$URL/title?url=https://example.com"
```

## Implementation Requirements

### Playwright Configuration
- Use official Playwright Docker image: `mcr.microsoft.com/playwright:<version>-<ubuntu>`
- Required Chrome flags: `--no-sandbox`, `--disable-dev-shm-usage`
- Pin Playwright version in package.json to match base image

### Environment Variables
- `DEBUG`: Playwright debug logs (default: `""`, verbose: `pw:browser*,pw:protocol`)
- `WAIT_UNTIL`: Page wait condition (`load|domcontentloaded|networkidle`, default: `load`)
- `NAV_TIMEOUT_MS`: Navigation timeout (default: `15000`)
- `REQ_TIMEOUT_MS`: Total request timeout (default: `30000`)
- `ALLOWED_HOSTS`: Optional comma-separated allowlist (empty = allow all)
- `PORT`: Server port (Cloud Run provides this, default: `8080`)

### Security & Validation
- Only allow `http://` and `https://` URLs (reject file/data/other schemes)
- URL max length: 2048 characters
- Implement proper error handling with structured JSON responses
- Use timeouts to prevent hanging requests

### Logging
- Structured JSON logging to stdout
- Log format: `{ traceId, url, start_ts, end_ts, timing_ms, status, outcome }`
- Include error codes: `NAV_TIMEOUT`, `DNS_FAIL`, `NET_TIMEOUT`, `NAV_ABORTED`

## Cloud Run Configuration
- Memory: 2Gi minimum
- Concurrency: 1 (to avoid browser launch contention)
- Timeout: 60s maximum
- Platform: managed
- Authentication: allow-unauthenticated for prototype

## Acceptance Criteria
1. `/healthz` returns `{ ok: true }` without launching browser
2. `/title?url=https://example.com` returns 200 with title "Example Domain"
3. Invalid URLs return 400 with descriptive error
4. Unreachable/timeout scenarios return 5xx with descriptive error
5. All responses have `Content-Type: application/json; charset=utf-8`