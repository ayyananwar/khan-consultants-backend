# Render Deploy Checklist (Backend)

Use this exact checklist to deploy `backend` to Render free plan.

This file is pre-configured for:

- Auto deploy backend from `main`
- Render PostgreSQL database name: `khan_data`
- Service name: `khan-consultants-api`

## 1) Create Render Resources

- Create Web Service from backend GitHub repo.
- Service name: `khan-consultants-api`
- Region: `Singapore`
- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Health check path: `/api/v1/health`
- Branch: `main`
- Auto deploy: `On`

Create PostgreSQL in Render with DB name `khan_data`.

## 2) Set Environment Variables in Render (Web Service)

Set these exact keys:

- `NODE_ENV=production`
- `TZ=Asia/Kolkata`
- `PORT=4000`
- `CORS_ORIGIN=https://khanconsultants.in,https://www.khanconsultants.in,https://*.netlify.app`
- `ADMIN_PASSWORD=<new strong password>`
- `RAZORPAY_KEY_ID=<razorpay test key>`
- `RAZORPAY_KEY_SECRET=<razorpay test secret>`

Notes:
- `npm run start` already runs `prisma migrate deploy` before server start.
- `DATABASE_URL` is auto-wired from Render PostgreSQL via `render.yaml`.
- Booking fee and appointment window are admin-managed in DB via `/admin/settings`.

## 3) Deploy

- Push to `main` branch.
- Render auto-deploy will start automatically.
- Wait until deployment is green.

## 4) Verify Backend

Open these URLs:

- `https://khan-consultants-api.onrender.com/api/v1/health`
- `https://khan-consultants-api.onrender.com/admin/login`

Expected:
- Health returns `success: true`
- Admin login page loads

## 5) Configure Netlify Frontend Env

Set these in Netlify:

- `VITE_BACKEND_URL=https://khan-consultants-api.onrender.com`
- `VITE_BOOKING_API_URL=https://khan-consultants-api.onrender.com/api/v1/birth/action`
- `VITE_SERVICE_ENQUIRY_API_URL=https://khan-consultants-api.onrender.com/api/v1/enquiries/submit`
- `VITE_CONTACT_ENQUIRY_API_URL=https://khan-consultants-api.onrender.com/api/v1/contact/submit`

Then redeploy frontend.

## 6) First-Time Admin Setup

- Login at `/admin/login`.
- Go to `/admin/settings` and set booking fee + appointment window.
- Go to `/admin/slots` and create active slots.

## 7) Final Smoke Test

- Submit Contact form.
- Submit Service enquiry.
- Open Birth booking modal, verify slots, create Razorpay order, complete test payment.
- Confirm booking appears in admin bookings.
