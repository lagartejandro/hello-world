// Uses Reddit's public JSON API — no OAuth credentials required.
// Rate limit: ~1 req/second. We add delays in the poller to stay safe.
const USER_AGENT = 'StockMentionsBot/1.0 (personal project)';
const BASE = 'https://www.reddit.com';

export interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  score: number;
  num_comments: number;
}

export interface RedditComment {
  body: string;
  score: number;
}

interface RedditListing {
  data: {
    children: Array<{ kind: string; data: Record<string, unknown> }>;
  };
}

export async function fetchHotPosts(subreddit: string, limit = 100): Promise<RedditPost[]> {
  const resp = await fetch(
    `${BASE}/r/${subreddit}/hot.json?limit=${limit}`,
    { headers: { 'User-Agent': USER_AGENT } }
  );

  if (!resp.ok) {
    console.warn(`Failed to fetch r/${subreddit}: ${resp.status}`);
    return [];
  }

  const listing = (await resp.json()) as RedditListing;
  return listing.data.children
    .filter(c => c.kind === 't3')
    .map(c => ({
      id: c.data.id as string,
      title: c.data.title as string,
      selftext: (c.data.selftext as string) ?? '',
      score: c.data.score as number,
      num_comments: c.data.num_comments as number,
    }));
}

export async function fetchComments(subreddit: string, postId: string): Promise<RedditComment[]> {
  const resp = await fetch(
    `${BASE}/r/${subreddit}/comments/${postId}.json?limit=200&depth=2`,
    { headers: { 'User-Agent': USER_AGENT } }
  );

  if (!resp.ok) {
    console.warn(`Failed to fetch comments for ${postId}: ${resp.status}`);
    return [];
  }

  // Response is [postListing, commentsListing]
  const [, commentsListing] = (await resp.json()) as [RedditListing, RedditListing];
  return commentsListing.data.children
    .filter(c => c.kind === 't1' && typeof c.data.body === 'string')
    .map(c => ({
      body: c.data.body as string,
      score: c.data.score as number,
    }));
}
