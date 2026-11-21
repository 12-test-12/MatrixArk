import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { config } from '../config';

export const IMAGE_UPLOAD_LIMIT = 20 * 1024 * 1024;
export const VIDEO_UPLOAD_LIMIT = 100 * 1024 * 1024;

async function validMp4(path: string, size: number) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(16);
    const boxes = new Set<string>();
    let offset = 0;
    for (let count = 0; offset < size && count < 1024; count++) {
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      const type = header.toString('ascii', 4, 8);
      let length = header.readUInt32BE(0);
      if (length === 1) {
        if (bytesRead < 16) return false;
        const extended = header.readBigUInt64BE(8);
        if (extended < 16n || extended > BigInt(size - offset)) return false;
        length = Number(extended);
      } else if (length === 0) length = size - offset;
      if (length < 8 || length > size - offset) return false;
      if (offset === 0 && (type !== 'ftyp' || length < 16 || header.toString('ascii', 8, 12) === 'qt  ')) return false;
      boxes.add(type);
      offset += length;
    }
    return offset === size && boxes.has('moov') && boxes.has('mdat');
  } finally {
    await file.close();
  }
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeUploadName(filename: string) {
  // Multer reads the browser's UTF-8 filename parameter as Latin-1.
  if (/[^\u0000-\u00ff]/u.test(filename)) return filename;
  try {
    return utf8.decode(Buffer.from(filename, 'latin1'));
  } catch {
    return filename;
  }
}

export function imageDisplayName(filename: string) {
  const decoded = decodeUploadName(filename);
  // Recover old Chinese names or byte sequences that left C1 controls in the stored name.
  return /[\u0080-\u009f]/u.test(filename) || /\p{Script=Han}/u.test(decoded) ? decoded : filename;
}

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
  return { file, mimeType, filename: decodeUploadName(file.originalname) };
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

  async remove(key: string) {
    await rm(this.absolute(key), { force: true });
  }

  async saveVideo(workspaceId: string, input: Readable, expectedSize: number) {
    const key = `${workspaceId}/${randomUUID()}.mp4`;
    const target = this.absolute(key);
    await mkdir(join(target, '..'), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > VIDEO_UPLOAD_LIMIT) return callback(new PayloadTooLargeException('视频不能超过 100 MiB'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input, verify, createWriteStream(target, { flags: 'wx' }));
      if (size !== expectedSize) throw new BadRequestException('视频上传未完成，请重试');
      if (!await validMp4(target, size)) throw new UnsupportedMediaTypeException('请选择有效的 MP4 视频文件');
      return { storageKey: key, size, checksum: hash.digest('hex') };
    } catch (error) {
      await this.remove(key).catch(() => undefined);
      throw error;
    }
  }

  videoPath(workspaceId: string, key: string) {
    if (!key.startsWith(workspaceId + '/') || !/^[a-f\d-]{36}\.mp4$/u.test(key.slice(workspaceId.length + 1))) {
      throw new NotFoundException('视频不存在');
    }
    return this.absolute(key);
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
