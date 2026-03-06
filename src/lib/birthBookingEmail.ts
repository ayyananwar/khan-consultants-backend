type BirthBookingConfirmationEmailInput = {
  toEmail: string;
  applicantName: string;
  bookingReference: string;
  chosenThursday: string;
  appointmentWindow: string;
  paymentId: string;
  applicationType: string;
};

const RESEND_API_URL = 'https://api.resend.com/emails';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toHumanDateLabel(slotDate: string): string {
  if (slotDate === 'WAITLIST') {
    return 'Waitlist (next available slot)';
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) {
    return slotDate;
  }

  const date = new Date(`${slotDate}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'full',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

function buildConfirmationHtml(input: BirthBookingConfirmationEmailInput): string {
  const safeName = input.applicantName || 'Customer';

  return `
    <div style="background:#f4f8f5;padding:28px 12px;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e5ece8;border-radius:16px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#1f3a30,#2c4d3f);padding:20px 24px;color:#ffffff;">
          <p style="margin:0;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#b3e5c2;font-weight:700;">Khan Consultants</p>
          <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3;">Birth Booking Confirmed</h1>
        </div>

        <div style="padding:24px;">
          <p style="margin:0 0 14px;font-size:15px;color:#1f2937;">Hi ${safeName},</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#374151;">
            Your booking has been confirmed after successful payment verification. Please keep this email for your records.
          </p>

          <div style="border:1px solid #d7e5dc;background:#f8fdf9;border-radius:12px;padding:14px 16px;">
            <p style="margin:0 0 8px;font-size:14px;color:#1f2937;"><strong>Booking Reference:</strong> ${input.bookingReference}</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1f2937;"><strong>Application Type:</strong> ${input.applicationType}</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1f2937;"><strong>Slot Date:</strong> ${toHumanDateLabel(input.chosenThursday)}</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1f2937;"><strong>Time Window:</strong> ${input.appointmentWindow}</p>
            <p style="margin:0;font-size:14px;color:#1f2937;"><strong>Payment ID:</strong> ${input.paymentId}</p>
          </div>

          <p style="margin:18px 0 0;font-size:13px;line-height:1.7;color:#4b5563;">
            Need help? Reply to this email and our team will assist you.
          </p>
        </div>
      </div>
    </div>
  `;
}

function buildConfirmationText(input: BirthBookingConfirmationEmailInput): string {
  return [
    `Hi ${input.applicantName || 'Customer'},`,
    '',
    'Your Birth Certificate booking is confirmed after successful payment verification.',
    '',
    `Booking Reference: ${input.bookingReference}`,
    `Application Type: ${input.applicationType}`,
    `Slot Date: ${toHumanDateLabel(input.chosenThursday)}`,
    `Time Window: ${input.appointmentWindow}`,
    `Payment ID: ${input.paymentId}`,
    '',
    'Need help? Reply to this email and our team will assist you.',
    '',
    'Khan Consultants',
  ].join('\n');
}

async function sendResendEmail(payload: {
  apiKey: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: payload.from,
      to: [payload.to],
      reply_to: payload.replyTo ? [payload.replyTo] : undefined,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend API error ${response.status}: ${errorBody}`);
  }
}

export async function sendBirthBookingConfirmationEmail(input: BirthBookingConfirmationEmailInput): Promise<void> {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.EMAIL_FROM || '').trim();
  const replyTo = String(process.env.EMAIL_REPLY_TO || '').trim();

  if (!apiKey) {
    throw new Error('RESEND_API_KEY is missing');
  }

  if (!from) {
    throw new Error('EMAIL_FROM is missing');
  }

  const maxRetries = parsePositiveInt(process.env.BOOKING_EMAIL_MAX_RETRIES, 3);
  const retryDelayMs = parsePositiveInt(process.env.BOOKING_EMAIL_RETRY_DELAY_MS, 900);

  const subject = `Booking Confirmed | ${input.bookingReference}`;
  const html = buildConfirmationHtml(input);
  const text = buildConfirmationText(input);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await sendResendEmail({
        apiKey,
        from,
        to: input.toEmail,
        replyTo: replyTo || undefined,
        subject,
        html,
        text,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const waitMs = retryDelayMs * attempt;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw (lastError instanceof Error ? lastError : new Error('Unknown email delivery failure'));
}
