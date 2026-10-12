import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

function hashString(content) {
  return createHash('sha256').update(content || '', 'utf8').digest('hex');
}

export class MirrorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.directory = dirname(filePath);
    this.lastWrittenHash = null;
    this.lastWrittenMtime = 0;
  }

  static forSession(sessionId, workspaceRoot = process.cwd(), customFilename = 'LIVE_CONTEXT.md') {
    // Almacena preferentemente en .dsh/clm en el workspace para visibilidad del agente,
    // o fallback en tmpdir si workspaceRoot no está disponible
    const baseDir = workspaceRoot
      ? join(workspaceRoot, '.dsh', 'clm')
      : join(tmpdir(), 'dsh-clm', sessionId || 'default');
    const filePath = join(baseDir, customFilename);
    return new MirrorStore(filePath);
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
  }

  async write(content) {
    await this.init();
    const tempPath = join(this.directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, content, { encoding: 'utf8', flag: 'w' });
      await rename(tempPath, this.filePath);
      this.lastWrittenHash = hashString(content);
      const st = await stat(this.filePath).catch(() => null);
      this.lastWrittenMtime = st ? st.mtimeMs : Date.now();
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async read() {
    try {
      return await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async hasChanged() {
    try {
      const st = await stat(this.filePath);
      if (!this.lastWrittenHash) return false;
      // Comprobación rápida por timestamp
      if (st.mtimeMs <= this.lastWrittenMtime) {
        return false;
      }
      // Comprobación exacta por hash
      const currentContent = await readFile(this.filePath, 'utf8');
      const currentHash = hashString(currentContent);
      return currentHash !== this.lastWrittenHash;
    } catch {
      return false;
    }
  }

  async cleanup() {
    try {
      await rm(this.filePath, { force: true });
    } catch {}
  }
}
