const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config();
const { MongoClient } = require('mongodb');

// ======================
// 📦 MONGODB CONNECTION
// ======================
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  tls: true,
  tlsAllowInvalidCertificates: true, // fix SSL/TLS error no Railway (Node 18 + OpenSSL 3)
});
let memoryCollection;

async function connectDB() {
  try {
    await mongoClient.connect();
    console.log("✅ Conectado ao MongoDB!");
    const db = mongoClient.db("puzzleBotDB");
    memoryCollection = db.collection("serversMemory");

    const saved = await memoryCollection.findOne({ key: 'servers' });
    if (!saved) {
      await memoryCollection.insertOne({ key: 'servers', data: {} });
      console.log("📂 Documento inicial criado no MongoDB");
    } else {
      Object.assign(servers, saved.data);
    }
  } catch (err) {
    console.error("❌ Erro ao conectar ao MongoDB:", err);
    process.exit(1);
  }
}

// ======================
// 📦 DISCORD CLIENT
// ======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ======================
// 📦 IN-MEMORY DATA
// ======================
const servers = {};

// ======================
// 📚 ALBUMS
// ======================
const albumsData = {
  BalladOfWindAndCold: {
    HonorAndGlory: 12,
    ColdHighways: 14,
    WordsOfTheForgotten: 14,
    MonumentToTheFlames: 13,
    AllianceShowdown: 12,
    StateVersusState: 14,
    TheSummitOfBattle: 12,
    CastleOfConflict: 12,
    RemakerOfOrder: 11
  },
  KingsOfCombat: {
    LeagueOfHonor: 12,
    ATournamentOfHeroes: 14,
    DuelOfGreatness: 14,
    TheCallisto: 13,
    KingsOfCombat: 12,
    TheArenaGamers: 13,
    TheHeliosCannon: 13,
    Behemoth: 11,
    TheBellTolls: 12
  },
  FrostdragonEmpire: {
    FrostdragonEmpire: 12,
    TheDragonicLegend: 14,
    WingsOfEmpire: 14,
    TheDragonicLegion: 13,
    Rediscovery: 12,
    FutureVision: 14,
    WarAndWealth: 12,
    BanquetForAKing: 12,
    ATyrantCrowned: 11
  }
};

// ======================
// 💾 DATABASE FUNCTIONS
// ======================
async function saveData() {
  if (!memoryCollection) return;
  await memoryCollection.updateOne(
    { key: 'servers' },
    { $set: { data: servers } },
    { upsert: true }
  );
}

function ensureServer(guildId) {
  if (!servers[guildId]) {
    servers[guildId] = { users: {}, sessions: {} };
  }
}

function makePieces(n) {
  return Array.from({ length: n }, (_, i) => (i + 1).toString());
}

// ======================
// MENUS
// ======================
function albumMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('album')
      .setPlaceholder('Select album')
      .addOptions(Object.keys(albumsData).map(a => ({ label: a, value: a })))
  );
}

function puzzleMenu(album) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`puzzle|${album}`)
      .setPlaceholder('Select puzzle')
      .addOptions(Object.keys(albumsData[album]).map(p => ({ label: p, value: p })))
  );
}

