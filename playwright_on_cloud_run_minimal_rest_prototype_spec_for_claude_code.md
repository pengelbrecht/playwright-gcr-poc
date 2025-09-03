# Goal
Build a tiny production-like prototype that exposes a single HTTP GET endpoint on Google Cloud Run. The endpoint launches a **headless Playwright Chromium** instance, performs a very simple action, and returns a small JSON payload. Use the **gcloud CLI** for build/deploy as much as possible. **No application code in this spec**—only requirements, commands, and acceptance criteria.

---

## Simple Test Task
- **Endpoint**: `GET /title`
- **Single query parameter**: `url` (required). Example: `/title?url=https://example.com`
- **Behavior**:
  1) Validate `url` is an absolute `http(s)` URL (reject file/data/other schemes).
  2) Launch Playwright Chromium **headless** with Cloud Run–safe flags (`--no-sandbox`, `--disable-dev-shm-usage`).
  3) Navigate to `url` with a **navigation timeout** (e.g., 15s) and a **total request timeout** (e.g., 25–30s).
  4) Wait for `load` (or a configurable `waitUntil`) and capture the page `<title>`.
  5) Return JSON with: `{ ok: boolean, title: string | null, url: string, status: number | null, timing_ms: number }`.
  6) Close the browser reliably in finally/cleanup blocks.

- **Non-goals** (explicitly out of scope): screenshots, authentication, scraping beyond a single navigation, proxy/VPN, downloading files, non-HTTP(S) protocols.

---

## API Contract
- **Request**
  - Method: `GET`
  - Path: `/title`
  - Query: `url` (required, http/https, max length 2048)

- **Successful Response** (`200 OK`)
```json
{
  "ok": true,
  "title": "Example Domain",
  "url": "https://example.com",
  "status": 200,
  "timing_ms": 1234
}
```

- **Client Error** (`400 Bad Request`)
```json
{
  "ok": false,
  "error": "Missing or invalid 'url' parameter"
}
```

- **Upstream/Timeout Error** (`504 Gateway Timeout` or `502 Bad Gateway`)
```json
{
  "ok": false,
  "error": "Navigation timed out after 15000 ms"
}
```

- **Content-Type**: `application/json; charset=utf-8`

---

## Runtime & Container Requirements (Implementation Guidance)
- **Language/Runtime**: Node.js LTS compatible with Playwright in the chosen base image.
- **Base Image**: Use an **official Playwright image** (e.g., `mcr.microsoft.com/playwright:<version>-<ubuntu>`). This avoids Alpine/musl issues and includes browsers + system deps. Pin to the same Playwright version used in `package.json`.
- **Playwright Launch Flags**: `--no-sandbox`, `--disable-dev-shm-usage`.
- **Server Port**: Cloud Run expects the app to listen on `PORT` env (default 8080).
- **Resource Hints**: Start with **1–2 GiB memory** and **concurrency = 1** to avoid launch contention. Increase gradually once stable.
- **Logging**: Respect `DEBUG` env (e.g., `pw:browser*`) and log structured JSON lines to stdout.
- **Health**: A simple `GET /healthz` that returns `{ ok: true }` without launching a browser.

> **Note:** Do not include code here—only follow these requirements when implementing.

---

## Security & Safety
- Validate the `url` protocol and length; optionally reject IP-literals or private subnets if desired (SSR mitigations).
- Block non-HTTP(S) protocols and file URIs.
- Set a **navigation timeout** and a **total request timeout** (Cloud Run request timeout ≤ 60s by default).
- Consider an optional **allowlist** env `ALLOWED_HOSTS` (comma-separated), and reject others (return `403`). For the prototype, this can be disabled by default.

---

## Observability & Debugging
- Env var `DEBUG=pw:browser*,pw:protocol` to trace launch/navigation issues.
- Log `{ traceId, url, start_ts, end_ts, timing_ms, status, outcome }` per request.
- On errors, include a short error `code` (`NAV_TIMEOUT`, `DNS_FAIL`, `NET_TIMEOUT`, `NAV_ABORTED`, etc.).

---

