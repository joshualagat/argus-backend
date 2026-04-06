import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { parseTradingViewCsv } from './csvParser.js';
import { ensureUserTab, appendOrders, syncGlobalLeaderboard } from './sheetsManager.js';

// Initialize full local Desktop Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once(Events.ClientReady, c => {
    console.log(`\n========================================`);
    console.log(`Ready! Logged in as ${c.user.tag}`);
    console.log(`Bot is now monitoring for CSV submissions locally.`);
    console.log(`========================================\n`);
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    // Trigger if message contains a CSV file
    if (message.attachments.size > 0) {
        const csvAttachment = message.attachments.find(att => att.name && att.name.toLowerCase().endsWith('.csv'));

        if (csvAttachment) {
            try {
                // Determine Username strictly from typed Message Content
                const username = message.content.trim();

                if (!username) {
                    await message.reply("⚠️ You forgot to type your Username! Please type your name in the message box when uploading your .csv file.");
                    return;
                }

                // Acknowledge the user instantly locally
                await message.react('👀');

                const response = await fetch(csvAttachment.url);
                const csvText = await response.text();

                let reportText = "";

                // Parse CSV locally on this machine — no Gemini API call needed!
                const parsedData = parseTradingViewCsv(csvText);
                const orders = parsedData?.orders || [];

                if (orders.length === 0) {
                    await message.reply("No recognizable position data could be parsed from the image.");
                    return;
                }

                reportText += `Analyzed ${orders.length} potential position(s) in CSV.\n`;

                try {
                    // Check Sheets Metadata and push non-duplicate arrays locally
                    await ensureUserTab(username);
                    const timestampMs = message.createdTimestamp;
                    const result = await appendOrders(username, orders, timestampMs);

                    // The Ultimate Refresh - Sweep all tabs and securely update the Global Leaderboard API
                    await syncGlobalLeaderboard();

                    if (result.success) {
                        reportText += `\n✅ **Success**: ${result.count} new trades securely synced!`;
                        if (result.ignored > 0) {
                            reportText += `\n*Ignored ${result.ignored} duplicate(s) successfully.*`;
                        }
                    } else {
                        reportText += `⚠️ **Rejected**: ${result.reason}`;
                    }

                    await message.reply(reportText);
                } catch (sheetsError) {
                    console.error('Google Sheets Error:', sheetsError);
                    await message.reply('❌ Failed to update Google Sheets. Please verify the credentials and spreadsheet access.');
                }

            } catch (error) {
                console.error('Error processing csv:', error);
                await message.reply('❌ An error occurred during CSV parsing with Google Gemini API.');
            }
        }
    }
});

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
    console.warn("\n=== WARNING ===");
    console.warn("DISCORD_BOT_TOKEN is not defined in your environment.");
    console.warn("Please add DISCORD_BOT_TOKEN=<your token> to your .env file.");
    console.warn("===============\n");
} else {
    // Initiate persistent WebSocket connection
    client.login(token);
}

// ─── Render Port Binding ────────────────────────────────────────────────────
// Render requires every Web Service to bind to an HTTP port.
// This tiny server has one job: respond 200 OK to Render's health checks.
// It uses Node's built-in 'http' module — zero extra dependencies needed.
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Argus Bot is running.');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Health-check server listening on port ${PORT}`);
});
