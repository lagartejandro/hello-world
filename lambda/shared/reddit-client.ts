const USER_AGENT = 'StockMentionsBot/1.0 (personal project)';

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

interface RedditTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface RedditListing {
  data: {
    children: Array<{ kind: string; data: Record<string, unknown> }>;
  };
}

export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });

  if (!resp.ok) {
    throw new Error(`Reddit auth failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as RedditTokenResponse;
  return data.access_token;
}

export async function fetchHotPosts(token: string, subreddit: string, limit = 100): Promise<RedditPost[]> {
  const resp = await fetch(
    `https://oauth.reddit.com/r/${subreddit}/hot.json?limit=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
    }
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

export async function fetchComments(token: string, subreddit: string, postId: string): Promise<RedditComment[]> {
  const resp = await fetch(
    `https://oauth.reddit.com/r/${subreddit}/comments/${postId}.json?limit=200&depth=2`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
    }
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
