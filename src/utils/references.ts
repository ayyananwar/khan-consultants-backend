import { compactDateForRef } from './time.js';

function randomSuffix(length = 4): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';

  for (let index = 0; index < length; index += 1) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }

  return value;
}

export function createBookingReference(): string {
  return `BC-${compactDateForRef()}-${randomSuffix(4)}`;
}

export function createContactReference(): string {
  return `KC-${compactDateForRef()}-${randomSuffix(4)}`;
}

export function createServiceEnquiryReference(): string {
  return `SE-${compactDateForRef()}-${randomSuffix(5)}`;
}
