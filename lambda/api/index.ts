import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const qs = event.queryStringParameters ?? {};
  const date = qs.date ?? todayUtc();
  const limit = Math.min(parseInt(qs.limit ?? '50', 10), 200);

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME!,
      KeyConditionExpression: '#date = :date',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':date': date },
    })
  );

  const tickers = (result.Items ?? [])
    .map(item => ({ ticker: item.ticker as string, mentions: item.mentions as number }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);

  return json(200, {
    date,
    tickers,
    total: tickers.length,
    updatedAt: tickers.length > 0
      ? (result.Items ?? []).reduce((latest, item) => {
          const ts = item.updatedAt as string;
          return ts > latest ? ts : latest;
        }, '')
      : null,
  });
}

function todayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
