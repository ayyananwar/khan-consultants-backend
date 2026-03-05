import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createContactReference } from '../utils/references.js';

const contactRouter = Router();

const contactSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().min(8).max(20),
  message: z.string().trim().min(2).max(2000),
  serviceType: z.string().trim().max(120).optional(),
  preferredContact: z.string().trim().max(50).optional(),
});

contactRouter.post('/submit', async (req, res, next) => {
  try {
    const payload = contactSchema.parse(req.body);

    const contact = await prisma.contactEnquiry.create({
      data: {
        contactReference: createContactReference(),
        fullName: payload.fullName,
        email: payload.email,
        phone: payload.phone,
        message: payload.message,
        serviceType: payload.serviceType,
        preferredContact: payload.preferredContact,
      },
      select: {
        contactReference: true,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        contactReference: contact.contactReference,
        message: 'Contact enquiry submitted successfully.',
      },
    });
  } catch (error) {
    next(error);
  }
});

export { contactRouter };
