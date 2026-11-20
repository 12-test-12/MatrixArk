import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { config } from '../config';

/**
 * 存储抽象：首版落本地目录，接口按 key 设计。
 * 以后换 MinIO/OSS 只换这个类的实现，调用方（稿件、通道）不用改。
 */
@Injectable()
export class StorageService {
  private readonly root = config.storage.localDir;

  async save(workspaceId: string, filename: string, data: Buffer): Promise<{ key: string }> {
    const ext = safeExtension(filename);
    const key = `${workspaceId}/${randomUUID()}${ext}`;
    const target = this.absolute(key);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, data);
    return { key };
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.absolute(key));
    } catch {
      throw new NotFoundException('文件不存在');
    }
  }

  /** 只有以 workspaceId 开头的 key 才能被读到，防止跨工作室路径穿越 */
  absolute(key: string): string {
    const rootPath = resolve(this.root);
    const target = resolve(rootPath, normalize(key));
    if (target !== rootPath && !target.startsWith(rootPath + sep)) {
      throw new NotFoundException('文件不存在');
    }
    return target;
  }
}

function safeExtension(filename: string): string {
  const match = /\.[a-zA-Z0-9]{1,5}$/.exec(filename);
  return match ? match[0].toLowerCase() : '';
}
