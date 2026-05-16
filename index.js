require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder
} = require("discord.js");

const db = require("./database");
const redeemCode = require("./redeem");

// =========================
// CONFIG
// =========================

// YOUR MAIN GIFT CODE CHANNEL
const GIFT_CHANNEL_ID = "1309545161105215539";

// =========================
// DISCORD CLIENT
// =========================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// =========================
// DATABASE TABLES
// =========================

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            discord_id TEXT,
            player_id TEXT PRIMARY KEY
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS guild_channels (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL
        )
    `);

});

// =========================
// SLASH COMMANDS
// =========================

const commands = [
    new SlashCommandBuilder()
        .setName("setchannel")
        .setDescription("Set this channel as the registration channel")
        .toJSON()
];

const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {

    try {

        console.log("Registering slash commands...");

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );

        console.log("Slash commands registered.");

    } catch (error) {
        console.log(error);
    }
}

// =========================
// READY
// =========================

client.once("ready", async () => {

    console.log(`Logged in as ${client.user.tag}`);

    await registerCommands();

});

// =========================
// SLASH COMMAND HANDLER
// =========================

client.on("interactionCreate", async (interaction) => {

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "setchannel") {

        db.run(`
            INSERT OR REPLACE INTO guild_channels
            (guild_id, channel_id)
            VALUES (?, ?)
        `,
        [
            interaction.guild.id,
            interaction.channel.id
        ]);

        await interaction.reply({
            content: "✅ This channel has been set for player registration and redemption notifications.",
            ephemeral: true
        });
    }
});

// =========================
// MESSAGE HANDLER
// =========================

client.on("messageCreate", async (message) => {

    if (message.author.bot) return;

    // =========================
    // AUTO PLAYER ID SAVE
    // =========================

    const content = message.content.trim();

    if (/^\d{6,15}$/.test(content)) {

        db.get(`
            SELECT * FROM guild_channels
            WHERE guild_id = ?
        `,
        [message.guild.id],
        (err, row) => {

            if (err || !row) return;

            // ONLY ALLOW IDS IN REGISTERED CHANNEL

            if (message.channel.id !== row.channel_id) return;

            db.run(`
                INSERT OR IGNORE INTO players
                (discord_id, player_id)
                VALUES (?, ?)
            `,
            [
                message.author.id,
                content
            ]);

            message.reply(`✅ Player ID saved: ${content}`);
        });

        return;
    }

    // =========================
    // GIFT CODE DETECTION
    // =========================

    // ONLY WATCH MAIN CHANNEL

    if (message.channel.id !== GIFT_CHANNEL_ID) return;

    let textToCheck = message.content;

    // READ EMBEDS

    if (message.embeds.length > 0) {

        const embed = message.embeds[0];

        textToCheck += "\n";

        if (embed.title)
            textToCheck += embed.title + "\n";

        if (embed.description)
            textToCheck += embed.description + "\n";

        if (embed.fields.length > 0) {

            for (const field of embed.fields) {

                textToCheck += field.name + "\n";
                textToCheck += field.value + "\n";
            }
        }
    }

    // DETECT CODE

    const codeMatch = textToCheck.match(
        /Code:\s*([A-Z0-9]+)/i
    );

    if (!codeMatch) return;

    const giftCode = codeMatch[1];

    console.log(`NEW CODE DETECTED: ${giftCode}`);

    // =========================
    // SEND START MESSAGE
    // =========================

    db.all(`
        SELECT * FROM guild_channels
    `,
    async (err, channels) => {

        if (err) return console.log(err);

        for (const ch of channels) {

            try {

                const channel =
                    await client.channels.fetch(
                        ch.channel_id
                    );

                if (channel) {

                    await channel.send(
                        `🎁 New gift code detected: ${giftCode}\n⏳ Redemption started...`
                    );
                }

            } catch (e) {
                console.log(e);
            }
        }

        // =========================
        // REDEEM FOR ALL PLAYERS
        // =========================

        db.all(`
            SELECT * FROM players
        `,
        async (err, players) => {

            if (err) return console.log(err);

            for (const player of players) {

                try {

                    const result = await redeemCode(
                        player.player_id,
                        giftCode,
                        client
                    );

                    console.log(
                        `${player.player_id}: ${result.message}`
                    );

                } catch (e) {
                    console.log(e);
                }
            }

            // =========================
            // SEND FINISH MESSAGE
            // =========================

            for (const ch of channels) {

                try {

                    const channel =
                        await client.channels.fetch(
                            ch.channel_id
                        );

                    if (channel) {

                        await channel.send(
                            `✅ Redemption completed for code: ${giftCode}`
                        );
                    }

                } catch (e) {
                    console.log(e);
                }
            }

        });

    });

});

client.login(process.env.DISCORD_TOKEN);