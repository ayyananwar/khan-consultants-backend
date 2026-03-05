import { app } from './app.js';
import { prisma } from './lib/prisma.js';
import { noteAdminSessionStoreRisk } from './lib/adminSession.js';

const port = Number(process.env.PORT || 4000);

function parseRequiredEnvVars(): string[] {
  const required = ['DATABASE_URL', 'ADMIN_PASSWORD'];
  if (process.env.NODE_ENV === 'production') {
    required.push('CORS_ORIGIN');
  }

  return required.filter((key) => !String(process.env[key] || '').trim());
}

const missingEnvVars = parseRequiredEnvVars();
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

async function startServer() {
  try {
    await prisma.$connect();
    noteAdminSessionStoreRisk();

    const server = app.listen(port, () => {
      console.log(`Backend running on http://localhost:${port}`);
    });

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection') => {
      if (shuttingDown) return;
      shuttingDown = true;

      console.log(`Received ${signal}. Shutting down gracefully...`);

      server.close(async () => {
        try {
          await prisma.$disconnect();
          process.exit(signal === 'uncaughtException' ? 1 : 0);
        } catch (error) {
          console.error('Error while disconnecting Prisma during shutdown', error);
          process.exit(1);
        }
      });

      setTimeout(() => {
        console.error('Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });

    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Promise rejection:', reason);
      void shutdown('unhandledRejection');
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      void shutdown('uncaughtException');
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

void startServer();
