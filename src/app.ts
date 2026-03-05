import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ZodError } from 'zod';
import { healthRouter } from './routes/health.js';
import { contactRouter } from './routes/contact.js';
import { birthRouter } from './routes/birth.js';
import { adminRouter } from './routes/admin.js';
import { adminCsrfProtection, adminRateLimiter, apiRateLimiter } from './middleware/security.js';
import { enquiriesRouter } from './routes/enquiries.js';

dotenv.config();

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string, configuredOrigins: string[]): boolean {
  for (const configuredOrigin of configuredOrigins) {
    if (!configuredOrigin) continue;

    if (configuredOrigin.includes('*')) {
      const escaped = configuredOrigin.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const wildcardPattern = `^${escaped.replace(/\*/g, '.*')}$`;
      if (new RegExp(wildcardPattern).test(origin)) {
        return true;
      }
      continue;
    }

    if (configuredOrigin === origin) {
      return true;
    }
  }

  return false;
}

const allowedOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

if (isProduction) {
  app.set('trust proxy', 1);
}

const apiCors = cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (!allowedOrigins.length && !isProduction) {
      callback(null, origin === 'http://localhost:5173');
      return;
    }

    if (isOriginAllowed(origin, allowedOrigins)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
});

app.use(cookieParser());
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const websiteLogoPath = path.resolve(__dirname, '../../khanConsultants/public/logo.svg');
const websiteIconPath = path.resolve(__dirname, '../../khanConsultants/public/icone.svg');

app.get('/logo.svg', (_req, res) => {
  res.sendFile(websiteLogoPath, (error) => {
    if (error) {
      res.status(404).json({
        success: false,
        error: 'Logo file not found',
      });
    }
  });
});

app.get('/icon.svg', (_req, res) => {
  res.sendFile(websiteIconPath, (error) => {
    if (error) {
      res.status(404).json({
        success: false,
        error: 'Icon file not found',
      });
    }
  });
});

app.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Khan Backend API is running',
  });
});

app.use('/api/v1', apiCors, apiRateLimiter);
app.use('/admin', adminRateLimiter, adminCsrfProtection, adminRouter);
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/contact', contactRouter);
app.use('/api/v1/birth', birthRouter);
app.use('/api/v1/enquiries', enquiriesRouter);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      issues: error.issues,
    });
  }

  const message = error instanceof Error ? error.message : 'Unexpected server error';

  return res.status(500).json({
    success: false,
    error: message,
  });
});

export { app };
