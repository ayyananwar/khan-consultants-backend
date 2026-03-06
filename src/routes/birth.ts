import { createHmac } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createBookingReference } from '../utils/references.js';
import { getIstTimestamp } from '../utils/time.js';
import { getBookingSettings } from '../lib/bookingSettings.js';
import { sendBirthBookingConfirmationEmail } from '../lib/birthBookingEmail.js';

const birthRouter = Router();

const SLOT_LOCK_TIMEOUT_MS = 30000;
const ALLOWED_ACTIONS = ['getSlots', 'getBookingFee', 'createOrder', 'verifyPaymentAndSave'] as const;

let bookingLock = false;

function sanitizeText(value: unknown, maxLen: number): string {
  return String(value || '').trim().slice(0, maxLen);
}

function parsePipeList(value: unknown): string[] {
  return String(value || '')
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function jsonResponse(res: Response, success: boolean, data: unknown, error = ''): void {
  res.status(200).json({ success, data, error });
}

function parseRequestBody(req: Request): Record<string, unknown> {
  const raw = req.body;

  if (typeof raw === 'string') {
    if (!raw.trim()) {
      throw new Error('Missing request body');
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid payload type');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error('Invalid JSON payload');
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Missing request body');
  }

  return raw as Record<string, unknown>;
}

function normalizeDateToUtcMidnight(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00.000Z`);
}

async function getBookedCountForDate(dateIso: string): Promise<number> {
  const start = normalizeDateToUtcMidnight(dateIso);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

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

async function getAppointmentWindowForDate(chosenThursday: string, fallbackWindow: string): Promise<string> {
  if (!chosenThursday || chosenThursday === 'WAITLIST') {
    return fallbackWindow;
  }

  const slot = await prisma.birthSlot.findFirst({
    where: {
      isActive: true,
      slotDate: {
        gte: normalizeDateToUtcMidnight(chosenThursday),
        lt: new Date(normalizeDateToUtcMidnight(chosenThursday).getTime() + 24 * 60 * 60 * 1000),
      },
    },
    select: {
      timeWindow: true,
    },
  });

  return String(slot?.timeWindow || fallbackWindow);
}

async function handleGetBookingFee(): Promise<{
  amount: number;
  currency: string;
  appointmentWindow: string;
}> {
  const settings = await getBookingSettings();

  return {
    amount: Number(settings.bookingFee || 199),
    currency: 'INR',
    appointmentWindow: String(settings.appointmentWindow || '9:20 AM - 9:50 AM'),
  };
}

async function handleGetSlots(): Promise<{
  slots: Array<{
    date: string;
    label: string;
    timeWindow: string;
    maxSlots: number;
    bookedCount: number;
    remainingSlots: number;
    isFull: boolean;
  }>;
  allFull: boolean;
  waitlistAllowed: boolean;
}> {
  const settings = await getBookingSettings();
  const defaultWindow = String(settings.appointmentWindow || '9:20 AM - 9:50 AM');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const slots = await prisma.birthSlot.findMany({
    where: {
      isActive: true,
      slotDate: {
        gte: todayStart,
      },
    },
    orderBy: {
      slotDate: 'asc',
    },
    select: {
      slotDate: true,
      maxSlots: true,
      timeWindow: true,
    },
  });

  const slotRows = await Promise.all(
    slots.map(async (slot) => {
      const date = slot.slotDate.toISOString().slice(0, 10);
      const bookedCount = await getBookedCountForDate(date);
      const maxSlots = Number(slot.maxSlots || 0);
      const remainingSlots = Math.max(0, maxSlots - Number(bookedCount));

      return {
        date,
        label: date,
        timeWindow: String(slot.timeWindow || defaultWindow),
        maxSlots,
        bookedCount: Number(bookedCount || 0),
        remainingSlots,
        isFull: remainingSlots <= 0,
      };
    }),
  );

  const allFull = slotRows.length > 0 && slotRows.every((slot) => slot.isFull);
  return { slots: slotRows, allFull, waitlistAllowed: allFull };
}

async function handleCreateOrder(body: Record<string, unknown>): Promise<{
  orderId: string;
  amountSubunits: number;
  amountRupees: number;
  currency: string;
  keyId: string;
}> {
  const settings = await getBookingSettings();
  const keyId = String(settings.razorpayKeyId || '');
  const keySecret = String(settings.razorpayKeySecret || '');
  const bookingFee = Number(settings.bookingFee || 199);

  if (!keyId || !keySecret) throw new Error('Razorpay settings missing');
  if (bookingFee <= 0) throw new Error('Invalid booking fee in Settings');

  const payload = {
    amount: bookingFee * 100,
    currency: 'INR',
    receipt: `bc_${Date.now()}`,
    payment_capture: 1,
  };

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json() as Record<string, unknown>;
  if (!data.id) throw new Error('Failed to create Razorpay order');

  return {
    orderId: String(data.id),
    amountSubunits: Number(data.amount || bookingFee * 100),
    amountRupees: bookingFee,
    currency: 'INR',
    keyId,
  };
}

async function fetchRazorpayPayment(paymentId: string, keyId: string, keySecret: string): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });

  const data = await response.json() as Record<string, unknown>;
  if (!data.id) throw new Error('Unable to verify payment details from Razorpay');
  return data;
}

function verifySignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  const raw = `${orderId}|${paymentId}`;
  const computedHex = createHmac('sha256', keySecret).update(raw).digest('hex');
  return computedHex === signature;
}

async function areAllActiveSlotsFull(): Promise<boolean> {
  const slots = await prisma.birthSlot.findMany({
    where: {
      isActive: true,
      slotDate: {
        gte: new Date(new Date().setHours(0, 0, 0, 0)),
      },
    },
    select: {
      slotDate: true,
      maxSlots: true,
    },
  });

  if (slots.length === 0) {
    return false;
  }

  for (const slot of slots) {
    const date = slot.slotDate.toISOString().slice(0, 10);
    const booked = await getBookedCountForDate(date);
    if (Number(booked) < Number(slot.maxSlots || 0)) {
      return false;
    }
  }

  return true;
}

async function incrementSlotIfAvailable(chosenThursday: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenThursday) && chosenThursday !== 'WAITLIST') {
    return false;
  }

  if (chosenThursday === 'WAITLIST') {
    return areAllActiveSlotsFull();
  }

  const slotStart = normalizeDateToUtcMidnight(chosenThursday);
  const slotEnd = new Date(slotStart.getTime() + 24 * 60 * 60 * 1000);

  const slot = await prisma.birthSlot.findFirst({
    where: {
      isActive: true,
      slotDate: {
        gte: slotStart,
        lt: slotEnd,
      },
    },
    select: {
      id: true,
      maxSlots: true,
    },
  });

  if (!slot) {
    return false;
  }

  const bookedCount = await getBookedCountForDate(chosenThursday);
  if (bookedCount >= Number(slot.maxSlots || 10)) {
    return false;
  }

  return true;
}

function bookingPaymentMarker(paymentId: string): string {
  return `Payment_ID:${paymentId}`;
}

function bookingAlreadyExistsNote(notes: string | null, paymentId: string): boolean {
  return String(notes || '').includes(bookingPaymentMarker(paymentId));
}

async function bookingAlreadyExists(paymentId: string): Promise<boolean> {
  const row = await prisma.birthBooking.findFirst({
    where: {
      notes: {
        contains: bookingPaymentMarker(paymentId),
      },
    },
    select: {
      id: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return Boolean(row?.id);
}

async function getExistingBookingReferenceByPaymentId(paymentId: string): Promise<string> {
  const row = await prisma.birthBooking.findFirst({
    where: {
      notes: {
        contains: bookingPaymentMarker(paymentId),
      },
    },
    select: {
      bookingReference: true,
      status: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!row) return '';
  if (!row.status || row.status.toLowerCase() === 'success' || row.status.toLowerCase() === 'confirmed') {
    return row.bookingReference;
  }

  return row.bookingReference;
}

function validateBookingFormData(formData: Record<string, unknown>): void {
  const applicantName = sanitizeText(formData.applicantName, 120);
  const applicantDob = sanitizeText(formData.applicantDob, 20);
  const applicantPhone = String(formData.applicantPhone || '').replace(/\D/g, '');
  const applicantEmail = sanitizeText(formData.applicantEmail, 160);
  const relation = sanitizeText(formData.relation || 'self', 16).toLowerCase();
  const fillerPhoneRaw = String(formData.fillerPhone || '').replace(/\D/g, '');
  const fillerEmailRaw = sanitizeText(formData.fillerEmail, 160);
  const fillerPhone = relation === 'self' ? (fillerPhoneRaw || applicantPhone) : fillerPhoneRaw;
  const fillerEmail = relation === 'self' ? (fillerEmailRaw || applicantEmail) : fillerEmailRaw;
  const chosenThursday = sanitizeText(formData.chosenThursday, 32);

  if (!applicantName) throw new Error('Applicant name is required');
  if (!applicantDob) throw new Error('Applicant DOB is required');
  if (applicantPhone.length !== 10) throw new Error('Applicant phone must be exactly 10 digits');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicantEmail)) throw new Error('Applicant email is invalid');
  if (fillerPhone.length !== 10) throw new Error('Filler phone must be exactly 10 digits');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fillerEmail)) throw new Error('Filler email is invalid');
  if (!chosenThursday) throw new Error('Slot is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(applicantDob)) throw new Error('Applicant DOB format is invalid');

  const documents = Array.isArray(formData.documents) ? formData.documents : parsePipeList(formData.documents);
  if (documents.length === 0) throw new Error('At least one document is required');

  const correctionEntries = Array.isArray(formData.correctionEntries) ? formData.correctionEntries : [];
  const applicationType = sanitizeText(formData.applicationType, 32).toLowerCase();
  if (applicationType === 'correction') {
    if (correctionEntries.length === 0) throw new Error('Correction fields are required for correction type');
    correctionEntries.forEach((entry) => {
      const row = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
      const incorrectValue = sanitizeText(row.incorrectValue, 240);
      const correctValue = sanitizeText(row.correctValue, 240);
      if (!incorrectValue || !correctValue) {
        throw new Error('Correction fields must include incorrect and correct values');
      }
    });
  }

  const relationshipToApplicant = sanitizeText(formData.relationshipToApplicant, 64);
  const relationshipOther = sanitizeText(formData.relationshipOther, 120);
  if (relation === 'other' && !relationshipToApplicant) throw new Error('Relationship with applicant is required for relation=other');
  if (relation === 'other' && relationshipToApplicant.toLowerCase() === 'other' && !relationshipOther) {
    throw new Error('Relationship details are required when relationship is Other');
  }

  if (relation === 'other') {
    const fillerName = sanitizeText(formData.fillerName, 120);
    const fillerPhoneForOther = String(formData.fillerPhone || '').replace(/\D/g, '');
    if (!fillerName) throw new Error('Filler name is required for relation=other');
    if (fillerPhoneForOther.length !== 10) throw new Error('Filler phone must be exactly 10 digits for relation=other');
  }
}

function mapRelationship(formData: Record<string, unknown>): string {
  const relation = sanitizeText(formData.relation || 'self', 16).toLowerCase();
  const relationship = sanitizeText(formData.relationshipToApplicant, 64);
  const relationshipOther = sanitizeText(formData.relationshipOther, 120);

  if (relation === 'self') return 'Self';
  if (relationship.toLowerCase() === 'other') return relationshipOther || relationship;
  return relationship;
}

function mapApplicationType(formData: Record<string, unknown>): string {
  const appType = sanitizeText(formData.applicationType, 64);
  const appTypeOther = sanitizeText(formData.applicationTypeOther, 120);

  if (appType.toLowerCase() === 'other') {
    return appTypeOther || appType;
  }

  return appType.toLowerCase();
}

async function acquireBookingLock(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (bookingLock) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  bookingLock = true;
  return true;
}

function releaseBookingLock(): void {
  bookingLock = false;
}

async function handleVerifyPaymentAndSave(body: Record<string, unknown>): Promise<{
  bookingReference: string;
  chosenThursday: string;
  appointmentWindow: string;
  paymentId: string;
}> {
  const settings = await getBookingSettings();
  const keyId = String(settings.razorpayKeyId || '');
  const keySecret = String(settings.razorpayKeySecret || '');
  const bookingFee = Number(settings.bookingFee || 199);
  const appointmentWindow = String(settings.appointmentWindow || '9:20 AM - 9:50 AM');

  const paymentId = String(body.razorpayPaymentId || '');
  const orderId = String(body.razorpayOrderId || '');
  const signature = String(body.razorpaySignature || '');
  const formData = (body.formData && typeof body.formData === 'object' && !Array.isArray(body.formData))
    ? body.formData as Record<string, unknown>
    : {};

  validateBookingFormData(formData);

  if (!paymentId || !orderId || !signature) throw new Error('Missing payment details');
  if (!keyId || !keySecret) throw new Error('Razorpay settings missing');
  if (!verifySignature(orderId, paymentId, signature, keySecret)) throw new Error('Invalid payment signature');

  const paymentDetails = await fetchRazorpayPayment(paymentId, keyId, keySecret);
  if (String(paymentDetails.order_id || '') !== orderId) throw new Error('Payment order mismatch');
  if (String(paymentDetails.status || '') !== 'captured') throw new Error('Payment not captured');
  if (Number(paymentDetails.amount || 0) !== bookingFee * 100) throw new Error('Payment amount mismatch');

  const lockAcquired = await acquireBookingLock(SLOT_LOCK_TIMEOUT_MS);
  if (!lockAcquired) {
    throw new Error('System is busy. Please retry in a few seconds.');
  }

  try {
    if (await bookingAlreadyExists(paymentId)) {
      const existingReference = await getExistingBookingReferenceByPaymentId(paymentId);
      const existingChosenThursday = String(formData.chosenThursday || '');
      const existingAppointmentWindow = await getAppointmentWindowForDate(existingChosenThursday, appointmentWindow);

      return {
        bookingReference: existingReference || (`EXISTING-${paymentId}`),
        chosenThursday: existingChosenThursday,
        appointmentWindow: existingAppointmentWindow,
        paymentId,
      };
    }

    const chosenThursday = String(formData.chosenThursday || '');
    if (!chosenThursday) throw new Error('Slot is required');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenThursday) && chosenThursday !== 'WAITLIST') {
      throw new Error('Invalid slot format');
    }

    if (chosenThursday === 'WAITLIST' && !(await areAllActiveSlotsFull())) {
      throw new Error('Waitlist not allowed while slots are available');
    }

    if (!(await incrementSlotIfAvailable(chosenThursday))) {
      throw new Error('Selected slot is unavailable for booking. Please retry.');
    }

    const selectedAppointmentWindow = await getAppointmentWindowForDate(chosenThursday, appointmentWindow);
    const bookingReference = createBookingReference();

    const noteParts = [
      sanitizeText(formData.notes, 2000),
      `Payment_ID:${paymentId}`,
      'Payment_Status:Success',
    ].filter((item) => item.length > 0);

    const relation = sanitizeText(formData.relation || 'self', 16).toLowerCase();

    const mappedApplicationType = mapApplicationType(formData);
    const applicantName = sanitizeText(formData.applicantName || '', 120);
    const applicantEmail = sanitizeText(formData.applicantEmail || '', 160);

    await prisma.birthBooking.create({
      data: {
        bookingReference,
        status: 'confirmed',
        submittedAtIst: getIstTimestamp(),
        fillerName: sanitizeText(formData.fillerName || formData.applicantName || '', 120),
        fillerPhone: sanitizeText(formData.fillerPhone || formData.applicantPhone || '', 20),
        fillerEmail: sanitizeText(formData.fillerEmail || formData.applicantEmail || '', 160),
        applicationType: mappedApplicationType,
        applicantName,
        applicantDob: sanitizeText(formData.applicantDob || '', 20),
        applicantPhone: sanitizeText(formData.applicantPhone || '', 20),
        applicantEmail,
        relationshipToApplicant: relation === 'self' ? 'Self' : mapRelationship(formData),
        correctionEntries: Array.isArray(formData.correctionEntries) ? formData.correctionEntries : [],
        documentsSelected: {
          selected: Array.isArray(formData.documents) ? formData.documents : parsePipeList(formData.documents),
        },
        chosenSlotDate: chosenThursday === 'WAITLIST' ? null : normalizeDateToUtcMidnight(chosenThursday),
        chosenTimeWindow: selectedAppointmentWindow,
        source: 'website',
        notes: noteParts.join('\n'),
      },
    });

    try {
      await sendBirthBookingConfirmationEmail({
        toEmail: applicantEmail,
        applicantName,
        bookingReference,
        chosenThursday,
        appointmentWindow: selectedAppointmentWindow,
        paymentId,
        applicationType: mappedApplicationType,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[BirthBookingEmail] Failed for ${bookingReference}: ${reason}`);
    }

    return {
      bookingReference,
      chosenThursday,
      appointmentWindow: selectedAppointmentWindow,
      paymentId,
    };
  } finally {
    releaseBookingLock();
  }
}

