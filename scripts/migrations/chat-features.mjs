import { MongoClient } from 'mongodb';
export const indexes = [
  [
    'chat_notifications',
    { organizationId: 1, userId: 1, createdAt: -1, _id: -1 },
    {},
  ],
  [
    'chat_notifications',
    { organizationId: 1, userId: 1, messageId: 1 },
    { unique: true },
  ],
  [
    'chat_blocks',
    { organizationId: 1, userId: 1, targetId: 1 },
    { unique: true },
  ],
  [
    'chat_reports',
    { organizationId: 1, status: 1, createdAt: -1, _id: -1 },
    {},
  ],
];
const apply = process.argv.includes('--apply');
if (apply && process.env.NODE_ENV !== 'development')
  throw new Error('Apply is restricted to development');
const client = new MongoClient(
  process.env.CHAT_MONGODB_URI ?? process.env.MONGODB_URI,
  { serverSelectionTimeoutMS: 10000 },
);
try {
  await client.connect();
  const database = client.db('continuum_chat');
  for (const [collection, fields, options] of indexes) {
    console.log(
      JSON.stringify({
        collection,
        fields,
        options,
        action: apply ? 'ENSURE_INDEX' : 'WOULD_ENSURE_INDEX',
      }),
    );
    if (apply)
      await database.collection(collection).createIndex(fields, options);
  }
  let count = 0;
  for await (const message of database
    .collection('chat_conversation_messages')
    .find(
      { links: { $exists: false } },
      { projection: { _id: 1, content: 1 } },
    )) {
    const links = [];
    for (const candidate of String(message.content ?? '').match(
      /https?:\/\/[^\s<>]+/giu,
    ) ?? []) {
      try {
        const url = new URL(candidate.replace(/[),.;!?]+$/u, ''));
        if (!url.username && !url.password) links.push(url.href);
      } catch {
        /* Keep malformed URLs as plain text. */
      }
    }
    if (apply)
      await database
        .collection('chat_conversation_messages')
        .updateOne(
          { _id: message._id, links: { $exists: false } },
          { $set: { links: [...new Set(links)].slice(0, 50) } },
        );
    count++;
  }
  console.log(
    JSON.stringify({ messagesNeedingLinksBackfill: count, applied: apply }),
  );
} catch (error) {
  console.error('Chat feature migration failed:', error.codeName ?? error.name);
  process.exitCode = 1;
} finally {
  await client.close();
}
