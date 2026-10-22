import { MongoClient } from 'mongodb';

export const searchFields = (fields) => ({
  analyzers: [
    {
      name: 'folded',
      tokenizer: { type: 'standard' },
      tokenFilters: [{ type: 'icuFolding' }],
    },
  ],
  mappings: {
    dynamic: false,
    fields: {
      _id: { type: 'objectId' },
      organizationId: { type: 'objectId' },
      conversationId: { type: 'objectId' },
      senderId: { type: 'token' },
      userId: { type: 'token' },
      status: { type: 'token' },
      createdAt: { type: 'date' },
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          field === 'content'
            ? { type: 'string', analyzer: 'folded', searchAnalyzer: 'folded' }
            : [
                {
                  type: 'autocomplete',
                  tokenization: 'edgeGram',
                  minGrams: 2,
                  maxGrams: 80,
                  foldDiacritics: true,
                  analyzer: 'folded',
                },
                {
                  type: 'string',
                  analyzer: 'folded',
                  searchAnalyzer: 'folded',
                },
              ],
        ]),
      ),
    },
  },
});

export const plans = [
  ['continuum_chat', 'chat_conversation_messages', ['content']],
  ['continuum_chat', 'chat_members', ['searchLabel']],
  ['continuum_iam', 'users', ['fullName', 'email']],
];

if (process.argv[1]?.endsWith('chat-search-indexes.mjs')) {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.NODE_ENV !== 'development')
    throw new Error('Apply is restricted to the development environment');
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    if (apply) {
      const database = client.db('continuum_chat');
      // Backfill per-member labels: direct chats contain only the peer's name.
      for await (const conversation of database
        .collection('chat_conversations')
        .find({})) {
        const members = await database
          .collection('chat_members')
          .find({ conversationId: conversation._id })
          .toArray();
        for (const member of members) {
          const label =
            conversation.type === 'ROOM'
              ? (conversation.title ?? '')
              : (members.find((peer) => peer.userId !== member.userId)
                  ?.displayName ?? '');
          await database
            .collection('chat_members')
            .updateOne({ _id: member._id }, { $set: { searchLabel: label } });
        }
      }
      // This obsolete index was created only by the first development dry implementation.
      const obsolete = await database
        .collection('chat_conversations')
        .listSearchIndexes('chat_search_v1')
        .toArray();
      if (obsolete.length)
        await database
          .collection('chat_conversations')
          .dropSearchIndex('chat_search_v1');
    }
    for (const [database, collection, fields] of plans) {
      const target = client.db(database).collection(collection);
      const existing = await target
        .listSearchIndexes('chat_search_v1')
        .toArray();
      console.log(
        JSON.stringify({
          database,
          collection,
          name: 'chat_search_v1',
          status: existing[0]?.status ?? 'MISSING',
          action: existing.length ? 'KEEP' : apply ? 'CREATE' : 'WOULD_CREATE',
        }),
      );
      if (apply && !existing.length)
        await target.createSearchIndex({
          name: 'chat_search_v1',
          definition: searchFields(fields),
        });
      if (apply && existing.length && !fields.includes('content'))
        await target.updateSearchIndex('chat_search_v1', searchFields(fields));
    }
  } finally {
    await client.close();
  }
}
