import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma.js';
import {
  createAdminSession,
  destroyAdminSession,
  getAdminSessionTtlSeconds,
  validateAdminSession,
} from '../lib/adminSession.js';
import { getBookingSettings, updateBookingSettings } from '../lib/bookingSettings.js';
import { ADMIN_SESSION_COOKIE, requireAdminAuth } from '../middleware/adminAuth.js';

const adminRouter = Router();
let runtimeAdminPassword: string | null = null;

type AdminNavKey = 'overview' | 'slots' | 'bookings' | 'contacts' | 'services' | 'summary' | 'settings';
type ContactStatus = 'new' | 'contacted' | 'closed';

const APPLICATION_LABELS: Record<string, string> = {
  new: 'New',
  correction: 'Correction',
  digital: 'Digital',
  'lost-destroyed': 'Lost / Destroyed',
  'get-copy': 'Get a Copy',
};

const SERVICE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gst', label: 'GST Services' },
  { value: 'fssai', label: 'FSSAI Food Licence' },
  { value: 'drug-licence', label: 'Pharmacy / Drug Licence' },
  { value: 'kmc', label: 'KMC Services' },
  { value: 'personal-documentation', label: 'Personal Documentation' },
  { value: 'trademark-marketplace', label: 'Trademark & Marketplace' },
];

const SERVICE_PAYLOAD_FIELD_OPTIONS: Record<string, Array<{ key: string; label: string }>> = {
  gst: [
    { key: 'hasGstNumber', label: 'Do You Already Have GST Number?' },
    { key: 'natureOfInquiry', label: 'Nature of Inquiry' },
    { key: 'wantGstRegistration', label: 'Need New GST Registration?' },
    { key: 'ownershipType', label: 'Business Ownership Type' },
    { key: 'monthlyTurnover', label: 'Expected Monthly Turnover' },
    { key: 'monthlyInvoices', label: 'Expected Monthly Invoices' },
    { key: 'otpEmail', label: 'OTP Email' },
    { key: 'otpMobile', label: 'OTP Mobile' },
    { key: 'gstHelpNeeded', label: 'GST Help Needed' },
  ],
  fssai: [
    { key: 'foodBusinessType', label: 'Food Business Type' },
    { key: 'annualTurnover', label: 'Estimated Annual Turnover' },
    { key: 'licenseTypeIfKnown', label: 'Licence Type (If Known)' },
    { key: 'hasTradeLicense', label: 'Do You Have Trade Licence?' },
    { key: 'kitchenAddress', label: 'Kitchen/Premises Address' },
  ],
  'drug-licence': [
    { key: 'drugLicenseType', label: 'Drug Licence Type' },
    { key: 'hasRegisteredPharmacist', label: 'Registered Pharmacist Available?' },
    { key: 'pharmacistRegistrationNumber', label: 'Pharmacist Registration Number' },
    { key: 'shopAreaSqFt', label: 'Shop Area (Sq Ft)' },
    { key: 'refrigeratorAvailable', label: 'Refrigerator Available?' },
  ],
  kmc: [
    { key: 'kmcServiceType', label: 'KMC Service Type' },
    { key: 'propertyType', label: 'Property Type' },
    { key: 'idNumbersAndDetails', label: 'Existing IDs / Details' },
  ],
  'personal-documentation': [
    { key: 'personalDocType', label: 'Document Type' },
    { key: 'applicationNature', label: 'Application Nature' },
  ],
  'trademark-marketplace': [
    { key: 'businessStructure', label: 'Business Structure' },
    { key: 'serviceRequired', label: 'Service Required' },
    { key: 'brandNameOrLogo', label: 'Brand Name / Logo' },
    { key: 'firstUseDate', label: 'Date of First Use' },
    { key: 'goodsServicesDescription', label: 'Goods / Services Description' },
    { key: 'registrationReason', label: 'Why Register Trademark?' },
    { key: 'currentSellerStatus', label: 'Current Seller Status' },
    { key: 'targetPlatforms', label: 'Target Platforms' },
    { key: 'brandAuthorization', label: 'Brand Authorization Available?' },
    { key: 'trademarkStatus', label: 'Trademark Status' },
    { key: 'skuCount', label: 'Approx SKU Count' },
    { key: 'pickupAddressType', label: 'Pickup Address Type' },
    { key: 'supportNeeded', label: 'Support Needed' },
  ],
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeDateToUtcMidnight(input: string): Date {
  return new Date(`${input}T00:00:00.000Z`);
}

function dayRange(date: Date): { start: Date; end: Date } {
  const iso = date.toISOString().slice(0, 10);
  const start = normalizeDateToUtcMidnight(iso);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function getBookedCountForDate(date: Date): Promise<number> {
  const { start, end } = dayRange(date);
  return prisma.birthBooking.count({
    where: {
      chosenSlotDate: {
        gte: start,
        lt: end,
      },
      status: 'confirmed',
    },
  });
}

function navLink(label: string, href: string, key: AdminNavKey, active: AdminNavKey): string {
  const activeClass = key === active ? 'side-link active' : 'side-link';
  return `<a class="${activeClass}" href="${href}">${label}</a>`;
}

function extractAdminRemark(notes: string | null): { clientNote: string; adminRemark: string } {
  const value = notes || '';
  const marker = '\n---\nAdmin Remark:';
  const index = value.indexOf(marker);

  if (index < 0) {
    return {
      clientNote: value,
      adminRemark: '',
    };
  }

  return {
    clientNote: value.slice(0, index).trim(),
    adminRemark: value.slice(index + marker.length).trim(),
  };
}

function mergeNotes(clientNote: string, adminRemark: string): string | null {
  const cleanClient = clientNote.trim();
  const cleanAdmin = adminRemark.trim();

  if (!cleanClient && !cleanAdmin) return null;
  if (!cleanAdmin) return cleanClient || null;
  if (!cleanClient) return `---\nAdmin Remark: ${cleanAdmin}`;

  return `${cleanClient}\n---\nAdmin Remark: ${cleanAdmin}`;
}

function toIsoDateInput(date: Date | null): string {
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

function parseContactStatus(value: string): ContactStatus | null {
  if (value === 'new' || value === 'contacted' || value === 'closed') {
    return value;
  }
  return null;
}

function csvEscape(value: string | number | null | undefined): string {
  const raw = String(value ?? '');
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function getEffectiveAdminPassword(): string {
  return runtimeAdminPassword || process.env.ADMIN_PASSWORD || '';
}

function getRuntimePasswordStateLabel(): string {
  return runtimeAdminPassword ? 'Runtime override active' : 'Using ADMIN_PASSWORD from .env';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatApplicationType(value: string): string {
  const key = value.trim().toLowerCase();
  return APPLICATION_LABELS[key] || value;
}

function formatRelationship(value: string): string {
  const text = value.trim();
  if (!text) return '-';
  if (text.toLowerCase() === 'self') return 'Self';
  return text;
}

function formatBookingStatusLabel(value: string): string {
  const key = value.trim().toLowerCase();
  if (key === 'confirmed') return 'Confirmed';
  return value;
}

function formatContactStatusLabel(value: string): string {
  const key = value.trim().toLowerCase();
  if (key === 'new') return 'New';
  if (key === 'contacted') return 'Contacted';
  if (key === 'closed') return 'Closed';
  return value;
}

function formatServiceTypeLabel(value: string): string {
  const found = SERVICE_TYPE_OPTIONS.find((option) => option.value === value);
  return found?.label || value;
}

function formatPayloadKeyLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return '-';

  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        return '';
      })
      .filter((item) => item.length > 0);
    return items.length > 0 ? items.join(', ') : '-';
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim() || '-';
  if (typeof value === 'object') return 'Provided';

  return String(value);
}

function servicePayloadDetailsHtml(serviceType: string, formPayload: Prisma.JsonValue): string {
  if (!formPayload || typeof formPayload !== 'object' || Array.isArray(formPayload)) {
    return '<div class="meta">No form details submitted.</div>';
  }

  const payload = formPayload as Record<string, unknown>;
  const configuredFields = SERVICE_PAYLOAD_FIELD_OPTIONS[serviceType] || [];
  const configuredKeys = new Set(configuredFields.map((field) => field.key));

  const rows: Array<{ label: string; value: string }> = [];

  configuredFields.forEach((field) => {
    if (payload[field.key] === undefined) return;
    rows.push({
      label: field.label,
      value: formatPayloadValue(payload[field.key]),
    });
  });

  Object.entries(payload).forEach(([key, value]) => {
    if (configuredKeys.has(key) || value === undefined) return;
    rows.push({
      label: formatPayloadKeyLabel(key),
      value: formatPayloadValue(value),
    });
  });

  if (rows.length === 0) {
    return '<div class="meta">No form details submitted.</div>';
  }

  return rows
    .map((row) => `<div><strong>${escapeHtml(row.label)}:</strong> ${escapeHtml(row.value)}</div>`)
    .join('');
}

function documentChecklistFromJson(json: Prisma.JsonValue): string[] {
  if (Array.isArray(json)) {
    return json
      .map((item) => asString(item).trim())
      .filter((item) => item.length > 0);
  }

  if (!json || typeof json !== 'object') {
    return [];
  }

  const selectedRaw = (json as Record<string, unknown>).selected;
  if (!Array.isArray(selectedRaw)) {
    return [];
  }

  return selectedRaw
    .map((item) => asString(item).trim())
    .filter((item) => item.length > 0);
}

function correctionSummaryFromJson(json: Prisma.JsonValue): string[] {
  if (!Array.isArray(json)) {
    return [];
  }

  return json
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      const row = item as Record<string, unknown>;
      const field = asString(row.field).trim();
      const incorrectValue = asString(row.incorrectValue).trim();
      const correctValue = asString(row.correctValue).trim();
      if (!incorrectValue && !correctValue) return '';
      const prefix = field ? `${field}: ` : '';
      return `${prefix}${incorrectValue || '-'} → ${correctValue || '-'}`;
    })
    .filter((entry) => entry.length > 0);
}

