import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: config.apiOrigin, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    console.error(`数据库连接失败${error.errorCode ? `（${error.errorCode}）` : ''}`);
  } else {
    console.error('API 启动失败', error);
  }
  process.exitCode = 1;
});
