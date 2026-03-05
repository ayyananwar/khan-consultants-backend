-- Sample SQL seed for local pgAdmin use
-- Adjust dates/time/capacity as needed

INSERT INTO "birth_slots" ("id", "slotDate", "timeWindow", "maxSlots", "isActive", "createdAt", "updatedAt")
VALUES
  ('slot_manual_001', CURRENT_DATE + INTERVAL '7 day', '9:20 AM - 9:50 AM', 15, TRUE, NOW(), NOW()),
  ('slot_manual_002', CURRENT_DATE + INTERVAL '14 day', '9:20 AM - 9:50 AM', 15, TRUE, NOW(), NOW()),
  ('slot_manual_003', CURRENT_DATE + INTERVAL '21 day', '9:20 AM - 9:50 AM', 15, TRUE, NOW(), NOW());