function buildCaseSummary(params: {
  booking: {
    bookingReference: string;
    createdAt: Date;
    applicantName: string;
    applicantPhone: string;
    applicantEmail: string;
    fillerName: string;
    fillerPhone: string;
    fillerEmail: string;
    relationshipToApplicant: string;
    applicationType: string;
    applicantDob: string;
    chosenSlotDate: Date | null;
    chosenTimeWindow: string | null;
    notes: string | null;
    documentsSelected: Prisma.JsonValue;
    correctionEntries: Prisma.JsonValue;
  };
  adminRemark: string;
}): string {
  const { booking } = params;
  const notes = extractAdminRemark(booking.notes);
  const docs = documentChecklistFromJson(booking.documentsSelected);
  const corrections = correctionSummaryFromJson(booking.correctionEntries);
  const slotDate = booking.chosenSlotDate ? booking.chosenSlotDate.toISOString().slice(0, 10) : '-';

  const lines = [
    'KHAN CONSULTANTS — CASE SUMMARY',
    '',
    `Reference: ${booking.bookingReference}`,
    `Created On: ${booking.createdAt.toISOString().slice(0, 10)}`,
    '',
    '1) APPLICANT PROFILE',
    `- Applicant Name: ${booking.applicantName}`,
    `- Applicant Phone: ${booking.applicantPhone}`,
    `- Applicant Email: ${booking.applicantEmail}`,
    `- Applicant DOB: ${booking.applicantDob}`,
    '',
    '2) REPRESENTATIVE DETAILS',
    `- Representative Name: ${booking.fillerName}`,
    `- Representative Phone: ${booking.fillerPhone}`,
    `- Representative Email: ${booking.fillerEmail}`,
    `- Relationship to Applicant: ${formatRelationship(booking.relationshipToApplicant)}`,
    '',
    '3) SERVICE & SLOT DETAILS',
    `- Application Type: ${formatApplicationType(booking.applicationType)}`,
    `- Chosen Slot Date: ${slotDate}`,
    `- Chosen Time Window: ${booking.chosenTimeWindow || '-'}`,
    '',
    '4) DOCUMENTS SUBMITTED',
    ...(docs.length ? docs.map((doc) => `- ${doc}`) : ['- No documents marked']),
    '',
    '5) CORRECTION REQUEST DETAILS',
    ...(corrections.length ? corrections.map((entry) => `- ${entry}`) : ['- No correction entries']),
    '',
    '6) ADMIN NOTES',
    `- Client Note: ${notes.clientNote || '-'}`,
    `- Admin Remark: ${params.adminRemark.trim() || notes.adminRemark || '-'}`,
  ];

  return lines.join('\n');
}

