const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder } = require('discord.js');
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

// Pending trades: { tradeId: { guildId, userA, userB, album, puzzle, pieces, expiresAt } }
const pendingTrades = {};

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

// Get albums where user has any data (have or need)
function getUserAlbums(userData) {
  const albums = [];
  for (const album in albumsData) {
    const hasHave = Object.keys(userData.have?.[album] || {}).some(
      puzzle => (userData.have[album][puzzle] || []).length > 0
    );
    const hasNeed = Object.keys(userData.need?.[album] || {}).some(
      puzzle => (userData.need[album][puzzle] || []).length > 0
    );
    if (hasHave || hasNeed) albums.push(album);
  }
  return albums;
}

// Get puzzles where user has any data (have or need) for a given album
function getUserPuzzles(userData, album) {
  const puzzles = [];
  for (const puzzle in albumsData[album]) {
    const haveCount = (userData.have?.[album]?.[puzzle] || []).length;
    const needCount = (userData.need?.[album]?.[puzzle] || []).length;
    if (haveCount > 0 || needCount > 0) puzzles.push(puzzle);
  }
  return puzzles;
}

// Get all pieces user has registered (have + need combined, deduplicated) for a puzzle
function getUserPieces(userData, album, puzzle) {
  const havePieces = (userData.have?.[album]?.[puzzle] || []).map(p => p.piece);
  const needPieces = (userData.need?.[album]?.[puzzle] || []).map(p => p.piece);
  return [...new Set([...havePieces, ...needPieces])].sort((a, b) => Number(a) - Number(b));
}

// Get matched albums between two users (both directions)
function getMatchedAlbums(userA, userB) {
  const matched = [];
  for (const album in albumsData) {
    for (const puzzle in albumsData[album]) {
      const aPieces = (userA.have?.[album]?.[puzzle] || []).map(p => p.piece);
      const bPieces = (userB.need?.[album]?.[puzzle] || []).map(p => p.piece);
      const abMatches = aPieces.filter(p => bPieces.includes(p));

      const bPieces2 = (userB.have?.[album]?.[puzzle] || []).map(p => p.piece);
      const aPieces2 = (userA.need?.[album]?.[puzzle] || []).map(p => p.piece);
      const baMatches = bPieces2.filter(p => aPieces2.includes(p));

      if ((abMatches.length > 0 || baMatches.length > 0) && !matched.includes(album)) {
        matched.push(album);
      }
    }
  }
  return matched;
}

// Get matched puzzles for a given album between two users (both directions)
function getMatchedPuzzles(userA, userB, album) {
  const matched = [];
  for (const puzzle in albumsData[album]) {
    const aPieces = (userA.have?.[album]?.[puzzle] || []).map(p => p.piece);
    const bPieces = (userB.need?.[album]?.[puzzle] || []).map(p => p.piece);
    const abMatches = aPieces.filter(p => bPieces.includes(p));

    const bPieces2 = (userB.have?.[album]?.[puzzle] || []).map(p => p.piece);
    const aPieces2 = (userA.need?.[album]?.[puzzle] || []).map(p => p.piece);
    const baMatches = bPieces2.filter(p => aPieces2.includes(p));

    if (abMatches.length > 0 || baMatches.length > 0) matched.push(puzzle);
  }
  return matched;
}

// Get matched pieces for a given album/puzzle between two users (both directions)
function getMatchedPieces(userA, userB, album, puzzle) {
  const aPieces = (userA.have?.[album]?.[puzzle] || []).map(p => p.piece);
  const bPieces = (userB.need?.[album]?.[puzzle] || []).map(p => p.piece);
  const abMatches = aPieces.filter(p => bPieces.includes(p));

  const bPieces2 = (userB.have?.[album]?.[puzzle] || []).map(p => p.piece);
  const aPieces2 = (userA.need?.[album]?.[puzzle] || []).map(p => p.piece);
  const baMatches = bPieces2.filter(p => aPieces2.includes(p));

  return [...new Set([...abMatches, ...baMatches])].sort((a, b) => Number(a) - Number(b));
}

function cleanExpiredTrades() {
  const now = Date.now();
  for (const tradeId in pendingTrades) {
    if (pendingTrades[tradeId].expiresAt < now) {
      delete pendingTrades[tradeId];
    }
  }
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

function removeAlbumMenu(albums) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('removeAlbum')
      .setPlaceholder('Select album')
      .addOptions(albums.map(a => ({ label: a, value: a })))
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

function removePuzzleMenu(puzzles, album) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`removePuzzle|${album}`)
      .setPlaceholder('Select puzzle')
      .addOptions(puzzles.map(p => ({ label: p, value: p })))
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

function removePiecesMenu(pieces, album, puzzle) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`removePieces|${album}|${puzzle}`)
      .setPlaceholder('Select pieces to remove')
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

function tradeUserMenu() {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('tradeUser')
      .setPlaceholder('Select the user you are trading with')
  );
}

