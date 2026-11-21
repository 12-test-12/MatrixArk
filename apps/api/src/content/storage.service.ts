import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { BadRequestException, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { config } from '../config';

export const IMAGE_UPLOAD_LIMIT = 20 * 1024 * 1024;

function imageType(data: Buffer) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && data.subarray(12, 16).toString('ascii') === 'IHDR') return 'image/png';
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 16 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function validateImageUpload(file: Express.Multer.File | undefined) {
  if (!file) throw new BadRequestException('没有收到文件');
  const mimeType = imageType(file.buffer);
  if (!mimeType) throw new UnsupportedMediaTypeException('只接受 JPEG、PNG 或 WebP 图片');
  return { file, mimeType };
}

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

  async readImage(workspaceId: string, key: string) {
    const [office, filename, ...rest] = key.split('/');
    if (office !== workspaceId || !filename || rest.length || !/^[\w.-]+$/.test(filename)
      || filename === '.' || filename === '..') throw new NotFoundException('文件不存在');
    let data: Buffer;
    try {
      data = await readFile(this.absolute(key));
    } catch {
      throw new NotFoundException('文件不存在');
    }
    const mimeType = imageType(data);
    if (!mimeType) throw new NotFoundException('文件不存在');
    return { data, mimeType };
  }

  private absolute(key: string): string {
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
