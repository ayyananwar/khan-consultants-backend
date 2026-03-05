import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function getNextThursday(date = new Date()): Date {
  const next = new Date(date);
  const day = next.getDay();
  const diff = (4 - day + 7) % 7 || 7;
  next.setDate(next.getDate() + diff);
  next.setHours(0, 0, 0, 0);
  return next;
}

async function main() {
  const existingSlots = await prisma.birthSlot.count();

  if (existingSlots > 0) {
    console.log(`Skipping slot seed: ${existingSlots} slot(s) already exist.`);
    return;
  }

  const first = getNextThursday();
  const second = new Date(first);
  second.setDate(first.getDate() + 7);
  const third = new Date(first);
  third.setDate(first.getDate() + 14);

  await prisma.birthSlot.createMany({
    data: [
      { slotDate: first, timeWindow: '9:20 AM - 9:50 AM', maxSlots: 15, isActive: true },
      { slotDate: second, timeWindow: '9:20 AM - 9:50 AM', maxSlots: 15, isActive: true },
      { slotDate: third, timeWindow: '9:20 AM - 9:50 AM', maxSlots: 15, isActive: true },
    ],
  });

  console.log('Seeded 3 birth slots successfully.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
