-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "birth_slots" (
    "id" TEXT NOT NULL,
    "slotDate" TIMESTAMP(3) NOT NULL,
    "timeWindow" TEXT NOT NULL,
    "maxSlots" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "birth_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "birth_bookings" (
    "id" TEXT NOT NULL,
    "bookingReference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "submittedAtIst" TEXT NOT NULL,
    "fillerName" TEXT NOT NULL,
    "fillerPhone" TEXT NOT NULL,
    "fillerEmail" TEXT NOT NULL,
    "relationshipToApplicant" TEXT NOT NULL,
    "applicationType" TEXT NOT NULL,
    "applicantName" TEXT NOT NULL,
    "applicantDob" TEXT NOT NULL,
    "applicantPhone" TEXT NOT NULL,
    "applicantEmail" TEXT NOT NULL,
    "correctionEntries" JSONB NOT NULL,
    "documentsSelected" JSONB NOT NULL,
    "chosenSlotDate" TIMESTAMP(3),
    "chosenTimeWindow" TEXT,
    "source" TEXT NOT NULL DEFAULT 'website',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "birth_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_enquiries" (
    "id" TEXT NOT NULL,
    "contactReference" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "serviceType" TEXT,
    "preferredContact" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "birth_slots_slotDate_idx" ON "birth_slots"("slotDate");

-- CreateIndex
CREATE UNIQUE INDEX "birth_bookings_bookingReference_key" ON "birth_bookings"("bookingReference");

-- CreateIndex
CREATE INDEX "birth_bookings_applicantPhone_idx" ON "birth_bookings"("applicantPhone");

-- CreateIndex
CREATE INDEX "birth_bookings_chosenSlotDate_idx" ON "birth_bookings"("chosenSlotDate");

-- CreateIndex
CREATE UNIQUE INDEX "contact_enquiries_contactReference_key" ON "contact_enquiries"("contactReference");

-- CreateIndex
CREATE INDEX "contact_enquiries_email_idx" ON "contact_enquiries"("email");

-- CreateIndex
CREATE INDEX "contact_enquiries_phone_idx" ON "contact_enquiries"("phone");