birthRouter.post('/action', async (req, res) => {
  try {
    const body = parseRequestBody(req);
    const action = sanitizeText(body.action, 64);

    if (!action) {
      jsonResponse(res, false, null, 'Missing action');
      return;
    }

    if (!ALLOWED_ACTIONS.includes(action as (typeof ALLOWED_ACTIONS)[number])) {
      jsonResponse(res, false, null, 'Invalid action');
      return;
    }

    if (action === 'getSlots') {
      jsonResponse(res, true, await handleGetSlots());
      return;
    }

    if (action === 'getBookingFee') {
      jsonResponse(res, true, await handleGetBookingFee());
      return;
    }

    if (action === 'createOrder') {
      jsonResponse(res, true, await handleCreateOrder(body));
      return;
    }

    if (action === 'verifyPaymentAndSave') {
      jsonResponse(res, true, await handleVerifyPaymentAndSave(body));
      return;
    }

    jsonResponse(res, false, null, 'Invalid action');
  } catch (error) {
    jsonResponse(res, false, null, String(error instanceof Error ? error.message : error));
  }
});

birthRouter.get('/slots', async (_req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: await handleGetSlots(),
    });
  } catch (error) {
    next(error);
  }
});

birthRouter.post('/submit', async (req, res, next) => {
  try {
    const formData = req.body as Record<string, unknown>;
    validateBookingFormData(formData);

    const chosenThursday = sanitizeText(formData.chosenThursday, 32);
    const settings = await getBookingSettings();
    const fallbackWindow = String(settings.appointmentWindow || '9:20 AM - 9:50 AM');

    if (chosenThursday === 'WAITLIST' && !(await areAllActiveSlotsFull())) {
      throw new Error('Waitlist not allowed while slots are available');
    }

    if (!(await incrementSlotIfAvailable(chosenThursday))) {
      throw new Error('Selected slot is unavailable for booking. Please retry.');
    }

    const selectedAppointmentWindow = await getAppointmentWindowForDate(chosenThursday, fallbackWindow);

    const booking = await prisma.birthBooking.create({
      data: {
        bookingReference: createBookingReference(),
        status: 'confirmed',
        submittedAtIst: getIstTimestamp(),
        fillerName: sanitizeText(formData.fillerName || formData.applicantName || '', 120),
        fillerPhone: sanitizeText(formData.fillerPhone || formData.applicantPhone || '', 20),
        fillerEmail: sanitizeText(formData.fillerEmail || formData.applicantEmail || '', 160),
        relationshipToApplicant: mapRelationship(formData),
        applicationType: mapApplicationType(formData),
        applicantName: sanitizeText(formData.applicantName || '', 120),
        applicantDob: sanitizeText(formData.applicantDob || '', 20),
        applicantPhone: sanitizeText(formData.applicantPhone || '', 20),
        applicantEmail: sanitizeText(formData.applicantEmail || '', 160),
        correctionEntries: Array.isArray(formData.correctionEntries) ? formData.correctionEntries : [],
        documentsSelected: {
          selected: Array.isArray(formData.documents) ? formData.documents : parsePipeList(formData.documents),
        },
        chosenSlotDate: chosenThursday === 'WAITLIST' ? null : normalizeDateToUtcMidnight(chosenThursday),
        chosenTimeWindow: selectedAppointmentWindow,
        source: 'website',
        notes: sanitizeText(formData.notes, 2000),
      },
      select: {
        bookingReference: true,
        status: true,
        chosenSlotDate: true,
        chosenTimeWindow: true,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        bookingReference: booking.bookingReference,
        status: booking.status,
        chosenSlotDate: booking.chosenSlotDate ? booking.chosenSlotDate.toISOString().slice(0, 10) : chosenThursday,
        chosenTimeWindow: booking.chosenTimeWindow,
        message: 'Birth booking submitted successfully.',
      },
    });
  } catch (error) {
    next(error);
  }
});

export { birthRouter };