function shellLayout(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Khan Admin</title>
  <style>
    :root {
      --sage: #3d6b56;
      --sage-dark: #2f5444;
      --bg: #f5f7fb;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --line: #e5e7eb;
      --amber: #f59e0b;
      --green: #10b981;
      --red: #ef4444;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 15% -10%, rgba(61, 107, 86, 0.15), transparent 30%),
        radial-gradient(circle at 90% 120%, rgba(245, 158, 11, 0.12), transparent 32%),
        var(--bg);
      min-height: 100vh;
    }

    .app { min-height: 100vh; }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
    }

    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--sage-dark); }
    .brand img { width: 38px; height: 38px; border-radius: 999px; background: #fff; padding: 4px; border: 1px solid var(--line); }
    .brand small { display:block; color: var(--muted); font-weight:600; font-size:11px; letter-spacing:0.04em; }

    .logout-btn {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 10px;
      padding: 8px 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .layout { display: block; }

    .sidebar {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.72);
      padding: 10px 12px;
      overflow-x: auto;
      white-space: nowrap;
    }

    .side-list {
      display: inline-flex;
      gap: 6px;
      min-width: max-content;
      padding: 4px;
      border-radius: 12px;
      background: rgba(148, 163, 184, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.24);
    }
    .side-link {
      display: inline-block;
      border: 1px solid var(--line);
      color: var(--text);
      text-decoration: none;
      padding: 9px 12px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
      min-height: 40px;
      transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
    }

    .side-link:hover {
      border-color: #cbd5e1;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
      transform: translateY(-1px);
    }

    .side-link.active { background: var(--sage); color: #fff; border-color: var(--sage); }

    .content { padding: 16px; max-width: 1200px; width: 100%; margin: 0 auto; }

    .section-title {
      margin: 0 0 8px;
      color: var(--sage);
      text-transform: uppercase;
      letter-spacing: .12em;
      font-size: 11px;
      font-weight: 700;
    }

    .headline { margin: 0 0 8px; font-size: 22px; line-height: 1.25; letter-spacing: -0.01em; }
    .subtle { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; max-width: 72ch; }

    .cards {
      margin-top: 16px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.05);
    }

    .metric { font-size: 28px; font-weight: 800; margin: 6px 0 0; }
    .label { color: var(--muted); font-size: 13px; }

    .chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 5px 9px; border-radius: 999px; margin-top: 8px; }
    .chip.green { background: #ecfdf5; color: #065f46; }
    .chip.amber { background: #fffbeb; color: #92400e; }
    .chip.red { background: #fef2f2; color: #991b1b; }

    .panel {
      margin-top: 14px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 8px 20px rgba(31, 41, 55, 0.04);
    }

    .panel h3 { margin: 0 0 10px; font-size: 15px; letter-spacing: -0.01em; }
    .panel p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }

    .form-grid { display: grid; gap: 10px; }
    .field-label { font-size: 12px; font-weight: 700; color: var(--muted); }
    .input, .select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      min-height: 42px;
      background: #fff;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .input:focus, .select:focus {
      border-color: var(--sage);
      box-shadow: 0 0 0 3px rgba(61, 107, 86, 0.12);
      outline: none;
    }
    .btn {
      border: 0;
      border-radius: 10px;
      padding: 9px 12px;
      font-size: 13px;
      font-weight: 700;
      min-height: 40px;
      cursor: pointer;
    }
    .btn-primary { background: var(--sage); color: #fff; }
    .btn-muted { background: #fff; color: var(--text); border: 1px solid var(--line); }
    .btn-danger { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
    .btn-success { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }

    .notice {
      margin: 0 0 12px;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 600;
    }
    .notice.ok { background: #ecfdf5; color: #065f46; border: 1px solid #bbf7d0; }
    .notice.err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }

    table { width: 100%; border-collapse: separate; border-spacing: 0; background: #fff; }
    th, td {
      text-align: left;
      padding: 11px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 13px;
    }
    th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      position: sticky;
      top: 0;
      background: #f8fafc;
      z-index: 1;
    }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; max-height: min(64vh, 680px); }
    .desktop-table { display: none; }

    .mobile-cards {
      display: grid;
      gap: 10px;
    }

    .mobile-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: #fff;
      display: grid;
      gap: 7px;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.05);
    }

    .mobile-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .mobile-meta-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .mobile-meta-row .meta strong {
      color: var(--text);
      display: block;
      font-size: 12px;
      margin-bottom: 2px;
    }
    .row-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta { color: var(--muted); font-size: 12px; }
    .pager { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .pager a { text-decoration: none; }

    .drawer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      top: auto;
      width: 100vw;
      height: 92vh;
      background: #f9fbfa;
      border-top: 1px solid var(--line);
      box-shadow: 0 -10px 26px rgba(0, 0, 0, 0.12);
      border-radius: 18px 18px 0 0;
      z-index: 40;
      overflow-y: auto;
    }
    .drawer-header {
      position: sticky;
      top: 0;
      background: #fff;
      border-bottom: 1px solid var(--line);
      padding: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .drawer-header::before {
      content: '';
      position: absolute;
      top: 6px;
      left: 50%;
      transform: translateX(-50%);
      width: 44px;
      height: 4px;
      border-radius: 999px;
      background: #cbd5e1;
    }
    .drawer-body { padding: 14px; display: grid; gap: 12px; }
    .drawer-card { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background:#fff; }
    .drawer-card h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
    .drawer-card > div { margin-top: 6px; line-height: 1.45; }
    .drawer-card pre {
      white-space: pre-wrap;
      margin: 6px 0 0;
      padding: 8px;
      font-size: 12px;
      border-radius: 8px;
      background: #f8fafc;
      border: 1px solid #e5e7eb;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .inline-form { display: flex; flex-wrap: wrap; gap: 8px; }
    .truncate {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: bottom;
    }
    .ref-text {
      max-width: 170px;
      font-weight: 700;
    }
    .name-text {
      max-width: 180px;
    }

    @media (max-width: 412px) {
      .topbar {
        gap: 8px;
        align-items: flex-start;
      }
      .logout-btn {
        white-space: nowrap;
      }
      .side-link {
        padding: 8px 10px;
        font-size: 12px;
      }
      .ref-text { max-width: 140px; }
      .name-text { max-width: 150px; }
      .btn {
        white-space: nowrap;
      }
      .inline-form {
        gap: 6px;
      }
    }

    @media (max-width: 390px) {
      .brand > div {
        max-width: 170px;
      }
      .brand small {
        letter-spacing: 0.02em;
      }
      .side-list {
        gap: 6px;
      }
      .side-link {
        padding: 7px 9px;
        border-radius: 9px;
        font-size: 11px;
      }
      .ref-text { max-width: 120px; }
      .name-text { max-width: 130px; }
      .pager {
        gap: 6px;
      }
      .pager .btn {
        padding: 7px 9px;
      }
    }

    @media (max-width: 360px) {
      .topbar { padding: 12px; }
      .brand img { width: 34px; height: 34px; }
      .brand { gap: 8px; }
      .brand > div { font-size: 14px; }
      .brand small { font-size: 10px; }

      .content { padding: 12px; }
      .section-title { font-size: 10px; }
      .headline { font-size: 20px; margin-bottom: 6px; }
      .subtle { font-size: 13px; }

      .card, .panel { padding: 12px; border-radius: 12px; }
      .metric { font-size: 24px; }
      .label, .meta { font-size: 12px; }
      .ref-text { max-width: 104px; }
      .name-text { max-width: 114px; }

      .input, .select { padding: 9px 10px; font-size: 13px; }
      .btn { padding: 8px 10px; font-size: 12px; }
      .logout-btn { padding: 7px 10px; font-size: 12px; }

      th, td { padding: 9px 8px; font-size: 12px; }
      th { font-size: 10px; }

      .drawer-header { padding: 12px; }
      .drawer-body { padding: 12px; gap: 10px; }
      .drawer-card { padding: 10px; }
      .drawer-card pre { font-size: 11px; }
    }

    @media (min-width: 1024px) {
      .content.has-drawer { padding-right: 500px; }
      .layout {
        display: grid;
        grid-template-columns: 260px 1fr;
        min-height: calc(100vh - 61px);
      }
      .topbar { padding: 14px 24px; }
      .sidebar {
        border-bottom: none;
        border-right: 1px solid var(--line);
        padding: 16px;
      }
      .side-list { display: grid; gap: 8px; }
      .side-link { display: block; }
      .content { padding: 22px 24px; }
      .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .form-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .field-span-2 { grid-column: span 2; }
      .field-span-4 { grid-column: span 4; }
      .headline { font-size: 28px; }
      .subtle { font-size: 14px; }
      .panel h3 { font-size: 16px; }

      .drawer {
        top: 0;
        right: 0;
        left: auto;
        width: min(100vw, 480px);
        height: 100vh;
        border-top: none;
        border-left: 1px solid var(--line);
        border-radius: 0;
        box-shadow: -12px 0 24px rgba(0, 0, 0, 0.08);
      }
    }

    @media (min-width: 768px) {
      .desktop-table { display: block; }
      .mobile-cards { display: none; }
    }
  </style>
</head>
<body>
  ${content}
  <script>
    (() => {
      const cookieName = 'admin_csrf=';
      const cookieValue = document.cookie
        .split(';')
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(cookieName));

      if (!cookieValue) return;

      const token = decodeURIComponent(cookieValue.slice(cookieName.length));
      if (!token) return;

      const forms = document.querySelectorAll('form[method="POST"], form[method="post"]');
      forms.forEach((form) => {
        const existing = form.querySelector('input[name="_csrf"]');
        if (existing) {
          existing.value = token;
          return;
        }

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = '_csrf';
        input.value = token;
        form.appendChild(input);
      });
    })();
  </script>
</body>
</html>`;
}

function adminScaffold(activeNav: AdminNavKey, bodyHtml: string): string {
  return shellLayout(`
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <img src="/icon.svg" alt="Khan" />
        <div>Khan Consultants Admin<small>Birth Certificate Operations</small></div>
      </div>
      <form method="POST" action="/admin/logout">
        <button class="logout-btn" type="submit">Logout</button>
      </form>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <nav class="side-list">
          ${navLink('Overview', '/admin', 'overview', activeNav)}
          ${navLink('Slot Management', '/admin/slots', 'slots', activeNav)}
          ${navLink('Birth Bookings', '/admin/bookings', 'bookings', activeNav)}
          ${navLink('Contact Enquiries', '/admin/contacts', 'contacts', activeNav)}
          ${navLink('Service Enquiries', '/admin/services', 'services', activeNav)}
          ${navLink('Case Summary Builder', '/admin/case-summary', 'summary', activeNav)}
          ${navLink('Settings', '/admin/settings', 'settings', activeNav)}
        </nav>
      </aside>

      <main class="content">
        ${bodyHtml}
      </main>
    </div>
  </div>`);
}

function loginPage(hasError: boolean): string {
  return shellLayout(`
  <main class="app" style="display:grid; place-items:center; padding:16px;">
    <section style="width:min(100%,420px); border:1px solid var(--line); border-radius:16px; background:#fff; box-shadow:0 16px 34px rgba(0,0,0,0.08); overflow:hidden;">
      <div style="padding:16px 16px 12px; background:linear-gradient(135deg,var(--sage),#2f5b49); color:#fff;">
        <div class="brand" style="color:#fff;">
          <img src="/icon.svg" alt="Khan" />
          <div>Khan Consultants<small style="color:#d1fae5">Secure Admin Access</small></div>
        </div>
      </div>
      <form method="POST" action="/admin/login" style="padding:16px; display:grid; gap:10px;">
        <label style="font-size:13px; font-weight:700; color:var(--text);">Admin Password</label>
        <input name="password" type="password" required placeholder="Enter password" style="width:100%; border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; outline:none;" />
        ${hasError ? '<div style="background:#fef2f2; color:#991b1b; border:1px solid #fecaca; padding:9px 10px; border-radius:10px; font-size:13px;">Invalid password. Please try again.</div>' : ''}
        <button type="submit" style="margin-top:4px; background:var(--sage); color:#fff; border:0; border-radius:10px; padding:10px 12px; font-size:14px; font-weight:700; cursor:pointer;">Login to Admin</button>
      </form>
    </section>
  </main>`);
}

function dashboardPage(metrics: {
  bookings: number;
  contacts: number;
  serviceEnquiries: number;
  activeSlots: number;
  confirmed: number;
}): string {
  return adminScaffold('overview', `
    <p class="section-title">Dashboard</p>
    <h1 class="headline">Daily Operations Overview</h1>
    <p class="subtle">Track bookings, enquiries and slot availability for the Birth Certificate service.</p>

    <section class="cards">
      <article class="card">
        <span class="label">Total Birth Bookings</span>
        <p class="metric">${metrics.bookings}</p>
      </article>
      <article class="card">
        <span class="label">Total Contact Enquiries</span>
        <p class="metric">${metrics.contacts}</p>
      </article>
      <article class="card">
        <span class="label">Total Service Enquiries</span>
        <p class="metric">${metrics.serviceEnquiries}</p>
      </article>
      <article class="card">
        <span class="label">Active Slots</span>
        <p class="metric">${metrics.activeSlots}</p>
      </article>
    </section>

    <section class="cards" style="margin-top:10px;">
      <article class="card">
        <span class="label">Confirmed</span>
        <p class="metric">${metrics.confirmed}</p>
        <span class="chip green">confirmed</span>
      </article>
    </section>
  `);
}

function slotManagementPage(params: {
  slots: Array<{
    id: string;
    slotDate: Date;
    timeWindow: string;
    maxSlots: number;
    isActive: boolean;
    bookedCount: number;
  }>;
  okMessage?: string;
  errorMessage?: string;
}): string {
  const rows = params.slots.map((slot) => {
    const dateValue = slot.slotDate.toISOString().slice(0, 10);
    const statusChip = slot.isActive ? '<span class="chip green" style="margin-top:0;">Active</span>' : '<span class="chip red" style="margin-top:0;">Disabled</span>';

    return `
      <tr>
        <td>
          <div><strong>${dateValue}</strong></div>
          <div class="meta">Booked: ${slot.bookedCount}</div>
        </td>
        <td>${escapeHtml(slot.timeWindow)}</td>
        <td>${slot.maxSlots}</td>
        <td>${statusChip}</td>
        <td>
          <form method="POST" action="/admin/slots/${slot.id}/update" class="form-grid" style="grid-template-columns:1fr; gap:8px;">
            <input class="input" type="date" name="slotDate" value="${dateValue}" required />
            <input class="input" type="text" name="timeWindow" value="${escapeHtml(slot.timeWindow)}" required maxlength="64" />
            <input class="input" type="number" name="maxSlots" min="0" value="${slot.maxSlots}" required />
            <button class="btn btn-primary" type="submit">Save</button>
          </form>
          <form method="POST" action="/admin/slots/${slot.id}/delete" style="margin-top:8px;" onsubmit="return confirm('Delete this slot permanently? This cannot be undone.');">
            <button class="btn btn-danger" type="submit">Delete Permanently</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  return adminScaffold('slots', `
    <p class="section-title">Slot Management</p>
    <h1 class="headline">Manage Slot Dates, Time & Capacity</h1>
    <p class="subtle">Create, update and permanently delete appointment slots. Capacity cannot be reduced below already booked count.</p>

    ${params.okMessage ? `<div class="notice ok">${escapeHtml(params.okMessage)}</div>` : ''}
    ${params.errorMessage ? `<div class="notice err">${escapeHtml(params.errorMessage)}</div>` : ''}

    <section class="panel" style="margin-top:12px;">
      <h3>Add New Slot</h3>
      <form method="POST" action="/admin/slots/create" class="form-grid" style="margin-top:10px;">
        <div>
          <label class="field-label">Slot Date</label>
          <input class="input" type="date" name="slotDate" required />
        </div>
        <div class="field-span-2">
          <label class="field-label">Time Window</label>
          <input class="input" type="text" name="timeWindow" placeholder="9:20 AM - 9:50 AM" maxlength="64" required />
        </div>
        <div>
          <label class="field-label">Max Capacity</label>
          <input class="input" type="number" name="maxSlots" min="0" value="10" required />
        </div>
        <div class="field-span-4">
          <button class="btn btn-primary" type="submit">Add Slot</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h3>Existing Slots</h3>
      <div class="table-wrap" style="margin-top:8px;">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Time Window</th>
              <th>Capacity</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5" class="meta">No slots found. Add your first slot above.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `);
}

function bookingsPage(params: {
  rows: Array<{
    id: string;
    bookingReference: string;
    status: string;
    applicantName: string;
    applicantPhone: string;
    fillerName: string;
    chosenSlotDate: Date | null;
    createdAt: Date;
    notes: string | null;
    applicantEmail: string;
    fillerPhone: string;
    fillerEmail: string;
    relationshipToApplicant: string;
    applicationType: string;
    documentsSelected: Prisma.JsonValue;
    correctionEntries: Prisma.JsonValue;
  }>;
  total: number;
  page: number;
  pageSize: number;
  q: string;
  from: string;
  to: string;
  openId?: string;
  okMessage?: string;
  errorMessage?: string;
}): string {
  const totalPages = Math.max(1, Math.ceil(params.total / params.pageSize));
  const rowStart = (params.page - 1) * params.pageSize + 1;
  const rowEnd = Math.min(params.total, params.page * params.pageSize);

  const queryBase = new URLSearchParams();
  if (params.q) queryBase.set('q', params.q);
  if (params.from) queryBase.set('from', params.from);
  if (params.to) queryBase.set('to', params.to);

  const selected = params.openId ? params.rows.find((row) => row.id === params.openId) : undefined;
  const selectedNotes = selected ? extractAdminRemark(selected.notes) : null;
  const selectedDocumentLines = selected ? documentChecklistFromJson(selected.documentsSelected) : [];
  const selectedCorrectionLines = selected ? correctionSummaryFromJson(selected.correctionEntries) : [];
  const selectedDocumentsText = selectedDocumentLines.length
    ? `• ${selectedDocumentLines.join('\n• ')}`
    : 'No documents selected';
  const selectedCorrectionsText = selectedCorrectionLines.length
    ? `• ${selectedCorrectionLines.join('\n• ')}`
    : 'No correction entries';

  const rowsHtml = params.rows.map((row) => {
    const dateLabel = row.chosenSlotDate ? row.chosenSlotDate.toISOString().slice(0, 10) : '-';
    const openQuery = new URLSearchParams(queryBase);
    openQuery.set('page', String(params.page));
    openQuery.set('open', row.id);
    const openHref = `/admin/bookings?${openQuery.toString()}`;

    return `
      <tr>
        <td><strong class="truncate ref-text" title="${escapeHtml(row.bookingReference)}">${escapeHtml(row.bookingReference)}</strong></td>
        <td><span class="truncate name-text" title="${escapeHtml(row.applicantName)}">${escapeHtml(row.applicantName)}</span><div class="meta">${escapeHtml(row.applicantPhone)}</div></td>
        <td>${escapeHtml(formatApplicationType(row.applicationType))}</td>
        <td>${escapeHtml(formatBookingStatusLabel(row.status))}</td>
        <td>${dateLabel}</td>
        <td>${row.createdAt.toISOString().slice(0, 10)}</td>
        <td>
          <a class="btn btn-muted" href="${openHref}">View</a>
        </td>
      </tr>
    `;
  }).join('');

  const mobileCardsHtml = params.rows.map((row) => {
    const dateLabel = row.chosenSlotDate ? row.chosenSlotDate.toISOString().slice(0, 10) : '-';
    const openQuery = new URLSearchParams(queryBase);
    openQuery.set('page', String(params.page));
    openQuery.set('open', row.id);
    const openHref = `/admin/bookings?${openQuery.toString()}`;

    return `
      <article class="mobile-card">
        <div class="mobile-head">
          <strong class="truncate ref-text" title="${escapeHtml(row.bookingReference)}">${escapeHtml(row.bookingReference)}</strong>
          <span class="chip green" style="margin-top:0;">${escapeHtml(formatBookingStatusLabel(row.status))}</span>
        </div>
        <div class="meta"><strong>${escapeHtml(row.applicantName)}</strong>${escapeHtml(row.applicantPhone)}</div>
        <div class="mobile-meta-row">
          <div class="meta"><strong>Type</strong>${escapeHtml(formatApplicationType(row.applicationType))}</div>
          <div class="meta"><strong>Slot</strong>${dateLabel}</div>
        </div>
        <a class="btn btn-muted" href="${openHref}" style="text-decoration:none; text-align:center;">View</a>
      </article>
    `;
  }).join('');

  const prevQuery = new URLSearchParams(queryBase);
  prevQuery.set('page', String(Math.max(1, params.page - 1)));
  const nextQuery = new URLSearchParams(queryBase);
  nextQuery.set('page', String(Math.min(totalPages, params.page + 1)));
  const exportQuery = new URLSearchParams(queryBase);
  exportQuery.set('export', 'csv');

  return adminScaffold('bookings', `
    <div class="${selected ? 'has-drawer' : ''}">
      <p class="section-title">Birth Bookings</p>
      <h1 class="headline">Birth Certificate Bookings</h1>
      <p class="subtle">Search quickly, review case details and update internal remarks.</p>

      ${params.okMessage ? `<div class="notice ok">${escapeHtml(params.okMessage)}</div>` : ''}
      ${params.errorMessage ? `<div class="notice err">${escapeHtml(params.errorMessage)}</div>` : ''}

      <section class="panel" style="margin-top:12px;">
        <h3>Filters</h3>
        <form method="GET" action="/admin/bookings" class="form-grid" style="margin-top:10px;">
          <div class="field-span-2">
            <label class="field-label">Search</label>
            <input class="input" name="q" value="${escapeHtml(params.q)}" placeholder="Name / phone / reference" />
          </div>
          <div>
            <label class="field-label">From date</label>
            <input class="input" type="date" name="from" value="${escapeHtml(params.from)}" />
          </div>
          <div>
            <label class="field-label">To date</label>
            <input class="input" type="date" name="to" value="${escapeHtml(params.to)}" />
          </div>
          <div class="field-span-4 inline-form">
            <button class="btn btn-primary" type="submit">Apply Filters</button>
            <a class="btn btn-muted" href="/admin/bookings" style="text-decoration:none;">Reset</a>
            <a class="btn btn-muted" href="/admin/bookings?${exportQuery.toString()}" style="text-decoration:none;">Export CSV</a>
          </div>
        </form>
      </section>

      <section class="panel">
        <h3>Bookings (${params.total})</h3>
        <div class="meta" style="margin-bottom:10px;">
          ${params.total === 0 ? 'No records found.' : `Showing ${rowStart}-${rowEnd} of ${params.total}`}
        </div>
        <div class="mobile-cards">
          ${mobileCardsHtml || '<div class="meta">No bookings match current filters.</div>'}
        </div>

        <div class="table-wrap desktop-table">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Applicant</th>
                <th>Type</th>
                <th>Status</th>
                <th>Slot Date</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="7" class="meta">No bookings match current filters.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="pager">
          <a class="btn btn-muted" href="/admin/bookings?${prevQuery.toString()}">Previous</a>
          <span class="meta">Page ${params.page} / ${totalPages}</span>
          <a class="btn btn-muted" href="/admin/bookings?${nextQuery.toString()}">Next</a>
        </div>
      </section>
    </div>

    ${selected ? `
      <aside class="drawer">
        <div class="drawer-header">
          <strong class="truncate" style="max-width:70%;" title="${escapeHtml(selected.bookingReference)}">${escapeHtml(selected.bookingReference)}</strong>
          <a class="btn btn-muted" href="/admin/bookings?${queryBase.toString()}" style="text-decoration:none;">Close</a>
        </div>
        <div class="drawer-body">
          <div class="drawer-card">
            <h4>Client Details</h4>
            <div><strong>Applicant:</strong> ${escapeHtml(selected.applicantName)}</div>
            <div><strong>Phone:</strong> ${escapeHtml(selected.applicantPhone)}</div>
            <div><strong>Email:</strong> ${escapeHtml(selected.applicantEmail)}</div>
            <div><strong>Representative:</strong> ${escapeHtml(selected.fillerName)} (${escapeHtml(formatRelationship(selected.relationshipToApplicant))})</div>
            <div><strong>Representative Phone:</strong> ${escapeHtml(selected.fillerPhone)}</div>
            <div><strong>Representative Email:</strong> ${escapeHtml(selected.fillerEmail)}</div>
          </div>

          <div class="drawer-card">
            <h4>Application</h4>
            <div><strong>Type:</strong> ${escapeHtml(formatApplicationType(selected.applicationType))}</div>
            <div><strong>Slot Date:</strong> ${selected.chosenSlotDate ? selected.chosenSlotDate.toISOString().slice(0, 10) : '-'}</div>
            <div><strong>Documents:</strong>
              <pre>${escapeHtml(selectedDocumentsText)}</pre>
            </div>
            <div><strong>Corrections:</strong>
              <pre>${escapeHtml(selectedCorrectionsText)}</pre>
            </div>
          </div>

          <div class="drawer-card">
            <h4>Status & Remark</h4>
            <form method="POST" action="/admin/bookings/${selected.id}/update" class="form-grid" style="grid-template-columns:1fr;">
              <input type="hidden" name="clientNote" value="${escapeHtml(selectedNotes?.clientNote || '')}" />
              <input type="hidden" name="status" value="confirmed" />
              <div><strong>Status:</strong> Confirmed</div>
              <label class="field-label">Internal Remark</label>
              <textarea class="input" name="adminRemark" rows="4" placeholder="Add internal remark">${escapeHtml(selectedNotes?.adminRemark || '')}</textarea>
              <button class="btn btn-primary" type="submit">Update Booking</button>
            </form>
            <form method="POST" action="/admin/bookings/${selected.id}/delete" style="margin-top:10px;" onsubmit="return confirm('Delete this booking permanently? This cannot be undone.');">
              <button class="btn btn-danger" type="submit">Delete Booking</button>
            </form>
          </div>
        </div>
      </aside>
    ` : ''}
  `);
}

function contactsPage(params: {
  rows: Array<{
    id: string;
    contactReference: string;
    fullName: string;
    email: string;
    phone: string;
    serviceType: string | null;
    preferredContact: string | null;
    message: string;
    status: string;
    internalRemark: string | null;
    createdAt: Date;
  }>;
  total: number;
  page: number;
  pageSize: number;
  q: string;
  status: string;
  from: string;
  to: string;
  openId?: string;
  okMessage?: string;
  errorMessage?: string;
}): string {
  const totalPages = Math.max(1, Math.ceil(params.total / params.pageSize));
  const rowStart = (params.page - 1) * params.pageSize + 1;
  const rowEnd = Math.min(params.total, params.page * params.pageSize);

  const queryBase = new URLSearchParams();
  if (params.q) queryBase.set('q', params.q);
  if (params.status) queryBase.set('status', params.status);
  if (params.from) queryBase.set('from', params.from);
  if (params.to) queryBase.set('to', params.to);

  const selected = params.openId ? params.rows.find((row) => row.id === params.openId) : undefined;

  const rowsHtml = params.rows.map((row) => {
    const openQuery = new URLSearchParams(queryBase);
    openQuery.set('page', String(params.page));
    openQuery.set('open', row.id);
    const openHref = `/admin/contacts?${openQuery.toString()}`;

    return `
      <tr>
        <td><strong class="truncate ref-text" title="${escapeHtml(row.contactReference)}">${escapeHtml(row.contactReference)}</strong></td>
        <td><span class="truncate name-text" title="${escapeHtml(row.fullName)}">${escapeHtml(row.fullName)}</span><div class="meta">${escapeHtml(row.phone)}</div></td>
        <td>${escapeHtml(row.serviceType || '-')}</td>
        <td>${escapeHtml(formatContactStatusLabel(row.status))}</td>
        <td>${row.createdAt.toISOString().slice(0, 10)}</td>
        <td><a class="btn btn-muted" href="${openHref}">View</a></td>
      </tr>
    `;
  }).join('');

  const mobileCardsHtml = params.rows.map((row) => {
    const openQuery = new URLSearchParams(queryBase);
    openQuery.set('page', String(params.page));
    openQuery.set('open', row.id);
    const openHref = `/admin/contacts?${openQuery.toString()}`;

    return `
      <article class="mobile-card">
        <div class="mobile-head">
          <strong class="truncate ref-text" title="${escapeHtml(row.contactReference)}">${escapeHtml(row.contactReference)}</strong>
          <span class="chip ${row.status === 'closed' ? 'red' : row.status === 'contacted' ? 'amber' : 'green'}" style="margin-top:0;">${escapeHtml(formatContactStatusLabel(row.status))}</span>
        </div>
        <div class="meta"><strong>${escapeHtml(row.fullName)}</strong>${escapeHtml(row.phone)}</div>
        <div class="mobile-meta-row">
          <div class="meta"><strong>Service</strong>${escapeHtml(row.serviceType || '-')}</div>
          <div class="meta"><strong>Date</strong>${row.createdAt.toISOString().slice(0, 10)}</div>
        </div>
        <a class="btn btn-muted" href="${openHref}" style="text-decoration:none; text-align:center;">View</a>
      </article>
    `;
  }).join('');

  const prevQuery = new URLSearchParams(queryBase);
  prevQuery.set('page', String(Math.max(1, params.page - 1)));
  const nextQuery = new URLSearchParams(queryBase);
  nextQuery.set('page', String(Math.min(totalPages, params.page + 1)));
  const exportQuery = new URLSearchParams(queryBase);
  exportQuery.set('export', 'csv');

  return adminScaffold('contacts', `
    <div class="${selected ? 'has-drawer' : ''}">
      <p class="section-title">Contact Enquiries</p>
      <h1 class="headline">Client Enquiries</h1>
      <p class="subtle">Review enquiries, update follow-up progress and keep internal remarks in one place.</p>

      ${params.okMessage ? `<div class="notice ok">${escapeHtml(params.okMessage)}</div>` : ''}
      ${params.errorMessage ? `<div class="notice err">${escapeHtml(params.errorMessage)}</div>` : ''}

      <section class="panel" style="margin-top:12px;">
        <h3>Filters</h3>
        <form method="GET" action="/admin/contacts" class="form-grid" style="margin-top:10px;">
          <div class="field-span-2">
            <label class="field-label">Search</label>
            <input class="input" name="q" value="${escapeHtml(params.q)}" placeholder="Name / phone / reference / email" />
          </div>
          <div>
            <label class="field-label">Status</label>
            <select class="select" name="status">
              <option value="">All</option>
              <option value="new" ${params.status === 'new' ? 'selected' : ''}>new</option>
              <option value="contacted" ${params.status === 'contacted' ? 'selected' : ''}>contacted</option>
              <option value="closed" ${params.status === 'closed' ? 'selected' : ''}>closed</option>
            </select>
          </div>
          <div>
            <label class="field-label">From date</label>
            <input class="input" type="date" name="from" value="${escapeHtml(params.from)}" />
          </div>
          <div>
            <label class="field-label">To date</label>
            <input class="input" type="date" name="to" value="${escapeHtml(params.to)}" />
          </div>
          <div class="field-span-4 inline-form">
            <button class="btn btn-primary" type="submit">Apply Filters</button>
            <a class="btn btn-muted" href="/admin/contacts" style="text-decoration:none;">Reset</a>
            <a class="btn btn-muted" href="/admin/contacts?${exportQuery.toString()}" style="text-decoration:none;">Export CSV</a>
          </div>
        </form>
      </section>

      <section class="panel">
        <h3>Enquiries (${params.total})</h3>
        <div class="meta" style="margin-bottom:10px;">
          ${params.total === 0 ? 'No records found.' : `Showing ${rowStart}-${rowEnd} of ${params.total}`}
        </div>
        <div class="mobile-cards">
          ${mobileCardsHtml || '<div class="meta">No enquiries match current filters.</div>'}
        </div>

        <div class="table-wrap desktop-table">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Client</th>
                <th>Service</th>
                <th>Status</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="6" class="meta">No enquiries match current filters.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="pager">
          <a class="btn btn-muted" href="/admin/contacts?${prevQuery.toString()}">Previous</a>
          <span class="meta">Page ${params.page} / ${totalPages}</span>
          <a class="btn btn-muted" href="/admin/contacts?${nextQuery.toString()}">Next</a>
        </div>
      </section>
    </div>

    ${selected ? `
      <aside class="drawer">
        <div class="drawer-header">
          <strong class="truncate" style="max-width:70%;" title="${escapeHtml(selected.contactReference)}">${escapeHtml(selected.contactReference)}</strong>
          <a class="btn btn-muted" href="/admin/contacts?${queryBase.toString()}" style="text-decoration:none;">Close</a>
        </div>
        <div class="drawer-body">
          <div class="drawer-card">
            <h4>Client Details</h4>
            <div><strong>Name:</strong> ${escapeHtml(selected.fullName)}</div>
            <div><strong>Phone:</strong> ${escapeHtml(selected.phone)}</div>
            <div><strong>Email:</strong> ${escapeHtml(selected.email)}</div>
            <div><strong>Service:</strong> ${escapeHtml(selected.serviceType || '-')}</div>
            <div><strong>Preferred Contact:</strong> ${escapeHtml(selected.preferredContact || '-')}</div>
          </div>

          <div class="drawer-card">
            <h4>Message</h4>
            <pre style="white-space:pre-wrap; margin:0; font-size:12px;">${escapeHtml(selected.message)}</pre>
          </div>

          <div class="drawer-card">
            <h4>Status & Remark</h4>
            <form method="POST" action="/admin/contacts/${selected.id}/update" class="form-grid" style="grid-template-columns:1fr;">
              <label class="field-label">Status</label>
              <select class="select" name="status">
                <option value="new" ${selected.status === 'new' ? 'selected' : ''}>New</option>
                <option value="contacted" ${selected.status === 'contacted' ? 'selected' : ''}>Contacted</option>
                <option value="closed" ${selected.status === 'closed' ? 'selected' : ''}>Closed</option>
              </select>
              <label class="field-label">Internal Remark</label>
              <textarea class="input" name="internalRemark" rows="4" placeholder="Add internal remark">${escapeHtml(selected.internalRemark || '')}</textarea>
              <button class="btn btn-primary" type="submit">Update Enquiry</button>
            </form>
            <form method="POST" action="/admin/contacts/${selected.id}/delete" style="margin-top:10px;" onsubmit="return confirm('Delete this enquiry permanently? This cannot be undone.');">
              <button class="btn btn-danger" type="submit">Delete Enquiry</button>
            </form>
          </div>
        </div>
      </aside>
    ` : ''}
  `);
}

function serviceEnquiriesPage(params: {
  rows: Array<{
    id: string;
    enquiryReference: string;
    serviceType: string;
    subServiceType: string | null;
    fullName: string;
    designation: string | null;
    officialBusinessName: string;
    phone: string;
    email: string;
    alternateNumber: string | null;
    businessAddress: string;
    preferredCommunication: string;
    additionalNotes: string;
    status: string;
    internalRemark: string | null;
    formPayload: Prisma.JsonValue;
    createdAt: Date;
  }>;
  total: number;
  page: number;
  pageSize: number;
  q: string;
  status: string;
  serviceType: string;
  from: string;
  to: string;
  openId?: string;
  okMessage?: string;
  errorMessage?: string;
}): string {
  const totalPages = Math.max(1, Math.ceil(params.total / params.pageSize));
  const rowStart = (params.page - 1) * params.pageSize + 1;
  const rowEnd = Math.min(params.total, params.page * params.pageSize);

  const queryBase = new URLSearchParams();
  if (params.q) queryBase.set('q', params.q);
  if (params.status) queryBase.set('status', params.status);
  if (params.serviceType) queryBase.set('serviceType', params.serviceType);
  if (params.from) queryBase.set('from', params.from);
  if (params.to) queryBase.set('to', params.to);

  const selected = params.openId ? params.rows.find((row) => row.id === params.openId) : undefined;
  const serviceTypeOptionsHtml = SERVICE_TYPE_OPTIONS.map((option) => (
    `<option value="${option.value}" ${params.serviceType === option.value ? 'selected' : ''}>${option.label}</option>`
  )).join('');

  const rowsHtml = params.rows.map((row) => {
    const openQuery = new URLSearchParams(queryBase);
    openQuery.set('page', String(params.page));
    openQuery.set('open', row.id);
    const openHref = `/admin/services?${openQuery.toString()}`;

    return `
      <tr>
        <td><strong class="truncate ref-text" title="${escapeHtml(row.enquiryReference)}">${escapeHtml(row.enquiryReference)}</strong></td>
        <td><span class="truncate name-text" title="${escapeHtml(row.fullName)}">${escapeHtml(row.fullName)}</span><div class="meta">${escapeHtml(row.phone)}</div></td>
        <td>${escapeHtml(formatServiceTypeLabel(row.serviceType))}</td>
        <td>${escapeHtml(formatContactStatusLabel(row.status))}</td>
        <td>${row.createdAt.toISOString().slice(0, 10)}</td>
        <td><a class="btn btn-muted" href="${openHref}">View</a></td>
      </tr>
    `;
  }).join('');

  const mobileCardsHtml = params.rows.map((row) => {
    const openQuery = new URLSearchParams(queryBase);
    openQuery.set('page', String(params.page));
    openQuery.set('open', row.id);
    const openHref = `/admin/services?${openQuery.toString()}`;

    return `
      <article class="mobile-card">
        <div class="mobile-head">
          <strong class="truncate ref-text" title="${escapeHtml(row.enquiryReference)}">${escapeHtml(row.enquiryReference)}</strong>
          <span class="chip ${row.status === 'closed' ? 'red' : row.status === 'contacted' ? 'amber' : 'green'}" style="margin-top:0;">${escapeHtml(formatContactStatusLabel(row.status))}</span>
        </div>
        <div class="meta"><strong>${escapeHtml(row.fullName)}</strong>${escapeHtml(row.phone)}</div>
        <div class="mobile-meta-row">
          <div class="meta"><strong>Service</strong>${escapeHtml(formatServiceTypeLabel(row.serviceType))}</div>
          <div class="meta"><strong>Date</strong>${row.createdAt.toISOString().slice(0, 10)}</div>
        </div>
        <a class="btn btn-muted" href="${openHref}" style="text-decoration:none; text-align:center;">View</a>
      </article>
    `;
  }).join('');

  const prevQuery = new URLSearchParams(queryBase);
  prevQuery.set('page', String(Math.max(1, params.page - 1)));
  const nextQuery = new URLSearchParams(queryBase);
  nextQuery.set('page', String(Math.min(totalPages, params.page + 1)));
  const exportQuery = new URLSearchParams(queryBase);
  exportQuery.set('export', 'csv');

  return adminScaffold('services', `
    <div class="${selected ? 'has-drawer' : ''}">
      <p class="section-title">Service Enquiries</p>
      <h1 class="headline">Non-Birth Service Leads</h1>
      <p class="subtle">Review service enquiries, update follow-up status and keep internal notes in one place.</p>

      ${params.okMessage ? `<div class="notice ok">${escapeHtml(params.okMessage)}</div>` : ''}
      ${params.errorMessage ? `<div class="notice err">${escapeHtml(params.errorMessage)}</div>` : ''}

      <section class="panel" style="margin-top:12px;">
        <h3>Filters</h3>
        <form method="GET" action="/admin/services" class="form-grid" style="margin-top:10px;">
          <div class="field-span-2">
            <label class="field-label">Search</label>
            <input class="input" name="q" value="${escapeHtml(params.q)}" placeholder="Name / phone / reference / email / business" />
          </div>
          <div>
            <label class="field-label">Status</label>
            <select class="select" name="status">
              <option value="">All</option>
              <option value="new" ${params.status === 'new' ? 'selected' : ''}>new</option>
              <option value="contacted" ${params.status === 'contacted' ? 'selected' : ''}>contacted</option>
              <option value="closed" ${params.status === 'closed' ? 'selected' : ''}>closed</option>
            </select>
          </div>
          <div>
            <label class="field-label">Service Type</label>
            <select class="select" name="serviceType">
              <option value="">All</option>
              ${serviceTypeOptionsHtml}
            </select>
          </div>
          <div>
            <label class="field-label">From date</label>
            <input class="input" type="date" name="from" value="${escapeHtml(params.from)}" />
          </div>
          <div>
            <label class="field-label">To date</label>
            <input class="input" type="date" name="to" value="${escapeHtml(params.to)}" />
          </div>
          <div class="field-span-4 inline-form">
            <button class="btn btn-primary" type="submit">Apply Filters</button>
            <a class="btn btn-muted" href="/admin/services" style="text-decoration:none;">Reset</a>
            <a class="btn btn-muted" href="/admin/services?${exportQuery.toString()}" style="text-decoration:none;">Export CSV</a>
          </div>
        </form>
      </section>

      <section class="panel">
        <h3>Enquiries (${params.total})</h3>
        <div class="meta" style="margin-bottom:10px;">
          ${params.total === 0 ? 'No records found.' : `Showing ${rowStart}-${rowEnd} of ${params.total}`}
        </div>
        <div class="mobile-cards">
          ${mobileCardsHtml || '<div class="meta">No service enquiries match current filters.</div>'}
        </div>

        <div class="table-wrap desktop-table">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Client</th>
                <th>Service</th>
                <th>Status</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="6" class="meta">No service enquiries match current filters.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="pager">
          <a class="btn btn-muted" href="/admin/services?${prevQuery.toString()}">Previous</a>
          <span class="meta">Page ${params.page} / ${totalPages}</span>
          <a class="btn btn-muted" href="/admin/services?${nextQuery.toString()}">Next</a>
        </div>
      </section>
    </div>

    ${selected ? `
      <aside class="drawer">
        <div class="drawer-header">
          <strong class="truncate" style="max-width:70%;" title="${escapeHtml(selected.enquiryReference)}">${escapeHtml(selected.enquiryReference)}</strong>
          <a class="btn btn-muted" href="/admin/services?${queryBase.toString()}" style="text-decoration:none;">Close</a>
        </div>
        <div class="drawer-body">
          <div class="drawer-card">
            <h4>Status & Remark</h4>
            <form method="POST" action="/admin/services/${selected.id}/update" class="form-grid" style="grid-template-columns:1fr;">
              <label class="field-label">Status</label>
              <select class="select" name="status">
                <option value="new" ${selected.status === 'new' ? 'selected' : ''}>New</option>
                <option value="contacted" ${selected.status === 'contacted' ? 'selected' : ''}>Contacted</option>
                <option value="closed" ${selected.status === 'closed' ? 'selected' : ''}>Closed</option>
              </select>
              <label class="field-label">Internal Remark</label>
              <textarea class="input" name="internalRemark" rows="4" placeholder="Add internal remark">${escapeHtml(selected.internalRemark || '')}</textarea>
              <button class="btn btn-primary" type="submit">Update Enquiry</button>
            </form>
            <form method="POST" action="/admin/services/${selected.id}/delete" style="margin-top:10px;" onsubmit="return confirm('Delete this enquiry permanently? This cannot be undone.');">
              <button class="btn btn-danger" type="submit">Delete Enquiry</button>
            </form>
          </div>

          <div class="drawer-card">
            <h4>Client & Business Details</h4>
            <div><strong>Name:</strong> ${escapeHtml(selected.fullName)}</div>
            <div><strong>Designation:</strong> ${escapeHtml(selected.designation || '-')}</div>
            <div><strong>Business:</strong> ${escapeHtml(selected.officialBusinessName)}</div>
            <div><strong>Phone:</strong> ${escapeHtml(selected.phone)}</div>
            <div><strong>Email:</strong> ${escapeHtml(selected.email)}</div>
            <div><strong>Alternate:</strong> ${escapeHtml(selected.alternateNumber || '-')}</div>
            <div><strong>Address:</strong> ${escapeHtml(selected.businessAddress)}</div>
            <div><strong>Preferred Contact:</strong> ${escapeHtml(selected.preferredCommunication)}</div>
          </div>

          <div class="drawer-card">
            <h4>Service Details</h4>
            <div><strong>Service Type:</strong> ${escapeHtml(formatServiceTypeLabel(selected.serviceType))}</div>
            <div><strong>Sub Service:</strong> ${escapeHtml(selected.subServiceType || '-')}</div>
            <div><strong>Additional Notes:</strong>
              <pre style="white-space:pre-wrap; margin:0; font-size:12px;">${escapeHtml(selected.additionalNotes)}</pre>
            </div>
            <div><strong>Submitted Details:</strong>
              ${servicePayloadDetailsHtml(selected.serviceType, selected.formPayload)}
            </div>
          </div>
        </div>
      </aside>
    ` : ''}
  `);
}

function caseSummaryPage(params: {
  q: string;
  selectedBookingId: string;
  adminRemark: string;
  generatedSummary: string;
  results: Array<{
    id: string;
    bookingReference: string;
    applicantName: string;
    applicantPhone: string;
    createdAt: Date;
  }>;
  okMessage?: string;
  errorMessage?: string;
}): string {
  const rows = params.results.map((row) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    query.set('bookingId', row.id);
    if (params.adminRemark) query.set('adminRemark', params.adminRemark);

    return `
      <tr>
        <td><strong class="truncate ref-text" title="${escapeHtml(row.bookingReference)}">${escapeHtml(row.bookingReference)}</strong></td>
        <td><span class="truncate name-text" title="${escapeHtml(row.applicantName)}">${escapeHtml(row.applicantName)}</span></td>
        <td>${escapeHtml(row.applicantPhone)}</td>
        <td>${row.createdAt.toISOString().slice(0, 10)}</td>
        <td><a class="btn btn-muted" href="/admin/case-summary?${query.toString()}">Use</a></td>
      </tr>
    `;
  }).join('');

  return adminScaffold('summary', `
    <p class="section-title">Case Summary Builder</p>
    <h1 class="headline">Generate, Edit & Export Case Summary</h1>
    <p class="subtle">Create client-ready summaries from booking data, then copy or export as branded PDF.</p>

    ${params.okMessage ? `<div class="notice ok">${escapeHtml(params.okMessage)}</div>` : ''}
    ${params.errorMessage ? `<div class="notice err">${escapeHtml(params.errorMessage)}</div>` : ''}

    <section class="panel" style="margin-top:12px;">
      <h3>Select Booking</h3>
      <form method="GET" action="/admin/case-summary" class="form-grid" style="margin-top:10px;">
        <div class="field-span-2">
          <label class="field-label">Search Booking</label>
          <input class="input" name="q" value="${escapeHtml(params.q)}" placeholder="Reference / applicant name / phone" />
        </div>
        <div>
          <label class="field-label">Booking ID (optional)</label>
          <input class="input" name="bookingId" value="${escapeHtml(params.selectedBookingId)}" placeholder="Select from table below" />
        </div>
        <div class="field-span-2">
          <label class="field-label">Admin Remark</label>
          <input class="input" name="adminRemark" value="${escapeHtml(params.adminRemark)}" placeholder="Add note for this case summary" />
        </div>
        <div class="field-span-4 inline-form">
          <button class="btn btn-primary" type="submit">Generate Summary</button>
          <a class="btn btn-muted" href="/admin/case-summary" style="text-decoration:none;">Reset</a>
        </div>
      </form>
    </section>

    <section class="panel">
      <h3>Booking Search Results</h3>
      <div class="table-wrap" style="margin-top:8px;">
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Applicant</th>
              <th>Phone</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5" class="meta">No matching bookings found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h3>Editable Summary</h3>
      <div class="meta" style="margin-bottom:10px;">Auto-generated from applicant details and admin notes. You can edit before copying or downloading PDF.</div>
      <form method="POST" action="/admin/case-summary/pdf">
        <textarea id="caseSummaryText" class="input" name="summaryText" rows="22" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; line-height:1.55; border-radius:12px; background:#f8fafc;">${escapeHtml(params.generatedSummary)}</textarea>
        <input type="hidden" name="bookingId" value="${escapeHtml(params.selectedBookingId)}" />
        <div class="inline-form" style="margin-top:10px;">
          <button type="button" class="btn btn-muted" onclick="copyCaseSummary()">Copy to Clipboard</button>
          <button type="submit" class="btn btn-primary">Download Branded PDF</button>
        </div>
      </form>
    </section>

    <script>
      function copyCaseSummary() {
        const el = document.getElementById('caseSummaryText');
        if (!el) return;
        navigator.clipboard.writeText(el.value || '').then(() => {
          alert('Case summary copied to clipboard.');
        });
      }
    </script>
  `);
}

function settingsPage(params: {
  okMessage?: string;
  errorMessage?: string;
  sessionHours: number;
  nodeEnv: string;
  dbStatus: 'connected' | 'error';
  passwordMode: string;
  bookingFee: number;
  appointmentWindow: string;
}): string {
  return adminScaffold('settings', `
    <p class="section-title">Settings</p>
    <h1 class="headline">Admin Settings & Diagnostics</h1>
    <p class="subtle">Manage admin access and monitor basic runtime health for this backend.</p>

    ${params.okMessage ? `<div class="notice ok">${escapeHtml(params.okMessage)}</div>` : ''}
    ${params.errorMessage ? `<div class="notice err">${escapeHtml(params.errorMessage)}</div>` : ''}

    <section class="cards" style="margin-top:12px;">
      <article class="card">
        <span class="label">Session Timeout</span>
        <p class="metric">${params.sessionHours}h</p>
      </article>
      <article class="card">
        <span class="label">Node Environment</span>
        <p class="metric" style="font-size:20px;">${escapeHtml(params.nodeEnv)}</p>
      </article>
      <article class="card">
        <span class="label">Database Status</span>
        <p class="metric" style="font-size:20px;">${params.dbStatus === 'connected' ? 'Connected' : 'Error'}</p>
        <span class="chip ${params.dbStatus === 'connected' ? 'green' : 'red'}">${params.dbStatus}</span>
      </article>
    </section>

    <section class="panel">
      <h3>Booking Settings</h3>
      <p class="meta" style="margin-bottom:8px;">These values are used for booking fee display, Razorpay order amount, and default appointment window.</p>
      <form method="POST" action="/admin/settings/booking" class="form-grid" style="margin-top:10px;">
        <div>
          <label class="field-label">Booking Fee (INR)</label>
          <input class="input" type="number" name="bookingFee" min="1" max="100000" required value="${params.bookingFee}" />
        </div>
        <div>
          <label class="field-label">Appointment Window</label>
          <input class="input" type="text" name="appointmentWindow" maxlength="120" required value="${escapeHtml(params.appointmentWindow)}" />
        </div>
        <div class="field-span-4 inline-form">
          <button class="btn btn-primary" type="submit">Update Booking Settings</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h3>Admin Password (Runtime Change)</h3>
      <p class="meta" style="margin-bottom:8px;">${escapeHtml(params.passwordMode)}. Runtime password changes are memory-only and reset after server restart.</p>
      <form method="POST" action="/admin/settings/password" class="form-grid" style="margin-top:10px;">
        <div>
          <label class="field-label">Current Password</label>
          <input class="input" type="password" name="currentPassword" required />
        </div>
        <div>
          <label class="field-label">New Password</label>
          <input class="input" type="password" name="newPassword" required minlength="8" />
        </div>
        <div>
          <label class="field-label">Confirm New Password</label>
          <input class="input" type="password" name="confirmPassword" required minlength="8" />
        </div>
        <div class="field-span-4 inline-form">
          <button class="btn btn-primary" type="submit">Update Runtime Password</button>
        </div>
      </form>
    </section>
  `);
}

adminRouter.get('/login', (req, res) => {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE] as string | undefined;

  if (validateAdminSession(token)) {
    res.redirect('/admin');
    return;
  }

  const hasError = req.query.error === '1';
  res.status(200).type('html').send(loginPage(hasError));
});

