import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyContent, buildBackfill, validateDatabaseName, indexes } from './work-note-agent.plan.mjs';
test('deterministic legacy conversion preserves inner whitespace and never overwrites an upgraded note', () => {
 const legacy={title:'Note',whatDone:'A\r\n  B',howSolved:'C',whyThisWay:'D'};
 assert.equal(legacyContent(legacy),'## Accomplishments\nA\r\n  B\n\n## Approach\nC\n\n## Reason\nD');
 assert.equal(buildBackfill({...legacy,contentSchemaVersion:2,contentMarkdown:'custom'}),null);
 assert.deepEqual(buildBackfill(legacy),{contentSchemaVersion:2,contentMarkdown:legacyContent(legacy),currentVersionNumber:1});
});
test('rejects missing legacy content, wrong database and over-budget notes',()=>{
 assert.throws(()=>buildBackfill({title:'x',whatDone:'a',howSolved:'b',whyThisWay:'c',currentVersionNumber:0}));
 assert.throws(()=>buildBackfill({whatDone:'a',howSolved:'b',whyThisWay:'c'}));
 assert.throws(()=>legacyContent({whatDone:'A'}));
 assert.throws(()=>validateDatabaseName('continuum_iam'));
 assert.throws(()=>legacyContent({whatDone:'a'.repeat(30001),howSolved:'b',whyThisWay:'c'}));
 assert.equal(indexes.work_note_agent_drafts.find(i=>i.expireAfterSeconds===0).key.expiresAt,1);
});
