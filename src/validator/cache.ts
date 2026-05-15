import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

interface CacheRecord<T> {
  createdAt: string;
  ttlMs: number;
  value: T;
}

export class FileCache {
  constructor(
    private readonly cacheDir: string,
    private readonly defaultTtlMs = 7 * 24 * 60 * 60 * 1000,
    private readonly disabled = false,
  ) {}

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    if (this.disabled) return undefined;
    const filePath = this.toFilePath(namespace, key);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const record = JSON.parse(raw) as CacheRecord<T>;
      const createdAtMs = Date.parse(record.createdAt);
      if (!Number.isFinite(createdAtMs)) return undefined;
      if (Date.now() - createdAtMs > record.ttlMs) return undefined;
      return record.value;
    } catch {
      return undefined;
    }
  }

  async set<T>(namespace: string, key: string, value: T, ttlMs = this.defaultTtlMs): Promise<void> {
    if (this.disabled) return;
    const filePath = this.toFilePath(namespace, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const record: CacheRecord<T> = {
      createdAt: new Date().toISOString(),
      ttlMs,
      value,
    };
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  }

  private toFilePath(namespace: string, key: string): string {
    const hash = createHash("sha256").update(key).digest("hex");
    return path.join(this.cacheDir, namespace, `${hash}.json`);
  }
}