adminRouter.post('/login', (req, res) => {
  const configuredPassword = getEffectiveAdminPassword();
  const inputPassword = String(req.body?.password || '');

  if (!configuredPassword) {
    res.status(500).type('html').send(shellLayout('<main style="padding:24px;">ADMIN_PASSWORD is not configured in .env</main>'));
    return;
  }

  if (inputPassword !== configuredPassword) {
    res.redirect('/admin/login?error=1');
    return;
  }

  const token = createAdminSession();
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: getAdminSessionTtlSeconds() * 1000,
    path: '/',
  });

  res.redirect('/admin');
});

adminRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE] as string | undefined;
  destroyAdminSession(token);
  res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
  res.redirect('/admin/login');
});

adminRouter.get('/', requireAdminAuth, async (_req, res, next) => {
  try {
    const [bookings, contacts, serviceEnquiries, activeSlots, confirmed] = await Promise.all([
      prisma.birthBooking.count(),
      prisma.contactEnquiry.count(),
      prisma.serviceEnquiry.count(),
      prisma.birthSlot.count({ where: { isActive: true } }),
      prisma.birthBooking.count({ where: { status: 'confirmed' } }),
    ]);

    res.status(200).type('html').send(dashboardPage({
      bookings,
      contacts,
      serviceEnquiries,
      activeSlots,
      confirmed,
    }));
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/slots', requireAdminAuth, async (req, res, next) => {
  try {
    const okMessage = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    const errorMessage = typeof req.query.err === 'string' ? req.query.err : undefined;

    const slots = await prisma.birthSlot.findMany({
      orderBy: { slotDate: 'asc' },
    });

    const slotsWithCounts = await Promise.all(
      slots.map(async (slot) => ({
        ...slot,
        bookedCount: await getBookedCountForDate(slot.slotDate),
      })),
    );

    res.status(200).type('html').send(slotManagementPage({
      slots: slotsWithCounts,
      okMessage,
      errorMessage,
    }));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/slots/create', requireAdminAuth, async (req, res, next) => {
  try {
    const slotDate = String(req.body?.slotDate || '').trim();
    const timeWindow = String(req.body?.timeWindow || '').trim();
    const maxSlotsRaw = String(req.body?.maxSlots || '').trim();
    const maxSlots = Number.parseInt(maxSlotsRaw, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) {
      res.redirect('/admin/slots?err=' + encodeURIComponent('Invalid slot date format.'));
      return;
    }

    if (!timeWindow) {
      res.redirect('/admin/slots?err=' + encodeURIComponent('Time window is required.'));
      return;
    }

    if (!Number.isFinite(maxSlots) || maxSlots < 0) {
      res.redirect('/admin/slots?err=' + encodeURIComponent('Max capacity must be 0 or more.'));
      return;
    }

    await prisma.birthSlot.create({
      data: {
        slotDate: normalizeDateToUtcMidnight(slotDate),
        timeWindow,
        maxSlots,
        isActive: true,
      },
    });

    res.redirect('/admin/slots?ok=' + encodeURIComponent('Slot added successfully.'));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/slots/:slotId/update', requireAdminAuth, async (req, res, next) => {
  try {
    const slotId = String(req.params.slotId);
    const slotDate = String(req.body?.slotDate || '').trim();
    const timeWindow = String(req.body?.timeWindow || '').trim();
    const maxSlotsRaw = String(req.body?.maxSlots || '').trim();
    const maxSlots = Number.parseInt(maxSlotsRaw, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) {
      res.redirect('/admin/slots?err=' + encodeURIComponent('Invalid slot date format.'));
      return;
    }

    if (!timeWindow) {
      res.redirect('/admin/slots?err=' + encodeURIComponent('Time window is required.'));
      return;
    }

    if (!Number.isFinite(maxSlots) || maxSlots < 0) {
      res.redirect('/admin/slots?err=' + encodeURIComponent('Max capacity must be 0 or more.'));
      return;
    }

    const targetDate = normalizeDateToUtcMidnight(slotDate);
    const bookedCount = await getBookedCountForDate(targetDate);

    if (maxSlots < bookedCount) {
      res.redirect('/admin/slots?err=' + encodeURIComponent(`Cannot set capacity below booked count (${bookedCount}).`));
      return;
    }

    await prisma.birthSlot.update({
      where: { id: slotId },
      data: {
        slotDate: targetDate,
        timeWindow,
        maxSlots,
      },
    });

    res.redirect('/admin/slots?ok=' + encodeURIComponent('Slot updated successfully.'));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/slots/:slotId/delete', requireAdminAuth, async (req, res, next) => {
  try {
    const slotId = String(req.params.slotId);

    await prisma.birthSlot.delete({
      where: { id: slotId },
    });

    res.redirect('/admin/slots?ok=' + encodeURIComponent('Slot deleted permanently.'));
  } catch (error) {
    res.redirect('/admin/slots?err=' + encodeURIComponent('Slot not found or could not be deleted.'));
    return;
  }
});

adminRouter.get('/bookings', requireAdminAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const openId = String(req.query.open || '').trim() || undefined;
    const exportType = String(req.query.export || '').trim();
    const okMessage = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    const errorMessage = typeof req.query.err === 'string' ? req.query.err : undefined;

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = 20;

    const where: Prisma.BirthBookingWhereInput = {};

    if (q) {
      where.OR = [
        { bookingReference: { contains: q, mode: 'insensitive' } },
        { applicantName: { contains: q, mode: 'insensitive' } },
        { applicantPhone: { contains: q, mode: 'insensitive' } },
        { fillerPhone: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (from || to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        createdAt.gte = new Date(`${from}T00:00:00.000Z`);
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        createdAt.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
      }
      where.createdAt = createdAt;
    }

    if (exportType === 'csv') {
      const records = await prisma.birthBooking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 2000,
      });

      const header = [
        'bookingReference',
        'status',
        'applicantName',
        'applicantPhone',
        'applicantEmail',
        'applicationType',
        'chosenSlotDate',
        'fillerName',
        'fillerPhone',
        'createdAt',
      ].join(',');

      const lines = records.map((row) => [
        csvEscape(row.bookingReference),
        csvEscape(row.status),
        csvEscape(row.applicantName),
        csvEscape(row.applicantPhone),
        csvEscape(row.applicantEmail),
        csvEscape(row.applicationType),
        csvEscape(toIsoDateInput(row.chosenSlotDate)),
        csvEscape(row.fillerName),
        csvEscape(row.fillerPhone),
        csvEscape(row.createdAt.toISOString()),
      ].join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="birth-bookings.csv"');
      res.status(200).send([header, ...lines].join('\n'));
      return;
    }

    const [total, rows] = await Promise.all([
      prisma.birthBooking.count({ where }),
      prisma.birthBooking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.status(200).type('html').send(bookingsPage({
      rows,
      total,
      page,
      pageSize,
      q,
      from,
      to,
      openId,
      okMessage,
      errorMessage,
    }));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/bookings/:bookingId/update', requireAdminAuth, async (req, res, next) => {
  try {
    const bookingId = String(req.params.bookingId);
    const statusRaw = String(req.body?.status || '').trim();
    const adminRemark = String(req.body?.adminRemark || '');
    const clientNote = String(req.body?.clientNote || '');

    if (statusRaw !== 'confirmed') {
      res.redirect('/admin/bookings?err=' + encodeURIComponent('Invalid booking status.'));
      return;
    }

    const mergedNotes = mergeNotes(clientNote, adminRemark);

    await prisma.birthBooking.update({
      where: { id: bookingId },
      data: {
        status: 'confirmed',
        notes: mergedNotes,
      },
    });

    const referer = req.get('referer') || '/admin/bookings';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}ok=${encodeURIComponent('Booking updated successfully.')}`);
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/bookings/:bookingId/delete', requireAdminAuth, async (req, res, next) => {
  try {
    const bookingId = String(req.params.bookingId);

    await prisma.birthBooking.delete({
      where: { id: bookingId },
    });

    const referer = req.get('referer') || '/admin/bookings';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}ok=${encodeURIComponent('Booking deleted permanently.')}`);
  } catch (error) {
    const referer = req.get('referer') || '/admin/bookings';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}err=${encodeURIComponent('Booking not found or could not be deleted.')}`);
    return;
  }
});

adminRouter.get('/contacts', requireAdminAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const openId = String(req.query.open || '').trim() || undefined;
    const exportType = String(req.query.export || '').trim();
    const okMessage = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    const errorMessage = typeof req.query.err === 'string' ? req.query.err : undefined;

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = 20;

    const where: Prisma.ContactEnquiryWhereInput = {};

    if (q) {
      where.OR = [
        { contactReference: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const statusParsed = parseContactStatus(status);
    if (status && statusParsed) {
      where.status = statusParsed;
    }

    if (from || to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        createdAt.gte = new Date(`${from}T00:00:00.000Z`);
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        createdAt.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
      }
      where.createdAt = createdAt;
    }

    if (exportType === 'csv') {
      const records = await prisma.contactEnquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 2000,
      });

      const header = [
        'contactReference',
        'status',
        'fullName',
        'phone',
        'email',
        'serviceType',
        'preferredContact',
        'createdAt',
      ].join(',');

      const lines = records.map((row) => [
        csvEscape(row.contactReference),
        csvEscape(row.status),
        csvEscape(row.fullName),
        csvEscape(row.phone),
        csvEscape(row.email),
        csvEscape(row.serviceType),
        csvEscape(row.preferredContact),
        csvEscape(row.createdAt.toISOString()),
      ].join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="contact-enquiries.csv"');
      res.status(200).send([header, ...lines].join('\n'));
      return;
    }

    const [total, rows] = await Promise.all([
      prisma.contactEnquiry.count({ where }),
      prisma.contactEnquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.status(200).type('html').send(contactsPage({
      rows,
      total,
      page,
      pageSize,
      q,
      status,
      from,
      to,
      openId,
      okMessage,
      errorMessage,
    }));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/contacts/:contactId/update', requireAdminAuth, async (req, res, next) => {
  try {
    const contactId = String(req.params.contactId);
    const statusRaw = String(req.body?.status || '').trim();
    const internalRemark = String(req.body?.internalRemark || '').trim();

    const status = parseContactStatus(statusRaw);
    if (!status) {
      res.redirect('/admin/contacts?err=' + encodeURIComponent('Invalid contact status.'));
      return;
    }

    await prisma.contactEnquiry.update({
      where: { id: contactId },
      data: {
        status,
        internalRemark: internalRemark || null,
      },
    });

    const referer = req.get('referer') || '/admin/contacts';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}ok=${encodeURIComponent('Enquiry updated successfully.')}`);
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/contacts/:contactId/delete', requireAdminAuth, async (req, res, next) => {
  try {
    const contactId = String(req.params.contactId);

    await prisma.contactEnquiry.delete({
      where: { id: contactId },
    });

    const referer = req.get('referer') || '/admin/contacts';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}ok=${encodeURIComponent('Enquiry deleted permanently.')}`);
  } catch (error) {
    const referer = req.get('referer') || '/admin/contacts';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}err=${encodeURIComponent('Enquiry not found or could not be deleted.')}`);
    return;
  }
});

adminRouter.get('/services', requireAdminAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const serviceType = String(req.query.serviceType || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const openId = String(req.query.open || '').trim() || undefined;
    const exportType = String(req.query.export || '').trim();
    const okMessage = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    const errorMessage = typeof req.query.err === 'string' ? req.query.err : undefined;

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = 20;

    const where: Prisma.ServiceEnquiryWhereInput = {};

    if (q) {
      where.OR = [
        { enquiryReference: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { officialBusinessName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const statusParsed = parseContactStatus(status);
    if (status && statusParsed) {
      where.status = statusParsed;
    }

    if (serviceType) {
      where.serviceType = serviceType;
    }

    if (from || to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        createdAt.gte = new Date(`${from}T00:00:00.000Z`);
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        createdAt.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
      }
      where.createdAt = createdAt;
    }

    if (exportType === 'csv') {
      const records = await prisma.serviceEnquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 2000,
      });

      const header = [
        'enquiryReference',
        'status',
        'serviceType',
        'subServiceType',
        'fullName',
        'officialBusinessName',
        'phone',
        'email',
        'preferredCommunication',
        'createdAt',
      ].join(',');

      const lines = records.map((row) => [
        csvEscape(row.enquiryReference),
        csvEscape(row.status),
        csvEscape(formatServiceTypeLabel(row.serviceType)),
        csvEscape(row.subServiceType),
        csvEscape(row.fullName),
        csvEscape(row.officialBusinessName),
        csvEscape(row.phone),
        csvEscape(row.email),
        csvEscape(row.preferredCommunication),
        csvEscape(row.createdAt.toISOString()),
      ].join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="service-enquiries.csv"');
      res.status(200).send([header, ...lines].join('\n'));
      return;
    }

    const [total, rows] = await Promise.all([
      prisma.serviceEnquiry.count({ where }),
      prisma.serviceEnquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.status(200).type('html').send(serviceEnquiriesPage({
      rows,
      total,
      page,
      pageSize,
      q,
      status,
      serviceType,
      from,
      to,
      openId,
      okMessage,
      errorMessage,
    }));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/services/:enquiryId/update', requireAdminAuth, async (req, res, next) => {
  try {
    const enquiryId = String(req.params.enquiryId);
    const statusRaw = String(req.body?.status || '').trim();
    const internalRemark = String(req.body?.internalRemark || '').trim();

    const status = parseContactStatus(statusRaw);
    if (!status) {
      res.redirect('/admin/services?err=' + encodeURIComponent('Invalid enquiry status.'));
      return;
    }

    await prisma.serviceEnquiry.update({
      where: { id: enquiryId },
      data: {
        status,
        internalRemark: internalRemark || null,
      },
    });

    const referer = req.get('referer') || '/admin/services';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}ok=${encodeURIComponent('Service enquiry updated successfully.')}`);
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/services/:enquiryId/delete', requireAdminAuth, async (req, res, next) => {
  try {
    const enquiryId = String(req.params.enquiryId);

    await prisma.serviceEnquiry.delete({
      where: { id: enquiryId },
    });

    const referer = req.get('referer') || '/admin/services';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}ok=${encodeURIComponent('Service enquiry deleted permanently.')}`);
  } catch (error) {
    const referer = req.get('referer') || '/admin/services';
    const separator = referer.includes('?') ? '&' : '?';
    res.redirect(`${referer}${separator}err=${encodeURIComponent('Service enquiry not found or could not be deleted.')}`);
    return;
  }
});

adminRouter.get('/case-summary', requireAdminAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const selectedBookingId = String(req.query.bookingId || '').trim();
    const adminRemark = String(req.query.adminRemark || '').trim();
    const okMessage = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    const errorMessage = typeof req.query.err === 'string' ? req.query.err : undefined;

    const searchWhere: Prisma.BirthBookingWhereInput = {};
    if (q) {
      searchWhere.OR = [
        { bookingReference: { contains: q, mode: 'insensitive' } },
        { applicantName: { contains: q, mode: 'insensitive' } },
        { applicantPhone: { contains: q, mode: 'insensitive' } },
      ];
    }

    const results = await prisma.birthBooking.findMany({
      where: searchWhere,
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        bookingReference: true,
        applicantName: true,
        applicantPhone: true,
        createdAt: true,
      },
    });

    let generatedSummary = '';
    if (selectedBookingId) {
      const booking = await prisma.birthBooking.findUnique({
        where: { id: selectedBookingId },
      });

      if (booking) {
        generatedSummary = buildCaseSummary({
          booking,
          adminRemark,
        });
      }
    }

    res.status(200).type('html').send(caseSummaryPage({
      q,
      selectedBookingId,
      adminRemark,
      generatedSummary,
      results,
      okMessage,
      errorMessage,
    }));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/case-summary/pdf', requireAdminAuth, async (req, res) => {
  const summaryText = String(req.body?.summaryText || '').trim();
  const bookingId = String(req.body?.bookingId || '').trim();

  if (!summaryText) {
    res.redirect('/admin/case-summary?err=' + encodeURIComponent('Summary text cannot be empty.'));
    return;
  }

  const fileRef = bookingId ? `case-summary-${bookingId}.pdf` : 'case-summary.pdf';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileRef}"`);

  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
  });

  doc.pipe(res);

  const pageWidth = doc.page.width;
  doc.rect(0, 0, pageWidth, 86).fill('#3d6b56');
  doc.fillColor('#ffffff').fontSize(19).font('Helvetica-Bold').text('Khan Consultants', 42, 24);
  doc.fillColor('#d1fae5').fontSize(10).font('Helvetica').text('Birth Certificate Case Summary', 42, 50);
  doc.fillColor('#e5f7ef').fontSize(9).text(`Generated on ${new Date().toISOString().slice(0, 10)}`, 42, 66);

  let y = 104;
  const sectionHeaderRegex = /^\d+\)\s+/;
  const bulletRegex = /^-\s+/;

  const ensureSpace = (needed: number) => {
    if (y + needed > doc.page.height - 42) {
      doc.addPage();
      y = 42;
    }
  };

  const lines = summaryText.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();

    if (!line.trim()) {
      y += 8;
      continue;
    }

    if (sectionHeaderRegex.test(line)) {
      ensureSpace(26);
      doc.roundedRect(42, y - 2, pageWidth - 84, 20, 4).fill('#eef6f2');
      doc.fillColor('#2f5444').font('Helvetica-Bold').fontSize(11).text(line, 50, y + 3, {
        width: pageWidth - 100,
      });
      y += 24;
      continue;
    }

    if (bulletRegex.test(line)) {
      ensureSpace(20);
      const bulletText = line.replace(bulletRegex, '');
      doc.fillColor('#111827').font('Helvetica').fontSize(10.5).text('•', 50, y, { continued: true });
      doc.text(` ${bulletText}`, 60, y, {
        width: pageWidth - 110,
        lineGap: 2,
      });
      y = doc.y + 3;
      continue;
    }

    ensureSpace(20);
    doc.fillColor('#111827').font('Helvetica').fontSize(10.5).text(line, 50, y, {
      width: pageWidth - 100,
      lineGap: 2,
    });
    y = doc.y + 3;
  }

  const footerY = doc.page.height - 24;
  doc.fillColor('#6b7280').fontSize(8).font('Helvetica').text('Khan Consultants • Internal Use', 42, footerY, {
    width: pageWidth - 84,
    align: 'right',
  });

  doc.end();
});

