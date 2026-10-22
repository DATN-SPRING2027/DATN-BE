#!/usr/bin/env node
/**
 * Workspace work-item query-plan benchmark (design evidence only).
 *
 * Purpose: measure candidate MongoDB query/index strategies for the PROPOSED
 * workspace work-item read model (docs/workspace/07-performance-analysis.md)
 * before any Task API is approved. It does NOT touch continuum_task or any
 * service-owned database and does NOT exercise production code.
 *
 * Safety:
 *  - URI must be mongodb:// on a loopback host (127.0.0.1 / localhost / ::1).
 *  - Database name is uniquely generated per run (`datn_ws_perf_<pid>_<ts>_<rand>`),
 *    verified not to exist beforehand, and dropped in a `try / finally` block.
 *
 * Usage:
 *   node scripts/perf/workspace-query-plans.mjs [--uri mongodb://127.0.0.1:27017] [--iterations 20]
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';

export function createUniqueScratchDbName(prefix = 'datn_ws_perf') {
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
const STATUS_WEIGHTS = [0.28, 0.18, 0.08, 0.04, 0.37, 0.05];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
const TYPES = ['TASK', 'BUG', 'STORY'];

// Deterministic PRNG so runs are reproducible.
let seed = 20261022;
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function pick(values, weights) {
  if (!weights) return values[Math.floor(random() * values.length)];
  let roll = random();
  for (let index = 0; index < values.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return values[index];
  }
  return values[values.length - 1];
}

const BASE_DATE = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

function buildItems(projectId, count, members, sprints) {
  const items = [];
  const parents = [];
  for (let index = 0; index < count; index += 1) {
    const _id = new ObjectId();
    const isSubtask = parents.length > 0 && random() < 0.35;
    const created = BASE_DATE + Math.floor(random() * 300) * DAY;
    const hasDue = random() < 0.7;
    const due = created + Math.floor(random() * 45) * DAY;
    const doc = {
      _id,
      projectId,
      key: `P-${index + 1}`,
      title: `Work item ${index + 1} ${pick(['login', 'billing', 'search', 'report', 'sync', 'upload'])} flow`,
      type: pick(TYPES),
      status: pick(STATUSES, STATUS_WEIGHTS),
      priority: pick(PRIORITIES),
      assigneeId: random() < 0.85 ? pick(members) : null,
      reporterId: pick(members),
      parentId: isSubtask ? pick(parents) : null,
      sprintId: random() < 0.65 ? pick(sprints) : null,
      startDate: hasDue ? new Date(created) : null,
      dueDate: hasDue ? new Date(due) : null,
      createdAt: new Date(created),
      updatedAt: new Date(created + Math.floor(random() * 10) * DAY),
      version: 1,
      description: 'x'.repeat(200 + Math.floor(random() * 600)),
      labels: random() < 0.4 ? ['backend', 'p1'] : [],
    };
    if (!isSubtask && random() < 0.4) parents.push(_id);
    items.push(doc);
  }
  return items;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

async function time(fn, runs = iterations) {
  for (let warm = 0; warm < Math.min(3, runs); warm += 1) await fn();
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: +percentile(samples, 50).toFixed(2),
    p95: +percentile(samples, 95).toFixed(2),
    p99: +percentile(samples, 99).toFixed(2),
  };
}

function summarizeExplain(explain) {
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
    nReturned: stats?.nReturned,
    keysExamined: stats?.totalKeysExamined,
    docsExamined: stats?.totalDocsExamined,
    plan: stages.join(' <- '),
  };
}

async function main() {
  assertLoopback(uri);
  const scratchDbName = createUniqueScratchDbName('datn_ws_perf');
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
    const buildInfo = await client.db('admin').command({ buildInfo: 1 });
    const items = db.collection('work_items');

    const members = Array.from({ length: 12 }, () => new ObjectId());
    const sprints = Array.from({ length: 6 }, () => new ObjectId());
    const tiers = [
      { name: 'S', count: 1_000, projectId: new ObjectId() },
      { name: 'M', count: 10_000, projectId: new ObjectId() },
      { name: 'L', count: 100_000, projectId: new ObjectId() },
    ];
    const noiseProjects = 40;
    const loadStarted = Date.now();
    for (const tier of tiers) {
      const docs = buildItems(tier.projectId, tier.count, members, sprints);
      for (let offset = 0; offset < docs.length; offset += 5000) {
        await items.insertMany(docs.slice(offset, offset + 5000), {
          ordered: false,
        });
      }
      tier.sampleParents = docs
        .filter((doc) => doc.parentId === null)
        .slice(0, 50)
        .map((doc) => doc._id);
      tier.deepAfterId = docs
        .map((doc) => doc._id)
        .sort((a, b) => a.toHexString().localeCompare(b.toHexString()))[
        Math.min(docs.length - 1, 10_000 - 1)
      ];
    }
    for (let index = 0; index < noiseProjects; index += 1) {
      const docs = buildItems(new ObjectId(), 2_500, members, sprints);
      await items.insertMany(docs, { ordered: false });
    }
    const totalDocs = await items.estimatedDocumentCount();
    const collStats = await db.command({ collStats: 'work_items' });
    const loadSeconds = (Date.now() - loadStarted) / 1000;

    const assignee = members[0];
    const activeSprint = sprints[0];
    const windowStart = new Date(BASE_DATE + 120 * DAY);
    const windowEnd = new Date(BASE_DATE + 155 * DAY);
    const listProjection = {
      title: 1,
      key: 1,
      type: 1,
      status: 1,
      priority: 1,
      assigneeId: 1,
      dueDate: 1,
      parentId: 1,
      sprintId: 1,
      labels: 1,
      updatedAt: 1,
      version: 1,
    };

    const queries = (tier) => ({
      Q1_list_first_page_keyset: {
        run: () =>
          items
            .find({ projectId: tier.projectId }, { projection: listProjection })
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find({ projectId: tier.projectId }, { projection: listProjection })
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q2a_deep_page_offset_skip_9950: {
        run: () =>
          items
            .find({ projectId: tier.projectId }, { projection: listProjection })
            .sort({ _id: 1 })
            .skip(Math.min(9_950, tier.count - 50))
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find({ projectId: tier.projectId }, { projection: listProjection })
            .sort({ _id: 1 })
            .skip(Math.min(9_950, tier.count - 50))
            .limit(50)
            .explain('executionStats'),
      },
      Q2b_deep_page_keyset_afterId: {
        run: () =>
          items
            .find(
              { projectId: tier.projectId, _id: { $gt: tier.deepAfterId } },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              { projectId: tier.projectId, _id: { $gt: tier.deepAfterId } },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q3_filter_status_in_progress: {
        run: () =>
          items
            .find(
              { projectId: tier.projectId, status: 'IN_PROGRESS' },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              { projectId: tier.projectId, status: 'IN_PROGRESS' },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q4_filter_assignee_open_status: {
        run: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                assigneeId: assignee,
                status: { $in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                assigneeId: assignee,
                status: { $in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q5_calendar_due_window_35d: {
        run: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                dueDate: { $gte: windowStart, $lt: windowEnd },
              },
              { projection: { title: 1, key: 1, status: 1, dueDate: 1 } },
            )
            .sort({ dueDate: 1, _id: 1 })
            .limit(500)
            .toArray(),
        explain: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                dueDate: { $gte: windowStart, $lt: windowEnd },
              },
              { projection: { title: 1, key: 1, status: 1, dueDate: 1 } },
            )
            .sort({ dueDate: 1, _id: 1 })
            .limit(500)
            .explain('executionStats'),
      },
      Q6_board_status_counts: {
        run: () =>
          items
            .aggregate([
              { $match: { projectId: tier.projectId } },
              { $group: { _id: '$status', count: { $sum: 1 } } },
            ])
            .toArray(),
        explain: () =>
          items
            .aggregate([
              { $match: { projectId: tier.projectId } },
              { $group: { _id: '$status', count: { $sum: 1 } } },
            ])
            .explain('executionStats'),
      },
      Q7a_subtask_counts_N_plus_1: {
        run: () =>
          Promise.all(
            tier.sampleParents.map((parentId) =>
              items.countDocuments({ projectId: tier.projectId, parentId }),
            ),
          ),
        explain: null,
      },
      Q7a_subtask_counts_N_plus_1_sequential: {
        runs: 5,
        run: async () => {
          for (const parentId of tier.sampleParents)
            await items.countDocuments({ projectId: tier.projectId, parentId });
        },
        explain: null,
      },
      Q7b_subtask_counts_batched: {
        run: () =>
          items
            .aggregate([
              {
                $match: {
                  projectId: tier.projectId,
                  parentId: { $in: tier.sampleParents },
                },
              },
              {
                $group: {
                  _id: '$parentId',
                  total: { $sum: 1 },
                  done: {
                    $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] },
                  },
                },
              },
            ])
            .toArray(),
        explain: () =>
          items
            .aggregate([
              {
                $match: {
                  projectId: tier.projectId,
                  parentId: { $in: tier.sampleParents },
                },
              },
              {
                $group: {
                  _id: '$parentId',
                  total: { $sum: 1 },
                  done: {
                    $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] },
                  },
                },
              },
            ])
            .explain('executionStats'),
      },
      Q8_overview_facet: {
        run: () =>
          items
            .aggregate([
              { $match: { projectId: tier.projectId } },
              {
                $facet: {
                  byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
                  byPriority: [
                    { $group: { _id: '$priority', n: { $sum: 1 } } },
                  ],
                  byType: [{ $group: { _id: '$type', n: { $sum: 1 } } }],
                  byAssignee: [
                    { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
                  ],
                },
              },
            ])
            .toArray(),
        explain: () =>
          items
            .aggregate([
              { $match: { projectId: tier.projectId } },
              {
                $facet: {
                  byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
                },
              },
            ])
            .explain('executionStats'),
      },
      Q9_title_contains_search: {
        run: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                title: { $regex: 'billing', $options: 'i' },
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                title: { $regex: 'billing', $options: 'i' },
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q9b_title_contains_rare_term: {
        run: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                title: { $regex: 'nomatchterm', $options: 'i' },
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                title: { $regex: 'nomatchterm', $options: 'i' },
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q10_calendar_unscheduled: {
        run: () =>
          items
            .find(
              { projectId: tier.projectId, dueDate: null },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              { projectId: tier.projectId, dueDate: null },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q11_timeline_top_level: {
        run: () =>
          items
            .find(
              { projectId: tier.projectId, parentId: null },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              { projectId: tier.projectId, parentId: null },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q12_sprint_board_column: {
        run: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                sprintId: activeSprint,
                status: 'IN_PROGRESS',
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .toArray(),
        explain: () =>
          items
            .find(
              {
                projectId: tier.projectId,
                sprintId: activeSprint,
                status: 'IN_PROGRESS',
              },
              { projection: listProjection },
            )
            .sort({ _id: 1 })
            .limit(50)
            .explain('executionStats'),
      },
      Q8b_overview_parallel_groups: {
        run: () =>
          Promise.all([
            items
              .aggregate([
                { $match: { projectId: tier.projectId } },
                { $group: { _id: '$status', n: { $sum: 1 } } },
              ])
              .toArray(),
            items
              .aggregate([
                { $match: { projectId: tier.projectId } },
                { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
              ])
              .toArray(),
            items
              .aggregate([
                { $match: { projectId: tier.projectId } },
                {
                  $group: {
                    _id: { p: '$priority', t: '$type' },
                    n: { $sum: 1 },
                  },
                },
              ])
              .toArray(),
          ]),
        explain: null,
      },
    });

    async function runPhase(label) {
      const results = [];
      for (const tier of tiers) {
        for (const [name, query] of Object.entries(queries(tier))) {
          const latency = await time(query.run, query.runs);
          const plan = query.explain
            ? summarizeExplain(await query.explain())
            : {};
          results.push({
            phase: label,
            tier: tier.name,
            items: tier.count,
            query: name,
            ...latency,
            ...plan,
          });
        }
      }
      return results;
    }

    // Phase A: only the already-approved Task index shape {projectId, _id}.
    await items.createIndex(
      { projectId: 1, _id: 1 },
      { name: 'project_cursor' },
    );
    const phaseA = await runPhase('A_existing_index_only');

    // Phase B: first candidate set, with PARTIAL due/parent indexes.
    await items.createIndexes([
      {
        key: { projectId: 1, status: 1, _id: 1 },
        name: 'project_status_cursor',
      },
      {
        key: { projectId: 1, assigneeId: 1, status: 1, _id: 1 },
        name: 'project_assignee_status_cursor',
      },
      {
        key: { projectId: 1, sprintId: 1, status: 1, _id: 1 },
        name: 'project_sprint_status_cursor',
      },
      {
        key: { projectId: 1, dueDate: 1, _id: 1 },
        name: 'project_due_cursor',
        partialFilterExpression: { dueDate: { $type: 'date' } },
      },
      {
        key: { projectId: 1, parentId: 1, _id: 1 },
        name: 'project_parent_cursor',
        partialFilterExpression: { parentId: { $type: 'objectId' } },
      },
    ]);
    const phaseB = await runPhase('B_partial_due_parent');

    // Phase C: final proposal — NON-partial due/parent indexes (also serve dueDate:null / parentId:null).
    await items.dropIndex('project_due_cursor');
    await items.dropIndex('project_parent_cursor');
    await items.createIndexes([
      { key: { projectId: 1, dueDate: 1, _id: 1 }, name: 'project_due_cursor' },
      {
        key: { projectId: 1, parentId: 1, _id: 1 },
        name: 'project_parent_cursor',
      },
    ]);
    const phaseC = await runPhase('C_final_proposal');

    const indexStats = await db.command({ collStats: 'work_items' });

    // Write-cost check: insert 2,000 docs with the final index set vs the existing index only.
    async function insertCost(label) {
      const docs = buildItems(new ObjectId(), 2_000, members, sprints);
      const started = process.hrtime.bigint();
      for (let offset = 0; offset < docs.length; offset += 100) {
        await items.insertMany(docs.slice(offset, offset + 100), {
          ordered: false,
        });
      }
      return {
        label,
        msPer1000Docs: +(
          Number(process.hrtime.bigint() - started) /
          1e6 /
          2
        ).toFixed(2),
      };
    }
    const writeWithC = await insertCost('final proposal (6 indexes + _id)');
    for (const name of [
      'project_status_cursor',
      'project_assignee_status_cursor',
      'project_sprint_status_cursor',
      'project_due_cursor',
      'project_parent_cursor',
    ]) {
      await items.dropIndex(name);
    }
    const writeWithA = await insertCost('existing project_cursor + _id only');

    // Payload size: compact list projection vs full document.
    const sampleFull = await items
      .find({ projectId: tiers[1].projectId })
      .limit(50)
      .toArray();
    const sampleCompact = await items
      .find({ projectId: tiers[1].projectId }, { projection: listProjection })
      .limit(50)
      .toArray();
    const payload = {
      fullJsonBytesPer50: Buffer.byteLength(JSON.stringify(sampleFull)),
      compactJsonBytesPer50: Buffer.byteLength(JSON.stringify(sampleCompact)),
    };

    console.log(
      JSON.stringify(
        {
          environment: {
            mongodVersion: buildInfo.version,
            topology: 'standalone loopback',
            node: process.version,
            scratchDbName,
            iterations,
            totalDocs,
            dataSizeMB: +(collStats.size / 1024 / 1024).toFixed(1),
            loadSeconds,
          },
          indexSizesKB: Object.fromEntries(
            Object.entries(indexStats.indexSizes).map(([k, v]) => [
              k,
              Math.round(v / 1024),
            ]),
          ),
          writeCost: [writeWithA, writeWithC],
          payload,
          results: [...phaseA, ...phaseB, ...phaseC],
        },
        null,
        2,
      ),
    );
  } finally {
    if (dbCreated) {
      await client
        .db(scratchDbName)
        .dropDatabase()
        .catch(() => {});
    }
    await client.close().catch(() => {});
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
