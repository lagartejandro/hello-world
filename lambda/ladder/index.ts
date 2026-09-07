import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { clubDate, codeForDate } from '../shared/invite-code';

/**
 * The chess ladder API.
 *
 * This is a dumb event store on purpose. It never computes a rating — the
 * client replays the match log and derives standings itself, exactly as it did
 * when everything lived in localStorage. Keeping Elo on one side of the wire
 * is what makes the offline story work: a disconnected operator has the whole
 * truth locally and only needs to exchange rows, not answers.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

// Single-tenant today. The partition key carries a club id anyway so a second
// club is a new partition rather than a migration.
const CLUB = 'CLUB#default';

let cachedSecret: string | undefined;
async function inviteSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.INVITE_SECRET_ARN! })
  );
  cachedSecret = res.SecretString!;
  return cachedSecret;
}

/**
 * Cognito group membership from the validated JWT.
 *
 * API Gateway flattens array claims into a string, and the exact shape varies
 * ("[operators]", "operators", or comma separated), so normalise all three
 * rather than trusting one.
 */
function groupsOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string[] {
  const raw = event.requestContext.authorizer?.jwt?.claims?.['cognito:groups'];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean);
}

const isOperator = (event: APIGatewayProxyEventV2WithJWTAuthorizer) =>
  groupsOf(event).includes('operators');

const subOf = (event: APIGatewayProxyEventV2WithJWTAuthorizer) =>
  String(event.requestContext.authorizer?.jwt?.claims?.sub ?? '');

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/$/, '');

  if (method === 'GET' && path === '/api/state') return getState(event);
  if (method === 'GET' && path === '/api/me') return getMe(event);
  if (method === 'GET' && path === '/api/admin/invite-code') return getInviteCode(event);
  if (method === 'POST' && path === '/api/sync') return postSync(event);

  return json(404, { error: 'Not found' });
}

/* ── Read the ladder ──────────────────────────────────────────────────────── */

async function getState(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const since = event.queryStringParameters?.since;
  if (since && !isIsoDate(since)) {
    return json(400, { error: 'since must be an ISO 8601 timestamp' });
  }

  const items = await queryClub();

  // Filtering on updatedAt in memory rather than with a GSI: a club partition
  // is hundreds of rows, so a full query costs less than the index would, and
  // it keeps the write path free of index maintenance. Revisit if a club ever
  // gets big enough for this to show up in latency.
  const changed = since ? items.filter(i => String(i.updatedAt ?? '') > since) : items;

  return json(200, {
    players: changed.filter(i => i.type === 'player').map(stripKeys),
    matches: changed.filter(i => i.type === 'match').map(stripKeys),
    settings: changed.filter(i => i.type === 'settings').map(stripKeys)[0] ?? null,
    // The client stores this and sends it back as ?since= next time.
    syncedAt: new Date().toISOString(),
  });
}

async function queryClub() {
  const out: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: process.env.TABLE_NAME!,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': CLUB },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/* ── Who am I ─────────────────────────────────────────────────────────────── */

async function getMe(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const sub = subOf(event);
  if (!sub) return json(401, { error: 'No subject in token' });

  const res = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_NAME!,
    Key: { pk: `USER#${sub}`, sk: 'PROFILE' },
  }));

  const claims = event.requestContext.authorizer.jwt.claims;
  return json(200, {
    sub,
    email: claims.email ?? null,
    operator: isOperator(event),
    // playerId links an account to a row on the ladder. The operator sets it;
    // until then a signed-in member can see the ladder but not "their" rating.
    playerId: res.Item?.playerId ?? null,
  });
}

/* ── Today's invite code (operators only) ─────────────────────────────────── */

async function getInviteCode(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  if (!isOperator(event)) return json(403, { error: 'Operators only' });
  const date = clubDate();
  return json(200, { code: codeForDate(await inviteSecret(), date), date });
}

/* ── Push local changes (operators only) ──────────────────────────────────── */

const MAX_ITEMS = 500;

