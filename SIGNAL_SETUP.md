# 📱 Signal Integration Setup Guide

Complete guide to integrate AI Assistant with Signal for secure, encrypted messaging.

## 🎯 What You'll Be Able To Do

- ✅ Chat with the AI agent through Signal
- ✅ End-to-end encrypted conversations
- ✅ Personal productivity assistance
- ✅ Secure project discussions
- ✅ Daily planning and reminders
- ✅ Memory search and retrieval

## ⚠️ Important Limitations

**Signal does NOT provide an official bot API**, so this integration uses alternative methods:

1. **Signal CLI** (Recommended) - Command-line interface
2. **Community HTTP Bridge** - Third-party services
3. **Manual Webhook Setup** - Advanced configuration

## 📋 Prerequisites

- Signal installed on your phone
- Signal phone number (registered and verified)
- Basic command-line familiarity
- Server with internet access

## 🚀 Setup Process

### Option 1: Signal CLI (Recommended)

#### Step 1: Install Signal CLI

**Using Cargo (Rust Package Manager):**

```bash
# Install Rust/Cargo if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Install Signal CLI
cargo install signal-cli
```

**Or download pre-built binary:**

```bash
# Download from GitHub releases
wget https://github.com/AsamK/signal-cli/releases/download/v0.10.0/signal-cli-0.10.0-linux-x64.tar.gz

# Extract and install
tar -xzf signal-cli-*.tar.gz
cd signal-cli-*
sudo ln -s $(pwd)/signal-cli /usr/local/bin/signal-cli
```

#### Step 2: Link Your Phone Number

```bash
# Start linking process
signal-cli link

# This will show a QR code on your terminal
```

**On your phone:**

1. Open Signal
2. Go to Settings → Linked Devices
3. Tap "Link Device (Desktop)"
4. Scan the QR code shown in terminal

#### Step 3: Verify Installation

```bash
# Test Signal CLI
signal-cli --version

# List linked devices
signal-cli listIds

# Send a test message
signal-cli send +1234567890 -m "Test from AI Assistant"
```

#### Step 4: Configure Environment Variables

Add to your `.env` file:

```bash
# Signal Configuration
SIGNAL_PHONE_NUMBER=+1234567890
SIGNAL_DATA_PATH=~/.config/Signal
SIGNAL_WEBHOOK_PORT=3001
```

**Important:** Use your actual Signal phone number in international format (+country code + number)

#### Step 5: Start the Signal Bot

```bash
# Make sure the main server is running
npm run dev &

# Start Signal bot
npm run bot:signal
```

### Option 2: Signal HTTP Bridge (Alternative)

If Signal CLI doesn't work for you, use a community HTTP bridge:

#### Step 1: Choose an HTTP Bridge Service

Popular options:

- **signal-http-api** (https://github.com FormerLabs/signal-http-api)
- **signald** (https://github.com/signald/signald)
- **signal-rest-api** (https://github.com-mfietz/signal-rest-api)

#### Step 2: Install and Configure

**Example using signal-http-api:**

```bash
# Clone the repository
git clone https://github.com/FormerLabs/signal-http-api.git
cd signal-http-api

# Install dependencies
npm install

# Configure
cp config.example.json config.json
# Edit config.json with your settings

# Start the service
npm start
```

#### Step 3: Update Environment Variables

```bash
# Signal HTTP Bridge Configuration
SIGNAL_HTTP_BRIDGE_URL=http://localhost:8080
SIGNAL_PHONE_NUMBER=+1234567890
```

### Option 3: Manual Webhook (Advanced)

For advanced users who want more control:

#### Step 1: Set Up Webhook Receiver

Your bot server already includes a webhook endpoint at `/webhook/signal`

#### Step 2: Configure Signal Forwarding

This requires additional setup with Signal's internal systems and is more complex.

## 🎮 Using the Signal Bot

### Basic Usage

Once the bot is running, simply send a message to your linked Signal number:

**You:** "Help me plan my day"

**Bot:** [AI responds with daily planning]

### Advanced Features

**Memory Integration:**

```
You: "What did we discuss about the security project?"
Bot: [Searches memory and provides relevant conversations]
```

**Roadmap Management:**

```
You: "Show me my roadmaps"
Bot: [Lists all your roadmaps with details]
```

**Daily Planning:**

```
You: "Plan tomorrow"
Bot: [Creates detailed day plan]
```

## 🔧 Configuration

### Environment Variables

```bash
# Required
SIGNAL_PHONE_NUMBER=+1234567890          # Your Signal number
SIGNAL_DATA_PATH=~/.config/Signal      # Signal CLI data path

# Optional
SIGNAL_WEBHOOK_PORT=3001                # Webhook server port
SIGNAL_HTTP_BRIDGE_URL=http://...       # If using HTTP bridge
```

### Bot Behavior

The Signal bot includes:

- ✅ **Auto-reply** - Responds to all incoming messages
- ✅ **Memory** - Remembers conversations across sessions
- ✅ **Context** - Knows about your roadmaps and projects
- ✅ **Guardrails** - Won't perform dangerous actions
- ✅ **Audit logging** - All conversations logged

## 🔒 Security Considerations

✅ **End-to-End Encryption**: Signal's core security
✅ **No Message Storage**: Messages not stored by bot
✅ **Audit Logs**: All interactions logged locally
✅ **Guardrails**: Dangerous operations blocked
⚠️ **Trusted Network**: Requires server deployment

## 🐛 Troubleshooting

**Signal CLI not working:**

```bash
# Check installation
signal-cli --version

# Check linking status
signal-cli listIds

# Test sending
signal-cli send +1234567890 -m "Test message"
```

**Bot not responding:**

```bash
# Check if bot is running
ps aux | grep bot-server

# Check logs
# Look for [SignalBot] prefixes
```

**Messages not being received:**

- Verify Signal phone number format
- Check phone is linked to Signal CLI
- Ensure webhook server is accessible
- Test with manual signal-cli command first

## 📊 Comparison: Signal vs Discord

| Feature          | Signal            | Discord                   |
| ---------------- | ----------------- | ------------------------- |
| Security         | ✅ E2E Encryption | ✅ Server-side encryption |
| Setup Complexity | 🔴 High           | 🟢 Low                    |
| Reliability      | 🟡 Medium         | 🟢 High                   |
| Features         | 🟡 Basic          | 🟢 Advanced               |
| User Experience  | ✅ Native app     | ✅ Rich interface         |
| Slash Commands   | ❌ No             | ✅ Yes                    |
| Webhooks         | 🟡 Limited        | 🟢 Full support           |

## 🎯 Recommendations

**When to Use Signal:**

- Secure, sensitive discussions
- Personal productivity
- Encrypted team communication
- When privacy is critical

**When to Use Discord:**

- Team collaboration
- Rich features needed
- Slash command interface
- Webhook-heavy workflows

## 🚀 Next Steps

1. **Set up Signal CLI** (30 minutes)
2. **Test basic messaging** (5 minutes)
3. **Configure webhooks** (15 minutes, optional)
4. **Deploy to production** (as part of main deployment)

---

**Status**: Signal integration implemented and ready for testing

**Estimated Setup Time**: 45-60 minutes

**Support**: Check logs for `[SignalBot]` prefixes

**Notes**: Signal integration is more complex than Discord due to limited official API support, but provides superior security for sensitive communications.
