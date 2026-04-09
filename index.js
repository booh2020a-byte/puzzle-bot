const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, EmbedBuilder } = require('discord.js');
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
const pendingTrades = {};

// ======================
// 🎨 COLORS
// ======================
const COLORS = {
  purple: 0x9B59B6,
  gold: 0xF1C40F,
  green: 0x2ECC71,
  red: 0xE74C3C,
  blue: 0x3498DB,
};

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
// 🎨 EMBED BUILDERS
// ======================
function makeEmbed(color, title, description) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function makeFieldEmbed(color, title, description, fields) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp();
  if (description) embed.setDescription(description);
  if (fields && fields.length > 0) embed.addFields(fields);
  return embed;
}

// ======================
// HELPERS
// ======================
function formatList(typeData) {
  if (!typeData || Object.keys(typeData).length === 0) return null;

  const fields = [];
  for (const album in albumsData) {
    if (!typeData[album]) continue;
    let albumText = '';
    for (const puzzle in albumsData[album]) {
      const pieces = (typeData[album][puzzle] || [])
        .map(p => p.piece)
        .sort((a, b) => Number(a) - Number(b));
      if (pieces.length > 0) albumText += `**${puzzle}:** ${pieces.join(', ')}\n`;
    }
    if (albumText) fields.push({ name: `🗂️ ${album}`, value: albumText.trim() });
  }
  return fields.length > 0 ? fields : null;
}

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
      const embed = makeFieldEmbed(
        COLORS.gold,
        '🔥 New Match Found!',
        null,
        [
          { name: '👤 Users', value: `<@${userId}> (${type}) ↔ <@${otherId}> (${opposite})`, inline: false },
          { name: '🗂️ Album', value: album, inline: true },
          { name: '🧩 Puzzle', value: puzzle, inline: true },
          { name: '🔢 Pieces', value: matches.join(', '), inline: false }
        ]
      );
      await channel.send({ embeds: [embed] });
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
        const embed = makeEmbed(COLORS.purple, '🧩 Puzzle Bot', 'Select an album to continue:');
        return interaction.reply({ embeds: [embed], components: [albumMenu()], ephemeral: true });
      }

      if (interaction.commandName === 'list') {
        const embed = makeEmbed(COLORS.purple, '📋 Your Lists', 'Which list do you want to see?');
        return interaction.reply({ embeds: [embed], components: [listTypeMenu()], ephemeral: true });
      }

      if (interaction.commandName === 'matches') {
        const embed = makeEmbed(COLORS.purple, '🔥 Your Matches', 'Which matches do you want to see?');
        return interaction.reply({ embeds: [embed], components: [matchesTypeMenu()], ephemeral: true });
      }

      if (interaction.commandName === 'clear') {
        const embed = makeEmbed(COLORS.purple, '🗑️ Clear List', 'Which list do you want to clear?');
        return interaction.reply({
          embeds: [embed],
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
        const embed = makeEmbed(COLORS.purple, '🤝 Start a Trade', 'Who are you trading with?');
        return interaction.reply({ embeds: [embed], components: [tradeUserMenu()], ephemeral: true });
      }
    }

    // ======================
    // MENUS
    // ======================
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      const parts = interaction.customId.split('|');

      // TRADE USER SELECT
      if (interaction.customId === 'tradeUser') {
        const userBId = interaction.values[0];

        if (userBId === interaction.user.id) {
          const embed = makeEmbed(COLORS.red, '❌ Invalid Trade', 'You cannot trade with yourself!');
          return interaction.update({ embeds: [embed], components: [] });
        }

        const users = servers[interaction.guildId].users;
        const userA = users[interaction.user.id];
        const userB = users[userBId];

        if (!userA) {
          const embed = makeEmbed(COLORS.red, '❌ No Data', 'You have no data registered.');
          return interaction.update({ embeds: [embed], components: [] });
        }
        if (!userB) {
          const embed = makeEmbed(COLORS.red, '❌ No Data', `<@${userBId}> has no data registered.`);
          return interaction.update({ embeds: [embed], components: [] });
        }

        const matchedAlbums = getMatchedAlbums(userA, userB);
        if (matchedAlbums.length === 0) {
          const embed = makeEmbed(COLORS.red, '❌ No Matches', `You have no matches with <@${userBId}>.`);
          return interaction.update({ embeds: [embed], components: [] });
        }

        session.tradeUserB = userBId;
        session.tradeStep = 'selectAlbum';

        const embed = makeEmbed(COLORS.purple, '🤝 Select Album', `Trading with <@${userBId}>.\nOnly albums with matches are shown.`);
        return interaction.update({ embeds: [embed], components: [tradeAlbumMenu(matchedAlbums)] });
      }

      // TRADE ALBUM SELECT
      if (interaction.customId === 'tradeAlbum') {
        const album = interaction.values[0];
        const users = servers[interaction.guildId].users;
        const userA = users[interaction.user.id];
        const userB = users[session.tradeUserB];

        const matchedPuzzles = getMatchedPuzzles(userA, userB, album);
        if (matchedPuzzles.length === 0) {
          const embed = makeEmbed(COLORS.red, '❌ No Matches', 'No matched puzzles in this album.');
          return interaction.update({ embeds: [embed], components: [] });
        }

        session.tradeAlbum = album;
        const embed = makeEmbed(COLORS.purple, '🤝 Select Puzzle', `**Album:** ${album}\nOnly puzzles with matches are shown.`);
        return interaction.update({ embeds: [embed], components: [tradePuzzleMenu(matchedPuzzles)] });
      }

      // TRADE PUZZLE SELECT
      if (interaction.customId === 'tradePuzzle') {
        const puzzle = interaction.values[0];
        const users = servers[interaction.guildId].users;
        const userA = users[interaction.user.id];
        const userB = users[session.tradeUserB];

        const matchedPieces = getMatchedPieces(userA, userB, session.tradeAlbum, puzzle);
        if (matchedPieces.length === 0) {
          const embed = makeEmbed(COLORS.red, '❌ No Matches', 'No matched pieces in this puzzle.');
          return interaction.update({ embeds: [embed], components: [] });
        }

        session.tradePuzzle = puzzle;
        const embed = makeEmbed(COLORS.purple, '🤝 Select Pieces', `**Album:** ${session.tradeAlbum}\n**Puzzle:** ${puzzle}\nSelect the pieces you are trading:`);
        return interaction.update({ embeds: [embed], components: [tradePiecesMenu(matchedPieces)] });
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

        const waitEmbed = makeFieldEmbed(
          COLORS.purple,
          '⏳ Trade Request Sent',
          `Waiting for <@${session.tradeUserB}> to confirm. *(15 minutes)*`,
          [
            { name: '🗂️ Album', value: session.tradeAlbum, inline: true },
            { name: '🧩 Puzzle', value: session.tradePuzzle, inline: true },
            { name: '🔢 Pieces', value: pieces.join(', '), inline: false }
          ]
        );

        await interaction.update({ embeds: [waitEmbed], components: [] });

        const requestEmbed = makeFieldEmbed(
          COLORS.gold,
          '🤝 Trade Request!',
          `<@${session.tradeUserB}>, <@${interaction.user.id}> wants to trade with you!\n\nDo you confirm? *(expires in 15 minutes)*`,
          [
            { name: '🗂️ Album', value: session.tradeAlbum, inline: true },
            { name: '🧩 Puzzle', value: session.tradePuzzle, inline: true },
            { name: '🔢 Pieces', value: pieces.join(', '), inline: false }
          ]
        );

        await interaction.channel.send({ embeds: [requestEmbed], components: [tradeConfirmButtons(tradeId)] });
        return;
      }

      // LIST TYPE MENU
      if (interaction.customId === 'listType') {
        const type = interaction.values[0];
        const userData = servers[interaction.guildId]?.users[interaction.user.id];
        const typeData = userData?.[type];
        const fields = formatList(typeData);

        if (!fields) {
          const embed = makeEmbed(COLORS.purple, `📋 Your ${type.toUpperCase()} List`, 'Your list is empty.');
          return interaction.update({ embeds: [embed], components: [] });
        }

        // Discord embeds support max 25 fields — chunk if needed
        const chunks = [];
        for (let i = 0; i < fields.length; i += 25) {
          chunks.push(fields.slice(i, i + 25));
        }

        const firstEmbed = makeFieldEmbed(COLORS.purple, `📋 Your ${type.toUpperCase()} List`, null, chunks[0]);
        await interaction.update({ embeds: [firstEmbed], components: [] });

        for (let i = 1; i < chunks.length; i++) {
          const embed = makeFieldEmbed(COLORS.purple, `📋 Your ${type.toUpperCase()} List (cont.)`, null, chunks[i]);
          await interaction.followUp({ embeds: [embed], ephemeral: true });
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
          const embed = makeEmbed(COLORS.red, '❌ No Data', 'You have no data registered.');
          return interaction.update({ embeds: [embed], components: [] });
        }

        const fields = [];

        for (const album in albumsData) {
          if (!myData[direction]?.[album]) continue;
          let albumText = '';
          for (const puzzle in albumsData[album]) {
            if (!myData[direction][album]?.[puzzle]) continue;
            const myPieces = myData[direction][album][puzzle].map(p => p.piece);
            const allMatches = [];
            for (const [otherId, otherData] of Object.entries(users)) {
              if (otherId === userId) continue;
              const theirPieces = (otherData[opposite]?.[album]?.[puzzle] || []).map(p => p.piece);
              const matches = myPieces.filter(p => theirPieces.includes(p));
              if (matches.length > 0) {
                const verb = direction === 'have' ? 'needs it' : 'has it';
                allMatches.push(`**${matches.sort((a, b) => Number(a) - Number(b)).join(', ')}** — <@${otherId}> ${verb}`);
              }
            }
            if (allMatches.length > 0) {
              albumText += `**${puzzle}:**\n${allMatches.join('\n')}\n`;
            }
          }
          if (albumText) fields.push({ name: `🗂️ ${album}`, value: albumText.trim() });
        }

        if (fields.length === 0) {
          const embed = makeEmbed(COLORS.purple, '🔥 Your Matches', 'No current matches found.');
          return interaction.update({ embeds: [embed], components: [] });
        }

        const label = direction === 'have' ? 'Pieces I HAVE that others need' : 'Pieces I NEED that others have';
        const chunks = [];
        for (let i = 0; i < fields.length; i += 25) chunks.push(fields.slice(i, i + 25));

        const firstEmbed = makeFieldEmbed(COLORS.gold, `🔥 ${label}`, null, chunks[0]);
        await interaction.update({ embeds: [firstEmbed], components: [] });

        for (let i = 1; i < chunks.length; i++) {
          const embed = makeFieldEmbed(COLORS.gold, `🔥 ${label} (cont.)`, null, chunks[i]);
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        }
        return;
      }

      // CLEAR MENU
      if (interaction.customId === 'clearMenu') {
        const choice = interaction.values[0];
        const user = servers[interaction.guildId].users[interaction.user.id];
        if (!user) {
          const embed = makeEmbed(COLORS.red, '❌ No Data', 'No data to clear.');
          return interaction.update({ embeds: [embed], components: [] });
        }

        if (choice === 'have' || choice === 'need') {
          user[choice] = {};
        } else if (choice === 'both') {
          user.have = {};
          user.need = {};
        }

        await saveData();
        const embed = makeEmbed(COLORS.green, '✅ Cleared!', `Your **${choice}** list has been cleared.`);
        return interaction.update({ embeds: [embed], components: [] });
      }

      // ALBUM MENU
      if (interaction.customId === 'album') {
        session.album = interaction.values[0];
        const embed = makeEmbed(COLORS.purple, '🧩 Puzzle Bot', `**Album:** ${session.album}\nNow select a puzzle:`);
        return interaction.update({ embeds: [embed], components: [puzzleMenu(session.album)] });
      }

      // PUZZLE MENU
      if (parts[0] === 'puzzle') {
        session.album = parts[1];
        session.puzzle = interaction.values[0];
        const embed = makeEmbed(COLORS.purple, '🧩 Puzzle Bot', `**Album:** ${session.album}\n**Puzzle:** ${session.puzzle}\nNow select your pieces:`);
        return interaction.update({ embeds: [embed], components: [piecesMenu(parts[1], session.puzzle)] });
      }

      // PIECES MENU
      if (parts[0] === 'pieces') {
        const album = parts[1];
        const puzzle = parts[2];
        const pieces = interaction.values;

        if (session.type === 'remove') {
          await removePieces(interaction.guildId, interaction.user.id, 'have', album, puzzle, pieces);
          await removePieces(interaction.guildId, interaction.user.id, 'need', album, puzzle, pieces);
          const embed = makeFieldEmbed(COLORS.green, '✅ Pieces Removed!', null, [
            { name: '🗂️ Album', value: album, inline: true },
            { name: '🧩 Puzzle', value: puzzle, inline: true },
            { name: '🔢 Pieces', value: pieces.join(', '), inline: false }
          ]);
          return interaction.update({ embeds: [embed], components: [] });
        } else {
          await savePieces(interaction.guildId, interaction.user.id, session.type, album, puzzle, pieces);

          if (interaction.channel) {
            const updateEmbed = makeFieldEmbed(
              COLORS.purple,
              '📦 List Updated',
              `<@${interaction.user.id}> updated their **${session.type}** list`,
              [
                { name: '🗂️ Album', value: album, inline: true },
                { name: '🧩 Puzzle', value: puzzle, inline: true },
                { name: '🔢 Pieces', value: pieces.join(', '), inline: false }
              ]
            );
            await interaction.channel.send({ embeds: [updateEmbed] });
          }

          await checkMatch(interaction.guildId, interaction.user.id, session.type, album, puzzle, interaction.channel);

          const embed = makeFieldEmbed(COLORS.green, '✅ List Updated!', null, [
            { name: '🗂️ Album', value: album, inline: true },
            { name: '🧩 Puzzle', value: puzzle, inline: true },
            { name: '🔢 Pieces', value: pieces.join(', '), inline: false }
          ]);
          return interaction.update({ embeds: [embed], components: [] });
        }
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
          const embed = makeEmbed(COLORS.red, '❌ Expired', 'This trade has expired or no longer exists.');
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        if (interaction.user.id !== trade.userB) {
          const embed = makeEmbed(COLORS.red, '❌ Not Your Trade', 'This trade request is not for you.');
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (parts[0] === 'tradeDecline') {
          delete pendingTrades[tradeId];
          const declineEmbed = makeFieldEmbed(
            COLORS.red,
            '❌ Trade Declined',
            `<@${trade.userB}> declined the trade with <@${trade.userA}>.`,
            [
              { name: '🗂️ Album', value: trade.album, inline: true },
              { name: '🧩 Puzzle', value: trade.puzzle, inline: true },
              { name: '🔢 Pieces', value: trade.pieces.join(', '), inline: false }
            ]
          );
          await interaction.update({ embeds: [declineEmbed], components: [] });
          const notifyEmbed = makeEmbed(COLORS.red, '❌ Trade Declined', `<@${trade.userA}> your trade request was declined by <@${trade.userB}>.`);
          await interaction.channel.send({ embeds: [notifyEmbed] });
          return;
        }

        if (parts[0] === 'tradeConfirm') {
          const { guildId, userA, userB, album, puzzle, pieces } = trade;
          delete pendingTrades[tradeId];

          await removePieces(guildId, userA, 'have', album, puzzle, pieces);
          await removePieces(guildId, userA, 'need', album, puzzle, pieces);
          await removePieces(guildId, userB, 'have', album, puzzle, pieces);
          await removePieces(guildId, userB, 'need', album, puzzle, pieces);

          const confirmEmbed = makeFieldEmbed(
            COLORS.green,
            '✅ Trade Confirmed!',
            `<@${userA}> and <@${userB}> completed a trade!`,
            [
              { name: '🗂️ Album', value: album, inline: true },
              { name: '🧩 Puzzle', value: puzzle, inline: true },
              { name: '🔢 Pieces Traded', value: pieces.join(', '), inline: false }
            ]
          );
          await interaction.update({ embeds: [confirmEmbed], components: [] });

          const celebEmbed = makeEmbed(COLORS.green, '🎉 Trade Complete!', `<@${userA}> <@${userB}> your trade is done! Pieces **${pieces.join(', ')}** from **${puzzle}** have been removed from both your lists.`);
          await interaction.channel.send({ embeds: [celebEmbed] });
          return;
        }
      }
    }

  } catch (err) {
    console.error("❌ Erro na interação:", err);
    try {
      if (interaction.replied || interaction.deferred) return;
      const embed = makeEmbed(COLORS.red, '❌ Something went wrong', 'Please try again.');
      await interaction.reply({ embeds: [embed], ephemeral: true });
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