async function postSync(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  if (!isOperator(event)) return json(403, { error: 'Operators only' });

  let body: any;
  try { body = JSON.parse(event.body ?? '{}'); }
  catch { return json(400, { error: 'Body must be JSON' }); }

  const players = Array.isArray(body.players) ? body.players : [];
  const matches = Array.isArray(body.matches) ? body.matches : [];
  const settings = body.settings ?? null;

  if (players.length + matches.length > MAX_ITEMS) {
    return json(413, { error: `Send at most ${MAX_ITEMS} rows per request` });
  }

  const now = new Date().toISOString();
  const writes: Promise<'written' | 'stale'>[] = [];

  for (const p of players) {
    if (!p?.id || typeof p.name !== 'string') return json(400, { error: 'Player needs id and name' });
    writes.push(putPlayer({
      pk: CLUB, sk: `PLAYER#${p.id}`, type: 'player',
      id: p.id, name: p.name, here: !!p.here,
      seed: p.seed ?? null,
      deleted: !!p.deleted, updatedAt: p.updatedAt ?? now,
    }, p.created ?? now));
  }

  for (const m of matches) {
    if (!m?.id || !m.at || !m.a || !m.b) return json(400, { error: 'Match needs id, at, a, b' });
    if (!['a', 'b', 'draw'].includes(m.result)) return json(400, { error: 'Bad match result' });
    writes.push(put({
      pk: CLUB, sk: `MATCH#${m.at}#${m.id}`, type: 'match',
      id: m.id, at: m.at, a: m.a, b: m.b, result: m.result,
      deleted: !!m.deleted, updatedAt: m.updatedAt ?? now,
    }));
  }

  if (settings) {
    writes.push(put({
      pk: CLUB, sk: 'SETTINGS', type: 'settings',
      start: num(settings.start, 1200), kNew: num(settings.kNew, 40),
      k: num(settings.k, 20), provGames: num(settings.provGames, 10),
      updatedAt: settings.updatedAt ?? now,
    }));
  }

  const results = await Promise.all(writes);
  return json(200, {
    written: results.filter(r => r === 'written').length,
    // Rows the server already had a newer copy of. Not an error — it is the
    // sync protocol working.
    stale: results.filter(r => r === 'stale').length,
    syncedAt: now,
  });
}

/**
 * Last-write-wins on updatedAt, enforced by the database rather than by read
 * -then-write in the handler, so two operators syncing at once cannot
 * interleave into a lost update.
 *
 * Matches are immutable, so this only ever matters for players and settings —
 * but applying it uniformly costs nothing and removes a special case.
 */
/**
 * A player write, with `created` pinned on first write and never moved after.
 *
 * Sync is whole-row: the client sends a complete player and the server
 * replaces it. That is fine for everything the operator can actually edit, but
 * `created` is immutable history — a row that arrived without it (a partial
 * push, a future optimisation, a hand-rolled call) would silently reset when
 * a member joined the club, and the only way back would be a point-in-time
 * restore. if_not_exists makes that unrepresentable rather than merely
 * unlikely.
 */
async function putPlayer(item: Record<string, any>, created: string): Promise<'written' | 'stale'> {
  const fields = Object.keys(item).filter(k => k !== 'pk' && k !== 'sk');
  try {
    await ddb.send(new UpdateCommand({
      TableName: process.env.TABLE_NAME!,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression:
        'SET ' + fields.map(f => `#${f} = :${f}`).join(', ') +
        ', created = if_not_exists(created, :created)',
      ExpressionAttributeNames: Object.fromEntries(fields.map(f => [`#${f}`, f])),
      ExpressionAttributeValues: {
        ...Object.fromEntries(fields.map(f => [`:${f}`, item[f]])),
        ':created': created,
        ':u': item.updatedAt,
      },
      ConditionExpression: 'attribute_not_exists(sk) OR updatedAt <= :u',
    }));
    return 'written';
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return 'stale';
    throw err;
  }
}

async function put(item: Record<string, any>): Promise<'written' | 'stale'> {
  try {
    await ddb.send(new PutCommand({
      TableName: process.env.TABLE_NAME!,
      Item: item,
      ConditionExpression: 'attribute_not_exists(sk) OR updatedAt <= :u',
      ExpressionAttributeValues: { ':u': item.updatedAt },
    }));
    return 'written';
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return 'stale';
    throw err;
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function stripKeys(item: Record<string, any>) {
  const { pk, sk, type, ...rest } = item;
  return rest;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isIsoDate(s: string): boolean {
  return !isNaN(Date.parse(s));
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
