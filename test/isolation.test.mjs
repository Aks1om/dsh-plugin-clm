import { rm, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';
import { MirrorStore } from '../lib/mirror-store.js';
import {
  renderContextDocument,
  applyContextDocument,
  parseHeader,
} from '../lib/context-document.js';

async function runTests() {
  console.log('--- TEST SUITE: dsh-plugin-clm Session Isolation & Anti-Collision ---');
  const testWorkspace = join(tmpdir(), 'dsh-clm-test-' + Date.now());
  await mkdir(testWorkspace, { recursive: true });

  try {
    // 1. Test forSession path isolation
    console.log('1. Checking path isolation between sessions...');
    const storeA = MirrorStore.forSession('session-A', testWorkspace);
    const storeB = MirrorStore.forSession('session-B', testWorkspace);
    assert.notStrictEqual(storeA.filePath, storeB.filePath, 'Paths must be distinct!');
    assert(storeA.filePath.includes('session-A.md'), 'Path A must contain session-A.md');
    assert(storeB.filePath.includes('session-B.md'), 'Path B must contain session-B.md');
    console.log('   OK: Paths are distinct:');
    console.log('       A ->', storeA.filePath);
    console.log('       B ->', storeB.filePath);

    // 2. Test independent writing and reading
    console.log('2. Testing independent writing and reading...');
    const contentA = renderContextDocument(
      [{ id: 'msg-1', role: 'user', content: 'Hola desde sesion A' }],
      { sessionId: 'session-A', persistentNotes: 'Notas de la sesion A' }
    );
    await storeA.write(contentA.text);

    const contentB = renderContextDocument(
      [{ id: 'msg-2', role: 'user', content: 'Hola desde sesion B' }],
      { sessionId: 'session-B', persistentNotes: 'Notas de la sesion B' }
    );
    await storeB.write(contentB.text);

    const readBackA = await storeA.read();
    const readBackB = await storeB.read();
    assert(readBackA.includes('Notas de la sesion A'), 'A must contain A notes');
    assert(!readBackA.includes('Notas de la sesion B'), 'A must NOT contain B notes');
    assert(readBackB.includes('Notas de la sesion B'), 'B must contain B notes');
    assert(!readBackB.includes('Notas de la sesion A'), 'B must NOT contain A notes');
    console.log('   OK: Content is strictly isolated.');

    // 3. Test global mirror (LIVE_CONTEXT.md) and parseHeader
    console.log('3. Testing global mirror header and attribution...');
    const globalContent = await readFile(storeB.globalPath, 'utf8');
    const header = parseHeader(globalContent);
    assert.strictEqual(header.session, 'session-B', 'Global mirror must be attributed to session-B');
    console.log('   OK: Global mirror is correctly stamped with session:', header.session);

    // 4. Test change detection: Session A should NOT see Session B global write as a change
    console.log('4. Testing cross-session change rejection...');
    const hasChangedA = await storeA.hasChanged();
    assert.strictEqual(hasChangedA, false, 'Session A must NOT detect changes made by Session B!');
    console.log('   OK: Session A ignored Session B modifications.');

    // 5. Test applyContextDocument foreign conversation firewall
    console.log('5. Testing applyContextDocument foreign conversation blocks firewall...');
    // Suppose Session B's content was mistakenly passed to Session A's snapshot
    const attempt = applyContextDocument(contentB.text, contentA);
    assert.strictEqual(attempt.changed, false, 'Foreign conversation document must be REJECTED');
    assert(
      attempt.reason === 'session-mismatch' || attempt.reason === 'foreign-conversation-blocks',
      'Reason must be firewall: ' + attempt.reason
    );
    console.log('   OK: Firewall rejected foreign document with reason:', attempt.reason);

    console.log('\n>>> ALL 5 ISOLATION TESTS PASSED SUCCESSFULLY! <<<');
  } finally {
    await rm(testWorkspace, { recursive: true, force: true }).catch(() => {});
  }
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
