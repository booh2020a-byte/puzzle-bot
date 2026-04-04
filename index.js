const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
require('dotenv').config();
const { MongoClient } = require('mongodb');

// ======================
// 📦 MONGODB CONNECTION
// ======================
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  tls: true,
  tlsAllowInvalidCertificates: true,
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
// HELPERS
// ======================
function formatList(typeData) {
  if (!typeData || Object.keys(typeData).length === 0) return null;

  let msg = '';
  for (const album in albumsData) {
    if (!typeData[album]) continue;
    msg += `**${album}:**\n`;
    for (const puzzle in albumsData[album]) {
      const pieces = (typeData[album][puzzle] || [])
        .map(p => p.piece)
        .sort((a, b) => Number(a) - Number(b));
      if (pieces.length > 0) msg += `${puzzle}: ${pieces.join(', ')}\n`;
    }
    msg += '\n';
  }
  return msg.trim() || null;
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

function listTypeMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('listType')
      .setPlaceholder('Select list to view')
      .addOptions([
        { label: 'Have', value: 'have' },
        { label: 'Need', value: 'need' }
      ])
  );
}

function matchesTypeMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('matchesType')
      .setPlaceholder('Select match direction')
      .addOptions([
        { label: 'Pieces I have that others need', value: 'have' },
        { label: 'Pieces I need that others have', value: 'need' }
      ])
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

  const existing = users[userId][type][album][puzzle] || [];

  const existingKept = existing.filter(p => !pieces.includes(p.piece));
  const newPieces = pieces.map(p => ({ piece: p, timestamp: now }));

  users[userId][type][album][puzzle] = [...existingKept, ...newPieces];
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
  const timeout = 14 * 24 * 60 * 60 * 1000;

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
        return interaction.reply({ content: 'Select album:', components: [albumMenu()], ephemeral: true });
      }

      if (interaction.commandName === 'list') {
        return interaction.reply({
          content: 'Which list do you want to see?',
          components: [listTypeMenu()],
          ephemeral: true
        });
      }

      if (interaction.commandName === 'matches') {
        return interaction.reply({
          content: 'Which matches do you want to see?',
          components: [matchesTypeMenu()],
          ephemeral: true
        });
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
    }

    // ======================
    // MENUS
    // ======================
    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split('|');

      // LIST TYPE MENU
      if (interaction.customId === 'listType') {
        const type = interaction.values[0];
        const userData = servers[interaction.guildId]?.users[interaction.user.id];
        const typeData = userData?.[type];
        const formatted = formatList(typeData);

        if (!formatted) {
          return interaction.update({ content: `Your **${type}** list is empty.`, components: [] });
        }

        const chunks = [];
        let current = `📋 **Your ${type.toUpperCase()} list:**\n\n`;
        for (const line of formatted.split('\n')) {
          if (current.length + line.length + 1 > 1900) { chunks.push(current); current = ''; }
          current += line + '\n';
        }
        if (current.trim()) chunks.push(current);

        await interaction.update({ content: chunks[0], components: [] });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
        return;
      }

      // MATCHES TYPE MENU
      if (interaction.customId === 'matchesType') {
        const direction = interaction.values[0];
        const opposite = direction === 'have' ? 'need' : 'have';
        const users = servers[interaction.guildId]?.users;
        const userId = interaction.user.id;
        const myData = users?.[userId];

        if (!myData) {
          return interaction.update({ content: 'You have no data.', components: [] });
        }

        const matchMap = {};

        for (const [otherId, otherData] of Object.entries(users)) {
          if (otherId === userId) continue;

          for (const album in myData[direction] || {}) {
            for (const puzzle in myData[direction][album]) {
              const myPieces = myData[direction][album][puzzle].map(p => p.piece);
              const theirPieces = (otherData[opposite]?.[album]?.[puzzle] || []).map(p => p.piece);
              const matches = myPieces.filter(p => theirPieces.includes(p));
              if (matches.length > 0) {
                if (!matchMap[album]) matchMap[album] = {};
                if (!matchMap[album][puzzle]) matchMap[album][puzzle] = [];
                const verb = direction === 'have' ? 'needs it' : 'has it';
                matchMap[album][puzzle].push(`${matches.sort((a, b) => Number(a) - Number(b)).join(', ')} — <@${otherId}> ${verb}`);
              }
            }
          }
        }

        if (Object.keys(matchMap).length === 0) {
          return interaction.update({ content: 'No current matches found.', components: [] });
        }

        const label = direction === 'have' ? 'Pieces I HAVE that others need' : 'Pieces I NEED that others have';
        let body = `🔥 **${label}:**\n\n`;
        for (const album in albumsData) {
          if (!matchMap[album]) continue;
          body += `**${album}:**\n`;
          for (const puzzle in albumsData[album]) {
            if (!matchMap[album]?.[puzzle]) continue;
            for (const line of matchMap[album][puzzle]) {
              body += `${puzzle}: ${line}\n`;
            }
          }
          body += '\n';
        }

        const chunks = [];
        let current = '';
        for (const line of body.split('\n')) {
          if (current.length + line.length + 1 > 1900) { chunks.push(current); current = ''; }
          current += line + '\n';
        }
        if (current.trim()) chunks.push(current);

        await interaction.update({ content: chunks[0], components: [] });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
        return;
      }

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
          return interaction.update({ content: `✅ Removed pieces from ${puzzle}`, components: [] });
        } else {
          await savePieces(interaction.guildId, interaction.user.id, session.type, album, puzzle, pieces);

          if (interaction.channel) {
            await interaction.channel.send(
              `📦 <@${interaction.user.id}> updated their ${session.type} list for ${puzzle}: ${pieces.join(', ')}`
            );
          }

          await checkMatch(interaction.guildId, interaction.user.id, session.type, album, puzzle, interaction.channel);
          return interaction.update({ content: `✅ Updated ${puzzle}`, components: [] });
        }
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