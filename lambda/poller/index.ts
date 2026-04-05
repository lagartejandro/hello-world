import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getAccessToken, fetchHotPosts, fetchComments } from '../shared/reddit-client';
import { getNyseTickerSet, extractTickers } from '../shared/ticker-utils';

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'StockMarket'];
// How many top posts per subreddit to also pull comments from
const COMMENT_FETCH_LIMIT = 10;
// Delay between comment fetches to stay well under Reddit's rate limit
const FETCH_DELAY_MS = 700;

export async function handler(): Promise<void> {
  const [clientId, clientSecret] = await Promise.all([
    getParam(process.env.REDDIT_CLIENT_ID_PARAM!),
    getParam(process.env.REDDIT_CLIENT_SECRET_PARAM!),
  ]);

  if (clientId === 'PLACEHOLDER' || clientSecret === 'PLACEHOLDER') {
    console.warn('Reddit credentials not configured — set SSM params and redeploy.');
    return;
  }

  const [validTickers, token] = await Promise.all([
    getNyseTickerSet(),
    getAccessToken(clientId, clientSecret),
  ]);

  // ticker -> cumulative mention count for this run
  const counts: Record<string, number> = {};

  const addMentions = (text: string) => {
    for (const ticker of extractTickers(text, validTickers)) {
      counts[ticker] = (counts[ticker] ?? 0) + 1;
    }
  };

  for (const subreddit of SUBREDDITS) {
    console.log(`Polling r/${subreddit}...`);
    const posts = await fetchHotPosts(token, subreddit, 100);

    for (const post of posts) {
      addMentions(post.title);
      if (post.selftext) addMentions(post.selftext);
    }

    // Fetch comments for the most-discussed posts
    const topPosts = [...posts]
      .sort((a, b) => b.num_comments - a.num_comments)
      .slice(0, COMMENT_FETCH_LIMIT);

    for (const post of topPosts) {
      const comments = await fetchComments(token, subreddit, post.id);
      for (const comment of comments) {
        addMentions(comment.body);
      }
      await delay(FETCH_DELAY_MS);
    }
  }

  const today = todayUtc();
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // keep 30 days

  const entries = Object.entries(counts);
  console.log(`Writing ${entries.length} ticker counts for ${today}`);

  // Write all counts to DynamoDB concurrently (ADD is idempotent across runs)
  await Promise.all(
    entries.map(([ticker, n]) =>
      ddb.send(
        new UpdateCommand({
          TableName: process.env.TABLE_NAME!,
          Key: { date: today, ticker },
          UpdateExpression: 'ADD mentions :n SET #ttl = :ttl, updatedAt = :ts',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':n': n,
            ':ttl': ttl,
            ':ts': new Date().toISOString(),
          },
        })
      )
    )
  );

  const top10 = entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t, n]) => `${t}:${n}`)
    .join(', ');
  console.log(`Top tickers this run: ${top10}`);
}

async function getParam(name: string): Promise<string> {
  const result = await ssm.send(new GetParameterCommand({ Name: name }));
  return result.Parameter?.Value ?? 'PLACEHOLDER';
}

function todayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
