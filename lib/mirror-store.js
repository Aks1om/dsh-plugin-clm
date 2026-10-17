import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parseHeader } from './context-document.js';

function hashString(content) {
  return createHash('sha256').update(content || '', 'utf8').digest('hex');
}

export class MirrorStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.directory = dirname(filePath);
    this.globalPath = options.globalPath || null;
    this.sessionId = options.sessionId || 'default';
    this.lastWrittenHash = null;
    this.lastWrittenMtime = 0;
    this.lastGlobalHash = null;
    this.lastGlobalMtime = 0;
    this._readSource = 'file';
  }

  static forSession(sessionId, workspaceRoot = process.cwd(), customFilename = 'LIVE_CONTEXT.md') {
    const safeSessionId = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const clmDir = workspaceRoot
      ? join(workspaceRoot, '.dsh', 'clm')
      : join(tmpdir(), 'dsh-clm');

    const sessionsDir = join(clmDir, 'sessions');
    const privateFilePath = safeSessionId === 'default'
      ? join(clmDir, customFilename)
      : join(sessionsDir, `${safeSessionId}.md`);

    const globalPath = join(clmDir, customFilename);

    return new MirrorStore(privateFilePath, {
      globalPath: safeSessionId === 'default' ? null : globalPath,
      sessionId: safeSessionId,
    });
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    if (this.globalPath) {
      await mkdir(dirname(this.globalPath), { recursive: true });
    }
  }

  async write(content) {
    await this.init();

    // 1. Escritura atómica en el archivo privado y aislado de la sesión
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

    // 2. Si existe un espejo global (LIVE_CONTEXT.md), actualizarlo atómicamente como vista activa
    if (this.globalPath) {
      const globalDir = dirname(this.globalPath);
      const globalTemp = join(globalDir, `.${basename(this.globalPath)}.${randomUUID()}.tmp`);
      try {
        await writeFile(globalTemp, content, { encoding: 'utf8', flag: 'w' });
        await rename(globalTemp, this.globalPath);
        this.lastGlobalHash = hashString(content);
        const gst = await stat(this.globalPath).catch(() => null);
        this.lastGlobalMtime = gst ? gst.mtimeMs : Date.now();
      } catch (err) {
        await rm(globalTemp, { force: true }).catch(() => undefined);
      }
    }
  }

  async read() {
    // Si la última comprobación detectó un cambio en el archivo global atribuible a esta sesión, leer el global
    if (this._readSource === 'global' && this.globalPath) {
      try {
        return await readFile(this.globalPath, 'utf8');
      } catch {}
    }

    try {
      return await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async hasChanged() {
    this._readSource = 'file';

    // 1. Comprobar si el archivo privado de la sesión ha cambiado en disco
    try {
      const currentContent = await readFile(this.filePath, 'utf8');
      const currentHash = hashString(currentContent);
      if (this.lastWrittenHash && currentHash !== this.lastWrittenHash) {
        return true;
      }
      if (!this.lastWrittenHash) {
        this.lastWrittenHash = currentHash;
      }
    } catch {
      // El archivo privado aún no existe
    }

    // 2. Comprobar si el archivo global LIVE_CONTEXT.md fue editado por el usuario para ESTA sesión
    if (this.globalPath) {
      try {
        const globalContent = await readFile(this.globalPath, 'utf8');
        const header = parseHeader(globalContent);
        // Sólo considerar cambios en globalPath si el header coincide con esta sesión
        if (header && header.session === this.sessionId) {
          const currentGlobalHash = hashString(globalContent);
          if (this.lastGlobalHash && currentGlobalHash !== this.lastGlobalHash) {
            this._readSource = 'global';
            return true;
          }
          if (!this.lastGlobalHash) {
            this.lastGlobalHash = currentGlobalHash;
          }
        }
      } catch {}
    }

    return false;
  }

  async cleanup() {
    try {
      await rm(this.filePath, { force: true });
    } catch {}
  }
}
