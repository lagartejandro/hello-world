import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fetchHotPosts, fetchComments } from '../shared/reddit-client';
import { getNyseTickerSet, extractTickers } from '../shared/ticker-utils';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'StockMarket'];
const COMMENT_FETCH_LIMIT = 10;
const FETCH_DELAY_MS = 1100; // ~1 req/sec to respect public API rate limit

export async function handler(): Promise<void> {
  const validTickers = await getNyseTickerSet();

  const counts: Record<string, number> = {};
  const addMentions = (text: string) => {
    for (const ticker of extractTickers(text, validTickers)) {
      counts[ticker] = (counts[ticker] ?? 0) + 1;
    }
  };

  for (const subreddit of SUBREDDITS) {
    console.log(`Polling r/${subreddit}...`);
    const posts = await fetchHotPosts(subreddit, 100);

    for (const post of posts) {
      addMentions(post.title);
      if (post.selftext) addMentions(post.selftext);
    }

    const topPosts = [...posts]
      .sort((a, b) => b.num_comments - a.num_comments)
      .slice(0, COMMENT_FETCH_LIMIT);

    for (const post of topPosts) {
      await delay(FETCH_DELAY_MS);
      const comments = await fetchComments(subreddit, post.id);
      for (const comment of comments) {
        addMentions(comment.body);
      }
    }

    await delay(FETCH_DELAY_MS);
  }

  const today = new Date().toISOString().split('T')[0];
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  const entries = Object.entries(counts);
  console.log(`Writing ${entries.length} ticker counts for ${today}`);

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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
