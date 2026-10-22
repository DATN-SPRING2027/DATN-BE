#!/usr/bin/env node
/**
 * Manager (organization-wide) task query benchmark (design evidence only).
 *
 * Compares two ways to serve the Manager "all projects" view:
 *   A. denormalized `organizationId` on each task + {organizationId, ...} indexes
 *   B. no schema change: caller supplies the Organization's projectIds and the
 *      existing {projectId, ...} indexes are used with `$in`
 *
 * Safety:
 *  - Loopback mongodb:// only.
 *  - Uniquely generated scratch database per run (`datn_ws_org_perf_<pid>_<ts>_<rand>`),
 *    verified not to exist beforehand, and dropped in a `try / finally` block.
 *  - Never touches continuum_task or any service DB.
 *
 * Usage:
 *   node scripts/perf/workspace-org-queries.mjs [--uri mongodb://127.0.0.1:27017] [--iterations 20]
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';

export function createUniqueScratchDbName(prefix = 'datn_ws_org_perf') {
  const suffix = randomBytes(4).toString('hex');
  return `${prefix}_${process.pid}_${Date.now()}_${suffix}`;
}

const args = new Map(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const uri =
  args.get('uri') ?? 'mongodb://127.0.0.1:27017/?directConnection=true';
const iterations = Number(args.get('iterations') ?? 20);

export function assertLoopback(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'mongodb:')
    throw new Error('Only mongodb:// URIs are allowed.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing non-loopback host: ${host}`);
  }
}

const STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'BLOCKED',
  'DONE',
  'CANCELLED',
];
const WEIGHTS = [0.28, 0.18, 0.08, 0.04, 0.37, 0.05];
let seed = 20261022;
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function pickStatus() {
  let roll = random();
  for (let index = 0; index < STATUSES.length; index += 1) {
    roll -= WEIGHTS[index];
    if (roll <= 0) return STATUSES[index];
  }
  return STATUSES[STATUSES.length - 1];
}
const BASE = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

function buildOrg(organizationId, projectCount, perProject, members) {
  const projectIds = Array.from({ length: projectCount }, () => new ObjectId());
  const docs = [];
  for (const projectId of projectIds) {
    for (let index = 0; index < perProject; index += 1) {
      const created = BASE + Math.floor(random() * 300) * DAY;
      docs.push({
        _id: new ObjectId(),
        organizationId,
        projectId,
        title: `Task ${index} flow`,
        status: pickStatus(),
        priority: 'MEDIUM',
        assigneeId: members[Math.floor(random() * members.length)],
        dueDate:
          random() < 0.7
            ? new Date(created + Math.floor(random() * 45) * DAY)
            : null,
        createdAt: new Date(created),
        version: 1,
      });
    }
  }
  return { projectIds, docs };
}

function percentile(sorted, p) {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

async function time(fn) {
  for (let warm = 0; warm < 3; warm += 1) await fn();
  const samples = [];
  for (let run = 0; run < iterations; run += 1) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: +percentile(samples, 50).toFixed(2),
    p95: +percentile(samples, 95).toFixed(2),
  };
}

function summarize(explain) {
  const stats =
    explain.executionStats ?? explain.stages?.[0]?.$cursor?.executionStats;
  const plan =
    explain.queryPlanner?.winningPlan ??
    explain.stages?.[0]?.$cursor?.queryPlanner?.winningPlan;
  const stages = [];
  const walk = (node) => {
    if (!node) return;
    const stage = node.stage ?? node.queryPlan?.stage;
    if (stage)
      stages.push(node.indexName ? `${stage}(${node.indexName})` : stage);
    walk(node.inputStage ?? node.queryPlan?.inputStage);
    (node.inputStages ?? []).forEach(walk);
  };
  walk(plan?.queryPlan ?? plan);
  return {
    keys: stats?.totalKeysExamined,
    docs: stats?.totalDocsExamined,
    plan: [...new Set(stages)].join(' <- '),
  };
}

async function main() {
  assertLoopback(uri);
  const scratchDbName = createUniqueScratchDbName('datn_ws_org_perf');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  let dbCreated = false;

  try {
    const existing = await client
      .db('admin')
      .command({ listDatabases: 1, nameOnly: true });
    if (existing.databases?.some((entry) => entry.name === scratchDbName)) {
      throw new Error(
        `Refusing to run: scratch database ${scratchDbName} already exists.`,
      );
    }

    const db = client.db(scratchDbName);
    dbCreated = true;
    const tasks = db.collection('tasks');
    const members = Array.from({ length: 30 }, () => new ObjectId());

    // Target org: 40 projects x 2,500 tasks = 100k. Three noise orgs of equal size.
    const targetOrg = new ObjectId();
    const target = buildOrg(targetOrg, 40, 2_500, members);
    const noiseOrgs = [new ObjectId(), new ObjectId(), new ObjectId()];
    const all = [target.docs];
    for (const org of noiseOrgs)
      all.push(buildOrg(org, 40, 2_500, members).docs);
    for (const docs of all) {
      for (let offset = 0; offset < docs.length; offset += 5000) {
        await tasks.insertMany(docs.slice(offset, offset + 5000), {
          ordered: false,
        });
      }
    }
    const totalDocs = await tasks.estimatedDocumentCount();
    const projectIds = target.projectIds;
    const assignee = members[0];
    const openStatuses = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'];
    const now = new Date(BASE + 160 * DAY);
    const dueStart = new Date(BASE + 120 * DAY);
    const dueEnd = new Date(BASE + 155 * DAY);
    const projection = {
      title: 1,
      status: 1,
      assigneeId: 1,
      dueDate: 1,
      projectId: 1,
    };

    const strategies = {
      A_organizationId: {
        list: () =>
          tasks
            .find({ organizationId: targetOrg }, { projection })
            .sort({ _id: 1 })
            .limit(50),
        status: () =>
          tasks
            .find(
              { organizationId: targetOrg, status: 'IN_PROGRESS' },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        assigneeOnly: () =>
          tasks
            .find(
              {
                organizationId: targetOrg,
                assigneeId: assignee,
              },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        assigneeStatus: () =>
          tasks
            .find(
              {
                organizationId: targetOrg,
                assigneeId: assignee,
                status: { $in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
              },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        dueWindow: () =>
          tasks
            .find(
              {
                organizationId: targetOrg,
                dueDate: { $gte: dueStart, $lt: dueEnd },
              },
              { projection },
            )
            .sort({ dueDate: 1, _id: 1 })
            .limit(50),
        oneProject: () =>
          tasks
            .find(
              { organizationId: targetOrg, projectId: projectIds[7] },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        summary: () =>
          tasks.aggregate([
            { $match: { organizationId: targetOrg } },
            {
              $group: {
                _id: { p: '$projectId', s: '$status' },
                n: { $sum: 1 },
              },
            },
          ]),
        overdue: () =>
          tasks.aggregate([
            {
              $match: {
                organizationId: targetOrg,
                status: { $in: openStatuses },
                dueDate: { $lt: now },
              },
            },
            { $group: { _id: '$projectId', n: { $sum: 1 } } },
          ]),
      },
      B_projectId_in: {
        list: () =>
          tasks
            .find({ projectId: { $in: projectIds } }, { projection })
            .sort({ _id: 1 })
            .limit(50),
        status: () =>
          tasks
            .find(
              { projectId: { $in: projectIds }, status: 'IN_PROGRESS' },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        assigneeOnly: () =>
          tasks
            .find(
              {
                projectId: { $in: projectIds },
                assigneeId: assignee,
              },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        assigneeStatus: () =>
          tasks
            .find(
              {
                projectId: { $in: projectIds },
                assigneeId: assignee,
                status: { $in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
              },
              { projection },
            )
            .sort({ _id: 1 })
            .limit(50),
        dueWindow: () =>
          tasks
            .find(
              {
                projectId: { $in: projectIds },
                dueDate: { $gte: dueStart, $lt: dueEnd },
              },
              { projection },
            )
            .sort({ dueDate: 1, _id: 1 })
            .limit(50),
        oneProject: () =>
          tasks
            .find({ projectId: projectIds[7] }, { projection })
            .sort({ _id: 1 })
            .limit(50),
        summary: () =>
          tasks.aggregate([
            { $match: { projectId: { $in: projectIds } } },
            {
              $group: {
                _id: { p: '$projectId', s: '$status' },
                n: { $sum: 1 },
              },
            },
          ]),
        overdue: () =>
          tasks.aggregate([
            {
              $match: {
                projectId: { $in: projectIds },
                status: { $in: openStatuses },
                dueDate: { $lt: now },
              },
            },
            { $group: { _id: '$projectId', n: { $sum: 1 } } },
          ]),
      },
    };

    async function run(label) {
      const out = [];
      for (const [name, queries] of Object.entries(strategies)) {
        for (const [query, build] of Object.entries(queries)) {
          const isAggregate = query === 'summary' || query === 'overdue';
          const latency = await time(async () => {
            await build().toArray();
          });
          const explain = await build().explain('executionStats');
          out.push({
            phase: label,
            strategy: name,
            query,
            ...latency,
            ...summarize(explain),
            aggregate: isAggregate,
          });
        }
      }
      return out;
    }

    // Phase 1: project-scoped indexes.
    await tasks.createIndexes([
      { key: { projectId: 1, _id: 1 }, name: 'project_cursor' },
      {
        key: { projectId: 1, status: 1, _id: 1 },
        name: 'project_status_cursor',
      },
      {
        key: { projectId: 1, assigneeId: 1, _id: 1, status: 1 },
        name: 'project_assignee_cursor_status',
      },
      { key: { projectId: 1, dueDate: 1, _id: 1 }, name: 'project_due_cursor' },
    ]);
    const phaseB = await run('1_project_indexes_only');

    // Phase 2: add the organizationId indexes required by strategy A.
    await tasks.createIndexes([
      { key: { organizationId: 1, _id: 1 }, name: 'org_cursor' },
      {
        key: { organizationId: 1, status: 1, _id: 1 },
        name: 'org_status_cursor',
      },
      {
        key: { organizationId: 1, projectId: 1, _id: 1 },
        name: 'org_project_cursor',
      },
      {
        key: { organizationId: 1, assigneeId: 1, _id: 1, status: 1 },
        name: 'org_assignee_cursor_status',
      },
      {
        key: { organizationId: 1, dueDate: 1, _id: 1 },
        name: 'org_due_cursor',
      },
      {
        key: { organizationId: 1, projectId: 1, status: 1, dueDate: 1 },
        name: 'org_project_status_due',
      },
    ]);
    const phaseA = await run('2_plus_organization_indexes');

    const stats = await db.command({ collStats: 'tasks' });
    console.log(
      JSON.stringify(
        {
          environment: {
            scratchDbName,
            totalDocs,
            targetOrgDocs: target.docs.length,
            projects: projectIds.length,
            iterations,
          },
          indexSizesKB: Object.fromEntries(
            Object.entries(stats.indexSizes).map(([k, v]) => [
              k,
              Math.round(v / 1024),
            ]),
          ),
          results: [...phaseB, ...phaseA],
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanupScratchDatabase(client, scratchDbName, dbCreated);
  }
}

export async function cleanupScratchDatabase(client, scratchDbName, dbCreated) {
  try {
    if (dbCreated) {
      await client.db(scratchDbName).dropDatabase();
    }
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