function piecesMenu(album, puzzle) {
  const count = albumsData[album]?.[puzzle];
  if (!count) return null;

  const pieces = makePieces(count);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pieces|${album}|${puzzle}`)
      .setPlaceholder('Select pieces')
      .setMinValues(1)
      .setMaxValues(pieces.length)
      .addOptions(pieces.map(p => ({ label: p, value: p })))
  );
}

function submitButton(customId = 'submit') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('Submit')
      .setStyle(ButtonStyle.Success)
  );
}

// ======================
// SAVE & REMOVE PIECES
// ======================
async function savePieces(guildId, userId, type, album, puzzle, pieces) {
  const users = servers[guildId].users;
  const now = Date.now();

  if (!users[userId]) users[userId] = { have: {}, need: {} };
  if (!users[userId][type][album]) users[userId][type][album] = {};

  users[userId][type][album][puzzle] = pieces.map(p => ({
    piece: p,
    timestamp: now
  }));

  users[userId][`${type}Updated`] = now;

  await saveData();
}

async function removePieces(guildId, userId, type, album, puzzle, pieces) {
  const users = servers[guildId].users;
  if (!users[userId] || !users[userId][type]?.[album]?.[puzzle]) return;

  users[userId][type][album][puzzle] =
    users[userId][type][album][puzzle].filter(p => !pieces.includes(p.piece));

  if (users[userId][type][album][puzzle].length === 0) {
    delete users[userId][type][album][puzzle];
  }

  await saveData();
}

// ======================
// MATCH FUNCTION
// ======================
async function checkMatch(guildId, userId, type, album, puzzle, channel) {
  const opposite = type === 'have' ? 'need' : 'have';
  const users = servers[guildId].users;

  const myPieces = (users[userId]?.[type]?.[album]?.[puzzle] || []).map(p => p.piece);

  for (const [otherId, data] of Object.entries(users)) {
    if (otherId === userId) continue;

    const otherPieces = (data?.[opposite]?.[album]?.[puzzle] || []).map(p => p.piece);
    const matches = myPieces.filter(p => otherPieces.includes(p));

    if (matches.length > 0 && channel) {
      await channel.send(
        `🔥 MATCH!\n<@${userId}> (${type}) ↔ <@${otherId}> (${opposite})\nAlbum: ${album}\nPuzzle: ${puzzle}\nPieces: ${matches.join(', ')}`
      );
    }
  }
}

// ======================
// CLEAN OLD DATA
// ======================
async function cleanOldData() {
  const now = Date.now();
  const timeout = 14 * 24 * 60 * 60 * 1000; // 14 dias

  for (const guild of Object.values(servers)) {
    for (const [userId, user] of Object.entries(guild.users || {})) {
      ['have', 'need'].forEach(type => {
        const updated = user[`${type}Updated`] || 0;
        if (now - updated > timeout) {
          user[type] = {};
        }
      });
    }
  }

  await saveData();
}

// ======================
// INTERACTIONS
// ======================
client.on('interactionCreate', async interaction => {
  if (!interaction.guildId) return;

  try {
    ensureServer(interaction.guildId);

    if (!servers[interaction.guildId].sessions[interaction.user.id]) {
      servers[interaction.guildId].sessions[interaction.user.id] = {};
    }

    const session = servers[interaction.guildId].sessions[interaction.user.id];

    // ======================
    // CHAT COMMANDS
    // ======================
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'have' || interaction.commandName === 'need' || interaction.commandName === 'remove') {
        session.type = interaction.commandName === 'remove' ? 'remove' : interaction.commandName;
        session.album = null;
        session.puzzle = null;

        return interaction.reply({
          content: 'Select album:',
          components: [albumMenu()],
          ephemeral: true
        });
      }

      if (interaction.commandName === 'list') {
        const userData = servers[interaction.guildId]?.users[interaction.user.id];
        if (!userData) return interaction.reply({ content: 'You have no data.', ephemeral: true });

        let msg = '';
        ['have', 'need'].forEach(type => {
          msg += `\n**${type.toUpperCase()}**\n`;
          for (const album in userData[type] || {}) {
            for (const puzzle in userData[type][album]) {
              const pieces = userData[type][album][puzzle].map(p => p.piece);
              msg += `${album} → ${puzzle}: ${pieces.join(', ')}\n`;
            }
          }
        });

        return interaction.reply({ content: msg || 'No data.', ephemeral: true });
      }

      if (interaction.commandName === 'clear') {
        return interaction.reply({
          content: 'Which list do you want to clear?',
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('clearMenu')
                .setPlaceholder('Select list to clear')
                .addOptions([
                  { label: 'Have', value: 'have' },
                  { label: 'Need', value: 'need' },
                  { label: 'Both', value: 'both' }
                ])
            )
          ],
          ephemeral: true
        });
      }

      // ======================
      // /matches COMMAND
      // ======================
      if (interaction.commandName === 'matches') {
        const users = servers[interaction.guildId]?.users;
        const userId = interaction.user.id;
        const myData = users?.[userId];

        if (!myData) return interaction.reply({ content: 'You have no data.', ephemeral: true });

        const matchMap = {};

        for (const [otherId, otherData] of Object.entries(users)) {
          if (otherId === userId) continue;

          // My HAVE vs their NEED
          for (const album in myData.have || {}) {
            for (const puzzle in myData.have[album]) {
              const myPieces = myData.have[album][puzzle].map(p => p.piece);
              const theirPieces = (otherData.need?.[album]?.[puzzle] || []).map(p => p.piece);
              const matches = myPieces.filter(p => theirPieces.includes(p));
              if (matches.length > 0) {
                const key = `${album} → ${puzzle}`;
                if (!matchMap[key]) matchMap[key] = [];
                matchMap[key].push(`I **have** piece(s) **${matches.join(', ')}** that <@${otherId}> needs`);
              }
            }
          }

          // My NEED vs their HAVE
          for (const album in myData.need || {}) {
            for (const puzzle in myData.need[album]) {
              const myPieces = myData.need[album][puzzle].map(p => p.piece);
              const theirPieces = (otherData.have?.[album]?.[puzzle] || []).map(p => p.piece);
              const matches = myPieces.filter(p => theirPieces.includes(p));
              if (matches.length > 0) {
                const key = `${album} → ${puzzle}`;
                if (!matchMap[key]) matchMap[key] = [];
                matchMap[key].push(`I **need** piece(s) **${matches.join(', ')}** that <@${otherId}> has`);
              }
            }
          }
        }

        if (Object.keys(matchMap).length === 0) {
          return interaction.reply({ content: 'No current matches found.', ephemeral: true });
        }

        let msg = '🔥 **Your current matches:**\n\n';
        for (const [key, lines] of Object.entries(matchMap)) {
          msg += `**${key}**\n${lines.join('\n')}\n\n`;
        }

        return interaction.reply({ content: msg, ephemeral: true });
      }
    }

    // ======================
    // MENUS
    // ======================
    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split('|');

      // CLEAR MENU
      if (interaction.customId === 'clearMenu') {
        const choice = interaction.values[0];
        const user = servers[interaction.guildId].users[interaction.user.id];
        if (!user) return interaction.update({ content: 'No data to clear.', components: [] });

        if (choice === 'have' || choice === 'need') {
          user[choice] = {};
        } else if (choice === 'both') {
          user.have = {};
          user.need = {};
        }

        await saveData();
        return interaction.update({ content: `✅ Cleared ${choice}`, components: [] });
      }

      // ALBUM MENU
      if (interaction.customId === 'album') {
        session.album = interaction.values[0];
        return interaction.update({ content: `Album: ${session.album}`, components: [puzzleMenu(session.album)] });
      }

      // PUZZLE MENU
      if (parts[0] === 'puzzle') {
        session.album = parts[1];
        session.puzzle = interaction.values[0];
        return interaction.update({ content: `Puzzle: ${session.puzzle}`, components: [piecesMenu(parts[1], session.puzzle)] });
      }

      // PIECES MENU
      if (parts[0] === 'pieces') {
        const album = parts[1];
        const puzzle = parts[2];
        const pieces = interaction.values;

        if (session.type === 'remove') {
          await removePieces(interaction.guildId, interaction.user.id, 'have', album, puzzle, pieces);
          await removePieces(interaction.guildId, interaction.user.id, 'need', album, puzzle, pieces);

          return interaction.update({ content: `✅ Removed pieces from ${puzzle}`, components: [submitButton()] });
        } else {
          await savePieces(interaction.guildId, interaction.user.id, session.type, album, puzzle, pieces);

          if (interaction.channel) {
            await interaction.channel.send(
              `📦 <@${interaction.user.id}> updated their ${session.type} list for ${puzzle}: ${pieces.join(', ')}`
            );
          }

          await checkMatch(interaction.guildId, interaction.user.id, session.type, album, puzzle, interaction.channel);

          return interaction.update({ content: `✅ Updated ${puzzle}`, components: [submitButton()] });
        }
      }
    }

    // ======================
    // BUTTONS
    // ======================
    if (interaction.isButton()) {
      if (interaction.customId === 'submit') {
        delete servers[interaction.guildId].sessions[interaction.user.id];
        return interaction.update({ content: '✅ Done!', components: [] });
      }
    }

  } catch (err) {
    console.error("❌ Erro na interação:", err);
    try {
      if (interaction.replied || interaction.deferred) return;
      await interaction.reply({ content: '❌ Algo deu errado. Tente novamente.', ephemeral: true });
    } catch (_) {}
  }
});

// ======================
// START
// ======================
async function start() {
  await connectDB();
  await client.login(process.env.TOKEN);
}

client.once('clientReady', async () => {
  await client.application.commands.set([
    { name: 'have', description: 'Pieces you have' },
    { name: 'need', description: 'Pieces you need' },
    { name: 'remove', description: 'Remove pieces from your lists' },
    { name: 'list', description: 'See your pieces' },
    { name: 'clear', description: 'Clear your data' },
    { name: 'matches', description: 'See your current matches' }
  ]);

  setInterval(cleanOldData, 60 * 60 * 1000);
  console.log(`✅ Logged in as ${client.user.tag}`);
});

start();