function tradeAlbumMenu(matchedAlbums) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tradeAlbum')
      .setPlaceholder('Select album')
      .addOptions(matchedAlbums.map(a => ({ label: a, value: a })))
  );
}

function tradePuzzleMenu(matchedPuzzles) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tradePuzzle')
      .setPlaceholder('Select puzzle')
      .addOptions(matchedPuzzles.map(p => ({ label: p, value: p })))
  );
}

function tradePiecesMenu(matchedPieces) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tradePieces')
      .setPlaceholder('Select pieces to trade')
      .setMinValues(1)
      .setMaxValues(matchedPieces.length)
      .addOptions(matchedPieces.map(p => ({ label: p, value: p })))
  );
}

function tradeConfirmButtons(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tradeConfirm|${tradeId}`)
      .setLabel('✅ Confirm Trade')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tradeDecline|${tradeId}`)
      .setLabel('❌ Decline Trade')
      .setStyle(ButtonStyle.Danger)
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

      if (interaction.commandName === 'have' || interaction.commandName === 'need') {
        session.type = interaction.commandName;
        session.album = null;
        session.puzzle = null;
        return interaction.reply({ content: 'Select album:', components: [albumMenu()], ephemeral: true });
      }

      if (interaction.commandName === 'remove') {
        const userData = servers[interaction.guildId]?.users[interaction.user.id];
        if (!userData) return interaction.reply({ content: '❌ You have no data to remove.', ephemeral: true });

        const albums = getUserAlbums(userData);
        if (albums.length === 0) return interaction.reply({ content: '❌ You have no data to remove.', ephemeral: true });

        session.type = 'remove';
        return interaction.reply({
          content: 'Select album:',
          components: [removeAlbumMenu(albums)],
          ephemeral: true
        });
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

      if (interaction.commandName === 'trade') {
        session.tradeStep = 'selectUser';
        return interaction.reply({
          content: '🤝 Who are you trading with?',
          components: [tradeUserMenu()],
          ephemeral: true
        });
      }
    }

    // ======================
    // MENUS
    // ======================
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      const parts = interaction.customId.split('|');

      // REMOVE ALBUM MENU
      if (interaction.customId === 'removeAlbum') {
        const album = interaction.values[0];
        const userData = servers[interaction.guildId]?.users[interaction.user.id];
        const puzzles = getUserPuzzles(userData, album);

        if (puzzles.length === 0) {
          return interaction.update({ content: '❌ No data in this album.', components: [] });
        }

        session.removeAlbum = album;
        return interaction.update({
          content: `Album: **${album}**\nSelect a puzzle:`,
          components: [removePuzzleMenu(puzzles, album)]
        });
      }

      // REMOVE PUZZLE MENU
      if (parts[0] === 'removePuzzle') {
        const album = parts[1];
        const puzzle = interaction.values[0];
        const userData = servers[interaction.guildId]?.users[interaction.user.id];
        const pieces = getUserPieces(userData, album, puzzle);

        if (pieces.length === 0) {
          return interaction.update({ content: '❌ No pieces in this puzzle.', components: [] });
        }

        session.removeAlbum = album;
        session.removePuzzle = puzzle;
        return interaction.update({
          content: `Album: **${album}** | Puzzle: **${puzzle}**\nSelect pieces to remove:`,
          components: [removePiecesMenu(pieces, album, puzzle)]
        });
      }

      // REMOVE PIECES MENU
      if (parts[0] === 'removePieces') {
        const album = parts[1];
        const puzzle = parts[2];
        const pieces = interaction.values;

        await removePieces(interaction.guildId, interaction.user.id, 'have', album, puzzle, pieces);
        await removePieces(interaction.guildId, interaction.user.id, 'need', album, puzzle, pieces);
        return interaction.update({ content: `✅ Removed pieces **${pieces.join(', ')}** from **${puzzle}**`, components: [] });
      }

      // TRADE USER SELECT
      if (interaction.customId === 'tradeUser') {
        const userBId = interaction.values[0];

        if (userBId === interaction.user.id) {
          return interaction.update({ content: '❌ You cannot trade with yourself!', components: [] });
        }

        const users = servers[interaction.guildId].users;
        const userA = users[interaction.user.id];
        const userB = users[userBId];

        if (!userA) return interaction.update({ content: '❌ You have no data registered.', components: [] });
        if (!userB) return interaction.update({ content: '❌ That user has no data registered.', components: [] });

        const matchedAlbums = getMatchedAlbums(userA, userB);
        if (matchedAlbums.length === 0) {
          return interaction.update({ content: `❌ You have no matches with <@${userBId}>.`, components: [] });
        }

        session.tradeUserB = userBId;
        session.tradeStep = 'selectAlbum';

        return interaction.update({
          content: `Trading with <@${userBId}>. Select an album:`,
          components: [tradeAlbumMenu(matchedAlbums)]
        });
      }

      // TRADE ALBUM SELECT
      if (interaction.customId === 'tradeAlbum') {
        const album = interaction.values[0];
        const users = servers[interaction.guildId].users;
        const userA = users[interaction.user.id];
        const userB = users[session.tradeUserB];

        const matchedPuzzles = getMatchedPuzzles(userA, userB, album);
        if (matchedPuzzles.length === 0) {
          return interaction.update({ content: '❌ No matched puzzles in this album.', components: [] });
        }

        session.tradeAlbum = album;

        return interaction.update({
          content: `Album: **${album}**\nSelect a puzzle:`,
          components: [tradePuzzleMenu(matchedPuzzles)]
        });
      }

      // TRADE PUZZLE SELECT
      if (interaction.customId === 'tradePuzzle') {
        const puzzle = interaction.values[0];
        const users = servers[interaction.guildId].users;
        const userA = users[interaction.user.id];
        const userB = users[session.tradeUserB];

        const matchedPieces = getMatchedPieces(userA, userB, session.tradeAlbum, puzzle);
        if (matchedPieces.length === 0) {
          return interaction.update({ content: '❌ No matched pieces in this puzzle.', components: [] });
        }

        session.tradePuzzle = puzzle;

        return interaction.update({
          content: `Album: **${session.tradeAlbum}** | Puzzle: **${puzzle}**\nSelect the pieces you are trading:`,
          components: [tradePiecesMenu(matchedPieces)]
        });
      }

      // TRADE PIECES SELECT
      if (interaction.customId === 'tradePieces') {
        const pieces = interaction.values;
        const tradeId = `${interaction.user.id}_${session.tradeUserB}_${Date.now()}`;
        const expiresAt = Date.now() + 15 * 60 * 1000;

        pendingTrades[tradeId] = {
          guildId: interaction.guildId,
          userA: interaction.user.id,
          userB: session.tradeUserB,
          album: session.tradeAlbum,
          puzzle: session.tradePuzzle,
          pieces,
          expiresAt
        };

        await interaction.update({
          content: `⏳ Trade request sent to <@${session.tradeUserB}>!\nWaiting for their confirmation *(15 minutes)*.\n\n**${session.tradeAlbum} → ${session.tradePuzzle}**\nPieces: ${pieces.join(', ')}`,
          components: []
        });

        await interaction.channel.send({
          content: `🤝 <@${session.tradeUserB}>, <@${interaction.user.id}> wants to trade with you!\n\n**${session.tradeAlbum} → ${session.tradePuzzle}**\nPieces: ${pieces.join(', ')}\n\nDo you confirm this trade? *(expires in 15 minutes)*`,
          components: [tradeConfirmButtons(tradeId)]
        });

        return;
      }

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

          for (const album in albumsData) {
            if (!myData[direction]?.[album]) continue;
            for (const puzzle in albumsData[album]) {
              if (!myData[direction][album]?.[puzzle]) continue;
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

    // ======================
    // BUTTONS
    // ======================
    if (interaction.isButton()) {
      const parts = interaction.customId.split('|');

      if (parts[0] === 'tradeConfirm' || parts[0] === 'tradeDecline') {
        const tradeId = parts[1];
        cleanExpiredTrades();
        const trade = pendingTrades[tradeId];

        if (!trade) {
          return interaction.reply({ content: '❌ This trade has expired or no longer exists.', ephemeral: true });
        }
        if (interaction.user.id !== trade.userB) {
          return interaction.reply({ content: '❌ This trade request is not for you.', ephemeral: true });
        }

        if (parts[0] === 'tradeDecline') {
          delete pendingTrades[tradeId];
          await interaction.update({
            content: `❌ <@${trade.userB}> declined the trade with <@${trade.userA}>.\n\n**${trade.album} → ${trade.puzzle}**\nPieces: ${trade.pieces.join(', ')}`,
            components: []
          });
          await interaction.channel.send(`<@${trade.userA}> your trade request was declined by <@${trade.userB}>. ❌`);
          return;
        }

        if (parts[0] === 'tradeConfirm') {
          const { guildId, userA, userB, album, puzzle, pieces } = trade;
          delete pendingTrades[tradeId];

          await removePieces(guildId, userA, 'have', album, puzzle, pieces);
          await removePieces(guildId, userA, 'need', album, puzzle, pieces);
          await removePieces(guildId, userB, 'have', album, puzzle, pieces);
          await removePieces(guildId, userB, 'need', album, puzzle, pieces);

          await interaction.update({
            content: `✅ Trade confirmed between <@${userA}> and <@${userB}>!\n\n**${album} → ${puzzle}**\nPieces traded: ${pieces.join(', ')}`,
            components: []
          });
          await interaction.channel.send(`🎉 <@${userA}> <@${userB}> your trade is complete! Pieces **${pieces.join(', ')}** from **${puzzle}** have been removed from both your lists.`);
          return;
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
    { name: 'matches', description: 'See your current matches' },
    { name: 'trade', description: 'Trade pieces with another user' }
  ]);

  setInterval(cleanOldData, 60 * 60 * 1000);
  console.log(`✅ Logged in as ${client.user.tag}`);
});

start();