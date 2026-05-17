/**
 * Discord Bot Integration for AI Assistant
 * Enables chatting with the AI agent through Discord
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import axios from "axios";

const API_BASE =
  process.env.AIWORKASSISTANT_URL ||
  process.env.API_BASE_URL ||
  "http://localhost:3050";

interface DiscordConfig {
  token: string;
  clientId: string;
  guildId?: string;
  allowedUserId?: string;
  apiKey?: string;
}

interface ConversationSession {
  userId: string;
  channelId: string;
  sessionId: string;
  mode: "productivity" | "engineering" | "musician";
  lastActivity: Date;
}

class DiscordAgentBot {
  private client: Client;
  private config: DiscordConfig;
  private sessions: Map<string, ConversationSession> = new Map();
  private apiBaseUrl: string;
  private apiKey: string;

  constructor(config: DiscordConfig) {
    this.config = config;
    this.apiBaseUrl = API_BASE;
    this.apiKey = config.apiKey || "";

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  /**
   * Start the Discord bot
   */
  async start(): Promise<void> {
    console.log("[DiscordBot] Starting bot...");

    // Register event handlers
    this.client.on("clientReady", () => this.onReady());
    this.client.on("messageCreate", (message) => this.onMessage(message));
    this.client.on("interactionCreate", (interaction) =>
      this.onInteraction(interaction),
    );

    // Login to Discord
    await this.client.login(this.config.token);
  }

  /**
   * Bot ready handler
   */
  private async onReady(): Promise<void> {
    console.log(`[DiscordBot] Logged in as ${this.client.user?.tag}`);

    // Register slash commands
    await this.registerCommands();

    // Set bot status
    this.client.user?.setPresence({
      status: "online",
      activities: [
        {
          name: "Type /help for commands",
          type: 1, // PLAYING
        },
      ],
    });
  }

  /**
   * Register slash commands
   */
  private async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("chat")
        .setDescription("Chat with the AI agent")
        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("Your message to the AI")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Agent mode")
            .addChoices(
              { name: "productivity", value: "productivity" },
              { name: "engineering", value: "engineering" },
              { name: "musician", value: "musician" },
            )
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("plan")
        .setDescription("Plan your day")
        .addStringOption((option) =>
          option
            .setName("date")
            .setDescription('Date to plan (YYYY-MM-DD or "today")')
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("roadmap")
        .setDescription("Manage roadmaps")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Action to perform")
            .addChoices(
              { name: "list", value: "list" },
              { name: "create", value: "create" },
              { name: "templates", value: "templates" },
            )
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName("session")
        .setDescription("Manage conversation sessions")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Session action")
            .addChoices(
              { name: "start", value: "start" },
              { name: "end", value: "end" },
              { name: "info", value: "info" },
            )
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName("memory")
        .setDescription("Search your conversation memory")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("Search query")
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show help and available commands"),
      // Musician Assistant Commands
      new SlashCommandBuilder()
        .setName("music-theory")
        .setDescription("Learn music theory concepts")
        .addStringOption((option) =>
          option
            .setName("topic")
            .setDescription("Music theory topic (e.g., chord progressions, scales)")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("level")
            .setDescription("Skill level")
            .addChoices(
              { name: "Beginner", value: "beginner" },
              { name: "Intermediate", value: "intermediate" },
              { name: "Advanced", value: "advanced" },
              { name: "Professional", value: "pro" },
            )
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("instrument")
            .setDescription("Instrument (e.g., piano, guitar)")
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("compose")
        .setDescription("Get composition assistance")
        .addStringOption((option) =>
          option
            .setName("goal")
            .setDescription("Composition goal (e.g., write a chorus)")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("genre")
            .setDescription("Genre (e.g., pop, rock, jazz)")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("mood")
            .setDescription("Mood (e.g., uplifting, melancholic)")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("key")
            .setDescription("Key (e.g., C major, Am)")
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("generate-music")
        .setDescription("Generate music from text description")
        .addStringOption((option) =>
          option
            .setName("prompt")
            .setDescription("Music description (avoid specific artist names)")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("duration")
            .setDescription("Duration in seconds (5-60)")
            .setMinValue(5)
            .setMaxValue(60)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("dryrun")
            .setDescription("Preview only (no actual generation)")
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("practice-plan")
        .setDescription("Generate a personalized practice plan")
        .addStringOption((option) =>
          option
            .setName("instrument")
            .setDescription("Instrument to practice")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("goal")
            .setDescription("Practice goal")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("minutes")
            .setDescription("Minutes per day")
            .setMinValue(10)
            .setMaxValue(480)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("days")
            .setDescription("Days per week")
            .setMinValue(1)
            .setMaxValue(7)
            .setRequired(false),
        ),
    ];

    try {
      const rest = new REST({ version: "10" }).setToken(this.config.token);

      if (this.config.guildId) {
        // Register commands for specific guild (faster, no global propagation delay)
        await rest.put(
          Routes.applicationGuildCommands(
            this.config.clientId,
            this.config.guildId,
          ),
          { body: commands },
        );
        console.log("[DiscordBot] Registered guild commands");
      } else {
        // Register global commands (takes up to 1 hour to propagate)
        await rest.put(Routes.applicationCommands(this.config.clientId), {
          body: commands,
        });
        console.log(
          "[DiscordBot] Registered global commands (may take up to 1 hour to propagate)",
        );
      }
    } catch (error) {
      console.error("[DiscordBot] Failed to register commands:", error);
    }
  }

  /**
   * Handle incoming messages
   */
  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    if (message.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }

    if (
      this.config.allowedUserId &&
      message.author.id !== this.config.allowedUserId
    ) {
      return;
    }

    const isDM = message.channel.isDMBased();
    const isMentioned = message.mentions.has(this.client.user!);

    if (!isDM && !isMentioned) return;

    // Get user's session or create new one
    const sessionKey = `${message.author.id}-${message.channelId}`;
    let session = this.sessions.get(sessionKey);

    if (!session) {
      session = {
        userId: message.author.id,
        channelId: message.channelId,
        sessionId: "", // Will be created when needed
        mode: "productivity",
        lastActivity: new Date(),
      };
      this.sessions.set(sessionKey, session);
    }

    // Process the message
    const content = message.content
      .replace(new RegExp(`<@!?${this.client.user!.id}>`), "")
      .trim();

    if (content) {
      await this.processUserMessage(message, content, session);
    }

    session.lastActivity = new Date();
  }

  /**
   * Handle slash command interactions
   */
  private async onInteraction(interaction: any): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    if (
      this.config.allowedUserId &&
      interaction.user.id !== this.config.allowedUserId
    ) {
      await interaction.reply({
        content: "This bot is not available to you.",
        ephemeral: true,
      });
      return;
    }

    const { commandName } = interaction;

    try {
      switch (commandName) {
        case "chat":
          await this.handleChatCommand(interaction);
          break;
        case "plan":
          await this.handlePlanCommand(interaction);
          break;
        case "roadmap":
          await this.handleRoadmapCommand(interaction);
          break;
        case "session":
          await this.handleSessionCommand(interaction);
          break;
        case "memory":
          await this.handleMemoryCommand(interaction);
          break;
        case "help":
          await this.handleHelpCommand(interaction);
          break;
        case "music-theory":
          await this.handleMusicTheoryCommand(interaction);
          break;
        case "compose":
          await this.handleComposeCommand(interaction);
          break;
        case "generate-music":
          await this.handleGenerateMusicCommand(interaction);
          break;
        case "practice-plan":
          await this.handlePracticePlanCommand(interaction);
          break;
        default:
          await interaction.reply({
            content: "Unknown command",
            ephemeral: true,
          });
      }
    } catch (error) {
      console.error("[DiscordBot] Error handling interaction:", error);
      await interaction.reply({
        content: "Sorry, there was an error processing your command.",
        ephemeral: true,
      });
    }
  }

  /**
   * Handle /chat command
   */
  private async handleChatCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const message = interaction.options.getString("message");
    const mode =
      (interaction.options.getString("mode") as
        | "productivity"
        | "engineering"
        | "musician") || "productivity";

    const response = await this.sendToAgent(message, interaction.user.id, mode);

    await this.sendLongReply(interaction, response);
  }

  /**
   * Handle /plan command
   */
  private async handlePlanCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const date = interaction.options.getString("date") || "today";
    const message = `Plan my day for ${date}`;

    const response = await this.sendToAgent(
      message,
      interaction.user.id,
      "productivity",
    );

    await this.sendLongReply(interaction, response);
  }

  /**
   * Handle /roadmap command
   */
  private async handleRoadmapCommand(interaction: any): Promise<void> {
    const action = interaction.options.getString("action");

    switch (action) {
      case "list": {
        await interaction.deferReply();

        const response = await axios.get(`${this.apiBaseUrl}/api/roadmaps`, {
          headers: this.getAuthHeaders(),
        });
        const roadmaps = response.data.roadmaps || [];

        if (roadmaps.length === 0) {
          await interaction.editReply(
            "No roadmaps found. Create one with /roadmap create",
          );
          return;
        }

        const reply = `📋 **Roadmaps** (${roadmaps.length}):\n\n${roadmaps
          .map(
            (r: any) =>
              `**${r.name}** (${r.type})\nStatus: ${r.status}\nCreated: ${new Date(r.createdAt).toLocaleDateString()}`,
          )
          .join("\n\n")}`;

        await this.sendLongReply(interaction, reply);
        break;
      }
      case "templates": {
        await interaction.deferReply();

        const response = await axios.get(`${this.apiBaseUrl}/api/templates`, {
          headers: this.getAuthHeaders(),
        });
        const templates = response.data.templates || [];

        const reply = `📋 **Roadmap Templates** (${templates.length}):\n\n${templates
          .map(
            (t: any) =>
              `**${t.name}**\n${t.description}\nCategory: ${t.category}`,
          )
          .join("\n\n")}`;

        await this.sendLongReply(interaction, reply);
        break;
      }
      case "create":
        await interaction.reply({
          content:
            "To create a roadmap, please provide:\n• Name\n• Type (client/internal)\n• Template (optional)",
          ephemeral: true,
        });
        break;
    }
  }

  /**
   * Handle /session command
   */
  private async handleSessionCommand(interaction: any): Promise<void> {
    const action = interaction.options.getString("action");
    const sessionKey = `${interaction.user.id}-${interaction.channelId}`;
    let session = this.sessions.get(sessionKey);

    switch (action) {
      case "start":
        if (!session) {
          session = {
            userId: interaction.user.id,
            channelId: interaction.channelId,
            sessionId: "",
            mode: "productivity",
            lastActivity: new Date(),
          };
          this.sessions.set(sessionKey, session);
        }
        await interaction.reply("✅ Session started. I'm ready to help!");
        break;

      case "end":
        if (session && session.sessionId) {
          try {
            await axios.post(
              `${this.apiBaseUrl}/chat/sessions/${session.sessionId}/end`,
              {},
              { headers: this.getAuthHeaders() },
            );
            this.sessions.delete(sessionKey);
            await interaction.reply("✅ Session ended and saved to memory.");
          } catch (error) {
            await interaction.reply("ℹ️ Session ended locally.");
          }
        } else {
          await interaction.reply("ℹ️ No active session to end.");
        }
        break;

      case "info":
        if (session && session.sessionId) {
          try {
            const response = await axios.get(
              `${this.apiBaseUrl}/chat/sessions/${session.sessionId}`,
              { headers: this.getAuthHeaders() },
            );
            const sessionData = response.data.session;

            await interaction.reply(
              `📊 **Session Info**\n` +
                `• Messages: ${sessionData.messageCount}\n` +
                `• Mode: ${sessionData.mode}\n` +
                `• Created: ${new Date(sessionData.createdAt).toLocaleString()}\n` +
                `• Last Active: ${new Date(sessionData.updatedAt).toLocaleString()}`,
            );
          } catch (error) {
            await interaction.reply("ℹ️ Session info unavailable.");
          }
        } else {
          await interaction.reply(
            "ℹ️ No active session. Start one with /session start",
          );
        }
        break;
    }
  }

  /**
   * Handle /memory command
   */
  private async handleMemoryCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const query = interaction.options.getString("query");

    try {
      const response = await axios.get(
        `${this.apiBaseUrl}/chat/memory/search`,
        {
          params: {
            userId: interaction.user.id,
            query,
            limit: 5,
          },
          headers: this.getAuthHeaders(),
        },
      );

      const memories = response.data.results || [];

      if (memories.length === 0) {
        await interaction.editReply("No memories found matching your query.");
        return;
      }

      const reply = `🧠 **Memory Search Results** (${memories.length}):\n\n${memories
        .map(
          (m: any) =>
            `**${m.title}**\n${m.summary.substring(0, 200)}...\n*${new Date(m.startDate).toLocaleDateString()}*`,
        )
        .join("\n\n")}`;

      await this.sendLongReply(interaction, reply);
    } catch (error) {
      await interaction.editReply("Failed to search memory.");
    }
  }

  /**
   * Handle /help command
   */
  private async handleHelpCommand(interaction: any): Promise<void> {
    const helpText = `
🤖 **AI Assistant - Discord Bot**

**Chat Commands:**
• \`/chat [message] [mode]\` - Chat with the AI agent
• \`/plan [date]\` - Plan your day
• \`/roadmap [action]\` - Manage roadmaps
• \`/session [action]\` - Manage conversation sessions
• \`/memory [query]\` - Search your memory
• \`/help\` - Show this help message

**Musician Assistant:**
🎵 \`/music-theory [topic]\` - Learn music theory
🎼 \`/compose [goal]\` - Get composition help
🎹 \`/generate-music [prompt]\` - Generate music samples
📝 \`/practice-plan [instrument]\` - Create practice plans

**How to Use:**
1. Mention the bot in any message: \`@AIAssistant your message\`
2. Use slash commands for structured interactions
3. Create sessions for continued conversations

**Modes:**
• **Productivity**: Planning, scheduling, organization
• **Engineering**: Technical design, code, architecture
• **Musician**: Music theory, composition, analysis

**Features:**
✅ Conversation memory across sessions
✅ Roadmap management
✅ Jira & GitLab integration
✅ Project planning
✅ Daily scheduling
✅ Music theory tutoring
✅ Composition assistance
✅ Text-to-music generation

Just start chatting with me! 🚀
    `;

    await interaction.reply(helpText);
  }

  /**
   * Handle /music-theory command
   */
  private async handleMusicTheoryCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const topic = interaction.options.getString("topic");
    const level = interaction.options.getString("level") || "intermediate";
    const instrument = interaction.options.getString("instrument");

    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/api/musician/theory`,
        {
          topic,
          skillLevel: level,
          instrument,
          includeExamples: true,
        },
        { headers: this.getAuthHeaders() },
      );

      const content = response.data.content || response.data.explanation || "No response";
      await this.sendLongReply(interaction, `🎵 **Music Theory: ${topic}**\n\n${content}`);
    } catch (error) {
      console.error("[DiscordBot] Error in music-theory command:", error);
      await interaction.editReply("❌ Failed to generate theory explanation. Please try again.");
    }
  }

  /**
   * Handle /compose command
   */
  private async handleComposeCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const goal = interaction.options.getString("goal");
    const genre = interaction.options.getString("genre");
    const mood = interaction.options.getString("mood");
    const key = interaction.options.getString("key");

    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/api/musician/composition`,
        {
          goal,
          genre,
          mood,
          key,
          outputFormat: "markdown",
        },
        { headers: this.getAuthHeaders() },
      );

      const content = response.data.content || response.data.plan || "No response";
      await this.sendLongReply(interaction, `🎼 **Composition Plan**\n\n${content}`);
    } catch (error) {
      console.error("[DiscordBot] Error in compose command:", error);
      await interaction.editReply("❌ Failed to generate composition plan. Please try again.");
    }
  }

  /**
   * Handle /generate-music command
   */
  private async handleGenerateMusicCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const prompt = interaction.options.getString("prompt");
    const duration = interaction.options.getInteger("duration") || 15;
    const dryRun = interaction.options.getBoolean("dryrun") || false;

    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/api/musician/generate`,
        {
          prompt,
          durationSeconds: duration,
          dryRun,
        },
        { headers: this.getAuthHeaders() },
      );

      const result = response.data;
      let replyText = `🎹 **Music Generation**\n\n`;
      replyText += `**Prompt**: ${prompt}\n`;
      replyText += `**Duration**: ${duration}s\n`;
      replyText += `**Model**: ${result.model}\n`;

      if (dryRun) {
        replyText += `\n✅ Dry run complete - no audio generated`;
      } else {
        replyText += `\n✅ Generation complete!`;
        replyText += `\n**Asset ID**: ${result.assetId}`;
      }

      if (result.warnings && result.warnings.length > 0) {
        replyText += `\n\n⚠️ **Warnings**:\n${result.warnings.map((w: string) => `• ${w}`).join("\n")}`;
      }

      await this.sendLongReply(interaction, replyText);
    } catch (error: any) {
      console.error("[DiscordBot] Error in generate-music command:", error);
      const errorMsg = error.response?.data?.error || "Failed to generate music";
      await interaction.editReply(`❌ ${errorMsg}`);
    }
  }

  /**
   * Handle /practice-plan command
   */
  private async handlePracticePlanCommand(interaction: any): Promise<void> {
    await interaction.deferReply();

    const instrument = interaction.options.getString("instrument");
    const goal = interaction.options.getString("goal");
    const minutes = interaction.options.getInteger("minutes") || 30;
    const days = interaction.options.getInteger("days") || 5;

    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/api/musician/practice-plan`,
        {
          instrument,
          goal,
          minutesPerDay: minutes,
          daysPerWeek: days,
          skillLevel: "intermediate",
        },
        { headers: this.getAuthHeaders() },
      );

      const content = response.data.content || response.data.plan || "No response";
      await this.sendLongReply(
        interaction,
        `📝 **Practice Plan for ${instrument}**\n\n${content}`,
      );
    } catch (error) {
      console.error("[DiscordBot] Error in practice-plan command:", error);
      await interaction.editReply("❌ Failed to generate practice plan. Please try again.");
    }
  }

  /**
   * Process user message and send to agent
   */
  private async processUserMessage(
    message: Message,
    content: string,
    session: ConversationSession,
  ): Promise<void> {
    try {
      // Show typing indicator if supported by channel type
      if (
        "sendTyping" in message.channel &&
        typeof message.channel.sendTyping === "function"
      ) {
        await message.channel.sendTyping();
      }

      // Send to agent
      const response = await this.sendToAgent(
        content,
        message.author.id,
        session.mode,
      );

      // Send response
      await this.sendLongReply(message, response);
    } catch (error) {
      console.error("[DiscordBot] Error processing message:", error);
      await message.reply("Sorry, I encountered an error. Please try again.");
    }
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Send message to AI Assistant
   */
  private async sendToAgent(
    message: string,
    userId: string,
    mode: "productivity" | "engineering" | "musician",
  ): Promise<string> {
    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/chat`,
        {
          message,
          mode,
          userId: `discord-${userId}`,
          includeMemory: true,
          includeTools: true,
        },
        { headers: this.getAuthHeaders() },
      );

      return response.data.content || "No response from agent.";
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;

        if (status === 503) {
          return "❌ Agent not available. Please contact the administrator.";
        } else if (data?.error) {
          return `❌ Error: ${data.error}`;
        }
      }

      return "❌ Failed to connect to the agent. Please try again.";
    }
  }

  /**
   * Send long reply (handles Discord's 2000 character limit)
   */
  private async sendLongReply(
    message: Message | any,
    content: string,
  ): Promise<void> {
    const maxLength = 2000;

    if (content.length <= maxLength) {
      if (message.deferred || message.replied) {
        await message.editReply(content);
      } else {
        await message.reply(content);
      }
    } else {
      // Split content into chunks
      const chunks = this.splitContent(content, maxLength);

      if (message.deferred || message.replied) {
        await message.editReply(chunks[0]);
      } else {
        await message.reply(chunks[0]);
      }

      // Send remaining chunks
      for (let i = 1; i < chunks.length; i++) {
        await message.followUp(chunks[i]);
      }
    }
  }

  /**
   * Split content into chunks that fit within Discord's limits
   */
  private splitContent(content: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    const lines = content.split("\n");

    for (const line of lines) {
      if ((currentChunk + line + "\n").length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = line + "\n";
      } else {
        currentChunk += line + "\n";
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    console.log("[DiscordBot] Stopping bot...");
    this.client.destroy();
  }
}

export { DiscordAgentBot };
