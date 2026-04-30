# 🤖 Discord Bot Setup Guide

Complete guide to set up OpenClaw Agent as a Discord bot so you can chat with it through Discord.

## 🎯 What You'll Be Able To Do

- ✅ Chat with the AI agent in Discord DMs
- ✅ Use the bot in Discord servers
- ✅ Slash commands for structured interactions
- ✅ Conversation memory across sessions
- ✅ Roadmap management through Discord
- ✅ Daily planning and scheduling
- ✅ Memory search and retrieval

## 📋 Prerequisites

- Discord account
- Discord server where you have admin permissions
- OpenClaw Agent server running

## 🚀 Setup Process

### 1. Create Discord Application

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name it "OpenClaw Agent"
4. Click "Create"

### 2. Configure Bot

1. In the left sidebar, click "Bot"
2. Click "Add Bot"
3. **IMPORTANT**: Copy the **Bot Token** (you'll need this)
4. Under "Privileged Gateway Intents", enable:
   - ✅ Message Content Intent
   - ✅ Server Members Intent
   - ✅ Presence Intent

### 3. Configure OAuth2

1. In the left sidebar, click "OAuth2" -> "URL Generator"
2. Under "Scopes", select:
   - ✅ bot
   - ✅ applications.commands
3. Under "Bot Permissions", select:
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Attach Files
   - ✅ Read Message History
   - ✅ Use Slash Commands
4. Copy the generated URL at the bottom
5. Paste it in your browser and authorize the bot

### 4. Get Application Details

1. In "General Information" tab
2. Copy the **Application ID** (this is your Client ID)

### 5. Configure Environment Variables

Add to your `.env` file:

```bash
# Discord Bot Configuration
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_server_id_here  # Optional: for faster command registration during development
```

**To get your Server ID:**
1. Enable Developer Mode in Discord (Settings -> Advanced)
2. Right-click your server name
3. Select "Copy ID"

### 6. Install Dependencies

```bash
npm install discord.js
```

### 7. Start the Bot

```bash
# Make sure the main server is running first
npm run dev &

# Start the Discord bot
npm run bot:discord
```

### 8. Test the Bot

In Discord, try these commands:

- `/help` - Show all available commands
- `/chat Hello, can you help me plan my day?` - Chat with the AI
- `/plan today` - Plan your day
- `/roadmap list` - List all roadmaps
- `/memory project planning` - Search your memory

## 🎨 Bot Commands Reference

### Chat Commands

**`/chat [message] [mode]`**
- Chat directly with the AI agent
- Modes: `productivity` or `engineering`
- Example: `/chat "Help me design a REST API" engineering`

**`/plan [date]`**
- Plan your day for a specific date
- Example: `/plan 2026-05-01` or `/plan today`

### Roadmap Commands

**`/roadmap list`**
- List all existing roadmaps

**`/roadmap create`**
- Create a new roadmap (interactive)

**`/roadmap templates`**
- Show available roadmap templates

### Session Commands

**`/session start`**
- Start a new conversation session

**`/session end`**
- End current session and save to memory

**`/session info`**
- Show current session information

### Memory Commands

**`/memory [query]`**
- Search your conversation memory
- Example: `/memory "security discussions"`

**`/help`**
- Show help message and all commands

## 💬 Direct Messaging

The bot also works in direct messages!

1. Find the bot in your DM list
2. Just start typing - no need for slash commands
3. The bot will remember conversations across messages

## 🔧 Advanced Configuration

### Custom Prefixes

You can mention the bot instead of using commands:
```
@OpenClaw Help me plan my week
```

### Server-Specific Behavior

The bot can be configured differently per server:
- Different default modes
- Custom roadmaps per server
- Server-specific memory

### Rate Limiting

The bot respects Discord's rate limits:
- 50 commands per second per server
- Per-user rate limiting for abuse prevention

## 🎯 Use Cases

### **For Personal Productivity**
- Daily planning with `/plan today`
- Task management and prioritization
- Meeting preparation and follow-ups

### **For Engineering Teams**
- Code review assistance
- Architecture discussions
- Technical documentation
- Bug triage and planning

### **For Project Management**
- Roadmap creation and management
- Project timeline planning
- Stakeholder communication
- Progress tracking

### **For Knowledge Management**
- Search past conversations with `/memory`
- Team knowledge base
- Documentation assistance
- Best practices sharing

## 🔒 Security Considerations

✅ **Implemented Security:**
- Bot token stored in environment variables
- User-specific conversation memory
- Guardrails for dangerous operations
- Audit logging of all bot interactions

⚠️ **Best Practices:**
- Don't share your bot token publicly
- Use server-specific channels for sensitive topics
- Regular security audits of bot permissions
- Monitor bot usage logs

## 🐛 Troubleshooting

**Bot not responding:**
```bash
# Check if the bot is running
ps aux | grep bot-server

# Check logs
# Look for "[DiscordBot]" prefixes
```

**Commands not appearing:**
- Wait up to 1 hour for global commands to propagate
- Use guild ID for instant registration during development
- Check that you've enabled "Message Content Intent"

**Bot can't read messages:**
- Verify "Message Content Intent" is enabled
- Check bot permissions in the server
- Ensure bot has access to the channel

**Memory not working:**
- Make sure the main server is running
- Check API_BASE_URL points to correct server
- Verify user ID consistency

## 🚀 Next Steps

After Discord is working, you can add:
- Mattermost integration (for internal team chat)
- Signal integration (for secure messaging)
- WhatsApp integration (for personal/quick communication)
- Web dashboard for visual roadmap management
- Mobile app for on-the-go access

---

**Status**: Discord bot is fully implemented and ready to deploy!

**Estimated Setup Time**: 15-20 minutes

**Support**: Check logs for `[DiscordBot]` prefixes for debugging information.