adminRouter.get('/settings', requireAdminAuth, async (req, res) => {
  const okMessage = typeof req.query.ok === 'string' ? req.query.ok : undefined;
  const errorMessage = typeof req.query.err === 'string' ? req.query.err : undefined;

  let dbStatus: 'connected' | 'error' = 'connected';
  let bookingFee = Number(process.env.BOOKING_FEE || 199);
  let appointmentWindow = String(process.env.APPOINTMENT_WINDOW || '9:20 AM - 9:50 AM');
  try {
    await prisma.$queryRaw`SELECT 1`;
    const settings = await getBookingSettings();
    bookingFee = settings.bookingFee;
    appointmentWindow = settings.appointmentWindow;
  } catch {
    dbStatus = 'error';
  }

  res.status(200).type('html').send(settingsPage({
    okMessage,
    errorMessage,
    sessionHours: Math.round(getAdminSessionTtlSeconds() / 3600),
    nodeEnv: process.env.NODE_ENV || 'development',
    dbStatus,
    passwordMode: getRuntimePasswordStateLabel(),
    bookingFee,
    appointmentWindow,
  }));
});

adminRouter.post('/settings/booking', requireAdminAuth, async (req, res) => {
  const bookingFeeRaw = String(req.body?.bookingFee || '').trim();
  const appointmentWindow = String(req.body?.appointmentWindow || '').trim();
  const bookingFee = Number.parseInt(bookingFeeRaw, 10);

  if (!Number.isFinite(bookingFee) || bookingFee <= 0) {
    res.redirect('/admin/settings?err=' + encodeURIComponent('Booking fee must be a valid positive number.'));
    return;
  }

  if (!appointmentWindow) {
    res.redirect('/admin/settings?err=' + encodeURIComponent('Appointment window is required.'));
    return;
  }

  try {
    await updateBookingSettings({
      bookingFee,
      appointmentWindow,
    });

    res.redirect('/admin/settings?ok=' + encodeURIComponent('Booking settings updated successfully.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update booking settings.';
    res.redirect('/admin/settings?err=' + encodeURIComponent(message));
  }
});

adminRouter.post('/settings/password', requireAdminAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const confirmPassword = String(req.body?.confirmPassword || '');

  const effectivePassword = getEffectiveAdminPassword();

  if (currentPassword !== effectivePassword) {
    res.redirect('/admin/settings?err=' + encodeURIComponent('Current password is incorrect.'));
    return;
  }

  if (newPassword.length < 8) {
    res.redirect('/admin/settings?err=' + encodeURIComponent('New password must be at least 8 characters.'));
    return;
  }

  if (newPassword !== confirmPassword) {
    res.redirect('/admin/settings?err=' + encodeURIComponent('New password and confirmation do not match.'));
    return;
  }

  runtimeAdminPassword = newPassword;
  res.redirect('/admin/settings?ok=' + encodeURIComponent('Runtime admin password updated successfully.'));
});

export { adminRouter };
