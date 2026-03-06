# Khan Backend (Local v1)

Local backend for:
- Birth Booking
- Contact Us form
- Service Enquiries (JSON-only)

## Stack
- Node.js + Express + TypeScript
- Prisma ORM
- PostgreSQL

## Quick Start

1. Copy `.env.example` to `.env` and update values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```
4. Create/apply initial migration:
   ```bash
   npm run prisma:migrate:init
   ```
   For later schema changes, use:
   ```bash
   npm run prisma:migrate
   ```
5. Seed sample slots (optional):
   ```bash
   npm run prisma:seed
   ```
6. Start in dev mode:
   ```bash
   npm run dev
   ```

## pgAdmin SQL Seed (Optional)

If you prefer manual SQL in pgAdmin instead of Prisma seed script:

1. Apply migrations first.
2. Open [prisma/seed.sql](prisma/seed.sql) and run it in pgAdmin query tool.

## Existing Generated Migration

An initial migration file is already generated at:

`prisma/migrations/20260301120000_init/migration.sql`

To apply migrations to your local database, run:

```bash
npm run prisma:migrate
```

## API Endpoints

- `GET /api/v1/health`
- `POST /api/v1/contact/submit`
- `POST /api/v1/enquiries/submit` (JSON payload only; no file uploads)
- `GET /api/v1/birth/slots`
- `POST /api/v1/birth/submit`
- `POST /api/v1/birth/action` (`getSlots`, `getBookingFee`, `createOrder`, `verifyPaymentAndSave`)

## Birth Action Parity Env Vars

Set these in `.env` for Razorpay + booking parity:

```bash
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxxxxx
```

For customer booking confirmation emails (sent only after successful payment verification):

```bash
RESEND_API_KEY=re_xxxxx
EMAIL_FROM="Khan Consultants <onboarding@resend.dev>"
# Optional
EMAIL_REPLY_TO=khanconsultants2025@gmail.com
BOOKING_EMAIL_MAX_RETRIES=3
BOOKING_EMAIL_RETRY_DELAY_MS=900
```

`BOOKING_FEE` and `APPOINTMENT_WINDOW` are now admin-managed via `/admin/settings` and stored in DB. Env values for these are only optional first-run fallbacks.

## Admin Dashboard (Phase 1)

- `GET /admin/login` (login page)
- `POST /admin/login` (password login)
- `POST /admin/logout` (logout)
- `GET /admin` (protected dashboard shell)

Set this in `.env`:

```bash
ADMIN_PASSWORD=your-secure-admin-password
```

## Security & Production Controls

Admin CSRF protection and API/admin rate limiting are enabled.

Optional `.env` overrides:

```bash
API_RATE_LIMIT_WINDOW_MS=900000
API_RATE_LIMIT_MAX=300
ADMIN_RATE_LIMIT_WINDOW_MS=900000
ADMIN_RATE_LIMIT_MAX=200
```

Recommended for production:

- `NODE_ENV=production`
- Run behind HTTPS reverse proxy
- Set `CORS_ORIGIN` to allowed frontend origin(s); supports comma-separated values and wildcard entries like `https://*.netlify.app`
- Ensure `DATABASE_URL` and `ADMIN_PASSWORD` are set
- Rotate exposed credentials and use strong secrets
- Configure a shared session store before running multiple backend instances
- Graceful shutdown is enabled for `SIGINT`/`SIGTERM` and process-level errors

## Render Deployment (Recommended)

Use these service settings on Render:

- Root Directory: `backend`
- Build Command: `npm install && npm run build`
- Start Command: `npm run start`
- Health Check Path: `/api/v1/health`

Notes:

- `npm run start` runs `prisma migrate deploy` automatically before starting server.
- Set environment variables in Render dashboard (do not commit secrets).
- Keep a single instance on free tier unless you add shared session storage.

## Notes

- Birth action endpoint supports action payloads for slot, fee, order, and payment verification flow.
- Service enquiry endpoint accepts JSON body only and does not support file uploads.
- Birth booking confirmation email is sent to the customer only after `verifyPaymentAndSave` succeeds.
- Slot data can be edited directly in PostgreSQL/pgAdmin.
