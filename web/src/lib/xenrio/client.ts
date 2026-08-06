export interface XenrioPublishInput {
  accountId: string;
  caption: string;
  surface: "feed" | "reel" | "story";
  mediaUrl?: string;
  mediaType?: "image" | "video";
  timezone?: string;
}

interface CreateProfileResponse {
  id?: string;
  profileId?: string;
  profile?: {
    id?: string;
    _id?: string;
    name?: string;
  };
  data?: {
    id?: string;
    profileId?: string;
    profile?: {
      id?: string;
      _id?: string;
      name?: string;
    };
  };
}

interface ConnectUrlResponse {
  authUrl?: string;
  oauthUrl?: string;
  authorizationUrl?: string;
  connectUrl?: string;
  url?: string;
  data?: {
    authUrl?: string;
    auth_url?: string;
    oauthUrl?: string;
    oauth_url?: string;
    authorizationUrl?: string;
    authorization_url?: string;
    connectUrl?: string;
    connect_url?: string;
    url?: string;
  };
}

interface ListAccountsResponse {
  accounts?: Array<{
    id?: string;
    _id?: string;
    platform: string;
    username?: string;
    profileId?: string;
    externalPostCount?: number;
  }>;
  data?: {
    accounts?: Array<{
      id?: string;
      _id?: string;
      platform: string;
      username?: string;
      profileId?: string;
      externalPostCount?: number;
    }>;
  };
}

interface CreatePostResponse {
  id?: string;
  postId?: string;
  post?: {
    id?: string;
    _id?: string;
  };
  data?: {
    id?: string;
    postId?: string;
    post?: {
      _id?: string;
      id?: string;
      status?: string;
    };
  };
}

export class XenrioClient {
  constructor(private readonly apiKey: string) {}

  private get baseUrl() {
    return process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      throw new Error(`Zernio request failed (${res.status}): ${await res.text()}`);
    }