## Local Smoke Test (no code, just expectations)
- Run the service locally (implementation does this) and call:
  - `curl "http://localhost:8080/title?url=https://example.com"`
  - Expect `200` and JSON containing `"title": "Example Domain"` within ~2–5s on a warm run.

---

## Cloud Build & Cloud Run Deployment (gcloud-first)
> Use **gcloud CLI** for all steps. Replace placeholders in ALL_CAPS.

### 1) Project & APIs
```bash
export PROJECT_ID=YOUR_PROJECT_ID
export REGION=europe-west1
export SERVICE=playwright-title

gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

### 2) Build with Cloud Build
- The repository should contain the Docker context (Dockerfile, package files, etc.).
- Build and tag with timestamp:
```bash
export IMG_TAG=$(date +%Y%m%d-%H%M%S)
export IMAGE=gcr.io/$PROJECT_ID/$SERVICE:$IMG_TAG

gcloud builds submit --tag $IMAGE
```

### 3) First Deploy to Cloud Run (fully managed)
```bash
gcloud run deploy $SERVICE \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --concurrency 1 \
  --timeout 60 \
  --set-env-vars DEBUG=pw:browser*,NODE_ENV=production
```
- Capture the **service URL** output by the command for testing.

### 4) Test the Deployed Endpoint
```bash
export URL="$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')"

curl -i "$URL/title?url=https://example.com"
```
- Expect `200 OK` with `"title":"Example Domain"`.

### 5) Updates / Rollouts
- Repeat build, then deploy with the **new** `$IMAGE` tag to get a new revision.
- If needed, pin traffic between revisions with `--traffic` flags (optional for prototype).

### 6) Cleanup (optional)
```bash
gcloud run services delete $SERVICE --region $REGION -q
```

---

## Configuration (Environment Variables)
- `DEBUG` (string): default `""`. For verbose Playwright logs: `pw:browser*,pw:protocol`.
- `WAIT_UNTIL` (string): one of `load|domcontentloaded|networkidle` (default `load`).
- `NAV_TIMEOUT_MS` (int): default `15000`.
- `REQ_TIMEOUT_MS` (int): default `30000`.
- `ALLOWED_HOSTS` (string): optional comma-separated allowlist (empty = allow all http/https for prototype).

---

## Acceptance Criteria
1) Calling `GET /healthz` returns `{ ok: true }` without any Playwright launch.
2) Calling `GET /title?url=https://example.com` returns `200` with `ok: true`, `title = "Example Domain"`, and non-null `timing_ms`.
3) Invalid or missing `url` returns `400` with a descriptive JSON error.
4) Unreachable host or timeout returns a `5xx` with a descriptive JSON error and `ok: false`.
5) Service is deployed on Cloud Run, publicly accessible (allow-unauthenticated), and logs appear in Cloud Logging with structured fields.
6) Memory set ≥ 1Gi (target 2Gi), concurrency = 1, request timeout ≤ 60s.

---

## Risks & Mitigations (Prototype Level)
- **Chromium sandbox issues** → Always pass `--no-sandbox` & `--disable-dev-shm-usage`.
- **Resource starvation / hangs** → Start with low concurrency and ≥1–2GiB memory.
- **Version drift** → Pin Playwright version in `package.json` to match the Playwright base image tag.
- **Slow cold starts** → Acceptable for prototype; can later add min instances or reduce image size.

---

## Work Plan for Claude Code
1) **Scaffold** a minimal Node HTTP server exposing `/healthz` and `/title` (no extra frameworks needed).
2) **Integrate Playwright** Chromium launch with required flags and env-driven timeouts.
3) **Implement validation** for `url` and return structured JSON responses and errors.
4) **Add logging** (structured JSON to stdout) including timing and status fields.
5) **Create Dockerfile** based on the official Playwright image; respect `PORT` env.
6) **Test locally**, then **build & deploy** to Cloud Run using the gcloud commands above.
7) **Verify** acceptance criteria using `curl` and Cloud Logging.

---

## Nice-to-haves (if time permits)
- Add `User-Agent` override env (e.g., `UA_OVERRIDE`) for deterministic titles.
- Add basic input rate limits (per-IP) or simple in-memory queue to serialize requests.
- Expose a `GET /version` endpoint returning image tag and Playwright version.

