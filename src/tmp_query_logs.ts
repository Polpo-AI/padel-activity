import { prisma } from './services/db';

async function main() {
  const chatId = process.argv[2] || '393457991255@s.whatsapp.net';
  const messages = await prisma.whatsAppMessage.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' },
    take: 100,
  });

  console.log(JSON.stringify(messages, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
