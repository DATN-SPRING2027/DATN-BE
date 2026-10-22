# Chat expansion contract

Scope authorized by the user: organization-only Chat; no audio/video or external connections. Existing IAM active organization membership and conversation membership checks remain mandatory, including cache hits.

All routes below use `/api/v1/chat`, existing cookie/Bearer authentication, `Cache-Control: no-store`, structured 401/404/422/429 errors. Writes are Redis rate limited; MongoDB owns durable data. Unknown fields are rejected. Search uses indexed tokens, not substring regex or leading wildcards.

| Method/path | Request | Response |
|---|---|---|
| GET conversations | existing pagination/search plus `archived=true/false` | existing conversation page plus personal preferences |
| PATCH conversations/:id/preferences | any of `isPinned:boolean,isArchived:boolean,notificationMode:ALL/MENTIONS/NONE,markedUnread:boolean` | preferences; never modifies another member |
| GET/PUT conversations/:id/draft | PUT `{content:string,mentionUserIds?:string[]}` max 8,000 | `{content,mentionUserIds,updatedAt}`; empty content clears it |
| POST conversations/:id/ownership | `{userId}` active member | `{id}`; owner only, atomic transfer |
| PUT conversations/:id/managers/:userId | `{active:boolean}` | `{id}`; owner only, cannot change own role |
| GET messages/search | `q` 2–80 chars, optional conversationId, senderId, from/to ISO dates, kind IMAGE/DOCUMENT/LINK, cursor, limit 1–100 | message page; current active memberships before pagination; newest first |
| GET conversations/:id/library | `kind=IMAGE/DOCUMENT/LINK/PIN`, cursor, limit | message page, non-deleted items |
| PUT conversations/:id/messages/:messageId/pin | `{active:boolean}` | `{id}`; active member, shared conversation pin |
| POST conversations/:id/forward | `{sourceConversationId,messageId,clientMessageId}` | new message with text and copied attachment references under new target-scoped attachment IDs; requires source and target membership, never shares source download URLs |
| GET conversations/:id/messages/:messageId/receipts | no body | `{data:[{userId,displayName,readAt,deliveredAt}]}` |
| GET notifications | cursor, limit | current-user notification page; content rechecked against live memberships |
| PUT notifications/:id/read | `{}` | `{id}` |
| PUT blocks/:userId | `{active:boolean}` | `{userId,active}`; only a current organization member; blocks direct sends both directions, group conversations retain existing membership permissions |
| POST reports | `{conversationId,messageId?,reason}` 1–1,000 chars | `{id,status:OPEN}`; evidence must be accessible; stored for organization moderation, no automatic permission changes |

Mentions use explicit `mentionUserIds` (at most 50, active conversation members) on send/edit and are displayed as member names by FE; no mention resolution by ambiguous name. Notifications respect personal ALL/MENTIONS/NONE preferences. Unread is a personal display flag; it never moves the delivery/read cursors backwards.

Redis covers all Chat business requests with authenticated rate limiting; versioned read caching covers all list/search/context/preferences/library/receipts/drafts/notifications reads. Each mutation invalidates the corresponding organization cache generation and publishes changes through Redis Pub/Sub. Binary uploads remain streamed to S3/R2, not copied into Redis. IAM and conversation authorization are never served from stale read cache.