    return (await res.json()) as T;
  }

  private static pickFirstString(...values: Array<unknown>): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private static payloadShape(input: unknown): string {
    if (!input || typeof input !== "object") return "non-object payload";
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    const data = obj.data;
    const dataKeys = data && typeof data === "object" ? Object.keys(data as Record<string, unknown>) : [];
    return `keys=${keys.join(",") || "none"}; dataKeys=${dataKeys.join(",") || "none"}`;
  }

  private static readExistingProfileIdFromConflict(errorMessage: string): string | undefined {
    const jsonStart = errorMessage.indexOf("{");
    if (jsonStart < 0) return undefined;

    const maybeJson = errorMessage.slice(jsonStart);
    try {
      const parsed = JSON.parse(maybeJson) as {
        code?: string;
        details?: { existingProfileId?: string; existingProfileld?: string };
      };

      if (parsed.code !== "profile_name_conflict") return undefined;
      const raw = XenrioClient.pickFirstString(parsed.details?.existingProfileId, parsed.details?.existingProfileld);
      if (!raw) return undefined;

      // Zernio sometimes returns the whole profile object stringified in this
      // field (e.g. '{"_id":"...","name":"..."}') instead of a plain id —
      // confirmed by a real corrupted zernio_profile_id stored from this path.
      // Unwrap it so we never persist a JSON blob as the profile id.
      if (raw.trim().startsWith("{")) {
        try {
          const nested = JSON.parse(raw) as { _id?: string; id?: string };
          return XenrioClient.pickFirstString(nested._id, nested.id) ?? undefined;
        } catch {
          return undefined;
        }
      }

      return raw;
    } catch {
      return undefined;
    }
  }

  async createProfile(name: string, description?: string): Promise<{ profileId: string }> {
    let payload: CreateProfileResponse;
    try {
      payload = await this.request<CreateProfileResponse>("/profiles", {
        method: "POST",
        body: JSON.stringify({ name, description: description ?? "Bot profile" }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const existingProfileId = XenrioClient.readExistingProfileIdFromConflict(message);
      if (existingProfileId) {
        return { profileId: existingProfileId };
      }
      throw error;
    }

    const profileId = XenrioClient.pickFirstString(
      payload.data?.profile?._id,
      payload.data?.profile?.id,
      payload.data?.profileId,
      payload.data?.id,
      payload.profile?._id,
      payload.profile?.id,
      payload.profileId,
      payload.id,
    );

    if (!profileId) {
      throw new Error(
        `Zernio profile creation returned no profile id (${XenrioClient.payloadShape(payload)})`,
      );
    }
    return { profileId };
  }

  async getConnectUrl(
    platform: "instagram",
    profileId: string,
    options?: { redirectUri?: string; state?: string },
  ): Promise<{ authUrl: string }> {
    const query = new URLSearchParams({ profileId });
    // Keep both naming styles for compatibility with different Zernio gateway versions.
    query.set("profile_id", profileId);
    if (options?.redirectUri) {
      query.set("redirectUri", options.redirectUri);
      query.set("redirect_uri", options.redirectUri);
      // Some deployments expect "redirectUrl" instead of "redirectUri".
      query.set("redirectUrl", options.redirectUri);
      query.set("redirect_url", options.redirectUri);
      // Extra callback aliases used by some OAuth wrappers.
      query.set("callbackUrl", options.redirectUri);
      query.set("callback_url", options.redirectUri);
    }
    if (options?.state) query.set("state", options.state);
    query.set("platform", platform);

    const payload = await this.request<ConnectUrlResponse>(`/connect/${platform}?${query.toString()}`, {
      method: "GET",
    });

    const authUrl = XenrioClient.pickFirstString(
      payload.data?.oauthUrl,
      payload.data?.oauth_url,
      payload.data?.authorizationUrl,
      payload.data?.authorization_url,
      payload.data?.connectUrl,
      payload.data?.connect_url,
      payload.data?.authUrl,
      payload.data?.auth_url,
      payload.data?.url,
      payload.oauthUrl,
      payload.authorizationUrl,
      payload.connectUrl,
      payload.authUrl,
      payload.url,
    );
    if (!authUrl) throw new Error("Zernio connect URL not returned");
    return { authUrl };
  }

  async listAccounts(): Promise<Array<{ id: string; platform: string; username?: string; profileId?: string; externalPostCount?: number }>> {
    const payload = await this.request<ListAccountsResponse>("/accounts", { method: "GET" });
    const accounts = payload.data?.accounts ?? payload.accounts ?? [];
    return accounts.reduce<Array<{ id: string; platform: string; username?: string; profileId?: string; externalPostCount?: number }>>(
      (acc, account) => {
        const id = XenrioClient.pickFirstString(account._id, account.id);
        if (!id) return acc;
        acc.push({
          id,
          platform: account.platform,
          username: account.username,
          profileId: account.profileId,
          externalPostCount: typeof account.externalPostCount === "number" ? account.externalPostCount : undefined,
        });
        return acc;
      },
      [],
    );
  }

  async publish(input: XenrioPublishInput): Promise<{ postId: string }> {
    const content = input.caption;
    const inferredMediaType =
      input.mediaType ??
      (input.mediaUrl && /(\.mp4|\.mov|\.webm|\.m4v)(\?|$)/i.test(input.mediaUrl) ? "video" : "image");

    const payload = await this.request<CreatePostResponse>("/posts", {
      method: "POST",
      body: JSON.stringify({
        content,
        mediaUrl: input.mediaUrl,
        mediaItems: input.mediaUrl
          ? [
              {
                type: inferredMediaType,
                url: input.mediaUrl,
              },
            ]
          : undefined,
        publishNow: true,
        timezone: input.timezone,
        platforms: [
          {
            platform: "instagram",
            accountId: input.accountId,
          },
        ],
      }),
    });

    const postId = XenrioClient.pickFirstString(
      payload.data?.post?._id,
      payload.data?.post?.id,
      payload.data?.postId,
      payload.data?.id,
      payload.post?._id,
      payload.post?.id,
      payload.postId,
      payload.id,
    );
    if (!postId) {
      throw new Error(`Zernio publish succeeded without post id (${XenrioClient.payloadShape(payload)})`);
    }
    return { postId };
  }

  async listAccountPosts(accountId: string): Promise<
    Array<{
      id: string;
      message: string;
      createdTime: string;
      picture?: string;
      permalink?: string;
      mediaType?: string;
      likeCount: number;
      commentCount: number;
    }>
  > {
    const payload = await this.request<{
      status?: string;
      posts?: Array<{
        id: string;
        message?: string;
        createdTime: string;
        picture?: string;
        permalink?: string;
        mediaType?: string;
        likeCount?: number;
        commentCount?: number;
      }>;
    }>(`/accounts/${accountId}/posts`, { method: "GET" });

    return (payload.posts ?? []).map((post) => ({
      id: post.id,
      message: post.message ?? "",
      createdTime: post.createdTime,
      picture: post.picture,
      permalink: post.permalink,
      mediaType: post.mediaType,
      likeCount: post.likeCount ?? 0,
      commentCount: post.commentCount ?? 0,
    }));
  }

  async deletePost(postId: string): Promise<void> {
    await this.request(`/posts/${postId}`, { method: "DELETE" });
  }

  async updatePostCaption(postId: string, caption: string): Promise<void> {
    await this.request(`/posts/${postId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: caption }),
    });
  }

  async listComments(postId: string): Promise<Array<{ id: string; message: string; from?: string; createdTime: string }>> {
    const payload = await this.request<{
      comments?: Array<{
        id?: string;
        _id?: string;
        message?: string;
        text?: string;
        from?: string | { name?: string; username?: string };
        createdTime?: string;
        created_time?: string;
      }>;
      data?: {
        comments?: Array<{
          id?: string;
          _id?: string;
          message?: string;
          text?: string;
          from?: string | { name?: string; username?: string };
          createdTime?: string;
          created_time?: string;
        }>;
      };
    }>(`/posts/${postId}/comments`, { method: "GET" });

    const comments = payload.data?.comments ?? payload.comments ?? [];
    return comments.reduce<Array<{ id: string; message: string; from?: string; createdTime: string }>>((acc, comment) => {
      const id = XenrioClient.pickFirstString(comment.id, comment._id);
      if (!id) return acc;
      const from = typeof comment.from === "string" ? comment.from : comment.from?.name ?? comment.from?.username;
      acc.push({
        id,
        message: comment.message ?? comment.text ?? "",
        from,
        createdTime: comment.createdTime ?? comment.created_time ?? new Date().toISOString(),
      });
      return acc;
    }, []);
  }

  async createComment(postId: string, message: string): Promise<{ id: string }> {
    const payload = await this.request<{
      id?: string;
      commentId?: string;
      comment?: { id?: string; _id?: string };
      data?: { id?: string; commentId?: string; comment?: { id?: string; _id?: string } };
    }>(`/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });

    const id = XenrioClient.pickFirstString(
      payload.data?.comment?._id,
      payload.data?.comment?.id,
      payload.data?.commentId,
      payload.data?.id,
      payload.comment?._id,
      payload.comment?.id,
      payload.commentId,
      payload.id,
    );
    if (!id) {
      throw new Error(`Zernio comment succeeded without an id (${XenrioClient.payloadShape(payload)})`);
    }
    return { id };
  }
}
