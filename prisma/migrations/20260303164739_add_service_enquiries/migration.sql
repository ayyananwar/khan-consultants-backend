-- CreateTable
CREATE TABLE "service_enquiries" (
    "id" TEXT NOT NULL,
    "enquiryReference" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "subServiceType" TEXT,
    "fullName" TEXT NOT NULL,
    "designation" TEXT,
    "officialBusinessName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "alternateNumber" TEXT,
    "businessAddress" TEXT NOT NULL,
    "preferredCommunication" TEXT NOT NULL,
    "additionalNotes" TEXT NOT NULL,
    "consentAccepted" BOOLEAN NOT NULL DEFAULT false,
    "formPayload" JSONB NOT NULL,
    "attachments" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "internalRemark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_enquiries_enquiryReference_key" ON "service_enquiries"("enquiryReference");

-- CreateIndex
CREATE INDEX "service_enquiries_serviceType_idx" ON "service_enquiries"("serviceType");

-- CreateIndex
CREATE INDEX "service_enquiries_phone_idx" ON "service_enquiries"("phone");

-- CreateIndex
CREATE INDEX "service_enquiries_email_idx" ON "service_enquiries"("email");

-- CreateIndex
CREATE INDEX "service_enquiries_status_idx" ON "service_enquiries"("status");
