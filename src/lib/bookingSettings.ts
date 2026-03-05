import { prisma } from './prisma.js';

const BOOKING_FEE_KEY = 'booking_fee';
const APPOINTMENT_WINDOW_KEY = 'appointment_window';

export type BookingSettings = {
  bookingFee: number;
  appointmentWindow: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
};

function defaultBookingFee(): number {
  const parsed = Number(process.env.BOOKING_FEE || 199);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 199;
  }
  return Math.floor(parsed);
}

function defaultAppointmentWindow(): string {
  return String(process.env.APPOINTMENT_WINDOW || '9:20 AM - 9:50 AM').trim() || '9:20 AM - 9:50 AM';
}

function parseStoredBookingFee(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultBookingFee();
  }
  return Math.floor(parsed);
}

function parseStoredAppointmentWindow(raw: string | undefined): string {
  const text = String(raw || '').trim();
  return text || defaultAppointmentWindow();
}

export async function getBookingSettings(): Promise<BookingSettings> {
  const rows = await prisma.systemSetting.findMany({
    where: {
      settingKey: {
        in: [BOOKING_FEE_KEY, APPOINTMENT_WINDOW_KEY],
      },
    },
  });

  const map = new Map(rows.map((row) => [row.settingKey, row.settingValue]));

  return {
    bookingFee: parseStoredBookingFee(map.get(BOOKING_FEE_KEY)),
    appointmentWindow: parseStoredAppointmentWindow(map.get(APPOINTMENT_WINDOW_KEY)),
    razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || ''),
    razorpayKeySecret: String(process.env.RAZORPAY_KEY_SECRET || ''),
  };
}

export async function updateBookingSettings(input: { bookingFee: number; appointmentWindow: string }): Promise<void> {
  const bookingFee = Math.floor(Number(input.bookingFee));
  const appointmentWindow = String(input.appointmentWindow || '').trim();

  if (!Number.isFinite(bookingFee) || bookingFee <= 0 || bookingFee > 100000) {
    throw new Error('Booking fee must be a positive number up to 100000');
  }

  if (!appointmentWindow || appointmentWindow.length > 120) {
    throw new Error('Appointment window is required and must be at most 120 characters');
  }

  await prisma.$transaction([
    prisma.systemSetting.upsert({
      where: { settingKey: BOOKING_FEE_KEY },
      create: { settingKey: BOOKING_FEE_KEY, settingValue: String(bookingFee) },
      update: { settingValue: String(bookingFee) },
    }),
    prisma.systemSetting.upsert({
      where: { settingKey: APPOINTMENT_WINDOW_KEY },
      create: { settingKey: APPOINTMENT_WINDOW_KEY, settingValue: appointmentWindow },
      update: { settingValue: appointmentWindow },
    }),
  ]);
}
