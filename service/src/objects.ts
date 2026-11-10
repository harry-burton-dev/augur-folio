import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { AppStorage } from '@augur/service-kit';

/**
 * Where Folio keeps the files people upload, exactly as they were sent: its own
 * bucket on the platform's object store (docs/app-storage.md).
 */
export interface ObjectStore {
  /** Streams a file in. Rejects, keeping nothing, when the stream fails. */
  put(key: string, body: Readable, contentType: string): Promise<void>;
  /** Streams a file out, or undefined when there is none. */
  get(key: string): Promise<Readable | undefined>;
  delete(key: string): Promise<void>;
}

/** Keeps files in memory: for tests and `pnpm dev:app`. */
export class MemoryObjectStore implements ObjectStore {
  readonly files = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Readable, contentType: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    this.files.set(key, { body: Buffer.concat(chunks), contentType });
  }

  async get(key: string) {
    const file = this.files.get(key);
    return file && Readable.from([file.body]);
  }

  async delete(key: string) {
    this.files.delete(key);
  }
}

/** Folio's bucket on the platform's S3-compatible store. */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(bucket: NonNullable<AppStorage['bucket']>) {
    this.bucket = bucket.name;
    this.s3 = new S3Client({
      endpoint: bucket.endpoint,
      region: bucket.region,
      forcePathStyle: bucket.forcePathStyle,
      credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
    });
  }

  async put(key: string, body: Readable, contentType: string) {
    // In parts, so a 200 MB upload is never held in memory and its length needn't be known first.
    await new Upload({ client: this.s3, params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType } }).done();
  }

  async get(key: string) {
    try {
      const { Body } = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Body as Readable | undefined;
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
