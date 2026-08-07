export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      bots: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          is_active: boolean;
          api_slot: number;
          timezone: string;
          country: string | null;
          city: string | null;
          language: string;
          persona: string;
          additional_persona: string | null;
          content_target: string;
          custom_target_prompt: string | null;
          frequency_mode: "daily" | "every_n_days" | "weekdays_only";
          every_n_days: number | null;
          weekdays: number[];
          max_posts_per_day: number;
          cooldown_minutes: number;
          connection_status: "disconnected" | "connected" | "token_expiring" | "error";
          instagram_business_id: string | null;
          instagram_username: string | null;
          instagram_page_id: string | null;
          zernio_profile_id: string | null;
          zernio_account_id: string | null;
          last_posted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["bots"]["Row"]> & {
          user_id: string;
          name: string;
          api_slot: number;
        };
        Update: Partial<Database["public"]["Tables"]["bots"]["Row"]>;
      };
      bot_platform_accounts: {
        Row: {
          id: string;
          bot_id: string;
          platform: "instagram" | "tiktok" | "facebook";
          zernio_account_id: string;
          username: string | null;
          connection_status: string;
          rate_limited_until: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["bot_platform_accounts"]["Row"]> & {
          bot_id: string;
          platform: "instagram" | "tiktok" | "facebook";
          zernio_account_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["bot_platform_accounts"]["Row"]>;
      };
      media_assets: {
        Row: {
          id: string;
          bot_id: string;
          storage_path: string;
          public_url: string | null;
          media_type: "image" | "video";
          media_context_caption: string;
          tags: string[];
          duration_seconds: number | null;
          width: number | null;
          height: number | null;
          file_size_bytes: number | null;
          sha256: string | null;
          is_ready: boolean;
          is_used: boolean;
          usage_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["media_assets"]["Row"]> & {
          bot_id: string;
          storage_path: string;
          media_type: "image" | "video";
          media_context_caption: string;
        };
        Update: Partial<Database["public"]["Tables"]["media_assets"]["Row"]>;
      };
      content_queue: {
        Row: {
          id: string;
          bot_id: string;
          media_asset_id: string | null;
          status: "queued" | "validating" | "ready" | "publishing" | "posted" | "failed" | "cancelled";
          surface: "feed" | "reel" | "story";
          scheduled_for: string | null;
          published_at: string | null;
          generated_caption: string | null;
          hashtag_set: string[];
          call_to_action: string | null;
          provider_post_id: string | null;
          error_message: string | null;
          retry_count: number;
          next_retry_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["content_queue"]["Row"]> & {
          bot_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["content_queue"]["Row"]>;
      };
      songs: {
        Row: {
          id: string;
          bot_id: string;
          title: string;
          artist: string | null;
          mood: string | null;
          tags: string[];
          storage_path: string;
          duration_seconds: number | null;
          weight: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["songs"]["Row"]> & {
          bot_id: string;
          title: string;
          storage_path: string;
        };
        Update: Partial<Database["public"]["Tables"]["songs"]["Row"]>;
      };
      post_analytics_snapshots: {
        Row: {
          id: string;
          bot_id: string;
          queue_item_id: string | null;
          provider_post_id: string | null;
          captured_at: string;
          impressions: number;
          reach: number;
          likes: number;
          comments: number;
          shares: number;
          saves: number;
          profile_visits: number;
          follows: number;
          raw: Json;
        };
        Insert: Partial<Database["public"]["Tables"]["post_analytics_snapshots"]["Row"]> & {
          bot_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["post_analytics_snapshots"]["Row"]>;
      };
      artist_monitor_snapshots: {
        Row: {
          id: string;
          source_platform: string;
          source_handle: string;
          external_post_id: string;
          content_type: string | null;
          caption: string | null;
          media_url: string | null;
          posted_at: string | null;
          metrics: Json;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["artist_monitor_snapshots"]["Row"]> & {
          external_post_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["artist_monitor_snapshots"]["Row"]>;
      };
      bot_posting_windows: {
        Row: {
          id: string;
          bot_id: string;
          weekday: number;
          start_local: string;
          end_local: string;
          created_at: string;
        };
        Insert: {
          bot_id: string;
          weekday: number;
          start_local: string;
          end_local: string;
        };
        Update: Partial<Database["public"]["Tables"]["bot_posting_windows"]["Row"]>;
      };
      instagram_connections: {
        Row: {
          id: string;
          bot_id: string;
          encrypted_access_token: string;
          token_expires_at: string | null;
          scopes: string[];
          meta: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          bot_id: string;
          encrypted_access_token: string;
          token_expires_at?: string | null;
          scopes?: string[];
          meta?: Json;
        };
        Update: Partial<Database["public"]["Tables"]["instagram_connections"]["Row"]>;
      };
    };
  };
}
