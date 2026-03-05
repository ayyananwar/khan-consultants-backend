import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createServiceEnquiryReference } from '../utils/references.js';

const enquiriesRouter = Router();

const serviceTypeValues = [
  'gst',
  'fssai',
  'drug-licence',
  'kmc',
  'personal-documentation',
  'trademark-marketplace',
] as const;

type ServiceType = (typeof serviceTypeValues)[number];

const payloadSchema = z.object({
  serviceType: z.enum(serviceTypeValues),
  subServiceType: z.string().trim().max(120).optional(),
  fullName: z.string().trim().min(2).max(120),
  designation: z.string().trim().max(80).optional(),
  officialBusinessName: z.string().trim().min(2).max(180),
  phone: z.string().trim().regex(/^\d{10}$/, 'Phone must be exactly 10 digits'),
  email: z.string().trim().email().max(160),
  alternateNumber: z.string().trim().max(20).optional(),
  businessAddress: z.string().trim().min(4).max(500),
  preferredCommunication: z.enum(['WhatsApp', 'Phone call', 'Email']),
  additionalNotes: z.string().trim().min(2).max(3000),
  consentAccepted: z.literal(true),
  data: z.record(z.string(), z.unknown()).default({}),
});

function requireField(data: Record<string, unknown>, key: string, message: string): void {
  const value = data[key];
  const asString = typeof value === 'string' ? value.trim() : '';
  if (!asString) {
    throw new Error(message);
  }
}

function requireArray(data: Record<string, unknown>, key: string, message: string): void {
  const value = data[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(message);
  }
}

function validateServiceSpecific(serviceType: ServiceType, data: Record<string, unknown>): void {
  if (serviceType === 'gst') {
    requireField(data, 'hasGstNumber', 'GST registration status is required');
    const hasGst = String(data.hasGstNumber || '');

    if (hasGst === 'yes' || hasGst === 'not-sure') {
      requireField(data, 'natureOfInquiry', 'Nature of inquiry is required');
    }

    if (hasGst === 'no') {
      requireField(data, 'wantGstRegistration', 'GST registration intent is required');
      requireField(data, 'ownershipType', 'Ownership type is required');
      requireField(data, 'monthlyTurnover', 'Monthly turnover is required');
      requireField(data, 'monthlyInvoices', 'Monthly invoices range is required');
      requireField(data, 'otpEmail', 'OTP email is required');
      requireField(data, 'otpMobile', 'OTP mobile is required');
      requireArray(data, 'gstHelpNeeded', 'Select at least one GST help item');
    }

    return;
  }

  if (serviceType === 'fssai') {
    requireField(data, 'foodBusinessType', 'Food business type is required');
    requireField(data, 'annualTurnover', 'Annual turnover is required');
    requireField(data, 'licenseTypeIfKnown', 'Licence type is required');
    requireField(data, 'kitchenAddress', 'Kitchen/premises address is required');
    requireField(data, 'hasTradeLicense', 'Trade licence status is required');
    return;
  }

  if (serviceType === 'drug-licence') {
    requireField(data, 'drugLicenseType', 'Drug licence type is required');
    requireField(data, 'hasRegisteredPharmacist', 'Pharmacist status is required');
    requireField(data, 'shopAreaSqFt', 'Shop area is required');
    requireField(data, 'refrigeratorAvailable', 'Refrigerator status is required');

    if (String(data.hasRegisteredPharmacist || '') === 'yes') {
      requireField(data, 'pharmacistRegistrationNumber', 'Pharmacist registration number is required');
    }
    return;
  }

  if (serviceType === 'kmc') {
    requireField(data, 'kmcServiceType', 'KMC service type is required');
    requireField(data, 'propertyType', 'Property type is required');
    requireField(data, 'idNumbersAndDetails', 'KMC IDs/details are required');
    return;
  }

  if (serviceType === 'personal-documentation') {
    requireField(data, 'personalDocType', 'Personal document type is required');
    requireField(data, 'applicationNature', 'Application nature is required');
    return;
  }

  if (serviceType === 'trademark-marketplace') {
    requireField(data, 'businessStructure', 'Business structure is required');
    requireField(data, 'serviceRequired', 'Trademark service required is mandatory');
    requireField(data, 'brandNameOrLogo', 'Brand name/logo field is required');
    requireField(data, 'firstUseDate', 'Date of first use is required');
    requireField(data, 'goodsServicesDescription', 'Goods/services description is required');
    requireField(data, 'registrationReason', 'Registration reason is required');
    requireField(data, 'currentSellerStatus', 'Current seller status is required');
    requireArray(data, 'targetPlatforms', 'Select at least one target platform');
    requireField(data, 'brandAuthorization', 'Brand authorization status is required');
    requireField(data, 'trademarkStatus', 'Trademark status is required');
    requireField(data, 'skuCount', 'SKU count is required');
    requireField(data, 'pickupAddressType', 'Pickup address type is required');
    requireArray(data, 'supportNeeded', 'Select at least one support need');
  }
}

enquiriesRouter.post('/submit', async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ success: false, error: 'Missing payload' });
      return;
    }

    const payload = payloadSchema.parse(req.body);
    const serviceData = (payload.data || {}) as Record<string, unknown>;

    validateServiceSpecific(payload.serviceType as ServiceType, serviceData);

    const row = await prisma.serviceEnquiry.create({
      data: {
        enquiryReference: createServiceEnquiryReference(),
        serviceType: payload.serviceType,
        subServiceType: payload.subServiceType || null,
        fullName: payload.fullName,
        designation: payload.designation || null,
        officialBusinessName: payload.officialBusinessName,
        phone: payload.phone,
        email: payload.email,
        alternateNumber: payload.alternateNumber || null,
        businessAddress: payload.businessAddress,
        preferredCommunication: payload.preferredCommunication,
        additionalNotes: payload.additionalNotes,
        consentAccepted: payload.consentAccepted,
        formPayload: serviceData as Prisma.InputJsonValue,
      },
      select: {
        enquiryReference: true,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        enquiryReference: row.enquiryReference,
        message: 'Service enquiry submitted successfully.',
      },
    });
  } catch (error) {
    next(error);
  }
});

export { enquiriesRouter };