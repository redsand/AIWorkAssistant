import axios from "axios";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

interface SearchResponse {
  query: string;
  answer?: string;
  results: SearchResult[];
  totalResults: number;
  provider: "tavily" | "google";
}

class WebSearchClient {
  private tavilyApiKey: string;
  private googleApiKey: string;
  private googleEngineId: string;

  constructor() {
    this.tavilyApiKey = process.env.TAVILY_API_KEY || "";
    this.googleApiKey = process.env.GOOGLE_SEARCH_API_KEY || "";
    this.googleEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID || "";
  }

  isConfigured(): boolean {
    return !!(this.tavilyApiKey || (this.googleApiKey && this.googleEngineId));
  }

  async search(
    query: string,
    maxResults: number = 5,
    options?: {
      searchDepth?: "basic" | "advanced";
      topic?: "general" | "news" | "finance";
      includeAnswer?: boolean;
    },
  ): Promise<SearchResponse> {
    if (this.tavilyApiKey) {
      return this.tavilySearch(query, maxResults, options);
    }

    if (this.googleApiKey && this.googleEngineId) {
      return this.googleSearch(query, maxResults);
    }

    return {
      query,
      results: [],
      totalResults: 0,
      provider: "tavily",
    };
  }

  private async tavilySearch(
    query: string,
    maxResults: number,
    options?: {
      searchDepth?: "basic" | "advanced";
      topic?: "general" | "news" | "finance";
      includeAnswer?: boolean;
    },
  ): Promise<SearchResponse> {
    try {
      const response = await axios.post(
        "https://api.tavily.com/search",
        {
          api_key: this.tavilyApiKey,
          query,
          max_results: Math.min(maxResults, 20),
          search_depth: options?.searchDepth || "basic",
          topic: options?.topic || "general",
          include_answer: options?.includeAnswer !== false,
        },
        { timeout: 15000 },
      );

      const items = response.data.results || [];

      return {
        query,
        answer: response.data.answer || undefined,
        results: items.map((item: any) => ({
          title: item.title,
          url: item.url,
          snippet: item.content || item.snippet || "",
          score: item.score,
        })),
        totalResults: items.length,
        provider: "tavily",
      };
    } catch (error) {
      console.error(
        "[WebSearch/Tavily] Search failed:",
        error instanceof Error ? error.message : "Unknown error",
      );

      if (this.googleApiKey && this.googleEngineId) {
        console.log("[WebSearch] Falling back to Google Custom Search");
        return this.googleSearch(query, maxResults);
      }

      return {
        query,
        results: [],
        totalResults: 0,
        provider: "tavily",
      };
    }
  }

  private async googleSearch(
    query: string,
    maxResults: number,
  ): Promise<SearchResponse> {
    try {
      const response = await axios.get(
        "https://www.googleapis.com/customsearch/v1",
        {
          params: {
            key: this.googleApiKey,
            cx: this.googleEngineId,
            q: query,
            num: Math.min(maxResults, 10),
          },
          timeout: 10000,
        },
      );

      const items = response.data.items || [];

      return {
        query,
        results: items.map((item: any) => ({
          title: item.title,
          url: item.link,
          snippet: item.snippet || "",
        })),
        totalResults: parseInt(
          response.data.searchInformation?.totalResults || "0",
          10,
        ),
        provider: "google",
      };
    } catch (error) {
      console.error(
        "[WebSearch/Google] Search failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        query,
        results: [],
        totalResults: 0,
        provider: "google",
      };
    }
  }

  async fetchPage(url: string): Promise<{ url: string; content: string }> {
    if (this.tavilyApiKey) {
      return this.tavilyExtract(url);
    }
    return this.rawFetchPage(url);
  }

  private async tavilyExtract(
    url: string,
  ): Promise<{ url: string; content: string }> {
    try {
      const response = await axios.post(
        "https://api.tavily.com/extract",
        {
          api_key: this.tavilyApiKey,
          urls: [url],
        },
        { timeout: 15000 },
      );

      const results = response.data.results || [];
      const failed = response.data.failed || [];

      if (results.length > 0 && results[0].raw_content) {
        return { url, content: results[0].raw_content.substring(0, 15000) };
      }

      if (failed.length > 0) {
        return this.rawFetchPage(url);
      }

      return { url, content: "" };
    } catch {
      return this.rawFetchPage(url);
    }
  }

  private async rawFetchPage(
    url: string,
  ): Promise<{ url: string; content: string }> {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AIAssistant/1.0; +https://github.com/ai-assist)",
          Accept: "text/html,text/plain",
        },
        maxContentLength: 500 * 1024,
        responseType: "text",
      });

      const html = response.data as string;
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 10000);

      return { url, content: text };
    } catch (error) {
      return {
        url,
        content: `Failed to fetch: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }
}

export const webSearchClient = new WebSearchClient();
